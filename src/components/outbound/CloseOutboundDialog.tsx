/**
 * 出库单的作废 / 红冲对话框（03 §9.28 状态机）。
 *
 * 两个动作走同一张表单，因为它们要问的其实是一句话：**这张单为什么不算了**。
 * 差别只在能不能做——草稿作废（不动库存）与已过账红冲（补一条对称入库流水），
 * 由调用方按当前状态决定 title/mode，这里不自己判状态机（判据只有 Rust 一份）。
 *
 * 原因是必填硬闸门：≥6 个字，与磅单作废同源。这不是"工程卫生"，是这张单将来
 * 被查时唯一能说明自己的东西——审计页只显示动作名，看得懂的那句在这条 reason 里。
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ComboBox } from "@/components/business/ComboBox";
import { useQuickOptions } from "@/hooks/useLookups";
import { actorId } from "@/store/session";
import { VOID_REASON_MIN } from "@/lib/constants";
import type { OutboundOrder } from "@/mock/types";

export function CloseOutboundDialog({
  open,
  onOpenChange,
  order,
  mode,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  order: OutboundOrder | null;
  /** void＝过账前作废（不动库存）；reverse＝过账后红冲（补对称入库流水） */
  mode: "void" | "reverse";
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open, order?.order_no, mode]);

  // 常用作废事由做候选，仍可自由打字（02 §F6.3 同一套：话术由站长在基础档案里维护）
  const { options: presets } = useQuickOptions("void");

  const tooShort = [...reason.trim()].length < VOID_REASON_MIN;

  const run = useMutation({
    mutationFn: () => {
      const input = { order_no: order!.order_no, reason: reason.trim(), operator_id: actorId() };
      return mode === "void" ? api.voidOutbound(input) : api.reverseOutbound(input);
    },
    onSuccess: () => {
      toast.success(`${mode === "void" ? "已作废" : "已红冲"} ${order?.order_no}`);
      qc.invalidateQueries({ queryKey: ["outbound"] });
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      qc.invalidateQueries({ queryKey: ["stock-movements"] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === "void" ? "作废出库单" : "红冲出库单"}</DialogTitle>
          <DialogDescription>
            {mode === "void" ? (
              <>
                {order?.order_no} 尚未过账，作废不动库存账。
              </>
            ) : (
              <>
                {order?.order_no} 已扣减库存。红冲会把原单标记为「已红冲」并
                <b>另补一条入库流水</b>把粮记回原仓房；
                原来那条出库记录保留、不涂改。
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">
            {mode === "void" ? "作废原因" : "红冲原因"}（必填，至少 {VOID_REASON_MIN} 个字）
          </span>
          <ComboBox
            aria-label={mode === "void" ? "作废原因" : "红冲原因"}
            multiline
            rows={3}
            value={reason}
            onChange={setReason}
            presets={presets}
            placeholder={mode === "void" ? "如：领出方取消提货，本单未实际出库" : "如：重量录入错误，已按复磅结果另开新单"}
            invalid={reason.trim() !== "" && tooShort}
          />
          {reason.trim() !== "" && tooShort ? (
            <span className="text-xs text-destructive">还得写 {(VOID_REASON_MIN - [...reason.trim()].length)} 个字</span>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            取消
          </Button>
          <Button
            variant={mode === "reverse" ? "destructive" : "default"}
            disabled={tooShort || run.isPending || !order}
            onClick={() => run.mutate()}
          >
            {run.isPending ? "提交中…" : mode === "void" ? "确认作废" : "确认红冲"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
