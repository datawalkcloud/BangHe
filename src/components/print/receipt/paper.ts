/**
 * 纸张几何：真实物理尺寸（mm）。
 *
 * 预览与打印共用同一套 mm 尺寸，才能"所见即所得"——
 * 屏幕上按 mm 排版（96dpi 下 1mm 恰为 96/25.4 px），打印时把 @page 设成同尺寸、
 * 边距交给页面自身的 padding。于是"选 58 热敏"就是真的 58mm 宽，而不是一个近似的像素值。
 */
import type { PaperKind } from "@/lib/constants";

export interface MarginMm {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PaperSpec {
  /** 纸宽（mm），精确物理宽度 */
  widthMm: number;
  /** 纸高（mm）；卷纸（热敏 / 针式连续）为 null，高度随内容增长 */
  heightMm: number | null;
  /** 票内容与纸边的留白（mm） */
  marginMm: MarginMm;
  /** @page size 取值 */
  cssSize: string;
  /** 给人看的一行说明 */
  note: string;
}

export const PAPER_SPEC: Record<PaperKind, PaperSpec> = {
  A4: {
    widthMm: 210,
    heightMm: 297,
    marginMm: { top: 12, right: 14, bottom: 12, left: 14 },
    cssSize: "A4",
    note: "A4 · 210 × 297 mm 单页激光",
  },
  dot241: {
    // 241 针式连续纸：宽 241mm 固定，一联单据按 140mm 计（换联单可改此高度）
    widthMm: 241,
    heightMm: 140,
    marginMm: { top: 6, right: 10, bottom: 6, left: 10 },
    cssSize: "241mm 140mm",
    note: "241 针式 · 241 × 140 mm 连续纸（联单）",
  },
  thermal80: {
    widthMm: 80,
    heightMm: null,
    marginMm: { top: 3, right: 3, bottom: 3, left: 3 },
    cssSize: "80mm auto",
    note: "80 热敏 · 宽 80 mm 卷纸，长度随内容",
  },
  thermal58: {
    widthMm: 58,
    heightMm: null,
    marginMm: { top: 2, right: 3, bottom: 2, left: 3 },
    cssSize: "58mm auto",
    note: "58 热敏 · 宽 58 mm 卷纸，长度随内容",
  },
};

/** 1mm = 96/25.4 px（CSS 绝对单位，屏幕与打印一致） */
export const MM_TO_PX = 96 / 25.4;

export const mmToPx = (mm: number) => mm * MM_TO_PX;

/** 纸张在屏幕上的像素宽度 */
export const paperPxWidth = (kind: PaperKind) => mmToPx(PAPER_SPEC[kind].widthMm);

/** 纸张在屏幕上的像素高度（卷纸为 null） */
export const paperPxHeight = (kind: PaperKind) => {
  const h = PAPER_SPEC[kind].heightMm;
  return h == null ? null : mmToPx(h);
};
