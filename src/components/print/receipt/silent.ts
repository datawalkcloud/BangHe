/**
 * 无预览的「静默出票」（06 §2.2 硬规矩 2 / §8 打印编排）。
 *
 * 磅房的现场规矩只有一条：点打印 = 出纸，中间不弹任何框。这里是那条规矩的唯一实现——
 * 工作台不论自动（第二刷）还是手动（F9），都先走这里，只有真打不出去才回退预览框。
 *
 * 出纸口按**模板纸型**分流，两条路物理上不是一台机器：
 *  - 58 / 80 热敏：ESC/POS 直写 usbprint.sys（`print_receipt`），字节直达小票机；
 *  - A4 / 241 针式：Windows 打印队列直打（`print_receipt_queue`），Rust 用 GDI 把同一份
 *    行序列画到打印机 DC 上提交假脱机。**纸型、托盘、方向一概不传**——以打印机自身的
 *    配置为准（针式机装着 241 连续纸就出 241，激光机装着 A4 就出 A4）。
 *    目标机取设备台账里登记的默认队列机（`rawQueue`），台账没配就交给系统默认打印机。
 *
 * 浏览器演示没有原生通道，一律回 `"preview"`——回退不是失败，是"这台机/这个配置没法
 * 自动打"的诚实交代。出纸成功后自己补一条 `print_log`（与预览组件同一张表、同一形状）；
 * 留痕失败只提示，不假装"没打过"，也不回滚已经落库的皮重。
 */
import { toast } from "sonner";
import { api } from "@/lib/api";
import { runningInTauri, nativePrinter, toNativePaper, type NativePrintOutcome, type NativeResult } from "@/lib/native";
import type { DeviceConfig } from "@/mock/types";
import type { PaperKind, PrintChannel } from "@/lib/constants";
import { useDeviceStore } from "@/store/device";
import { actorId } from "@/store/session";
import { receiptLines } from "./escpos";
import { effectiveTemplate, useReceiptStore } from "./store";
import type { ReceiptContext, ReceiptScenario } from "./types";

export type SilentOutcome = "printed" | "preview";

/** 走 ESC/POS 直写的纸型；其余（A4 / dot241）都归打印队列 */
function isThermal(paper: PaperKind): boolean {
  return paper === "thermal80" || paper === "thermal58";
}

/**
 * 台账里配的队列打印机名：启用的打印机设备中，驱动为窗口预览/针式套打（即"靠队列名寻址"
 * 的那两类）优先取默认项。`rawQueue` 是设备中心扫队列机时回填的**真实队列名**，
 * 名称字段只做人看的备注，所以优先 rawQueue、没有再退 name。返回 undefined = 交给系统默认打印机。
 */
export function resolveQueuePrinter(devices: DeviceConfig[]): string | undefined {
  const queues = devices.filter(
    (d) => d.kind === "printer" && d.is_enabled === 1 && (d.driver === "preview" || d.driver === "raw_escp"),
  );
  const picked = queues.find((d) => d.is_default === 1) ?? queues[0];
  if (!picked) return undefined;
  const name = String(picked.config.rawQueue ?? picked.name ?? "").trim();
  return name || undefined;
}

export async function printReceiptSilently({
  scenario,
  context,
  docNo,
  isReprint = false,
  devices = [],
}: {
  scenario: ReceiptScenario;
  context: ReceiptContext;
  docNo: string;
  isReprint?: boolean;
  /** 设备台账（队列机从中解析）；不传 = 全部交给系统默认打印机 */
  devices?: DeviceConfig[];
}): Promise<SilentOutcome> {
  if (!runningInTauri()) return "preview";

  const tpl = effectiveTemplate(scenario);
  const paper = tpl.paper as PaperKind;
  const lines = receiptLines(tpl, { ...context, reprint: isReprint });

  let channel: PrintChannel;
  let printerName: string;
  let res: NativeResult<NativePrintOutcome>;

  if (isThermal(paper)) {
    /* ---------------------------------------------- 热敏：ESC/POS usbprint 直写 */
    channel = "raw";
    const printer = useDeviceStore.getState().printer;
    if (printer.status !== "online") {
      toast.error(`小票机不可用：${printer.lastError ?? "离线"}`, { description: "已转窗口预览，可手动重打" });
      return "preview";
    }
    printerName = printer.name;
    res = await nativePrinter.receipt(lines, {
      paper: toNativePaper(paper),
      cols: useReceiptStore.getState().thermalCols ?? undefined,
    });
  } else {
    /* ---------------------------------------------- A4 / 针式：Windows 打印队列直打 */
    channel = "pdf_silent";
    const target = resolveQueuePrinter(devices);
    res = await nativePrinter.receiptToQueue(lines, { printer: target ?? null });
    // 队列机用回执里的真实机器名留痕；拿不到才退回台账备注名 / "系统默认打印机"
    printerName = res.available ? (res.data?.device || target || "系统默认打印机") : (target ?? "系统默认打印机");
  }

  const out = res.available ? res.data : undefined;
  if (!res.available || !out?.ok) {
    // 06 §2.2：自动打印失败要报因，但不回滚已捕获的皮重；交回预览框给磅员一次手动机会
    toast.error(`码单没能自动出纸：${out?.error ?? res.error ?? "未知原因"}`, { description: "已转窗口预览；重量已记，不受影响" });
    return "preview";
  }

  try {
    await api.logPrint({
      doc_type: scenario,
      doc_no: docNo,
      paper,
      printer_name: printerName,
      channel,
      is_reprint: isReprint,
      operator_id: actorId() ?? 0,
    });
    toast.success(
      channel === "raw"
        ? `${docNo} 已出码单（热敏直连）`
        : `${docNo} 已提交「${printerName}」，纸张等按打印机配置`,
    );
  } catch (e) {
    toast.error("码单已出纸，但打印留痕失败：补打角标可能不准", {
      description: e instanceof Error ? e.message : String(e),
    });
  }
  return "printed";
}
