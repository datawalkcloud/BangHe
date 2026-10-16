/**
 * 结算弹窗里的「凭票打印」区块。
 *
 * 这里原来是工作台右栏的独立面板「凭票与打印」（05 §4 ⑤）。面板撤了，出票/补打的入口
 * 收进第三刷结算弹窗：磅员在同一屏里就能补打码单、看到本单已打几张，不用再回头点右栏那一格。
 * 计价与金额预览本就由 SettleForm 承载，这里不重复。
 *
 * 真正出纸的直连/队列分流、失败回退预览仍由 WorkstationPage 的直打路径
 * （triggerPrint → printReceiptSilently）统一负责，本组件只放触发按钮与「已打几张」状态。
 * 「已打几张」依旧只认 print_log 里 result=success 的那几条：机器卡纸一次不该把下一张标成补打、
 * 在客户票面上多印一行谎话。
 */
import { useMemo } from "react";
import { PrinterIcon } from "lucide-react";
import type { WeighOrder } from "@/mock/types";
import { dateTimeShort } from "@/lib/format";
import { ToneBadge } from "@/components/business/badges";
import { Button } from "@/components/ui/button";

export function TicketPrintSection({
  order,
  onPrint,
}: {
  order: WeighOrder | null;
  /** 触发页面注册的直打路径（F9 同源）：无预览直打，失败才弹预览框 */
  onPrint: () => void;
}) {
  const prints = useMemo(
    () => (order?.prints ?? []).filter((p) => p.doc_type === "weigh_order" && p.result === "success"),
    [order?.prints],
  );
  /** 没有净重就别打——票上连重量都没有，客户拿回去也结不了钱 */
  const canPrint = !!order && order.net_weight_01kg != null;
  const lastPrintAt = prints.at(-1)?.printed_at;

  if (!order) return null;

  return (
    <div className="flex flex-col gap-1 border-t pt-2">
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs font-semibold">凭票打印</span>
        {prints.length > 0 ? (
          <ToneBadge tone="success">已打 {prints.length} 张</ToneBadge>
        ) : (
          <ToneBadge tone="warning">未打印</ToneBadge>
        )}
      </div>
      <Button size="default" onClick={onPrint} disabled={!canPrint} className="h-8 text-xs">
        <PrinterIcon />
        {prints.length > 0 ? "补打码单（F9）" : "打印码单交客户（F9）"}
      </Button>
      {!canPrint && <p className="text-xs text-warning">净重还没确定，打不出有效票据。</p>}
      {lastPrintAt && <p className="text-[10px] text-muted-foreground">最近一次出纸 {dateTimeShort(lastPrintAt)}</p>}
    </div>
  );
}
