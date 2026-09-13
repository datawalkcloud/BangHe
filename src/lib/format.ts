/**
 * 全链路唯一的数值换算与格式化出口。
 *
 * 约定（见 docs/design/03-技术架构与数据模型.md §3.1）：
 *  - 重量以 0.1kg 为单位存整数（字段后缀 `_01kg`），真实实现由 Rust 侧 rust_decimal 计算，
 *    这里只做展示层换算，业务计算不在前端发生
 *  - 金额以分为单位（`_fen`）
 *  - 单价以分/吨为单位存（`price_fen_per_ton`），界面一律按元/公斤录入与展示，不再出现元/吨、元/斤
 *  - 化验指标以 0.01% 为单位（`_001pct`）
 *
 * 除本文件外，任何组件与页面都不允许出现 `/10`、`*100` 之类的散落换算。
 */

const EMPTY = "—";

function group(n: number, digits: number): string {
  return n.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function nil(v: number | null | undefined): v is null | undefined {
  return v === null || v === undefined || Number.isNaN(v);
}

/** 0.1kg → "12,345.6 kg" */
export function weight(v01kg: number | null | undefined, withUnit = true): string {
  if (nil(v01kg)) return EMPTY;
  const kg = v01kg / 10;
  return `${group(kg, 1)}${withUnit ? " kg" : ""}`;
}

/** 0.1kg → "12.346 t"，汇总场景用 */
export function ton(v01kg: number | null | undefined, withUnit = true): string {
  if (nil(v01kg)) return EMPTY;
  const t = v01kg / 10000;
  return `${group(t, 3)}${withUnit ? " t" : ""}`;
}

/** 仅取公斤数值，用于比较与输入回填 */
export function toKg(v01kg: number): number {
  return v01kg / 10;
}

/** 用户输入的公斤数 → 0.1kg 整数 */
export function fromKg(kg: number | string): number {
  const n = typeof kg === "string" ? Number(kg.replace(/[,，\s]/g, "")) : kg;
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 10);
}

/** 分 → "¥4,287.60" */
export function money(fen: number | null | undefined, withSymbol = true): string {
  if (nil(fen)) return EMPTY;
  const y = fen / 100;
  return `${withSymbol ? "¥" : ""}${group(y, 2)}`;
}

/** 单价展示串，全站唯一口径：元/公斤 */
export function price(fenPerTon: number | null | undefined): string {
  if (nil(fenPerTon)) return EMPTY;
  return `${priceNumber(fenPerTon)} 元/公斤`;
}

/** 分/吨 → 元/公斤的纯数值，用于比较、输入回填与拼接 */
export function toYuanPerKg(fenPerTon: number): number {
  return fenPerTon / 1000 / 100;
}

/** 元/公斤，2 位小数、最多 3 位（0.001 元/公斤 = 1 元/吨），不带货币符 */
export function priceNumber(fenPerTon: number | null | undefined): string {
  if (nil(fenPerTon)) return EMPTY;
  return (Math.round(toYuanPerKg(fenPerTon) * 1000) / 1000).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
}

/** 元/公斤 → 分/吨整数 */
export function fromYuanPerKg(yuanPerKg: number | string): number {
  const n = typeof yuanPerKg === "string" ? Number(yuanPerKg.replace(/[,，\s]/g, "")) : yuanPerKg;
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100 * 1000);
}

/** 0.01% → "14.80 %" */
export function percent(v001pct: number | null | undefined, unit = " %"): string {
  if (nil(v001pct)) return EMPTY;
  return `${group(v001pct / 100, 2)}${unit}`;
}

export function fromPercent(pct: number | string): number {
  const n = typeof pct === "string" ? Number(pct) : pct;
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

/** g/L 直接展示 */
export function density(gL: number | null | undefined): string {
  if (nil(gL)) return EMPTY;
  return `${group(gL, 0)} g/L`;
}

/* ------------------------------------------------------------------ 大写金额 */

const CN_NUM = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];
const CN_UNIT = ["", "拾", "佰", "仟"];
const CN_SECTION = ["", "万", "亿", "兆"];

/**
 * 人民币大写。码单必印项（05 文档 §9）。
 * 例：428760 分 → "人民币肆仟贰佰捌拾柒元陆角整"
 */
export function rmbUpper(fen: number | null | undefined): string {
  if (nil(fen)) return EMPTY;
  if (fen === 0) return "人民币零元整";
  const negative = fen < 0;
  const abs = Math.abs(Math.round(fen));
  const jiao = Math.floor(abs / 10) % 10;
  const fenDigit = abs % 10;
  const yuan = Math.floor(abs / 100);

  let body = "";
  if (yuan > 0) {
    const digits = String(yuan).split("").reverse();
    let pendingZero = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      const d = Number(digits[i]);
      const sectionPos = i % 4;
      if (d === 0) {
        if (sectionPos === 0) {
          // 节末尾，交由节名处理
          pendingZero = false;
        } else {
          pendingZero = true;
        }
      } else {
        if (pendingZero) body += "零";
        pendingZero = false;
        body += CN_NUM[d] + CN_UNIT[sectionPos];
      }
      if (sectionPos === 0) {
        body += CN_SECTION[i / 4] ?? "";
      }
    }
    body += "元";
  }

  if (jiao === 0 && fenDigit === 0) {
    return `${negative ? "负" : ""}人民币${body || ""}整`;
  }
  let tail = "";
  if (jiao > 0) tail += CN_NUM[jiao] + "角";
  else if (yuan > 0 && fenDigit > 0) tail += "零";
  if (fenDigit > 0) tail += CN_NUM[fenDigit] + "分";
  return `${negative ? "负" : ""}人民币${body}${tail}`;
}

/* ---------------------------------------------------------------------- 时间 */

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function parts(iso: string): {
  y: string; m: string; d: string; hh: string; mm: string; ss: string;
} {
  const [datePart = "", timePart = ""] = iso.split("T");
  const [y = "", m = "", d = ""] = datePart.split("-");
  const t = timePart.replace(/Z|[+-]\d{2}:\d{2}$/, "");
  const [hh = "00", mm = "00", ss = "00"] = t.split(":");
  return { y, m, d, hh, mm, ss };
}

/** YYYY-MM-DD HH:mm:ss */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const p = parts(iso);
  return `${p.y}-${p.m}-${p.d} ${p.hh}:${p.mm}:${p.ss}`;
}

/** MM-DD HH:mm，列表用 */
export function dateTimeShort(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const p = parts(iso);
  return `${p.m}-${p.d} ${p.hh}:${p.mm}`;
}

export function date(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const p = parts(iso);
  return `${p.y}-${p.m}-${p.d}`;
}

export function time(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const p = parts(iso);
  return `${p.hh}:${p.mm}`;
}

/** 距今多久，用于在途作业停留时长 */
export function sinceMinutes(iso: string, now = new Date()): number {
  const then = new Date(iso.replace(" ", "T"));
  if (Number.isNaN(then.getTime())) return 0;
  return Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60000));
}

export function durationText(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  if (h < 24) {
    const m = minutes % 60;
    return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
  }
  // 挂起的旧单用天说，屏幕上不会出现“15907 分钟”这种要心算的数
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh === 0 ? `${d} 天` : `${d} 天 ${rh} 小时`;
}

/** 「距今多久」的口语版：0 分钟（包含时间戳在未来、凌晨打开当日预排单）说“刚刚” */
export function sinceText(iso: string, now = new Date()): string {
  const m = sinceMinutes(iso, now);
  return m <= 0 ? "刚刚" : durationText(m);
}

/* -------------------------------------------------------------------- 其他 */

/** 身份证号掩码：迎检需要完整证号时由站长单独导出 */
export function maskIdCard(id: string | null | undefined): string {
  if (!id) return EMPTY;
  if (id.length < 10) return id;
  return `${id.slice(0, 6)}${"*".repeat(id.length - 10)}${id.slice(-4)}`;
}

/** GB 11643 校验位，01 文档 F1.1 */
export function validateIdCard(id: string): boolean {
  const s = id.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(s)) return false;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkChars = "10X98765432";
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * weights[i];
  return checkChars[sum % 11] === s[17];
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 百分比展示（统计口径，输入为 0..1 的比值） */
export function ratioText(r: number | null | undefined, digits = 2): string {
  if (nil(r)) return EMPTY;
  return `${(r * 100).toFixed(digits)}%`;
}

export const NUM_CELL = "tnum text-right tabular-nums";

/** 表格空值占位，避免出现 0 与缺失混淆 */
export function orDash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return EMPTY;
  return String(v);
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 本地时区的 ISO 时刻（带 +08:00 偏移）。
 * 永远不要用 new Date().toISOString()：parts() 是按字面切分的，
 * UTC 串会让界面少显示 8 小时。
 */
export function nowLocalISO(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function shiftDay(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  dt.setDate(dt.getDate() + days);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
