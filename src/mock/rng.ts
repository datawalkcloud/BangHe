/**
 * 造数工具：种子随机 + 本地时间 + 定点数对齐 + 合规证件号。
 *
 * 用种子随机而不是 Math.random()，是为了**刷新后所有数字完全一致**——
 * 否则截图、验收清单、报表对账都无法复现。
 */

import { ALIGN_DEFAULT, applyAlign } from "@/lib/scale-align";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

/** 本地时间 + 偏移，形如 2026-09-10T08:12:33+08:00（03 §3.2，刻意不用 UTC） */
export function isoOf(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(base: Date, days: number): Date {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

export function atTime(base: Date, dayOffset: number, hh: number, mm: number, ss: number): string {
  const d = addDays(base, dayOffset);
  const total = hh * 3600 + mm * 60 + ss;
  d.setHours(Math.floor(total / 3600) % 24, Math.floor((total % 3600) / 60), total % 60, 0);
  return isoOf(d);
}

/** 把"分钟数"折算成时刻并自动跨小时，避免手写 %24 出错 */
export function atMinute(base: Date, dayOffset: number, minutesFromMidnight: number, ss: number): string {
  return atTime(base, dayOffset, Math.floor(minutesFromMidnight / 60), minutesFromMidnight % 60, ss);
}

export function todayBase(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * 汽车衡分度值对齐（03 §3.1 规则 5）：造出来的种子重量必须像真仪表吐的数——
 * 只能落在分度值的整数倍上，否则「读数」那一栏本身就是一条不可能的记录。
 *
 * 公式不再在这里写第二份（从前是 `Math.round(v / 100) * 100`）：同一条口径的唯一实现是
 * `lib/scale-align.ts::applyAlign`，它与装机版 `scale.rs::Align::apply` 吃同一份用例表
 * （`scripts/scale-align/cases.json`）互相对拍，改一边就红。分度值取文档默认 100（=10 kg），
 * 与 mock 台账里 1 号磅的 `division: "10 kg"` 同一个数——这条相等关系由那个自检钉住。
 */
export function alignDiv(v01kg: number): number {
  return applyAlign(v01kg, ALIGN_DEFAULT);
}

/**
 * 取整与货款公式不在 mock 里重写：唯一同构版在 `lib/calc.ts`，
 * 保证造数据用的公式与界面试算、未来后端公式是同一个。（05 §8）
 */
export { amountFen, roundHalfUp } from "@/lib/calc";

const AREA = ["411323", "411324", "410327", "420625", "340825", "371522", "130433", "410526"];

/** 造一个 GB 11643 校验位正确的身份证号，便于验证掩码与校验函数 */
export function makeIdCard(int: (a: number, b: number) => number, pick: <T>(l: readonly T[]) => T): string {
  const area = pick(AREA);
  const body = `${area}${int(1958, 2003)}${pad(int(1, 12))}${pad(int(1, 28))}${pad(int(0, 999), 3)}`;
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkChars = "10X98765432";
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(body[i]) * weights[i];
  return body + checkChars[sum % 11];
}

const PROVINCE = ["豫A", "豫P", "豫K", "豫M", "鄂F", "皖S", "冀D"];
const PLATE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function makePlate(int: (a: number, b: number) => number, pick: <T>(l: readonly T[]) => T): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += i % 2 === 0 ? PLATE_CHARS[int(0, 23)] : String(int(0, 9));
  return pick(PROVINCE) + s;
}
