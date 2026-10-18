/**
 * 磅单定价 / 改价（02 §F1.4）。
 *
 * 价**不是结算的产物，是成交的前提**：农户到站先问价、谈成才卸货。制单那一刻服务端已经按
 * 价目表带过一次挂牌价（`orders.rs::create_order`），这个框管的是事后那两次改——
 * 化验定级之后按实际等级修正，以及现场议价。
 *
 * 为什么三个入口共用这一个框（称重区、磅单详情；结算中心走 `SettleForm` 里自己那一格）：
 * 改的都是同一列 `weigh_order.price_fen_per_ton`，判定也是同一套（偏离价目表现行价 → 真议价、可留事由）。
 * 各写一份必然分叉，而分叉出来的正是"同一张单两个价"。
 * `SettleForm` 那一格刻意不共用：那边的语义是"结算这一刻确认价"，与付款意图绑在一起、改完直接落账。
 *
 * 事由为什么**选填**：偏离价目就是一次真实议价，票面要把这个价印给客户，写了事后才翻得到"凭什么"；
 * 但磅房窗口上为一句事由卡住成交不划算，所以不拦提交（服务端 `orders.rs::set_price` 同口径，
 * 照价目执行的那一遍即便写了也清成 NULL）。
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { actorId } from "@/store/session";
import { money, price as fmtPrice, weight } from "@/lib/format";
import { lookupPrice, settlePreview } from "@/lib/settle-defaults";
import { usePrices, useQuickOptions } from "@/hooks/useLookups";
import type { QcReport, WeighOrder } from "@/mock/types";
import { ComboBox } from "@/components/business/ComboBox";
import { PriceField } from "@/components/business/NumField";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export function PriceDialog({
  open,
  onOpenChange,
  order,
  qc,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 当前单；`null` 时整框不渲染（调用方通常在没单时也不会开它） */
  order: WeighOrder | null;
  /** 化验单：等级与扣水扣杂的兜底来源，与结算框同口径（预约试算要用） */
  qc?: QcReport | null;
  onSaved?: (o: WeighOrder) => void;
}) {
  const { data: prices = [] } = usePrices();
  const queryClient = useQueryClient();
  const { options: priceOptions } = useQuickOptions("price");
  const [value, setValue] = useState<number | null>(null);
  const [reason, setReason] = useState("");

  // 等级与结算框同一口径：磅单上改判过的优先，其次化验判定（化验单本身永不改写）
  const grade = order?.grade ?? qc?.grade ?? null;
  /** 价目表现行价：偏离它就是一次真实议价（事由选填，写了才留痕） */
  const live = useMemo(
    () => (order ? lookupPrice(prices, order.variety_id, grade, order.business_date) : null),
    [prices, order, grade],
  );

  // 开框以本单现状为准：不预填一个空价，也不清掉已留过的事由（同「调整等级」「改派去向」的规矩）
  useEffect(() => {
    if (!open || !order) return;
    setValue(order.price_fen_per_ton);
    setReason(order.price_override_reason ?? "");
  }, [open, order?.order_no, order?.price_fen_per_ton, order?.price_override_reason, order]);

  const deviates = value != null && (live == null || value !== live.price_fen_per_ton);
  /** 即时试算：与结算框、票面预估值同一份公式，免得三个地方三个数 */
  const preview = order && value != null ? settlePreview({ ...order, price_fen_per_ton: value }, qc) : null;

  const save = useMutation({
    mutationFn: () =>
      api.setOrderPrice({
        order_no: order!.order_no,
        price_fen_per_ton: value!,
        // 照价目执行就记下来源；议价传 null，服务端会据此清掉并留事由（0001_init.sql:217）
        price_list_id: live != null && value === live.price_fen_per_ton ? live.id : null,
        reason: reason.trim(),
        operator_id: actorId(),
      }),
    onSuccess: (o) => {
      if (!o) {
        toast.error("定价失败：未找到该磅单");
        return;
      }
      toast.success(`本单单价已定为 ${fmtPrice(o.price_fen_per_ton)}`, {
        description: deviates ? (reason.trim() ? "已偏离价目表，事由已记录" : "已偏离价目表，未填事由") : "照价目表执行",
      });
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ["order", o.order_no] });
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      queryClient.invalidateQueries({ queryKey: ["open-orders"] });
      queryClient.invalidateQueries({ queryKey: ["audits"] });
      onSaved?.(o);
    },
    // 真库把"为什么不能改"说得很具体（单价必须大于 0 / 已结算 / 已作废 / 取价行对不上），
    // 固定文案会把原因吞掉——磅房站在窗口只看到"请重试"是最坏的结果
    onError: (e: Error) => toast.error(e.message || "定价失败，请重试"),
  });

  if (!order) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {order.price_fen_per_ton == null ? "定价" : "改价"} · {order.order_no}
          </DialogTitle>
          <DialogDescription className="text-xs">
            本单价用于出票与结算。偏离价目表现行价可写一句改价事由（选填）；已结算的单不能再改价，需站长红冲更正。
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-3">
          <PriceField
            label="本单单价"
            valueFenPerTon={value}
            onChange={setValue}
            size="sm"
            keypad
            invalid={value == null}
            hint={value == null ? "单价必须大于 0" : undefined}
          />
          <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            价目表现行价
            <span className="flex h-8 items-center justify-between gap-2 rounded border bg-muted/30 px-2 text-xs">
              <span className="tnum">{live ? fmtPrice(live.price_fen_per_ton) : "无现行价目"}</span>
              {live && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setValue(live.price_fen_per_ton)}
                  disabled={value === live.price_fen_per_ton}
                  title="填入价目表现行价"
                >
                  按此价
                </Button>
              )}
            </span>
          </Label>
        </div>

        {order.variety_id == null && (
          <p className="text-xs text-destructive">本单还没定收购品种，先定品种再定价。</p>
        )}

        {preview ? (
          <p className="tnum text-xs text-muted-foreground">
            按此价试算：结算重量 {weight(preview.settlement_weight_01kg)} × {fmtPrice(value)} = 货款 {money(preview.goods_amount_fen)}
            ，应付 {money(preview.payable_amount_fen)}。仅为预估，实际以结算确认为准。
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">填上单价后这里给出这一车的预估金额。</p>
        )}

        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span>{deviates ? "改价事由（选填，会一并记录）" : "改价事由（照价目表执行，不会记录）"}</span>
          <ComboBox
            aria-label="改价事由"
            presets={priceOptions}
            value={reason}
            onChange={setReason}
            placeholder="选一条常用的，或自己写…"
            className="h-8 text-sm"
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={save.isPending || value == null} onClick={() => save.mutate()}>
            {save.isPending ? "保存中…" : "保存定价"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
