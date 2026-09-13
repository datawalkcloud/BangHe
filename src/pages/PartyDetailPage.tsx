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
import { useMemo, type ReactNode } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, ScanLineIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { OrderRow } from "@/mock/api";
import { PARTY_TYPE, WEIGHT_SOURCE } from "@/lib/constants";
import { maskIdCard, money, orDash, shiftDay, todayISO, weight } from "@/lib/format";
import { useSetting } from "@/hooks/useLookups";
import { useDeviceStore } from "@/store/device";
import { backfillPartyPhotoFromCard } from "@/lib/party-photo";
import { DataTable, type Column } from "@/components/business/DataTable";
import { PartyPortrait } from "@/components/business/PartyPortrait";
import { OrderStatusBadge, PaymentStatusBadge, ToneBadge, WeightSourceBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid, PageHeader, SectionTitle } from "@/components/business/layout";
import { StatCard } from "@/components/business/StatCard";
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
  const readCard = useDeviceStore((s) => s.reader.idcard.read);
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
  const tareMean01kg = useMemo(() => {
    const r = tareList.slice(0, 5);
    // 手录皮重不进均值：来源不可信，拿它当基准会把后面几车都带偏
    const trusted = r.filter((x) => x.source === WEIGHT_SOURCE.scale.label);
    const list = trusted.length > 0 ? trusted : r;
    if (list.length === 0) return null;
    return Math.round(list.reduce((s, x) => s + x.tare_01kg, 0) / list.length);
  }, [tareList]);

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
   * 读卡核对（02 §F3.1、§F3.2）。这一枪顺手做完只有读卡才能给的三件事：
   *  ① 证号对得上＝"这个档案背后确实有这张证件"，与本页「已核验/未核验」同一判据；
   *  ② 档案还没有人像照片时，把证件里那张补进去（**只补缺**：已有照片的档案一律不动，
   *     换脸得由人在档案页点「上传照片」自己确认）；
   *  ③ 对不上要说清读到的是谁——把别人的证件按在本页上，比不核对更危险。
   */
  async function verifyByCard() {
    const card = await readCard({ photo: true });
    if (!card) return; // 读不出来/设备不可用：原因已由设备状态栏与档案页那条告警说清，这里不叠一条
    if (card.id_card_no !== p.id_card_no.trim().toUpperCase()) {
      toast.error("卡面证号与这张档案不一致", {
        description: `读到 ${maskIdCard(card.id_card_no)}，本档案是 ${maskIdCard(p.id_card_no)}。请确认拿的是谁的证件。`,
      });
      return;
    }
    if (p.photo_attachment_id == null && card.photo_path) {
      // 判据、写入、留痕、怎么说都收在 lib/party-photo（工作台/档案页/这一页共用一份）。
      // 它自己会报"已补上"或"没补上"，这里不再叠一条同义的 toast。
      await backfillPartyPhotoFromCard(card, p, qc);
      return;
    }
    toast.success("读卡核对通过", {
      description:
        p.photo_attachment_id != null
          ? "证号一致；这张档案已有照片与核验标记，无需改动。"
          : "证号一致，但这次没从证件里取到照片（解码组件不支持），可在档案页「上传照片」补。",
    });
  }

  const recentCols: Column<OrderRow>[] = [
    { key: "order_no", header: "磅单号", cell: (r) => <span className="tnum font-medium">{r.order_no}</span> },
    { key: "date", header: "业务日期", cell: (r) => <span className="tnum">{r.business_date}</span>, sortValue: (r) => r.business_date },
    { key: "variety", header: "品种/等级", cell: (r) => `${r.variety_name}${r.grade ? ` ${r.grade}` : ""}` },
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
        description={`${detail.code} · 建档 ${detail.created_at?.slice(0, 10) ?? ""} · 证号 ${maskIdCard(detail.id_card_no)}`}
        actions={
          <>
            {headerExtra}
            <Button size="sm" variant="outline" onClick={() => void verifyByCard()}>
              <ScanLineIcon />
              读卡核对
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
          </div>

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
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {detail.photo_attachment_id != null
                      ? "人像照片来自建档时刷的那张身份证；要换一张，到「农户与单位」编辑框里点「换一张」。"
                      : "还没有人像照片：刷一次身份证核对会自动补上，也可在编辑框里本地上传。这是选填项，不影响制单与结算。"}
                  </p>
                </div>
                <InfoGrid
                  cols={2}
                  items={[
                    { label: "档案编码", value: <span className="tnum">{detail.code}</span> },
                    { label: "身份类型", value: PARTY_TYPE[detail.party_type] },
                    { label: "证件号", value: <span className="tnum">{maskIdCard(detail.id_card_no)}</span> },
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
                        const dev =
                          tareMean01kg != null && tolerancePct > 0
                            ? Math.abs(t.tare_01kg - tareMean01kg) > Math.round((tareMean01kg * tolerancePct) / 100)
                            : false;
                        return (
                          <TableRow key={`${t.date}-${i}`} className={cn("border-b hover:bg-transparent", dev && "bg-warning-bg")}>
                            <TableCell className="tnum">{t.date}</TableCell>
                            <TableCell className="tnum text-right">{weight(t.tare_01kg)}</TableCell>
                            <TableCell>
                              {t.source === WEIGHT_SOURCE.scale.label ? (
                                <span className="text-xs text-muted-foreground">{t.source}</span>
                              ) : (
                                <ToneBadge tone="warning">{t.source}</ToneBadge>
                              )}
                            </TableCell>
                            <TableCell className="tnum text-right text-xs">
                              {tareMean01kg == null ? "—" : `${t.tare_01kg >= tareMean01kg ? "+" : "−"}${weight(Math.abs(t.tare_01kg - tareMean01kg), false)} kg`}
                              {dev && <span className="ml-1 text-warning">超容差</span>}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  <p className="text-xs text-muted-foreground">
                    近 5 次均值 {tareMean01kg == null ? "—" : weight(tareMean01kg)}，
                    比对基准来自站点参数「皮重容差比例」；超容差时磅房会要求站长授权并留痕。
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
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <SectionTitle>{title}</SectionTitle>
        {extra}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}
