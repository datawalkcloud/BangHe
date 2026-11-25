/**
 * 出库模式那一格**就地编辑**的出库单（05 §4，替代从前的 `OutboundFormDialog` 弹窗）。
 *
 * 现场节奏决定的两件事：磅员一手票据一手鼠标，弹窗会把常驻的过磅画面顶掉；而出库单确实要
 * 在车上了磅之后再补车牌、改单价。所以这里不弹窗、不等「保存」——**改完就存**，
 * 存完把这一行同步回左边的草稿队列与称重面板。
 *
 * 四条纪律：
 *  1. **取号只在填齐必填之后**：新建态不凭空占号（`next_no` 是消耗品，作废也不复用），
 *     填齐「出仓仓房 / 品种 / 领出方」才发第一次 `saveOutbound`，由服务端当场取 CK 号。
 *     在那之前人改的只是屏幕上的一份草稿，点「放弃新建」即丢。
 *  2. **回读只跟没改动的表单**：捕完一称重，服务端写的净重要立刻显示在这一格；而人正敲到
 *     一半的数字绝不能被一次 refetch 洗掉。判据是本地草稿指纹与已落库指纹是否一致。
 *  3. **上过磅的单不给手改净重**（0029）：毛/皮任一非空即只读，改重量走称重那块；
 *     后端 `outbound.rs::save` 那句拒绝是同一件事的硬闸门。
 *  4. **保存结果要看得见**：状态条显示服务端原话（`validate_save` 回的都是人话），
 *     不静默重试也不假装存上；那格再改一下即自动重发。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, CheckIcon, PrinterIcon, XIcon } from "lucide-react";
import { api } from "@/lib/api";
import { GRADES, OUTBOUND_KIND, OUTBOUND_STATUS, PARTY_TYPE, type OutboundKind } from "@/lib/constants";
import { money, orDash, price, time, ton, weight } from "@/lib/format";
import {
  EMPTY_OUTBOUND_DRAFT,
  missingOutboundFields,
  outboundDraftOf,
  outboundGoodsFen,
  outboundNumbers,
  outboundSaveInput,
  outboundWeighed,
  type OutboundDraft,
} from "@/lib/outbound-form";
import { useSlots, useVarieties, useWarehouses } from "@/hooks/useLookups";
import { actorId } from "@/store/session";
import { Choose } from "@/components/business/Choose";
import { NewPartyButton } from "@/components/outbound/NewPartyButton";
import { CallOut, InfoGrid } from "@/components/business/layout";
import { ToneBadge, WeightSourceBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";
import type { OutboundDetail, OutboundOrder, OutboundSaveInput } from "@/mock/types";

/** 停手多久之后落库。太短等于一个字一条审计记录，太长配不上"随即生效"这句话 */
const AUTO_SAVE_MS = 800;

export function OutboundFormPanel({
  doc,
  selectedNo,
  isNew,
  canEdit,
  completing,
  printBlockedReason,
  printedCount,
  onCreated,
  onCancelNew,
  onComplete,
  onPrint,
  onDetail,
}: {
  doc: OutboundDetail | null;
  /** 页面当前选中的单号（null＝没选）；「新建」态由 `isNew` 表示 */
  selectedNo: string | null;
  isNew: boolean;
  canEdit: boolean;
  completing: boolean;
  /** null＝可以打；否则就是按钮上悬停要说的那句"为什么灰"（05 §5） */
  printBlockedReason: string | null;
  printedCount: number;
  /** 新建那张第一次落库、拿到号之后交回页面选中它：队列与称重随即跟到这张单 */
  onCreated: (row: OutboundOrder) => void;
  onCancelNew: () => void;
  onComplete: () => void;
  onPrint: () => void;
  onDetail: () => void;
}) {
  const qc = useQueryClient();
  const { data: varieties = [] } = useVarieties();
  const { data: warehouses = [] } = useWarehouses();
  const { data: slots = [] } = useSlots();
  /**
   * 领出方候选：与弹窗那份同口径——**不限类型**，别传 `"all"` 之类的界面兜底值，
   * 真库侧会拿它去比对 `party_type`，查出来就是一张空表。
   */
  const partiesQ = useQuery({ queryKey: ["parties", "outbound"], queryFn: () => api.listParties("") });
  const parties = useMemo(() => (partiesQ.data ?? []).filter((p) => p.status === "active"), [partiesQ.data]);
  const activeWh = useMemo(() => warehouses.filter((w) => w.is_active === 1), [warehouses]);

  const [d, setD] = useState<OutboundDraft>(EMPTY_OUTBOUND_DRAFT);
  /** 这份本地草稿对应库里哪张单（null＝还没落库的新单）：换单、新建、清空都从它判 */
  const [boundNo, setBoundNo] = useState<string | null>(null);
  /** 已经落库的那份草稿指纹：与当前指纹不等就是"有改动没存上" */
  const [savedFp, setSavedFp] = useState("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 已发出、正等服务端回读的指纹；发失败的指纹（不拿同一个值反复撞后端） */
  const submitted = useRef<string | null>(null);
  const failedFp = useRef<string | null>(null);
  const mutateRef = useRef<(v: { fp: string; input: OutboundSaveInput }) => void>(() => undefined);

  const patch = useCallback((p: Partial<OutboundDraft>) => setD((v) => ({ ...v, ...p })), []);
  const loadFrom = useCallback((o: OutboundOrder | null, keepReceipt = false) => {
    const next = outboundDraftOf(o);
    setD(next);
    setSavedFp(JSON.stringify(next));
    setBoundNo(o?.order_no ?? null);
    submitted.current = null;
    failedFp.current = null;
    if (!keepReceipt) {
      setErr(null);
      setSavedAt(null);
    }
  }, []);

  const isDraft = isNew || doc?.status === "draft";
  const editable = canEdit && isDraft;
  /**
   * 队列里一张都没点中：整张空表照样铺出来，但**全部灰着**（`locked`）。
   * 从前这里只给两句提示，磅员要先点「新建」才看见字段，等于把"这张单要填什么"藏起来；
   * 与③称重区同一副样子——常驻的那格先看得到内容，取号之前只是不能敲。
   * 灰表也**不会自动落库**：`savable` 要 `editable`，`locked` 时 `doc` 为空即不成立。
   */
  const locked = !isNew && selectedNo == null;
  const showFields = locked || editable;
  const fp = JSON.stringify(d);
  const dirty = fp !== savedFp;

  /* ── 表单跟着页面的选择走：换单整份重来，同一张单的回读只在本地没改动时跟随 ── */
  useEffect(() => {
    if (isNew) {
      if (boundNo !== null) loadFrom(null);
      return;
    }
    if (selectedNo == null) {
      if (boundNo !== null) loadFrom(null);
      return;
    }
    if (!doc) return; // 读取中：先留着上一份，别闪一张空白表
    if (doc.order_no !== boundNo) {
      loadFrom(doc);
      return;
    }
    if (!dirty || submitted.current === fp) loadFrom(doc, true);
  }, [isNew, selectedNo, doc, boundNo, dirty, fp, loadFrom]);

  const missing = missingOutboundFields(d);
  const nums = outboundNumbers(d);
  /** 只有这一份能过后端 `validate_save` 的必填集时才发请求：灰着的表单不该往库里写垃圾 */
  const savable =
    editable &&
    missing.length === 0 &&
    nums.bad == null &&
    boundNo === (isNew ? null : selectedNo) &&
    (!isNew || selectedNo == null);

  const save = useMutation({
    mutationFn: (arg: { fp: string; input: OutboundSaveInput }) => api.saveOutbound(arg.input).then((row) => ({ row, fp: arg.fp })),
    onSuccess: ({ row, fp: done }) => {
      setSavedFp(done);
      setSavedAt(new Date().toISOString());
      setErr(null);
      submitted.current = null;
      failedFp.current = null;
      // 草稿队列（含这一单的领出方/品种/重量）与当前单都要跟上新数字
      void qc.invalidateQueries({ queryKey: ["outbound"] });
      if (boundNo == null) {
        setBoundNo(row.order_no);
        onCreated(row);
      }
    },
    // 服务端原因原样上屏：Rust 回的都是"登记出库不计价，单价请留空"这种人话
    onError: (e: Error, arg) => {
      failedFp.current = arg.fp;
      submitted.current = null;
      setErr(e.message);
    },
  });
  mutateRef.current = save.mutate;

  /* ── 改完就存：停手 AUTO_SAVE_MS 落一次，同一次改动只发一趟 ── */
  useEffect(() => {
    if (!savable || !dirty || failedFp.current === fp) return;
    const t = setTimeout(() => {
      if (submitted.current === fp) return;
      submitted.current = fp;
      mutateRef.current({ fp, input: outboundSaveInput(d, boundNo, actorId()) });
    }, AUTO_SAVE_MS);
    return () => clearTimeout(t);
  }, [savable, dirty, fp, d, boundNo]);

  const goods = outboundGoodsFen(d);
  const whId = Number(d.warehouse_id) || null;
  const varId = Number(d.variety_id) || null;
  const balanceQ = useQuery({ queryKey: ["stock-balance"], queryFn: () => api.stockBalance(), enabled: whId != null && varId != null });
  const cell = useMemo(() => {
    if (whId == null || varId == null) return null;
    return (balanceQ.data ?? []).find((b) => b.warehouse_id === whId && b.variety_id === varId) ?? null;
  }, [balanceQ.data, whId, varId]);

  /* ── 状态回执：这一格现在到底是"改了没存"还是"已经进库" ── */
  const chip = !canEdit
    ? { text: "只读（无出库制单岗权）", cls: "text-muted-foreground" }
    : locked
      ? { text: "未选单", cls: "text-muted-foreground" }
      : doc && doc.status !== "draft"
      ? { text: `只读（${OUTBOUND_STATUS[doc.status].label}）`, cls: "text-muted-foreground" }
      : err
        ? { text: "没存上", cls: "text-destructive" }
        : save.isPending || submitted.current === fp
          ? { text: "保存中…", cls: "text-primary" }
          : dirty
            ? { text: savable ? "待保存…" : `还差：${nums.bad ?? missing.join("、")}`, cls: "text-muted-foreground" }
            : savedAt
              ? { text: `已保存 ${time(savedAt)}`, cls: "text-primary" }
              : isNew
                ? { text: "填齐必填即取号", cls: "text-muted-foreground" }
                : { text: "与库中一致", cls: "text-muted-foreground" };

  return (
    <Card size="sm" className="flex min-h-0 flex-col py-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center px-2.5">
        <CardTitle className="flex min-w-0 items-center gap-1.5 text-xs font-semibold">
          <span className="shrink-0">{isNew ? "新建出库单" : "出库单"}</span>
          {!isNew && <span className="tnum truncate">{doc?.order_no ?? selectedNo ?? "（未选）"}</span>}
          {doc && !isNew && <ToneBadge tone={OUTBOUND_STATUS[doc.status].tone}>{OUTBOUND_STATUS[doc.status].label}</ToneBadge>}
        </CardTitle>
        <CardAction className={cn("text-[11px] font-normal", chip.cls)}>{chip.text}</CardAction>
      </CardHeader>

      <CardContent className="min-h-0 flex-1 overflow-y-auto p-2.5">
        {!showFields && !isNew && !doc ? (
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
            <Skeleton className="h-7" />
          </div>
        ) : !showFields ? (
          doc ? (
            <ReadOnly doc={doc} />
          ) : (
            <p className="py-2 text-xs text-muted-foreground">
              新建出库单需要值仓 / 站长 / 磅员 / 登记员岗位。当前账号只能查看与补打。
            </p>
          )
        ) : (
          <div className="flex flex-col gap-1.5">
            <Row label="出库性质">
              <Choose
                aria-label="出库性质"
                size="sm"
                disabled={locked}
                value={d.kind}
                onChange={(v) => {
                  const kind = v as OutboundKind;
                  // 切到登记出库就清掉单价：留着数字只会让「完成出库」被后端打回
                  patch(kind === "record" ? { kind, price_yuan_kg: "" } : { kind });
                }}
                options={(Object.keys(OUTBOUND_KIND) as OutboundKind[]).map((k) => ({ value: k, label: OUTBOUND_KIND[k].label }))}
              />
            </Row>
            <Row label="业务日期">
              <DatePicker aria-label="业务日期" disabled={locked} value={d.business_date} onChange={(v) => patch({ business_date: v })} className="h-7 min-w-0 text-xs" />
            </Row>
            <Row label="领出方">
              <Choose
                aria-label="领出方"
                size="sm"
                disabled={locked}
                className="w-auto min-w-0 flex-1"
                value={d.party_id}
                onChange={(v) => patch({ party_id: v })}
                options={[
                  {
                    value: "",
                    // 空表要说清是"还没加载"还是"真没有"，不然现场只当是卡住了
                    label: partiesQ.isPending
                      ? "档案加载中…"
                      : parties.length === 0
                        ? "暂无档案（点旁边「建档」现建一张）"
                        : d.kind === "sale"
                          ? "请选择（必填）"
                          : "不挂档案",
                  },
                  ...parties.map((p) => ({
                    value: String(p.id),
                    label: `${p.name}（${p.party_type === "farmer" || p.party_type === "large_grower" ? "个人" : PARTY_TYPE[p.party_type]}）`,
                  })),
                ]}
              />
              {/* 就地建档：新领出方不必先跑「农户单位」页建一张再回来搜（02 §F1.1 同一口径） */}
              <NewPartyButton parties={parties} onPicked={(p) => patch({ party_id: String(p.id) })} disabled={locked} />
            </Row>
            <Row label="领用方">
              <Input
                aria-label="领用方 / 用途对象"
                disabled={locked}
                className="h-7 min-w-0 text-xs"
                value={d.counterparty_label}
                onChange={(e) => patch({ counterparty_label: e.target.value })}
                placeholder={d.kind === "sale" ? "可不填；销售以档案为准" : "如：饲养组、职工食堂"}
              />
            </Row>
            <Row label="品种">
              <Choose
                aria-label="品种"
                size="sm"
                disabled={locked}
                invalid={!locked && d.variety_id === ""}
                value={d.variety_id}
                onChange={(v) => patch({ variety_id: v })}
                options={[
                  { value: "", label: "请选择（必填）" },
                  ...varieties.filter((v) => v.is_active === 1).map((v) => ({ value: String(v.id), label: v.name })),
                ]}
              />
            </Row>
            <Row label="等级">
              <Choose
                aria-label="等级"
                size="sm"
                disabled={locked}
                value={d.grade}
                onChange={(v) => patch({ grade: v })}
                options={[{ value: "", label: "未定级" }, ...GRADES.map((g) => ({ value: g, label: g }))]}
              />
            </Row>
            <Row label="出仓仓房">
              <Choose
                aria-label="出仓仓房"
                size="sm"
                disabled={locked}
                invalid={!locked && d.warehouse_id === ""}
                value={d.warehouse_id}
                onChange={(v) => patch({ warehouse_id: v, slot_id: "" })}
                options={[
                  { value: "", label: "请选择（必填）" },
                  ...activeWh.map((w) => ({ value: String(w.id), label: `${w.code} ${w.name}` })),
                ]}
              />
            </Row>
            <Row label="货位">
              <Choose
                aria-label="货位"
                size="sm"
                value={d.slot_id}
                disabled={locked || whId == null}
                onChange={(v) => patch({ slot_id: v })}
                options={[
                  { value: "", label: whId == null ? "先选仓房" : "不指定" },
                  ...slots.filter((s) => s.warehouse_id === whId && s.is_active === 1).map((s) => ({ value: String(s.id), label: s.label })),
                ]}
              />
            </Row>
            <Row label="净重 kg">
              {outboundWeighed(doc) ? (
                <span className="tnum flex min-w-0 items-center gap-1 text-xs font-medium" title="已过地磅：净重由毛重减皮重得出，要改请到称重那块">
                  {doc?.net_weight_01kg == null ? "—" : weight(doc.net_weight_01kg)}
                  <span className="tnum text-[10px] font-normal text-muted-foreground">
                    毛 {doc?.gross_weight_01kg == null ? "—" : weight(doc.gross_weight_01kg)} − 皮{" "}
                    {doc?.tare_weight_01kg == null ? "—" : weight(doc.tare_weight_01kg)}
                  </span>
                </span>
              ) : (
                <Input
                  aria-label="出库净重（kg）"
                  disabled={locked}
                  inputMode="decimal"
                  className="tnum h-7 min-w-0 text-xs"
                  value={d.net_kg}
                  onChange={(e) => patch({ net_kg: e.target.value })}
                  placeholder="如 12500"
                />
              )}
            </Row>
            <Row label="单价 元/kg">
              <Input
                aria-label="单价（元/公斤）"
                inputMode="decimal"
                className="tnum h-7 min-w-0 text-xs"
                disabled={locked || d.kind !== "sale"}
                value={d.price_yuan_kg}
                onChange={(e) => patch({ price_yuan_kg: e.target.value })}
                placeholder={d.kind === "sale" ? "如 2.60" : "登记出库不计价"}
              />
            </Row>
            <Row label="车牌">
              <Input
                aria-label="车牌"
                disabled={locked}
                className="tnum h-7 min-w-0 text-xs"
                value={d.vehicle_no}
                onChange={(e) => patch({ vehicle_no: e.target.value })}
                placeholder="如 豫PA1234"
              />
            </Row>
            <Row label="司机">
              <Input
                aria-label="司机名"
                disabled={locked}
                className="h-7 min-w-0 text-xs"
                value={d.driver_name}
                onChange={(e) => patch({ driver_name: e.target.value })}
                placeholder="如 张师傅"
              />
            </Row>
            <Row label="备注">
              <Input
                aria-label="备注"
                disabled={locked}
                className="h-7 min-w-0 text-xs"
                value={d.remark}
                onChange={(e) => patch({ remark: e.target.value })}
                placeholder="出库依据、审批人、用途说明等"
              />
            </Row>

            <p className="pt-0.5 text-[11px] text-muted-foreground">
              {d.kind === "sale" ? <>货款试算 <span className="tnum text-foreground">{goods == null ? "—" : money(goods)}</span> · </> : null}
              {cell ? (
                <>
                  账面结存 {ton(cell.balance_01kg)}
                  {cell.balance_01kg < (nums.net01 ?? 0) ? <span className="text-warning">（不够出，仍可完成）</span> : null}
                </>
              ) : (
                "选定仓房与品种后可看账面结存"
              )}
            </p>

            {err ? (
              <CallOut tone="danger" title="这一版改动没能保存">
                {err}
                <span className="mt-0.5 block text-[11px] text-muted-foreground">改一下那一格会自动重试；库里的单据仍是上一次存上的内容。</span>
              </CallOut>
            ) : null}
            {doc?.stock_warning ? (
              <CallOut tone="warning" title="出库时账面结存不足" icon={<AlertTriangleIcon className="size-4" />}>
                {doc.stock_warning}
                <span className="mt-1 block text-xs text-muted-foreground">出库已照常放行，请与库存账核对。</span>
              </CallOut>
            ) : null}
          </div>
        )}
      </CardContent>

      {(doc || isNew) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t px-2.5 py-2">
          {isNew ? (
            <>
              <span className="text-[11px] text-muted-foreground">
                {savable ? "正在取号…" : "填齐出仓仓房、品种、领出方即自动取号成单"}
              </span>
              <Button size="xs" variant="ghost" className="ml-auto" disabled={save.isPending} onClick={onCancelNew}>
                <XIcon />
                放弃新建
              </Button>
            </>
          ) : (
            <>
              {doc?.status === "draft" && canEdit ? (
                <Button size="sm" disabled={completing || save.isPending} onClick={onComplete}>
                  <CheckIcon />
                  {completing ? "过账中…" : "完成出库"}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={printBlockedReason != null} title={printBlockedReason ?? undefined} onClick={onPrint}>
                <PrinterIcon />
                {printedCount > 0 ? `补打出库磅单（已打 ${printedCount} 张）` : "打印出库磅单"}
              </Button>
              <Button size="sm" variant="ghost" onClick={onDetail}>
                单据详情
              </Button>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

/** 一行一个字段：标签固定宽度、控件吃满剩下的，窄格里也能一眼扫完 */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-[4.5rem] shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
    </div>
  );
}

/** 无岗权 / 已过账：退回只读摘要，摆一个点了会报错的输入框才是骗人 */
function ReadOnly({ doc }: { doc: OutboundDetail | null }) {
  if (!doc) return null;
  return (
    <div className="flex flex-col gap-2">
      <InfoGrid
        cols={2}
        items={[
          { label: "出库性质", value: OUTBOUND_KIND[doc.kind].label },
          { label: "业务日期", value: <span className="tnum">{doc.business_date}</span> },
          { label: "领出方", value: orDash(doc.party_name ?? doc.counterparty_label) },
          { label: "品种 / 等级", value: `${orDash(doc.variety_name)}${doc.grade ? ` · ${doc.grade}` : ""}` },
          { label: "出仓仓房", value: orDash(doc.slot_label ? `${doc.warehouse_name} / ${doc.slot_label}` : doc.warehouse_name) },
          { label: "车牌 / 司机", value: <span className="tnum">{`${orDash(doc.vehicle_no)}${doc.driver_name ? ` · ${doc.driver_name}` : ""}`}</span> },
          { label: "单价", value: <span className="tnum">{price(doc.price_fen_per_ton)}</span> },
          { label: "出库净重", value: <span className="tnum font-medium">{doc.net_weight_01kg == null ? "—" : weight(doc.net_weight_01kg)}</span> },
          { label: "货款", value: <span className="tnum font-medium">{doc.goods_amount_fen == null ? "—" : money(doc.goods_amount_fen)}</span> },
          { label: "重量来源", value: <WeightSourceBadge source={doc.weight_source} /> },
          { label: "备注", value: orDash(doc.remark) },
        ]}
      />
      <p className="text-[11px] text-muted-foreground">
        {doc.status === "done"
          ? "已过账：库存已扣减，要更正只能到详情页红冲后另开一张。"
          : doc.status === "draft"
            ? "这张草稿要改数得由值仓 / 站长 / 磅员 / 登记员动手：当前岗位只能看与补打。"
            : `本单${OUTBOUND_STATUS[doc.status].label}${doc.void_reason ? `：${doc.void_reason}` : ""}。`}
      </p>
    </div>
  );
}
