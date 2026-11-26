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
 *  台账没登记打印机时，才按**票面模板纸型**分流（热敏自动挑一台直连机 / 其余交预览框）——
 *  这条只剩预览框里的「静默直打」还会走到；业务出票这条路在入口就拦住了：
 *  **一台打印机都没登记就直接交浏览器预览**，不拿模板纸型去猜有机器还是没机器。
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
import { isPaperKind, PAPER_KINDS, type PaperKind } from "@/lib/constants";
import { ESCPOS_DRIVERS, papersForDriver, parseHex } from "@/lib/print-guard";
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

/** 台账里**真的在用**的打印机：启用、非 Mock。当前那台与纸型并集都从这份推，判据只写一次 */
function registeredPrinters(devices: DeviceConfig[]): DeviceConfig[] {
  return devices.filter((d) => d.kind === "printer" && d.is_enabled === 1 && d.is_mock !== 1);
}

/**
 * 台账里「系统当前那台打印机」：默认项优先，没标默认就取登记顺序第一台。
 *
 * 出纸口、当前用纸、取哪一格模板，全都从这一台推出来——整个系统默认一台打印机，
 * 判定只写这一份（`resolveDirectTarget` 与打印模板编辑器共用）。
 */
export function pickPrinterDevice(devices: DeviceConfig[]): DeviceConfig | null {
  const printers = registeredPrinters(devices);
  return printers.find((d) => d.is_default === 1) ?? printers[0] ?? null;
}

/**
 * 台账里**登记过的机器**能装哪几种纸的并集，驱动决定（判据在 `print-guard.papersForDriver`，
 * 与设备中心登记表单同一份）。
 *
 * 取并集而不是只看默认那台：磅房常见一台小票机 + 一台 A4 激光 + 一台 241，默认那台只决定
 * "当场出纸打到哪儿"，而预览框里的静默直打与 RAW 直连照样会用另外几台。只看默认那台，
 * 另外两台的版式就没有地方改，改不动的模板等于没有那台机器。
 *
 * **一台都没登记**时四种全给：那种情况下出纸本来就走浏览器预览，纸型只是挑一张纸来排版，
 * 没有硬件能拒。
 */
export function supportedPapers(devices: DeviceConfig[]): PaperKind[] {
  const printers = registeredPrinters(devices);
  if (printers.length === 0) return PAPER_KINDS;
  const seen = new Set<PaperKind>();
  for (const d of printers) for (const k of papersForDriver(d.driver)) seen.add(k);
  // 台账配了个驱动范围外的纸型（老记录、手改脏）也要有那一页：否则顶部没有它、下面却按它排版
  const cur = activePaper(devices);
  if (cur) seen.add(cur);
  // 按 PAPER_KINDS 的顺序出，不让登记顺序决定标签页顺序（现场习惯热敏在前）
  return PAPER_KINDS.filter((k) => seen.has(k));
}

/**
 * 当前用纸 = 台账里**默认那台**打印机登记的纸型；**没登记任何打印机 = null**，打印一律回浏览器预览。
 *
 * 老记录没填纸型或填了认不出的值，按该驱动默认那一档认（热敏 = 80）：脏配置该让票照出厂那台机打，
 * 不该把出纸卡成每次弹窗。
 */
export function activePaper(devices: DeviceConfig[]): PaperKind | null {
  const picked = pickPrinterDevice(devices);
  if (!picked) return null;
  const cfg = picked.config.paper;
  return isPaperKind(cfg) ? cfg : papersForDriver(picked.driver)[0] ?? null;
}

/**
 * 出纸口解析：设备中心登记的打印机（启用、非 Mock，默认项优先）说了算；
 * 没登记才按模板纸型兜底分流。Mock 机不参与——它背后没有能出纸的硬件。
 *
 * 默认路径只用它判"是不是热敏直连"；`printer` / `deviceName` 两枚是给预览框里
 * 「静默直打」那条通道准备的（见 `ReceiptPrintPreview.handlePrint`）。
 */
export function resolveDirectTarget(devices: DeviceConfig[], templatePaper: PaperKind): DirectTarget {
  const picked = pickPrinterDevice(devices);
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

  // 用哪张纸由设备中心那台打印机决定；一台都没登记 = 没有能直连的机器，直接交浏览器预览
  const wantedPaper = activePaper(devices);
  if (!wantedPaper) return "preview";

  // 票种名只从场景目录取一份：这条路不只打码单（质检单/结算凭证/付款小票都走它），
  // 失败提示写死"码单"会在别的页面变成谎话
  const docLabel = SCENARIOS[scenario]?.label ?? "单据";
  const target = resolveDirectTarget(devices, wantedPaper);
  // 只有 ESC/POS 直连的热敏机保持"点打印＝出纸"；A4 / 241 这类队列机一律先交预览框（issue #4）
  if (target.kind !== "thermal") return "preview";
  // 模板取机器实际那张纸的那一格：热敏分支下 target.paper 就是台账登记的 80 / 58
  const tpl = effectiveTemplate(scenario, target.paper);

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
