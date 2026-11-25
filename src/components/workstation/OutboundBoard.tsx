/**
 * 磅房工作台的**出库模式**板面（02 §M11 F11.6/F11.7、05 §4）。
 *
 * 入库模式那张桌子（身份制单 / 称重 / 化验 / 抓拍）是围绕**一张流转卡推进一步**排的；
 * 出库没有卡、没有化验、没有结算窗口，单据链只有 `draft → done`（03 §9.28），
 * 所以这里不复用那张网格，而是一张两栏桌：
 *  - 左：**草稿队列**——现场手里这张纸是不是今天早上在「库存与出库」里开的，
 *    答案就在这一列；点一下即定位，扫码枪扫进来也落到同一条 `onPick` 上。
 *  - 右：选中单的摘要 + **地磅称重**（`OutboundWeighPanel`，与详情页同一块）+ 过账动作。
 *
 * 三条边界刻意与详情页一致：
 *  1. **称重不在这里判**：毛/皮采用值、复称轨迹、手录标记全在 `OutboundWeighPanel`；
 *     本组件只传当前台账的磅与切换动作，一站两磅时在称重卡头部切。
 *  2. **完成出库的判据在服务端**：按钮只按 `status === 'draft'` 与岗位权置灰，
 *     净重够不够、品种/领出方齐不齐由 `outbound::complete` 回中文短句，原样透传。
 *  3. **不让这一页改写"过账后更正"**：已过账的单只能查看/补打，改数走红冲另开一张
 *     （与详情页同一句话），所以"修改 / 完成出库"在非草稿态直接不渲染。
 */
import { AlertTriangleIcon, ArrowUpRightIcon, CheckIcon, PencilIcon, PlusIcon, PrinterIcon } from "lucide-react";
import { OUTBOUND_KIND, OUTBOUND_STATUS } from "@/lib/constants";
import { dateTime, money, orDash, price, weight } from "@/lib/format";
import { OutboundWeighPanel } from "@/components/outbound/OutboundWeighPanel";
import { ToneBadge, WeightSourceBadge } from "@/components/business/badges";
import { CallOut, EmptyState, InfoGrid } from "@/components/business/layout";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";
import type { DeviceConfig, OutboundDetail, OutboundOrder } from "@/mock/types";

/** 队列表格里那一行"称到哪一步了"的短话：出库现场只关心还有没有车要称 */
function weighingHint(row: OutboundOrder): string {
  if (row.net_weight_01kg != null) return weight(row.net_weight_01kg);
  if (row.gross_weight_01kg != null || row.tare_weight_01kg != null) return "称重中";
  return "待称重";
}

export function OutboundBoard({
  drafts,
  draftsLoading,
  selectedNo,
  doc,
  docLoading,
  canCreate,
  completing,
  printBlockedReason,
  printedCount,
  scales,
  switchingScale,
  captureCams,
  anyCamOnline,
  onSelectScale,
  onPick,
  onNew,
  onEdit,
  onComplete,
  onPrint,
  onDetail,
}: {
  drafts: OutboundOrder[];
  draftsLoading: boolean;
  selectedNo: string | null;
  doc: OutboundDetail | null;
  docLoading: boolean;
  canCreate: boolean;
  completing: boolean;
  /** null＝可以打；否则就是按钮上悬停要说的那句"为什么灰"（05 §5） */
  printBlockedReason: string | null;
  printedCount: number;
  scales: DeviceConfig[];
  switchingScale: boolean;
  /** 勾了「过磅抓拍」的相机（与磅单侧同源）；过磅时前端为它们就地取帧 */
  captureCams: DeviceConfig[];
  anyCamOnline: boolean;
  onSelectScale: (code: string) => void;
  onPick: (no: string) => void;
  onNew: () => void;
  onEdit: () => void;
  onComplete: () => void;
  onPrint: () => void;
  onDetail: () => void;
}) {
  const draft = doc?.status === "draft";
  const closed = doc != null && doc.status !== "draft";

  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 px-3 py-2 xl:grid-cols-[minmax(270px,20rem)_minmax(0,1fr)]">
      {/* ── 左：草稿队列 ───────────────────────────────────────────── */}
      <Card size="sm" className="flex min-h-0 flex-col py-0">
        <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center px-2.5">
          <CardTitle className="text-xs font-semibold">出库草稿（{drafts.length}）</CardTitle>
          <CardAction className="self-center">
            <Button size="xs" variant="ghost" disabled={!canCreate} onClick={onNew}>
              <PlusIcon />
              新建
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 overflow-y-auto p-0">
          {draftsLoading ? (
            <div className="flex flex-col gap-1.5 p-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : drafts.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              暂无可称重的草稿出库单。
              <br />
              点「新建」现开一张，或到「库存与出库」制单。
            </p>
          ) : (
            <ul className="flex flex-col">
              {drafts.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => onPick(row.order_no)}
                    className={cn(
                      "w-full border-l-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/60",
                      row.order_no === selectedNo ? "border-primary bg-primary/5" : "border-transparent",
                    )}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="tnum text-sm font-medium">{row.order_no}</span>
                      <span className={cn("tnum text-xs", row.net_weight_01kg == null ? "text-muted-foreground" : "font-medium")}>
                        {weighingHint(row)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                      {orDash(row.party_name ?? row.counterparty_label)} · {orDash(row.variety_name)}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {OUTBOUND_KIND[row.kind].label} · {row.warehouse_name}
                      {row.slot_label ? ` / ${row.slot_label}` : ""}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── 右：选中单的摘要 + 称重 + 动作 ─────────────────────────── */}
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
        {docLoading ? (
          <Skeleton className="h-40" />
        ) : !selectedNo ? (
          <div className="flex min-h-[240px] flex-1 items-center justify-center border border-dashed px-4">
            <EmptyState
              title="选一张出库草稿开始称重"
              description="在左边队列点一张，或用扫码枪扫出库码单；手上没有这张纸就点「新建出库单」现开一张。"
              action={
                <Button size="sm" disabled={!canCreate} onClick={onNew}>
                  <PlusIcon />
                  新建出库单
                </Button>
              }
            />
          </div>
        ) : !doc ? (
          <div className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-2 border border-dashed px-4 text-center">
            <p className="text-sm font-medium">读不到出库单 {selectedNo}</p>
            <p className="text-xs text-muted-foreground">它可能已在别的电脑上作废，或这张单不属于本站。到「库存与出库」按单号查一下。</p>
          </div>
        ) : (
          <>
            <Card size="sm" className="py-0">
              <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center px-3">
                <CardTitle className="text-sm font-semibold">
                  出库单 <span className="tnum">{doc.order_no}</span>
                </CardTitle>
                <CardAction className="self-center">
                  <ToneBadge tone={OUTBOUND_STATUS[doc.status].tone}>{OUTBOUND_STATUS[doc.status].label}</ToneBadge>
                </CardAction>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 p-3">
                <InfoGrid
                  cols={3}
                  items={[
                    { label: "出库性质", value: OUTBOUND_KIND[doc.kind].label },
                    { label: "业务日期", value: <span className="tnum">{doc.business_date}</span> },
                    { label: "领出方", value: orDash(doc.party_name ?? doc.counterparty_label) },
                    { label: "品种 / 等级", value: `${orDash(doc.variety_name)}${doc.grade ? ` · ${doc.grade}` : ""}` },
                    { label: "出仓仓房", value: orDash(doc.slot_label ? `${doc.warehouse_name} / ${doc.slot_label}` : doc.warehouse_name) },
                    { label: "车牌", value: <span className="tnum">{orDash(doc.vehicle_no)}</span> },
                    { label: "司机", value: orDash(doc.driver_name) },
                    { label: "单价", value: <span className="tnum">{price(doc.price_fen_per_ton)}</span> },
                    { label: "出库净重", value: <span className="tnum font-medium">{doc.net_weight_01kg == null ? "—" : weight(doc.net_weight_01kg)}</span> },
                    { label: "货款", value: <span className="tnum font-medium">{doc.goods_amount_fen == null ? "—" : money(doc.goods_amount_fen)}</span> },
                    { label: "重量来源", value: <WeightSourceBadge source={doc.weight_source} /> },
                  ]}
                />
                <div className="flex flex-wrap items-center gap-2 border-t pt-2">
                  {draft ? (
                    <>
                      <Button
                        size="sm"
                        disabled={!canCreate || completing}
                        title={!canCreate ? "完成出库需要值仓 / 站长 / 磅员 / 登记员岗位" : undefined}
                        onClick={onComplete}
                      >
                        <CheckIcon />
                        {completing ? "过账中…" : "完成出库"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!canCreate}
                        title={!canCreate ? "修改出库单需要值仓 / 站长 / 磅员 / 登记员岗位" : undefined}
                        onClick={onEdit}
                      >
                        <PencilIcon />
                        修改
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {doc.status === "done"
                        ? `已于 ${dateTime(doc.completed_at ?? doc.updated_at)} 完成出库；要更正请到详情页红冲后另开一张。`
                        : `本单${OUTBOUND_STATUS[doc.status].label}${doc.void_reason ? `：${doc.void_reason}` : ""}，不能再称重或过账。`}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={printBlockedReason != null}
                    title={printBlockedReason ?? undefined}
                    onClick={onPrint}
                  >
                    <PrinterIcon />
                    {printedCount > 0 ? `补打码单（已打 ${printedCount} 张）` : "打印码单"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={onDetail}>
                    <ArrowUpRightIcon />
                    单据详情
                  </Button>
                </div>
              </CardContent>
            </Card>

            {doc.stock_warning ? (
              <CallOut tone="warning" title="出库时账面结存不足" icon={<AlertTriangleIcon className="size-4" />}>
                {doc.stock_warning}
                <span className="mt-1 block text-xs text-muted-foreground">出库已照常放行，请与库存账核对。</span>
              </CallOut>
            ) : null}
            {closed ? (
              <CallOut tone={doc.status === "voided" || doc.status === "reversed" ? "warning" : "info"} title={`本单${OUTBOUND_STATUS[doc.status].label}`}>
                {doc.status === "done"
                  ? `库存已扣减，不能再改数；要更正只能红冲后另开一张。`
                  : orDash(doc.void_reason)}
              </CallOut>
            ) : null}

            <OutboundWeighPanel
              order={doc}
              scales={scales}
              onSelectScale={onSelectScale}
              switchingScale={switchingScale}
              captureCams={captureCams}
              anyCamOnline={anyCamOnline}
            />
          </>
        )}
      </div>
    </div>
  );
}