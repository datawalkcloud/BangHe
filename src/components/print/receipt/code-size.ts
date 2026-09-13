/**
 * 码的尺寸：屏幕预览、A4 / 针式队列直打、热敏机三条出纸路共用的唯一一张表。
 *
 * 为什么以"点"而不是"毫米"为单位：热敏机的物理栅格就是点（203dpi，1 点 = 0.125mm），
 * 二维码的 `size` 指令和一维码的模块宽、条高都必须落在整数个点上——写成毫米再换算，
 * 预览是 0.35mm/模块、纸上是 3 点（0.375mm），两边永远差一点，而这一点正是"预览扫得动、
 * 纸上扫不动"的来源。所以这里把点当基本单位，毫米一律由 `DOT_MM` 乘出来。
 */
import type { PaperKind } from "@/lib/constants";
import { PAPER_SPEC } from "./paper";

/** 203dpi 热敏机一个点的物理边长（mm） */
export const DOT_MM = 0.125;

/**
 * 尺寸档位 → 一个模块占几个点。
 *
 * 2 档 = 4 点，正好是小票机固件的出厂值（escpos 的 `QRCodeOption::default().size() == 4`），
 * 也就是从前唯一能扫出来的那一档。1 档从前的 0.35mm 落到整数点上是 3 点（0.375mm），
 * 3 档从前的 0.7mm 是 6 点（0.75mm）——老模板存下的档位尺寸不变（差不到半个点），
 * 但从此在热敏机上也算数了：从前只有 A4 与预览认这个值，纸上恒为 4 点。
 */
export const CODE_SCALE_DOTS = { 1: 3, 2: 4, 3: 6, 4: 8, 5: 10 } as const;

export type CodeScale = keyof typeof CODE_SCALE_DOTS;

export const CODE_SCALE_LABEL: Record<CodeScale, string> = {
  1: "小",
  2: "中",
  3: "大",
  4: "特大",
  5: "超大",
};

/** 模板里存的是数字，可能被手改脏：认不出来就回落到「中」（= 机器出厂档），绝不放大 */
export function scaleOf(v: unknown): CodeScale {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5 ? v : 2;
}

/**
 * 一维码的条高（点）= 12mm。
 *
 * 不随模块宽度变：窄条加长并不会更好扫，扫码枪要的是"横向分辨率够 + 有足够瞄准余量"，
 * 而 58 纸纵向每一毫米都在拉长那张要塞进客户口袋的票。想要更高，靠的是尺寸档位旁边的
 * 留白，不是把条拉成一根柱子。
 */
export const BARCODE_HEIGHT_DOTS = 96;

export const barcodeHeightMm = () => BARCODE_HEIGHT_DOTS * DOT_MM;

/** 点 → mm */
export const dotsToMm = (dots: number) => dots * DOT_MM;

/**
 * 纸面上码能打多宽（mm）。
 *
 * 热敏纸取的是**机内栅格**而不是纸的标称宽度：58 纸可打 384 点、80 纸 512 点（203dpi），
 * 也就是 48 / 64mm——纸边那 5~8mm 是走纸轮压着的，码打上去就是被切掉一半的废票。
 * 定长纸（A4 / 241）反过来，页边距内都是可打区。
 */
export function printableMm(paper: PaperKind): number {
  if (paper === "thermal58") return dotsToMm(384);
  if (paper === "thermal80") return dotsToMm(512);
  const m = PAPER_SPEC[paper].marginMm;
  return PAPER_SPEC[paper].widthMm - m.left - m.right;
}

/**
 * 一维码放不进纸宽时，把模块点数压到放得下为止，最低 1 点（0.125mm，扫码枪的近距极限）。
 *
 * 这条压缩**必须**同时作用于预览和出纸，否则就退回"预览一套、纸上一套"的老坑：
 * 站长在预览里看到码放得好好的，纸上右半边被切掉，客户站在结算窗口才发现。
 * 所以它写在取码几何的那一处（`code128.ts` 的 `measureCode128`），两个渲染器都只调它。
 */
export function fitModuleDots(totalModules: number, paper: PaperKind, want: number): number {
  const max = printableMm(paper);
  let dots = want;
  while (dots > 1 && dotsToMm(totalModules * dots) > max) dots -= 1;
  return dots;
}
