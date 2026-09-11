/**
 * 桌面原生通道（Tauri）的唯一出口。
 *
 * 为什么要单独一层：小票机、读卡桥接这类设备访问只在桌面端存在，而项目还要能在
 * 纯浏览器里跑演示与冒烟测试。这里的约定是**永远不抛异常、也永远不返回假数据**：
 * 没有原生通道时回 `available: false` 加一句原因，界面据此把按钮置灰并解释，
 * 而不是拿一组假设备号骗出"设备在线"。
 */

/** 与 Rust `ticket_core::model::Paper` 对齐（serde 小写） */
export type NativePaper = "p80" | "p58";

/** 与 Rust `device::DeviceInfo` 对齐（camelCase 序列化） */
export interface NativePrinterDevice {
  devicePath: string;
  vendorId: number | null;
  productId: number | null;
  label: string;
}

/** 与 Rust `device::DeviceStatus` 对齐 */
export interface NativePrinterStatus {
  responding: boolean;
  online: boolean;
  paperAdequate: boolean;
  /** escpos = DLE EOT 有应答；ioctl = 只拿到类驱动状态字；none = 都没应答 */
  source: "escpos" | "ioctl" | "none" | string;
  rawByte: number | null;
  ioctl: number | null;
  note: string;
}

/** 与 Rust `printer::PrintOutcome` 对齐 */
export interface NativePrintOutcome {
  ok: boolean;
  device: string;
  status: NativePrinterStatus;
  elapsedMs: number;
  error: string | null;
}

/** 与 Rust `ticket_core::model::WeighTicket` 对齐（字段保持 snake_case） */
export interface ReceiptTicket {
  station_name: string;
  station_code: string;
  doc_no: string;
  biz_date: string;
  print_time: string;
  scale_no: string;
  farmer_name: string;
  id_card_masked: string;
  plate_no: string;
  grain_name: string;
  grade_name: string;
  gross_kg: number;
  tare_kg: number;
  net_kg: number;
  moisture: number | null;
  impurity: number | null;
  deduct_kg: number;
  settle_net_kg: number;
  unit_price: number;
  amount: number;
  amount_upper: string;
  weigher: string;
  qc_by: string;
  cashier: string;
  copy_note: string;
  is_reprint: boolean;
  qr_text: string;
  footer_note: string;
  paper: NativePaper;
  copies: number;
  open_drawer: boolean;
}

export type NativeResult<T> =
  | { available: true; data?: T; error?: string }
  | { available: false; error: string };

/** 只有桌面端才有 `__TAURI_INTERNALS__`；用惰性判断，模块在浏览器里加载也不能报错 */
export function runningInTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 纸型（站点参数里的 PaperKind）→ ESC/POS 纸宽。只在这里做一次映射：
 * 各处再写一遍 `=== "thermal58" ? ...` 迟早和 constants 分叉。
 */
export function toNativePaper(paper: string | null | undefined): NativePaper {
  return paper === "thermal58" ? "p58" : "p80";
}

const NO_CHANNEL = "当前是浏览器预览，没有原生设备通道；请用「npm run tauri dev」启动桌面端后重试";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<NativeResult<T>> {
  if (!runningInTauri()) return { available: false, error: NO_CHANNEL };
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return { available: true, data: await invoke<T>(cmd, args) };
  } catch (e) {
    // 命令本身失败（打不开设备、写失败）与"没有通道"要能区分开，故 available 仍为 true
    return { available: true, error: e instanceof Error ? e.message : String(e) };
  }
}

export const nativePrinter = {
  /** 可直连的小票机列表（设备中心下拉的数据源） */
  list: () => call<NativePrinterDevice[]>("printer_list"),

  /** 问一次实时状态，不出纸 */
  status: (dev?: { vid?: number; pid?: number }) =>
    call<{ device: NativePrinterDevice; status: NativePrinterStatus }>("printer_status", {
      vid: dev?.vid ?? null,
      pid: dev?.pid ?? null,
    }),

  /** 打自检票：一次判读通道 / 中文字库 / 栅格列数 / 切刀 */
  selfTest: (dev?: { vid?: number; pid?: number; paper?: NativePaper }) =>
    call<NativePrintOutcome>("printer_self_test", {
      vid: dev?.vid ?? null,
      pid: dev?.pid ?? null,
      paper: dev?.paper ?? null,
    }),

  /** 打过磅码单（票面内容由调用方快照好交过来） */
  weighTicket: (ticket: ReceiptTicket) =>
    call<NativePrintOutcome>("print_weigh_ticket", { ticket }),
};

/* ------------------------------------------------------------------ *
 * 身份证 / IC 卡读卡器（精伦 Routon iDR，走 routon-idr 封装）
 * 与 Rust `idcard::{ReaderStatus, IdCardInfo, IcCardInfo, IcBlock}` 对齐（camelCase）。
 * ------------------------------------------------------------------ */

/** 读卡器连接状态 */
export interface NativeReaderStatus {
  connected: boolean;
  samId: string | null;
  fingerprint: boolean;
  error: string | null;
}

/** 一张身份证的结构化信息（含可选照片绝对路径） */
export interface NativeIdCardInfo {
  ok: boolean;
  name: string;
  gender: string;
  nation: string;
  birth: string;
  idNumber: string;
  address: string;
  agency: string;
  validFrom: string;
  validTo: string;
  photoPath: string | null;
  error: string | null;
}

/** 一个 Mifare 数据块 */
export interface NativeIcBlock {
  sector: number;
  block: number;
  ok: boolean;
  hex: string;
  error: string | null;
}

/** IC（Mifare）卡读取结果 */
export interface NativeIcCardInfo {
  ok: boolean;
  kindCode: number;
  kindLabel: string;
  sn: string;
  blocks: NativeIcBlock[];
  error: string | null;
}

export const nativeIdcard = {
  /** 读卡器是否在线 + SAM 号（设备中心状态灯） */
  status: () => call<NativeReaderStatus>("idcard_status"),

  /** 读身份证；withPhoto=true 时把照片写到应用缓存目录并回传绝对路径 */
  read: (withPhoto = false) =>
    call<NativeIdCardInfo>("idcard_read", { withPhoto }),

  /** 读 Mifare IC 卡：卡号 + 指定块。keyHex 为 12 位十六进制，默认出厂 FFFFFFFFFFFF */
  icRead: (opts?: { keyHex?: string; blocks?: [number, number][] }) =>
    call<NativeIcCardInfo>("ic_read", {
      keyHex: opts?.keyHex ?? null,
      blocks: opts?.blocks ?? null,
    }),
};
