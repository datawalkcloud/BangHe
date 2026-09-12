/**
 * 打印入口包装：把「场景 + 上下文」交给当前生效的用户模板渲染，再走 PrintPreview 的通道/纸型/留痕。
 *
 * 业务页只需关心「打哪张单、数据是什么」，模板长什么样由用户在编辑器里决定。
 * 纸型默认取模板设置，但允许在打印弹窗里临时改——改完预览和出纸尺寸同步变（所见即所得）。
 *
 * 出纸去向按通道分流，两条路物理上不是一台机器：
 *  - `raw`：ESC/POS 直连**小票机**。票面按当前模板现排（`escpos.ts`），只能吃热敏纸；
 *  - 其余（窗口预览 / PDF 静默）：走 `window.print()`，对应 A4 激光与针式套打。
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PAPER } from "@/lib/constants";
import type { PaperKind, PrintChannel } from "@/lib/constants";
import { nativePrinter, toNativePaper } from "@/lib/native";
import { PrintPreview } from "../PrintPreview";
import { receiptLines } from "./escpos";
import { PaperFrame, ReceiptDocument, docMeta } from "./render";
import { useReceiptStore, useReceiptTemplate } from "./store";
import type { ReceiptContext, ReceiptScenario } from "./types";

export function ReceiptPrintPreview({
  open,
  onOpenChange,
  scenario,
  context,
  isReprint = false,
  docNo,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  scenario: ReceiptScenario;
  context: ReceiptContext;
  isReprint?: boolean;
  /** 不传则按上下文自动推导（order_no / report_no / settle_no / pay_no / 日期） */
  docNo?: string;
}) {
  const tpl = useReceiptTemplate(scenario);
  // 站点级实测列数；null = 按纸型标称。见 store.ts 的说明
  const thermalCols = useReceiptStore((s) => s.thermalCols);
  const [paper, setPaper] = useState<PaperKind>(tpl.paper);
  // 模板换过纸型（站长刚改过）时，本次打印默认跟随
  useEffect(() => setPaper(tpl.paper), [tpl.paper]);
  const no = docNo ?? docMeta(context).docNo;

  /**
   * 「RAW 直连」把小票机接进来；其余通道仍走浏览器打印。
   * 返回 false = 没出纸，PrintPreview 据此跳过留痕（不留"已打印但纸上空白"的假账）。
   * 失败提示在这里给全，所以 PrintPreview 侧不再叠一层。
   */
  async function handlePrint(channel: PrintChannel, p: PaperKind): Promise<boolean> {
    if (channel !== "raw") {
      window.print();
      return true;
    }
    if (p !== "thermal80" && p !== "thermal58") {
      toast.error(`RAW 直连只吃热敏纸，当前是${PAPER[p]}`, {
        description: "把纸型切成 58 / 80 热敏，或改用「窗口预览」通道打 A4。",
      });
      return false;
    }
    const res = await nativePrinter.receipt(receiptLines(tpl, { ...context, reprint: isReprint }), {
      paper: toNativePaper(p),
      cols: thermalCols ?? undefined,
    });
    if (!res.available) {
      toast.error(res.error);
      return false;
    }
    const out = res.data;
    if (out?.ok) return true;
    toast.error(`小票机没有出纸：${out?.error ?? res.error ?? "未知原因"}`, {
      description: "可在「系统 → 小票模板」里用「小票机自检」分清是机器的问题还是版面的问题。",
    });
    return false;
  }

  return (
    <PrintPreview
      open={open}
      onOpenChange={onOpenChange}
      docType={scenario}
      docNo={no}
      isReprint={isReprint}
      paper={paper}
      onPaperChange={setPaper}
      onPrint={handlePrint}
    >
      <PaperFrame paper={paper}>
        <ReceiptDocument template={tpl} paperOverride={paper} context={{ ...context, reprint: isReprint }} />
      </PaperFrame>
    </PrintPreview>
  );
}
