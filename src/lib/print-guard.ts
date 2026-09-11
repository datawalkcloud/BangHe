/**
 * 打印相关配置的"保存前必须联机测试"门禁（02 §M9）。
 *
 * 规则只在这里定义一次，站点参数与设备中心共用，避免两处各写一套判断：
 *
 * - **能测就必须测过**：桌面端有原生通道时，先真发一次 `DLE EOT` 状态查询，
 *   设备有应答且联机，才允许写配置；不通过直接拒绝保存。
 * - **测不了就留痕**：浏览器预览没有原生通道，无法验证。此时允许保存（否则开发期
 *   什么都改不动），但结果一律标成"未经真机验证"，台账与审计里看得见，
 *   绝不用 mock 的"测试通过"骗成绿标。
 */
import { nativePrinter, type NativePaper } from "@/lib/native";

export type PrintVerify =
  | { mode: "device"; ok: boolean; at: string; message: string }
  | { mode: "none"; at: string; message: string };

/** 这个参数改动是否需要先验一次小票机（只有会把单据打到热敏机的选项才要） */
export function needsPrintVerify(key: string, value: string): boolean {
  if (key === "print_channel") return value === "raw";
  if (key === "print_paper") return value === "thermal80" || value === "thermal58";
  return false;
}

/** 纸宽 → 栅格列数（与 Rust `Paper::cols()` 同一口径，只在这里映射一次） */
export const PAPER_COLS: Record<NativePaper, number> = { p80: 48, p58: 32 };

/** 配置里的 VID/PID 手写成 "0x0483" 这样的十六进制串，这里统一转数字 */
export function parseHex(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  const n = s.startsWith("0x") ? Number.parseInt(s.slice(2), 16) : Number.parseInt(s, 16);
  return Number.isFinite(n) ? n : null;
}

/**
 * 验一次小票机：只发状态查询，不出纸——改配置不该浪费一张票。
 * `sel` 省略时由 Rust 侧取枚举到的第一台（换 USB 口、换机器时不至于瘫在旧配置上）。
 */
export async function verifyReceiptPrinter(sel?: { vid?: number; pid?: number; paper?: NativePaper }): Promise<PrintVerify> {
  const at = stamp();
  const r = await nativePrinter.status({ vid: sel?.vid, pid: sel?.pid });
  if (!r.available) return { mode: "none", at, message: "浏览器预览没有原生通道，本次配置未经真机验证" };
  if (r.error) return { mode: "device", ok: false, at, message: `联机测试失败：${r.error}` };
  const s = r.data?.status;
  if (!s) return { mode: "device", ok: false, at, message: "设备未返回状态" };
  if (!s.responding) return { mode: "device", ok: false, at, message: `设备未应答状态查询（${s.note || s.source}）` };
  if (!s.online) return { mode: "device", ok: false, at, message: "设备未联机（检查脱机键、上盖与纸卷）" };
  const paper = s.paperAdequate ? "" : "；纸将尽或缺纸";
  const byte = s.rawByte === null ? s.source : `状态字节 0x${s.rawByte.toString(16).toUpperCase().padStart(2, "0")}`;
  return { mode: "device", ok: true, at, message: `设备已应答（${byte}）${paper}` };
}

/** `yyyy-MM-dd HH:mm:ss`，用于 last_ok_at 一类的留痕时刻 */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
