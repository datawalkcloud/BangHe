/**
 * 码的尺寸：屏幕预览、A4 / 针式队列直打、热敏机三条出纸路共用的唯一一张表。
 *
 * 为什么以"点"而不是"毫米"为单位：热敏机的物理栅格就是点（203dpi，1 点 = 0.125mm），
 * 二维码的 `size` 指令和一维码的模块宽、条高都必须落在整数个点上——写成毫米再换算，
 * 预览是 0.35mm/模块、纸上是 3 点（0.375mm），两边永远差一点，而这一点正是"预览扫得动、
 * 纸上扫不动"的来源。所以这里把点当基本单位，毫米一律由 `DOT_MM` 乘出来。
 */
import type { PaperKind } from "@/lib/constants";
import { isRollPaper, PAPER_SPEC } from "./paper";

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
 * 纸面上码能打多宽（点）。
 *
 * 热敏纸取的是**机内栅格**而不是纸的标称宽度：58 纸可打 384 点、80 纸 512 点（203dpi），
 * 也就是 48 / 64mm——纸边那 5~8mm 是走纸轮压着的，码打上去就是被切掉一半的废票。
 * 定长纸（A4 / 241）反过来，页边距内都是可打区。
 */
export function printableDots(paper: PaperKind): number {
  if (paper === "thermal58") return 384;
  if (paper === "thermal80") return 512;
  const m = PAPER_SPEC[paper].marginMm;
  return Math.round((PAPER_SPEC[paper].widthMm - m.left - m.right) / DOT_MM);
}

/** 同上，按毫米报（编辑器里"这一档实际多大"给人的是毫米） */
export function printableMm(paper: PaperKind): number {
  return dotsToMm(printableDots(paper));
}

/**
 * 打印头的点宽（203dpi）。这是**机身属性**，按机器装的那卷纸推：58 机 384 点（48mm）、
 * 80 机 576 点（72mm）。
 *
 * 它和纸宽不是一回事，两者都可能是窄的那一方：80 纸 640 点比 576 点宽（纸边各 4mm 打不到），
 * 58 纸 464 点比 576 点窄（机身有 10mm 宽的纸边用不上）。码的横向落点算的就是这个差。
 */
function headDots(paper: PaperKind): number {
  return paper === "thermal58" ? 384 : 576;
}

/** 卷纸的整幅点宽（含纸边那圈不可用区）：58 → 464，80 → 640。定长纸返回 0（不参与热敏落点） */
function rollDots(paper: PaperKind): number {
  return isRollPaper(paper) ? Math.round(PAPER_SPEC[paper].widthMm / DOT_MM) : 0;
}

/**
 * 码的宽度预算（点）：票面纸型的可打宽度，与机器头宽里更窄的那个。
 *
 * `machinePaper` = 这次出纸**告诉机器的**那张纸（`print_receipt` 的 paper 参数）。
 * 票面按 80 排、机器却是 58 时，预算被机头压到 384 点——不改的话码按 64mm 算出来，
 * 机器根本打不下，右半截直接消失。
 */
export function codeBudgetDots(paper: PaperKind, machinePaper?: PaperKind): number {
  const base = printableDots(paper);
  return isRollPaper(paper) && machinePaper ? Math.min(base, headDots(machinePaper)) : base;
}

/**
 * 码的横向落点（点，从**打印头左端**起算）。
 *
 * 为什么不让固件居中：`ESC a 1` 按**打印机自己认的可打宽度**居中，而那个数只跟机身有关、
 * 与这卷纸无关。80 机装 58 卷时机身仍按 576 点（72mm）居中，48mm 宽的条码就落在 12~60mm，
 * 而纸只有 58mm——右端连着停止符一起被切在纸外，票看着打出来了，扫码枪却读不出来。
 * 正文早就按这条原则办了（`render.rs::aligned` 用前导空格补齐，不交给 `ESC a`），
 * 码是最后两个漏网的；现在落点在这里一次算清，机器只负责照点排（见 `escpos.ts` 与
 * `render.rs::barcode`）。
 *
 * 轴取"纸"与"头"里更窄的那个，理由是纸在机身上的装法只有两种：
 *  - 纸比头窄（58 卷装在 80 机上）——卷贴着头的左端，于是"在卷上居中"就是"在这个更窄的轴里居中"；
 *  - 纸比头宽（80 纸对 576 点头）——卷在头下面居中，量到卷心的距离恰好就是头宽本身。
 * 后一种正是固件一直在用的轴，于是**装态一致的站点（票面纸型 = 机器纸型）这一改分毫不动**。
 *
 * 与预览的关系：预览把码居中画在纸宽里，所以这里的落点也按纸算，两边才重合。
 */
export function codeOffsetDots(codeDots: number, paper: PaperKind, machinePaper?: PaperKind): number {
  const roll = rollDots(paper);
  if (roll === 0) return 0; // 定长纸走打印队列，落点由驱动的可打区说了算，见 queue_print.rs
  const axis = Math.min(roll, headDots(machinePaper ?? paper));
  return Math.max(0, Math.round((axis - codeDots) / 2));
}

/** 再压也不能低于 1 点（0.125mm）：栅格画不出半个点，细于 1 点的模块会整条消失 */
export const MIN_MODULE_DOTS = 1;

/**
 * 一维码放不进纸宽时，把模块宽度压到刚好放得下——**按实数压，不落到整数点上**。
 *
 * 为什么不能只压到整数点：模块数一旦超过纸宽点数的一半，整数档位之间就没有中间值了。
 * 实测这条凭证载荷（20 字符 → 连静区 253 个模块）落在 58 纸的 384 个可打点上：
 *   - 1 点/模块 → 条身 233 点 = 29mm，只有 58mm 纸的一半，而且细到枪读不动；
 *   - 2 点/模块 → 466 点 = 58mm，直接顶出纸外（正是"条码超出纸张"那一次）；
 *   - 真正该用的是 384/253 ≈ 1.52 点/模块：整条铺满可打宽度，模块宽 0.19mm，
 *     仍然在扫码枪读得动的那一档。
 * 也就是说，"压小"和"占满纸宽"本不该互斥——互斥是"只取整数点"这个写法造出来的。
 *
 * 这条压缩**必须**同时作用于预览和出纸，否则就退回"预览一套、纸上一套"的老坑：
 * 站长在预览里看到码放得好好的，纸上右半边被切掉，客户站在结算窗口才发现。
 * 所以它写在取码几何的那一处（`code128.ts` 的 `measureCode128`），两个渲染器都只调它。
 *
 * 返回值是**实数**（点/模块）：预览按它画（SVG 认小数），热敏栅格按它折算成每段整数点宽
 * （见 `code128.ts::widthDots` 与 `render.rs::barcode`）。三处宽度因此仍是同一个数。
 */
export function fitModuleDots(totalModules: number, maxDots: number, want: number): number {
  if (totalModules <= 0) return want;
  return Math.max(MIN_MODULE_DOTS, Math.min(want, maxDots / totalModules));
}
