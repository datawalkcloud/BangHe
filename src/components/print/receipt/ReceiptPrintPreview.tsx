/**
 * 打印入口包装：把「场景 + 上下文」交给当前生效的用户模板渲染，再走 PrintPreview 的通道/纸型/留痕。
 *
 * 业务页只需关心「打哪张单、数据是什么」，模板长什么样由用户在编辑器里决定。
 * 纸型默认取**设备中心默认那台打印机登记的纸**（没登记任何打印机时取该场景出厂那张），弹窗里可以临时换，
 * 但候选只有台账里在用的机器装得下的那几种（与「系统 → 打印模板」顶部标签页同一份判据）。
 * 换的不只是尺寸：模板按 (场景, 纸型) 存，换纸型就换那张纸的版式，预览和出纸跟着同一份走（所见即所得）。
 *
 * 这个框现在是非小票机（A4 激光 / 241 针式）**打票的常规去处**：`silent.ts` 只让热敏直连机
 * 当场出纸，其余一律回到这里（issue #4）。三条通道各走各的：
 *  - `preview`（窗口预览）：走 `printPage.ts` 的离屏 iframe 通道，把预览里那张纸原样送进
 *    打印文档——改纸型 / 改版式后预览怎么变，纸上就怎么变；
 *  - `pdf_silent`（静默直打）：Rust 用 GDI 把同一份行序列画到打印机 DC 提交假脱机，
 *    纸型、托盘、方向一概不传，以打印机自身配置为准（连续纸、预印纸要的是这一条）；
 *  - `raw`：ESC/POS 直连**小票机**，票面按当前模板现排（`escpos.ts`），只能吃热敏纸。
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PAPER } from "@/lib/constants";
import type { PaperKind, PrintChannel } from "@/lib/constants";
import type { DeviceConfig } from "@/mock/types";
import { nativePrinter, toNativePaper } from "@/lib/native";
import { PrintPreview } from "../PrintPreview";
import { printJob } from "../printPage";
import { receiptLines } from "./escpos";
import { defaultTemplate } from "./defaults";
import { PaperFrame, ReceiptDocument, docMeta } from "./render";
import { activePaper, resolveDirectTarget, supportedPapers } from "./silent";
import { PAPER_SPEC } from "./paper";
import { useReceiptStore, useReceiptTemplate } from "./store";
import type { ReceiptContext, ReceiptScenario } from "./types";

export function ReceiptPrintPreview({
  open,
  onOpenChange,
  scenario,
  context,
  isReprint = false,
  docNo,
  devices = [],
  onPrinted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  scenario: ReceiptScenario;
  context: ReceiptContext;
  isReprint?: boolean;
  /** 不传则按上下文自动推导（order_no / report_no / settle_no / pay_no / 日期） */
  docNo?: string;
  /** 设备台账：「静默直打」那条通道要从这里认那台队列机的真实队列名 */
  devices?: DeviceConfig[];
  /** 出纸并留痕成功后回调，调用方用它刷新"这张票打过几次" */
  onPrinted?: () => void;
}) {
  // 用哪张纸由台账里默认那台打印机决定；一台都没登记（浏览器演示 / 还没配机器）才回落到该场景出厂那张纸
  const printerPaper = activePaper(devices);
  const [paper, setPaper] = useState<PaperKind>(printerPaper ?? defaultTemplate(scenario).paper);
  useEffect(() => {
    if (printerPaper) setPaper(printerPaper);
  }, [printerPaper]);
  // 纸型是模板的存储键：弹窗里换纸型 = 换那张纸的模板，预览与出纸跟着同一份版式走
  const tpl = useReceiptTemplate(scenario, paper);
  // 站点级实测列数；null = 按纸型标称。见 store.ts 的说明
  const thermalCols = useReceiptStore((s) => s.thermalCols);
  const no = docNo ?? docMeta(context).docNo;

  /**
   * 三条通道各自落地；返回 false = 没出纸，PrintPreview 据此跳过留痕（不留"已打印但纸上空白"的假账）。
   * 失败提示在这里给全，所以 PrintPreview 侧不再叠一层。
   */
  async function handlePrint(channel: PrintChannel, p: PaperKind): Promise<boolean> {
    if (channel === "pdf_silent") {
      // 队列机的 GDI 直打：纸面交给驱动，程序不选纸。要的就是"连续纸不弹框、按打印机配置走"
      const target = resolveDirectTarget(devices, p);
      if (target.kind !== "queue") {
        toast.error("静默直打只吃打印队列机（A4 激光 / 241 针式）", {
          description: target.deviceName ? `台账里默认那台「${target.deviceName}」是热敏直连机，请改用「RAW 直连」。` : "设备中心里没有登记可用的队列机，请改用「窗口预览」。",
        });
        return false;
      }
      // 队列机不传 machinePaper——可打区是驱动给的，落点不归我们算（与 silent.ts 同一口径）
      const res = await nativePrinter.receiptToQueue(receiptLines(tpl, { ...context, reprint: isReprint }), {
        printer: target.printer ?? null,
      });
      const out = res.available ? res.data : undefined;
      if (!res.available || !out?.ok) {
        toast.error(`没能提交打印队列：${out?.error ?? res.error ?? "本机没有原生打印通道"}`);
        return false;
      }
      return true;
    }
    if (channel !== "raw") {
      // 窗口预览：把预览里那块纸原样送进打印文档，纸上就是眼前这一版
      const node = document.getElementById("print-root");
      if (!node) return false;
      const spec = PAPER_SPEC[p];
      await printJob({
        title: no,
        widthMm: spec.widthMm,
        heightMm: spec.heightMm,
        marginMm: spec.marginMm,
        node,
      });
      return true;
    }
    if (p !== "thermal80" && p !== "thermal58") {
      toast.error(`RAW 直连只吃热敏纸，当前是${PAPER[p]}`, {
        description: "把纸型切成 58 / 80 热敏，或改用「窗口预览」通道打 A4。",
      });
      return false;
    }
    // 这里能在弹窗里临时换纸型，所以"告诉机器的纸"就是当场选的这张 p——
    // 它与 `toNativePaper(p)` 传下去的必须是同一张，否则码的落点按另一卷纸算
    const res = await nativePrinter.receipt(receiptLines(tpl, { ...context, reprint: isReprint }, { machinePaper: p }), {
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
      description: "可在「系统 → 打印模板」里用「小票机自检」分清是机器的问题还是版面的问题。",
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
      paperOptions={supportedPapers(devices)}
      // 选了别的纸就说清楚：这一格打的是那张纸的版式，而当场出纸走的是默认那台机装的纸
      paperNote={
        printerPaper && paper !== printerPaper ? (
          <span>
            {PAPER_SPEC[paper].note}
            <br />
            默认打印机装的是{PAPER[printerPaper]}，这一格是{PAPER[paper]}的版式
          </span>
        ) : undefined
      }
      onPaperChange={setPaper}
      onPrint={handlePrint}
      onPrinted={onPrinted}
    >
      <PaperFrame paper={paper}>
        <ReceiptDocument template={tpl} paperOverride={paper} context={{ ...context, reprint: isReprint }} />
      </PaperFrame>
    </PrintPreview>
  );
}
