/**
 * 打印预览与通道选择（04 文档 §7 的三通道在界面上的落点）。
 *
 * 现场规则：打印失败绝不能只弹一个"失败"，必须给两条出口——
 * "重试"和"改窗口预览打印"，否则磅队会堵在窗前（05 §6.5）。
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircleIcon, PrinterIcon } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { PaperKind, PrintChannel } from "@/lib/constants";
import type { ReceiptScenario } from "./receipt/types";
import { PAPER_SPEC } from "./receipt/paper";
import { PAPER, PRINT_CHANNEL } from "@/lib/constants";
import { useDeviceStore } from "@/store/device";
import { actorId } from "@/store/session";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Choose } from "@/components/business/Choose";
import { Field, FieldLabel } from "@/components/ui/field";

export function PrintPreview({
  open,
  onOpenChange,
  docType,
  docNo,
  isReprint = false,
  paper: paperProp,
  defaultPaper = "A4",
  onPaperChange,
  onPrint,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  docType: ReceiptScenario;
  docNo: string;
  isReprint?: boolean;
  /** 受控纸型：传入后此处选择会直接驱动预览与打印尺寸 */
  paper?: PaperKind;
  defaultPaper?: PaperKind;
  onPaperChange?: (p: PaperKind) => void;
  /**
   * 接管"按下打印"这个动作。不传则落到 `window.print()`（浏览器等价演示）。
   * 返回 `false` 表示这次没出纸——此时**不留痕**，否则 print_log 里会多出一条
   * "已打印"而纸上什么都没有的假记录，日后补打对不上账。
   * 失败原因由实现方自己提示，这里不再叠一层 toast。
   */
  onPrint?: (channel: PrintChannel, paper: PaperKind) => boolean | Promise<boolean>;
  children: ReactNode;
}) {
  const [paperState, setPaperState] = useState<PaperKind>(defaultPaper);
  const paper = paperProp ?? paperState;
  const setPaper = onPaperChange ?? setPaperState;
  const [channel, setChannel] = useState<PrintChannel>("preview");
  const printer = useDeviceStore((s) => s.printer);

  const log = useMutation({
    mutationFn: () =>
      api.logPrint({
        doc_type: docType,
        doc_no: docNo,
        paper,
        printer_name: printer.name,
        channel,
        is_reprint: isReprint,
        operator_id: actorId(),
      }),
    onSuccess: () => {
      toast.success(`${docNo} 已提交打印（${PAPER[paper]} · ${PRINT_CHANNEL[channel]}）`);
      onOpenChange(false);
    },
    onError: () => toast.error("打印留痕失败，可重试或改用窗口预览"),
  });

  async function doPrint() {
    if (printer.status !== "online") {
      toast.error(`${printer.name} ${printer.lastError ?? "不可用"}，可改用窗口预览打印`);
      return;
    }
    // 真实实现按通道分流：preview 走 webview print、pdf_silent 走 Rust 静默导出、
    // raw 走 ESC/POS 直连小票机。调用方给了 onPrint 就交给它（它知道票面长什么样），
    // 否则统一用浏览器打印等价演示。
    if (onPrint) {
      let printed: boolean;
      try {
        printed = (await onPrint(channel, paper)) !== false;
      } catch (e) {
        toast.error(`打印失败：${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      // 没出纸就别留痕：print_log 是"当初那张纸打的是什么"的凭据，不能记假的
      if (!printed) return;
    } else {
      window.print();
    }
    log.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[860px] gap-0 p-0">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <PrinterIcon className="size-4" />
            打印预览 · {docNo}
            {isReprint && <span className="border px-1 text-[10px]">补打，需站长授权</span>}
          </DialogTitle>
        </DialogHeader>

        {printer.status !== "online" && (
          <div className="px-4 pt-3">
            <Alert variant="destructive">
              <PrinterIcon />
              <AlertTitle>{printer.name} 不可用</AlertTitle>
              <AlertDescription className="flex items-center gap-2">
                <span>{printer.lastError ?? "设备离线"}。作业不会被阻塞，可换用本机已连接的打印机输出。</span>
                <Button size="xs" variant="outline" onClick={() => setChannel("preview")}>
                  改窗口预览打印
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        )}

        <div className="max-h-[62vh] overflow-y-auto bg-muted/40 p-4">{children}</div>

        <DialogFooter className="mx-0 flex items-center gap-3 border-t px-4 py-3 sm:justify-between">
          <div className="flex items-end gap-3">
            <Field className="gap-1">
              <FieldLabel className="text-xs">纸型</FieldLabel>
              <Choose
                size="sm"
                aria-label="纸型"
                className="w-40"
                value={paper}
                onChange={setPaper}
                options={(Object.keys(PAPER) as PaperKind[]).map((k) => ({ value: k, label: PAPER[k] }))}
              />
              <span className="text-[10px] text-muted-foreground">{PAPER_SPEC[paper].note}</span>
            </Field>
            <Field className="gap-1">
              <FieldLabel className="text-xs">通道</FieldLabel>
              <Choose
                size="sm"
                aria-label="打印通道"
                className="w-32"
                value={channel}
                onChange={setChannel}
                options={(Object.keys(PRINT_CHANNEL) as PrintChannel[]).map((k) => ({ value: k, label: PRINT_CHANNEL[k] }))}
              />
            </Field>
            <p className="pb-1 text-xs text-muted-foreground">
              打印内容会快照进 print_log，以便日后回答"当初那张纸打的是什么"
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
            <Button onClick={doPrint} disabled={log.isPending}>
              {log.isPending ? <LoaderCircleIcon className="animate-spin" /> : <PrinterIcon />}
              {isReprint ? "确认补打" : "打印（F9）"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
