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
import { PAPER, PRINT_CHANNEL } from "@/lib/constants";
import { useDeviceStore } from "@/store/device";
import { useSession } from "@/store/session";
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
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  docType: "weigh_order" | "quality_report" | "settlement_voucher";
  docNo: string;
  isReprint?: boolean;
  children: ReactNode;
}) {
  const [paper, setPaper] = useState<PaperKind>("A4");
  const [channel, setChannel] = useState<PrintChannel>("preview");
  const printer = useDeviceStore((s) => s.printer);
  const operator = useSession((s) => s.operator);

  const log = useMutation({
    mutationFn: () =>
      api.logPrint({
        doc_type: docType,
        doc_no: docNo,
        paper,
        printer_name: printer.name,
        channel,
        is_reprint: isReprint,
        operator_id: operator?.id ?? 0,
      }),
    onSuccess: () => {
      toast.success(`${docNo} 已提交打印（${PAPER[paper]} · ${PRINT_CHANNEL[channel]}）`);
      onOpenChange(false);
    },
    onError: () => toast.error("打印留痕失败，可重试或改用窗口预览"),
  });

  function doPrint() {
    if (printer.status !== "online") {
      toast.error(`${printer.name} ${printer.lastError ?? "不可用"}，可改用窗口预览打印`);
      return;
    }
    // 真实实现按通道分流：preview 走 webview print、pdf_silent 走 Rust 静默导出、
    // raw 走 Windows Spooler 直连针式；这里统一用浏览器打印等价演示
    window.print();
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

        <div className="max-h-[62vh] overflow-y-auto bg-muted/40 p-4">
          {/* 屏幕上给个纸张阴影，让操作员看到的就是纸上会有什么的边界 */}
          <div className="shadow-[0_0_0_1px_var(--color-border),0_8px_24px_rgb(0_0_0/0.12)]">{children}</div>
        </div>

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
