/**
 * 出库模式左边那一列**草稿队列**（05 §4）。
 *
 * 现场要回答的问题只有一个：手里这张纸是不是今天早上在「库存与出库」里开的那张。
 * 所以每行给到「单号 + 称到哪一步 + 领出方/品种 + 性质/仓房」就够，点一下即定位；
 * 扫码枪扫旧码单上的码、或直接输单号，走的也是同一个选中口径（`WorkstationPage::handleOutboundScan`）。
 *
 * 队列只列 `status='draft'`：已过账的单不能再称重，留着只会让人点了才发现。
 */
import { PlusIcon, Trash2Icon } from "lucide-react";
import { OUTBOUND_KIND } from "@/lib/constants";
import { orDash, weight } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "cn";
import type { OutboundOrder } from "@/mock/types";

/** 队列表格里那一行"称到哪一步了"的短话：出库现场只关心还有没有车要称 */
function weighingHint(row: OutboundOrder): string {
  if (row.net_weight_01kg != null) return weight(row.net_weight_01kg);
  if (row.gross_weight_01kg != null || row.tare_weight_01kg != null) return "称重中";
  return "待称重";
}

export function OutboundDraftsPanel({
  drafts,
  loading,
  selectedNo,
  isNew,
  canCreate,
  onPick,
  onNew,
  onDelete,
}: {
  drafts: OutboundOrder[];
  loading: boolean;
  selectedNo: string | null;
  /** 新建态：此刻没有一张单被选中，队列整列都不高亮，「新建」那颗压成按下样子 */
  isNew: boolean;
  canCreate: boolean;
  onPick: (no: string) => void;
  onNew: () => void;
  /**
   * 点行尾那只垃圾桶：把**这一行**交给页面的删除确认框（不必先选中，整列都能一键删）。
   * 权限与制单同岗——删自己刚开的空单是 `outbound.create`，更正别人的账才要更重的 `outbound.void`。
   */
  onDelete?: (row: OutboundOrder) => void;
}) {
  return (
    <Card size="sm" className="flex min-h-0 flex-col py-0">
      <CardHeader className="card-header-compact grid-cols-[1fr_auto] items-center px-2.5">
        <CardTitle className="text-xs font-semibold">出库草稿（{drafts.length}）</CardTitle>
        <CardAction className="self-center">
          <Button size="xs" variant={isNew ? "secondary" : "ghost"} disabled={!canCreate} onClick={onNew}>
            <PlusIcon />
            新建
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-y-auto p-0">
        {loading ? (
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
            {drafts.map((row) => {
              const selected = !isNew && row.order_no === selectedNo;
              return (
                <li key={row.id} className="group relative flex items-stretch">
                  <button
                    type="button"
                    onClick={() => onPick(row.order_no)}
                    className={cn(
                      "min-w-0 flex-1 border-l-2 px-2.5 py-2 text-left transition-colors hover:bg-muted/60",
                      selected ? "border-primary bg-primary/5" : "border-transparent",
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
                  {/*
                    行尾那颗垃圾桶：宽度常驻（一出现就把单号挤歪是不可接受的抖动），
                    图标悬停即出、整列都能一键删——开错号的不止当前这张。
                    键盘走得到（focus 时也显形），平时队列干净。
                  */}
                  <span className="flex w-6 shrink-0 items-center justify-center">
                    {canCreate && onDelete && (
                      <Button
                        size="xs"
                        variant="ghost"
                        className="size-5 shrink-0 rounded-md p-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
                        title={`删除草稿 ${row.order_no}：只删没上过磅的，删掉就没了`}
                        onClick={() => onDelete(row)}
                      >
                        <Trash2Icon className="size-3.5" />
                        <span className="sr-only">删除</span>
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
