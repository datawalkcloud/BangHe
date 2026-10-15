/**
 * 售粮人档案详情（05 §3 `/parties/$id`）。
 *
 * 这一页回答粮站最常被人问的三个问题：
 *   1. 这个人还有多少钱没付（挂账）；
 *   2. 他的车多重（皮重档案），下次能不能少等十分钟；
 *   3. 他一年交了多少粮（历史交售与累计）。
 *
 * 皮重"手录"那一行必须显式标出来：手录皮重一旦当均值参考，会把后面所有
 * 几车的净重都带偏，所以这里用文字标注来源，不靠颜色。
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, ScanLineIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { OrderRow } from "@/mock/api";
import { PARTY_TYPE } from "@/lib/constants";
import { maskIdCard, money, orDash, shiftDay, todayISO, weight, varietyLabel } from "@/lib/format";
import { tareMean01kg as tareMeanOf, tareOverTolerance } from "@/lib/tare-ref";
import { useSetting } from "@/hooks/useLookups";
import type { IdCardResult } from "@/store/device";
import { backfillPartyPhotoFromCard } from "@/lib/party-photo";
import { upgradeVerifiedFromCard } from "@/lib/party-verify";
import { CardScanDialog } from "@/components/business/CardScanDialog";
import { IdCardText } from "@/components/business/IdCardText";
import { DataTable, type Column } from "@/components/ui/data-table";
import { PartyPortrait } from "@/components/business/PartyPortrait";
import { OrderStatusBadge, PaymentStatusBadge, ToneBadge, WeightSourceBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader, SectionTitle } from "@/components/business/layout";
import { StatCard, StatCardGrid } from "@/components/business/StatCard";
import { detailColumn, QuickDetailLink } from "@/components/business/quickDetail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "cn";

/**
 * 详情页只读明细表的紧凑排版（同 OrderDetailPage / QcDetailPage）。
 * shadcn Table 默认的 h-12 表头 / p-3 单元格会把卡片撑开，这里用后代选择器压回
 * py-1.5 / 无左右内边距 / 表头随行取色，特异性高于组件内置类，能稳定覆盖。
 */
const DETAIL_TABLE =
  "border-collapse text-sm [&_th]:h-auto [&_th]:px-0 [&_th]:py-1.5 [&_th]:font-normal [&_th]:text-inherit [&_td]:px-0 [&_td]:py-1.5";

/**
 * 档案正文（整页与详情抽屉共用）。
 *
 * `embedded` 给抽屉用：标题条要让开 Sheet 右上角的关闭按钮；
 * 「返回列表」这类整页导航由整页壳通过 `headerExtra` 传进来。
 */
export function PartyDetailBody({
  partyId,
  embedded = false,
  headerExtra,
}: {
  partyId: number;
  embedded?: boolean;
  headerExtra?: ReactNode;
}) {
  const headerCls = embedded ? "pr-11" : undefined;
  const qc = useQueryClient();
  /**
   * 「读卡核对」的放卡监听弹窗。不是一次性点读：`idcard_read` 一轮约 2 秒，人还没走到
   * 读卡器跟前那一下就用完了，读空之后这一页又没处说原因（就是"点了没反应"那次）。
   */
  const [scanOpen, setScanOpen] = useState(false);
  const tolerancePct = useSetting("tare_tolerance_pct").num / 100;

  const { data: detail, isLoading } = useQuery({
    queryKey: ["party", partyId],
    queryFn: () => api.getParty(partyId),
    enabled: Number.isFinite(partyId),
  });
  const { data: credits = [] } = useQuery({ queryKey: ["credits"], queryFn: () => api.credits() });

  const myCredits = useMemo(
    () => credits.filter((c) => c.settlement.party_id === partyId),
    [credits, partyId],
  );

  const tareList = detail?.tareHistory ?? detail?.tare_history ?? [];
  /**
   * 近 5 次均值：口径单源在 `lib/tare-ref`（手录不进基准），与磅房工作台的皮重参考卡片
   * 吃同一个函数。以前这一页是拿 `source` 去比中文标签「地磅读数」，判据恒假——
   * 手录皮重其实一直算在基准里，正好是篇首那条注释说要防的事。
   */
  const tareMean01kg = useMemo(() => tareMeanOf(tareList), [tareList]);

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="售粮人档案" description="加载中…" className={headerCls} />
        <div className="grid gap-4 px-6 py-4 xl:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="售粮人档案" className={headerCls} />
        <EmptyState
          title={`找不到编号 ${partyId} 的档案`}
          description="档案可能已被删除，或这台电脑的数据与另一台不在一起。"
          action={
            embedded ? undefined : (
              <Button size="sm" variant="outline" render={<Link to="/parties" />}>
                返回档案列表
              </Button>
            )
          }
        />
      </div>
    );
  }

  /** 守卫之后取一份非空快照：函数声明会被提升，TS 不认下面这段里的 `detail` 已经收窄了 */
  const p = detail;

  /**
   * 拿读到的一张证件与这一页的档案比对（02 §F3.1、§F3.2）。「读卡核对」弹窗寻到卡后交进来，
   * 这一枪顺手做完只有读卡才能给的三件事：
   *  ① 证号对得上＝"这个档案背后确实有这张证件"，与本页「已核验/未核验」同一判据，
   *     对上了就当场把标记写进档案（这条路上没有"保存"按钮可等，理由同 ②）；
   *  ② 档案还没有人像照片时，把证件里那张补进去（**只补缺**：已有照片的档案一律不动，
   *     换脸得由人在档案页点「上传照片」自己确认）；
   *  ③ 对不上要说清读到的是谁——把别人的证件按在本页上，比不核对更危险。
   *
   * 只留电话建档的档案压根没有证号（02 §F3.1 允许），先走 ⓪ 那条：没有可比对的数就不假装核过，
   * 更不在这条路上补照片——认不出这张证件是不是档案本人时补脸，正是 ③ 要防的事。
   *
   * 读不出来与设备故障不在此列：那两样由监听弹窗自己说（`watchNote` / `error` 就显示在它
   * 底下那行红字上），这一页不再叠一条同义的 toast。
   */
  async function verifyAgainstCard(card: IdCardResult) {
    if (!p.id_card_no) {
      // 证号只出脱敏值，与本页其它地方同一口径：要录入的人手里就捏着那张证件，不必在屏幕上摊开
      toast.warning("这张档案没登记证号，核对无从比起", {
        description: `读到 ${card.name} · ${maskIdCard(card.id_card_no)}。要采集证号，到「农户与单位」编辑这张档案手工录入；不补上，下次这个人来刷卡建档还会另立一张新档案。`,
      });
      return;
    }
    if (card.id_card_no !== p.id_card_no.trim().toUpperCase()) {
      toast.error("卡面证号与这张档案不一致", {
        description: `读到 ${maskIdCard(card.id_card_no)}，本档案是 ${maskIdCard(p.id_card_no)}。请确认拿的是谁的证件。`,
      });
      return;
    }
    // ── 到这里证号逐字对上了。这一刷独有的两样当场落库：这一页没有"保存"按钮可等，
    //    磅员核完就走，挂着等保存等于永远不保存（02 §F3.1 给照片补写的同一条理由）。──
    const said: string[] = [];
    // 三条闸门（已经是 1 不重写 / 演示卡不盖章 / 卡面与档案的比对由后端重算）连同"成功后作废
    // 哪几处缓存"都收在 `lib/party-verify`，与工作台读卡认人共用同一份——判据不许长两处。
    const r = await upgradeVerifiedFromCard(card, p, qc);
    switch (r.kind) {
      case "upgraded":
        said.push("已把这张档案标成「已核验」");
        break;
      case "already-verified":
        said.push("这张档案本来就是「已核验」");
        break;
      case "demo-card":
        // 演示卡不盖章：台账把这台读卡器切成 Mock 时回的就是它，拿它给档案记一笔"核验过"，
        // 正是这条标记最怕的脏数据
        said.push("这台机此刻回的是演示卡，不给它盖「已核验」的章");
        break;
      case "failed":
        // 标记没写成只是这一格没升级，比对的结论仍然成立：说清"对上了、没落库、可以再刷一次"
        toast.warning("证号对上了，但「已核验」没写进档案", {
          description: `${r.reason}；档案其它内容一寸未动，可以再刷一次。`,
        });
        break;
    }
    // 照片那一句由共用实现自己说（判据、写入、留痕收在 lib/party-photo，三处读卡入口一份），
    // 它连"没补上"都会报，这里不叠同义的一条
    const fillingPhoto = p.photo_attachment_id == null && !!card.photo_path;
    if (!fillingPhoto) {
      said.push(
        p.photo_attachment_id != null
          ? "照片也已经在档案里"
          : "这次没从证件里取到照片（解码组件不配套的机型拿不到），可在档案页「上传照片」补",
      );
    }
    // 只剩"标记没写成 + 照片正在补"这一种形状时 said 是空的（两句都由别的那条说），兜一句
    toast.success("读卡核对通过", { description: said.length > 0 ? said.join("；") : "证号一致。" });
    if (fillingPhoto) void backfillPartyPhotoFromCard(card, p, qc);
  }

  /**
   * 顶栏那句副标题。没采集过证号就直说「未采集证号」，不写成"证号 —"：那是把"档案里根本没这个数"
   * 说成了一个读不出来的值，而且与下面「证件核验：未采集证号」同一状态两个叫法。
   *
   * 证号那半截用的是 `IdCardText`，不是 `maskIdCard` 拼进字符串：同一屏上顶栏和「档案信息」
   * 里那格指的是同一个号，两处都得能点开、都走同一条 `party_id_card` 通道留 `pii.read`。
   * 顶栏点不开而下格点得开，是会被当成 bug 报上来的那种不一致。
   */
  const headerDesc = (
    <>
      {detail.code} · 建档 {detail.created_at?.slice(0, 10) ?? ""} ·{" "}
      {detail.id_card_no ? (
        <>
          证号 <IdCardText value={detail.id_card_no} partyId={detail.id} className="tnum" />
        </>
      ) : (
        "未采集证号"
      )}
    </>
  );

  /**
   * 人像照片那一句说明。分成三条，是因为"刷一次核对就会补上"只对**有证号**的档案成立：
   * 只留电话建档的档案没有证号，核对认不出刷到的是不是本人，也就不会顺手把脸补进去（02 §F3.1）。
   */
  const photoHint =
    detail.photo_attachment_id != null
      ? "人像照片来自建档时刷的那张身份证；要换一张，到「农户与单位」编辑框里点「换一张」。"
      : detail.id_card_no
        ? "还没有人像照片：刷一次身份证核对会自动补上，也可在编辑框里本地上传。这是选填项，不影响制单与结算。"
        : "还没有人像照片：这张档案没登记证号，核对认不出刷到的是不是本人，也就不会替你补——先把证号采进档案，或直接在编辑框里上传一张。这是选填项，不影响制单与结算。";

  const recentCols: Column<OrderRow>[] = [
    { key: "order_no", header: "磅单号", cell: (r) => <span className="tnum font-medium">{r.order_no}</span> },
    { key: "date", header: "业务日期", cell: (r) => <span className="tnum">{r.business_date}</span>, sortValue: (r) => r.business_date },
    { key: "variety", header: "品种/等级", cell: (r) => `${varietyLabel(r.variety_name)}${r.grade ? ` ${r.grade}` : ""}` },
    { key: "vehicle", header: "车牌", cell: (r) => <span className="tnum">{orDash(r.vehicle_no)}</span> },
    { key: "net", header: "净重", align: "right", cell: (r) => <span className="tnum">{weight(r.net_weight_01kg)}</span>, sortValue: (r) => r.net_weight_01kg },
    { key: "settle", header: "结算重量", align: "right", cell: (r) => <span className="tnum">{weight(r.settlement_weight_01kg)}</span> },
    { key: "payable", header: "应付", align: "right", cell: (r) => <span className="tnum">{money(r.payable_amount_fen)}</span>, sortValue: (r) => r.payable_amount_fen },
    { key: "status", header: "状态", cell: (r) => <OrderStatusBadge status={r.status} /> },
    { key: "payment", header: "付款", cell: (r) => <PaymentStatusBadge status={r.payment_status} /> },
    { key: "source", header: "称重来源", cell: (r) => <WeightSourceBadge source={r.weight_source} /> },
    detailColumn("order", (r) => r.order_no),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        className={headerCls}
        title={
          <span className="flex items-center gap-2">
            {detail.name}
            <ToneBadge tone="neutral">{PARTY_TYPE[detail.party_type]}</ToneBadge>
            {detail.status === "disabled" && <ToneBadge tone="danger">已停用</ToneBadge>}
          </span>
        }
        description={headerDesc}
        actions={
          <>
            {headerExtra}
            <Button size="sm" variant="outline" onClick={() => setScanOpen(true)}>
              <ScanLineIcon />
              读卡核对
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          <StatCardGrid>
            <StatCard
              label="累计净重"
              value={(detail.total_net_01kg / 10000).toFixed(3)}
              unit="吨"
              hint="仅统计参与汇总的磅单，作废/拒收不计"
            />
            <StatCard label="磅单数" value={String(detail.recent.length)} unit="张（近期）" hint="完整记录请到磅单中心按姓名查" />
            <StatCard
              label="未付挂账"
              value={money(detail.credit_fen, false)}
              unit="元"
              tone={detail.credit_fen > 0 ? "warning" : "success"}
              hint={detail.credit_fen > 0 ? `额度 ${money(detail.credit_limit_fen, false)} 元` : "已结清"}
            />
            <StatCard
              label="参考皮重"
              value={tareMean01kg == null ? "—" : (tareMean01kg / 10).toFixed(0)}
              unit="kg"
              hint={tolerancePct > 0 ? `容差 ±${tolerancePct}%，超出需站长授权` : "未设置容差"}
            />
          </StatCardGrid>

          {detail.credit_fen > detail.credit_limit_fen && detail.credit_limit_fen > 0 && (
            <CallOut tone="danger" title="挂账已超额度">
              当前未付 {money(detail.credit_fen)}，超过设定额度 {money(detail.credit_limit_fen)}。
              站点参数「允许挂账」开启时仍可结算，但建议先把挂账付清再继续收粮。
            </CallOut>
          )}

          <div className="grid items-start gap-4 xl:grid-cols-2">
            <Card2 title="档案信息">
              <div className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <PartyPortrait partyId={partyId} hasPhoto={detail.photo_attachment_id != null} />
                  <p className="text-xs leading-relaxed text-muted-foreground">{photoHint}</p>
                </div>
                <InfoGrid
                  cols={2}
                  items={[
                    { label: "档案编码", value: <span className="tnum">{detail.code}</span> },
                    { label: "身份类型", value: PARTY_TYPE[detail.party_type] },
                    { label: "证件号", value: <IdCardText value={detail.id_card_no} partyId={detail.id} className="tnum" /> },
                    {
                      label: "证件核验",
                      // 用词与 /parties 列表一致：同一状态不在两处叫两个名字（读卡带入即已核验）
                      // 只留电话建档的档案压根没有证号，不能顶着「未核验」——那是刷过卡没核对上的意思
                      value: !detail.id_card_no ? (
                        <span className="text-muted-foreground">未采集证号</span>
                      ) : detail.id_card_verified === 1 ? (
                        <ToneBadge tone="success">已核验</ToneBadge>
                      ) : (
                        <ToneBadge tone="warning">未核验</ToneBadge>
                      ),
                    },
                    { label: "联系电话", value: <span className="tnum">{orDash(detail.phone)}</span> },
                    { label: "默认车牌", value: <span className="tnum">{orDash(detail.default_vehicle_no)}</span> },
                    { label: "住址", value: orDash(detail.address), span: 2 },
                    { label: "开户行", value: orDash(detail.bank_name) },
                    { label: "银行账号", value: <span className="tnum">{orDash(detail.bank_account)}</span> },
                    { label: "默认仓房", value: detail.default_warehouse_id == null ? "未预设" : `#${detail.default_warehouse_id}` },
                    { label: "默认货位", value: detail.default_slot_id == null ? "未预设" : `#${detail.default_slot_id}` },
                    { label: "备注", value: orDash(detail.remark), span: 2 },
                  ]}
                />
              </div>
            </Card2>

            <Card2
              title="皮重档案"
              extra={<span className="text-xs text-muted-foreground">皮重偏差是超收/少付的高发点，均值只取地磅读数</span>}
            >
              {tareList.length === 0 ? (
                <p className="text-sm text-muted-foreground">还没有皮重记录，第一次过磅后自动生成。</p>
              ) : (
                <div className="flex flex-col gap-2">
                  <Table className={DETAIL_TABLE}>
                    <TableHeader>
                      <TableRow className="border-b text-xs text-muted-foreground hover:bg-transparent">
                        <TableHead>日期</TableHead>
                        <TableHead className="text-right">皮重</TableHead>
                        <TableHead>来源</TableHead>
                        <TableHead className="text-right">与均值偏差</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {tareList.map((t, i) => {
                        const over = tareOverTolerance(t.tare_01kg, tareMean01kg, tolerancePct);
                        return (
                          <TableRow key={`${t.date}-${i}`} className={cn("border-b hover:bg-transparent", over && "bg-warning-bg")}>
                            <TableCell className="tnum">{t.date}</TableCell>
                            <TableCell className="tnum text-right">{weight(t.tare_01kg)}</TableCell>
                            <TableCell>
                              <WeightSourceBadge source={t.source} />
                            </TableCell>
                            <TableCell className="tnum text-right text-xs">
                              {tareMean01kg == null ? "—" : `${t.tare_01kg >= tareMean01kg ? "+" : "−"}${weight(Math.abs(t.tare_01kg - tareMean01kg), false)} kg`}
                              {over && <span className="ml-1 text-warning">超容差</span>}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  <p className="text-xs text-muted-foreground">
                    近 5 次均值 {tareMean01kg == null ? "—" : weight(tareMean01kg)}（手录那一行不计入），
                    比对基准来自站点参数「皮重容差比例」；磅房捕皮重超容差时<em>照常入账</em>，只在磅单上留一条醒目警示（05 §4 ②）。
                  </p>
                </div>
              )}
            </Card2>
          </div>

          <Card2 title="近期交售">
            <DataTable
              columns={recentCols}
              rows={detail.recent}
              rowKey={(r) => r.order_no}
              dense
              defaultPageSize={10}
              rowClassName={(r) => (r.weight_source === "manual" ? "bg-warning-bg" : undefined)}
              empty={<EmptyState title="此人还没有磅单" description="可以到磅房工作台读卡制单。" />}
            />
          </Card2>

          <Card2 title="挂账与结算单" extra={<span className="text-xs text-muted-foreground">未付清的结算单，按到期日排序</span>}>
            {myCredits.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有未付清的结算单。</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {myCredits.map((c) => (
                  <li key={c.settlement.settle_no} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <QuickDetailLink type="settlement" id={c.settlement.settle_no} className="tnum font-medium underline underline-offset-2">
                      {c.settlement.settle_no}
                    </QuickDetailLink>
                    <span className="text-xs text-muted-foreground">
                      {c.settlement.period_from} ~ {c.settlement.period_to} · {c.settlement.order_count} 张
                    </span>
                    <span className="tnum">未付 {money(c.unpaid_fen)}</span>
                    <span className="tnum text-xs text-muted-foreground">到期 {c.due_date}</span>
                    {c.overdue_days > 0 ? (
                      <ToneBadge tone="danger">逾期 {c.overdue_days} 天</ToneBadge>
                    ) : (
                      <ToneBadge tone="neutral">未到期</ToneBadge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card2>

          <p className="text-xs text-muted-foreground">
            提示：本页统计只覆盖 mock 保留的近期数据（{shiftDay(todayISO(), -14)} 起），
            正式台账请以「收购台账」报表导出数为准。
          </p>
        </div>
      </div>

      {/* 连续寻卡：读到即交回 verifyAgainstCard 比对，读不出来与设备故障的原因就显示在弹窗里 */}
      <CardScanDialog open={scanOpen} onOpenChange={setScanOpen} scene="verify" onCardRead={verifyAgainstCard} />
    </div>
  );
}

/** 整页路由入口：深链与 Ctrl+点击新窗口仍走这里，正文与详情抽屉共用 */
export function PartyDetailPage() {
  const { id } = useParams({ from: "/parties/$id" });
  return (
    <PartyDetailBody
      partyId={Number(id)}
      headerExtra={
        <Button size="sm" variant="outline" render={<Link to="/parties" />}>
          <ArrowLeftIcon />
          返回列表
        </Button>
      }
    />
  );
}

/** 详情页统一的小卡片壳，避免每块都写三遍 Card 头 */
function Card2({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <SectionTitle>{title}</SectionTitle>
        {extra}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}
