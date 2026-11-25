/**
 * 出库单的作废 / 红冲 / 删除对话框（03 §9.28 状态机）。
 *
 * 三个动作走同一张表单，因为它们要问的其实是一句话：**这张单为什么不算了**。
 * 差别只在能不能做、做完留不留痕——草稿作废（不动库存）、已过账红冲（补一条对称入库流水）、
 * 没上过磅的草稿删除（行真去掉）。由调用方按当前状态决定 title/mode，
 * 这里不自己判状态机（判据只有 Rust 一份）。
 *
 * 原因是必填硬闸门（作废与红冲）：≥6 个字，与磅单作废同源。这不是"工程卫生"，是这张单将来
 * 被查时唯一能说明自己的东西——审计页只显示动作名，看得懂的那句在这条 reason 里。
 * **唯独删除是选填**（2026-11-25 定，见下面 `reasonOptional`）：删的多半是自己上一秒点开的那张
 * 空单，而且服务端那条 `outbound.delete` 快照已经把这张单当时的内容全留住了，不靠这句人话。
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

/** 三种收尾各自的措辞：动作名在标题、原因标签、按钮、回执里要一致，别一处「作废」一处「删除」 */
const TEXT = {
  void: { title: "作废出库单", reason: "作废原因", confirm: "确认作废", done: "已作废", hint: "如：领出方取消提货，本单未实际出库" },
  reverse: { title: "红冲出库单", reason: "红冲原因", confirm: "确认红冲", done: "已红冲", hint: "如：重量录入错误，已按复磅结果另开新单" },
  delete: { title: "删除出库草稿", reason: "删除原因", confirm: "确认删除", done: "已删除", hint: "选填，一句就够：如手滑多点了一张、品种选错已另开" },
} as const;

export function CloseOutboundDialog({
  open,
  onOpenChange,
  order,
  mode,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  order: OutboundOrder | null;
  /** void＝过账前作废（不动库存）；reverse＝过账后红冲（补对称入库流水）；delete＝真删没上过磅的草稿 */
  mode: "void" | "reverse" | "delete";
  /** 删除成功（含"行已不在"）后回调：页面据此把选中/路由从这张单上挪开 */
  onDone?: (no: string) => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  useEffect(() => {
    if (open) setReason("");
  }, [open, order?.order_no, mode]);

  // 常用作废事由做候选，仍可自由打字（02 §F6.3 同一套：话术由站长在基础档案里维护）
  const { options: presets } = useQuickOptions("void");
  /**
   * 删除的**原因选填**（2026-11-25 定）：磅员手滑多点一颗「新建」，清掉它就是一个动作，
   * 硬逼六个字只会逼出一句废话。留痕的下限不在这句话上，而在服务端那条 `outbound.delete`
   * 审计快照里——动作、单号、经办人、时间、这张单当时的全部内容，填不填原因都照样落。
   * 作废与红冲仍是硬闸门：那是在更正别人的账。
   */
  const reasonOptional = mode === "delete";
  const tooShort = !reasonOptional && [...reason.trim()].length < VOID_REASON_MIN;

  const run = useMutation({
    mutationFn: async () => {
      const input = { order_no: order!.order_no, reason: reason.trim(), operator_id: actorId() };
      if (mode === "delete") return api.deleteOutbound(input);
      return mode === "void" ? api.voidOutbound(input) : api.reverseOutbound(input);
    },
    onSuccess: (res) => {
      const no = order?.order_no ?? "";
      // 删除回 null＝这一行早就不在了（另一台磅机刚删掉）：不当失败，但要把队列刷出来再告诉人
      if (mode === "delete" && res === null) toast.info(`${no} 已经不在了，可能别人刚删；列表已刷新`);
      else toast.success(`${TEXT[mode].done} ${no}`);
      qc.invalidateQueries({ queryKey: ["outbound"] });
      qc.invalidateQueries({ queryKey: ["stock-balance"] });
      qc.invalidateQueries({ queryKey: ["stock-movements"] });
      if (mode === "delete") onDone?.(no);
      onOpenChange(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{TEXT[mode].title}</DialogTitle>
          <DialogDescription>
            {mode === "void" ? (
              <>
                {order?.order_no} 尚未过账，作废不动库存账。
              </>
            ) : mode === "delete" ? (
              <>
                {order?.order_no} 还是草稿。删除是把这一行<b>从出库账里真去掉</b>：
                纸上不留字、那个 CK 号也不回收，事后只剩审计里一条快照说明号为什么空着。
                上过磅的删不掉（读数和过磅抓拍是计量证据），那种请改点「作废」——留痕但仍看得见。
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
            {TEXT[mode].reason}
            {reasonOptional ? "（选填）" : `（必填，至少 ${VOID_REASON_MIN} 个字）`}
          </span>
          <ComboBox
            aria-label={TEXT[mode].reason}
            multiline
            rows={3}
            value={reason}
            onChange={setReason}
            presets={presets}
            placeholder={TEXT[mode].hint}
            invalid={reason.trim() !== "" && tooShort}
          />
          {reason.trim() !== "" && tooShort ? (
            <span className="text-xs text-destructive">还得写 {(VOID_REASON_MIN - [...reason.trim()].length)} 个字</span>
          ) : null}
          {reasonOptional ? (
            <span className="text-[11px] text-muted-foreground">
              原因可以不填，也只用填这一次；<b>删除这个动作本身一定进审计</b>——单号、经办人、时间，
              连这张单当时的性质 / 仓房 / 品种 / 领出方 / 净重一起留档，审计页据此回答「这个号为什么没了」。
            </span>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            取消
          </Button>
          <Button
            variant={mode === "void" ? "default" : "destructive"}
            disabled={tooShort || run.isPending || !order}
            onClick={() => run.mutate()}
          >
            {run.isPending ? "提交中…" : TEXT[mode].confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
