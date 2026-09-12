/**
 * 无预览的「静默出票」（06 §2.2 硬规矩 2 / §8 打印编排）。
 *
 * 磅房的现场规矩只有一条：点打印 = 出纸，中间不弹任何框。这里是那条规矩的唯一实现——
 * 工作台不论自动（第二刷）还是手动（F9），都先走这里，只有真打不出去才回退预览框。
 *
 * **出纸口由设备中心配置的打印机决定**（默认项优先，其次台账里唯一那台），两条路物理上
 * 不是一台机器：
 *  - 直连小票机（驱动 `escpos_usbprint` / `raw_escpos`）：ESC/POS 直写 usbprint.sys
 *    （`print_receipt`），按台账的 VID/PID 寻址、按台账纸宽排栅格；
 *  - 队列机（驱动 `preview` / `raw_escp`，即 A4 激光与 241 针式）：Windows 打印队列直打
 *    （`print_receipt_queue`），Rust 用 GDI 把同一份行序列画到打印机 DC 上提交假脱机。
 *    **纸型、托盘、方向一概不传**——以打印机自身的配置为准（装 241 连续纸就出 241，
 *    装 A4 就出 A4）。目标机取台账扫队列机回填的 `rawQueue` 真实队列名。
 *  台账没登记打印机时，才退回按**票面模板纸型**分流（热敏自动挑一台直连机 / 其余进系统
 *  默认队列）——现场"配了哪台就打哪台"，不能让模板里的纸型和硬件各说各话。
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
import { parseHex, ESCPOS_DRIVERS } from "@/lib/print-guard";
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

type DirectTarget =
  /** ESC/POS 直写：vid/pid 来自台账（缺省由 Rust 自动挑第一台 usbprint 设备） */
  | { kind: "thermal"; paper: PaperKind; vid?: number; pid?: number; deviceName: string }
  /** Windows 打印队列：printer = 真实队列名，undefined = 系统默认打印机 */
  | { kind: "queue"; printer?: string; deviceName?: string };

/**
 * 出纸口解析：设备中心登记的打印机（启用、非 Mock，默认项优先）说了算；
 * 没登记才按模板纸型兜底分流。Mock 机不参与——它背后没有能出纸的硬件。
 */
export function resolveDirectTarget(devices: DeviceConfig[], templatePaper: PaperKind): DirectTarget {
  const printers = devices.filter((d) => d.kind === "printer" && d.is_enabled === 1 && d.is_mock !== 1);
  const picked = printers.find((d) => d.is_default === 1) ?? printers[0];
  if (picked) {
    if (ESCPOS_DRIVERS.includes(picked.driver)) {
      const paper = String(picked.config.paper ?? "") === "thermal58" ? "thermal58" : "thermal80";
      const vid = parseHex(picked.config.vid) ?? undefined;
      const pid = parseHex(picked.config.pid) ?? undefined;
      return { kind: "thermal", paper, vid, pid, deviceName: picked.name };
    }
    // 队列机：rawQueue 是扫队列机回填的真实队列名，name 只是人看的备注
    const queue = String(picked.config.rawQueue ?? picked.name ?? "").trim();
    return { kind: "queue", printer: queue || undefined, deviceName: queue || picked.name };
  }
  if (isThermal(templatePaper)) return { kind: "thermal", paper: templatePaper, deviceName: "热敏小票机" };
  return { kind: "queue" };
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
  /** 设备台账（出纸口从中解析）；不传 = 按模板纸型兜底分流 */
  devices?: DeviceConfig[];
}): Promise<SilentOutcome> {
  if (!runningInTauri()) return "preview";

  const tpl = effectiveTemplate(scenario);
  const target = resolveDirectTarget(devices, tpl.paper as PaperKind);
  const lines = receiptLines(tpl, { ...context, reprint: isReprint });

  let channel: PrintChannel;
  let printerName: string;
  let res: NativeResult<NativePrintOutcome>;
  // 留痕的纸型 = 实际出纸介质的纸型：热敏以台账配置为准，队列以票面模板为准（真纸随打印机，程序不选纸）
  let paper: PaperKind;

  if (target.kind === "thermal") {
    /* ---------------------------------------------- 热敏：ESC/POS usbprint 直写 */
    channel = "raw";
    paper = target.paper;
    const printer = useDeviceStore.getState().printer;
    if (printer.status !== "online") {
      toast.error(`小票机不可用：${printer.lastError ?? "离线"}`, { description: "已转窗口预览，可手动重打" });
      return "preview";
    }
    printerName = target.deviceName;
    res = await nativePrinter.receipt(lines, {
      paper: toNativePaper(paper),
      vid: target.vid,
      pid: target.pid,
      cols: useReceiptStore.getState().thermalCols ?? undefined,
    });
  } else {
    /* ---------------------------------------------- A4 / 针式：Windows 打印队列直打 */
    channel = "pdf_silent";
    paper = tpl.paper as PaperKind;
    res = await nativePrinter.receiptToQueue(lines, { printer: target.printer ?? null });
    // 队列机用回执里的真实机器名留痕；拿不到才退回台账名 / "系统默认打印机"
    printerName = (res.available ? res.data?.device : undefined) || target.deviceName || "系统默认打印机";
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
        ? `${docNo} 已出码单（${printerName} · 热敏直连）`
        : `${docNo} 已提交「${printerName}」，纸张等按打印机配置`,
    );
  } catch (e) {
    toast.error("码单已出纸，但打印留痕失败：补打角标可能不准", {
      description: e instanceof Error ? e.message : String(e),
    });
  }
  return "printed";
}
