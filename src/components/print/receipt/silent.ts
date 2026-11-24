/**
 * 「点打印」之后到底该不该出纸的唯一判定（06 §2.2 硬规矩 2 / §8 打印编排）。
 *
 * 所有会出票的入口（工作台自动/手动出码单、磅单与质检单详情的补打、结算凭证、付款小票）
 * 都先走这里，业务页统一经 `useSilentReceiptPrint` 进来，不要自己直接调本函数。
 * 它只回答一个问题：这台机器能不能不经人手直接出纸？能就打完返回 `"printed"`，
 * 不能（或打失败）就返回 `"preview"`，把票面交给预览框。
 *
 * **直打出纸只有一条路：ESC/POS 直连的热敏小票机。** 出纸口由设备中心配置的打印机决定
 * （默认项优先，其次台账里唯一那台），按台账登记的驱动认机器：
 *  - 直连小票机（驱动 `escpos_usbprint` / `raw_escpos`）：ESC/POS 直写 usbprint.sys
 *    （`print_receipt`），按台账的 VID/PID 寻址、按台账纸宽排栅格；
 *  - **其余一律回 `"preview"`**——A4 激光与 241 针式这类走 Windows 打印队列的机器，
 *    交回预览框由人看过版面再打（issue #4）。队列机的 GDI 直打命令
 *    （`nativePrinter.receiptToQueue` → `print_receipt_queue`）仍在，只是不在这条默认路径上。
 *  台账没登记打印机时，才按**票面模板纸型**分流（热敏自动挑一台直连机 / 其余交预览框）。
 *
 * 为什么队列机不直打：GDI 那条路把前端排好的行序列交给打印机驱动自己排版，纸型、托盘、
 * 方向一概不传，打出来什么全看驱动当时的配置；A4 又是单张纸，废一张是一张。预览框里
 * 走浏览器打印（`printPage.ts`）能把票面按毫米定死，并且让人当场挑机器、填份数。
 *
 * 浏览器演示没有原生通道，一律回 `"preview"`——回退不是失败，是"这台机/这个配置没法
 * 自动打"的诚实交代。出纸成功后自己补一条 `print_log`（与预览组件同一张表、同一形状）；
 * 留痕失败只提示，不假装"没打过"，也不回滚已经落库的皮重。
 */
import { toast } from "sonner";
import { api } from "@/lib/api";
import { announce } from "@/lib/voice-prompt";
import { runningInTauri, nativePrinter, toNativePaper } from "@/lib/native";
import type { DeviceConfig } from "@/mock/types";
import type { PaperKind } from "@/lib/constants";
import { parseHex, ESCPOS_DRIVERS } from "@/lib/print-guard";
import { useDeviceStore } from "@/store/device";
import { actorId } from "@/store/session";
import { receiptLines } from "./escpos";
import { SCENARIOS } from "./scenarios";
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
 *
 * 默认路径只用它判"是不是热敏直连"；`printer` / `deviceName` 两枚是给预览框里
 * 「静默直打」那条通道准备的（见 `ReceiptPrintPreview.handlePrint`）。
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

  // 票种名只从场景目录取一份：这条路不只打码单（质检单/结算凭证/付款小票都走它），
  // 失败提示写死"码单"会在别的页面变成谎话
  const docLabel = SCENARIOS[scenario]?.label ?? "单据";
  const tpl = effectiveTemplate(scenario);
  const target = resolveDirectTarget(devices, tpl.paper as PaperKind);
  // 只有 ESC/POS 直连的热敏机保持"点打印＝出纸"；A4 / 241 这类队列机一律先交预览框（issue #4）
  if (target.kind !== "thermal") return "preview";

  /* ---------------------------------------------- 热敏：ESC/POS usbprint 直写 */
  // 告诉机器的那张纸要一起给排版的：热敏机的码落点与宽度预算都按它算（见 code-size.ts）
  const lines = receiptLines(tpl, { ...context, reprint: isReprint }, { machinePaper: target.paper });
  const printer = useDeviceStore.getState().printer;
  if (printer.status !== "online") {
    toast.error(`小票机不可用：${printer.lastError ?? "离线"}`, { description: "已转窗口预览，可手动重打" });
    return "preview";
  }
  const res = await nativePrinter.receipt(lines, {
    paper: toNativePaper(target.paper),
    vid: target.vid,
    pid: target.pid,
    cols: useReceiptStore.getState().thermalCols ?? undefined,
  });

  const out = res.available ? res.data : undefined;
  if (!res.available || !out?.ok) {
    // 06 §2.2：自动打印失败要报因，但不回滚已捕获的皮重；交回预览框给磅员一次手动机会
    toast.error(`${docLabel}没能自动出纸：${out?.error ?? res.error ?? "未知原因"}`, { description: "已转窗口预览；已记的数据不受影响" });
    // 这一声必须出：不出，操作员会以为票已经在打了，直接让车下磅。成功不念——纸从出纸口出来比语音直接
    announce(`${docLabel}没能自动出纸，请在预览框里手动打一次`, `print-fail:${docNo}`);
    return "preview";
  }

  try {
    await api.logPrint({
      doc_type: scenario,
      doc_no: docNo,
      paper: target.paper,
      printer_name: target.deviceName,
      channel: "raw",
      is_reprint: isReprint,
      operator_id: actorId() ?? 0,
    });
    toast.success(`${docNo} 已出${docLabel}（${target.deviceName} · 热敏直连）`);
  } catch (e) {
    toast.error(`${docLabel}已出纸，但打印留痕失败：补打角标可能不准`, {
      description: e instanceof Error ? e.message : String(e),
    });
  }
  return "printed";
}
