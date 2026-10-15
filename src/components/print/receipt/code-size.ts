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
export function headDots(paper: PaperKind): number {
  return paper === "thermal58" ? 384 : 576;
}

/** 卷纸的整幅点宽（含纸边那圈不可用区）：58 → 464，80 → 640。定长纸返回 0（不参与热敏落点） */
export function rollDots(paper: PaperKind): number {
  return isRollPaper(paper) ? Math.round(PAPER_SPEC[paper].widthMm / DOT_MM) : 0;
}

/**
 * 码的宽度预算（点）：票面纸型的可打宽度，与这次出纸那张纸的可打宽度里**更窄的那个**。
 *
 * `machinePaper` = 这次出纸**告诉机器的**那张纸（`print_receipt` 的 paper 参数）。
 * 票面按 80 排、机器却是 58 时，预算被压到 384 点——不改的话码按 64mm 算出来，
 * 机器根本打不下，右半截直接消失。
 *
 * 2026-09-15 的另一半事故：收口原先挂在**票面**是不是卷纸上（`isRollPaper(paper)`）。
 * 票面声明 A4 的结算凭证从热敏机出来时，这一条直接不成立，预算就成了 A4 的 182mm——
 * 一条 126mm 宽的 CODE128 原样发给可打只有 48mm 的那卷纸，右半截连着停止符一起出纸，
 * 就是"结算凭证的条码超出纸张"那一次。规矩定在这里：**只要出纸的那台机器报了纸型，
 * 预算就以那张纸为准**，票面写的是 A4 还是 241 都不例外——票面的正文本来就由 Rust 按
 * 机器列数（`Paper::cols`）重排到那卷纸上，码没有理由继续按票面声明的纸宽要地方。
 *
 * 收的是**可打宽度**而不是机头宽度：80 机的头 576 点，那卷纸只有 512 点可打，
 * 按头收会让码的右端压进纸边那圈走纸轮压着的白边（一致装态下两者的差正好被 `min` 吸收，
 * 所以 58/80 热敏票面的预算数值与改前完全相同）。
 */
export function codeBudgetDots(paper: PaperKind, machinePaper?: PaperKind): number {
  const base = printableDots(paper);
  return machinePaper ? Math.min(base, printableDots(machinePaper)) : base;
}

/**
 * 卷纸在机头下的左沿（头坐标，可为负 = 卷比头宽、纸从两头探出去）。
 *
 * 走纸机构（纸仓壁或 58mm 定心隔套）一律把卷**居中**卡在机头下，所以这条式子对两种
 * 装态都成立：卷比头宽时纸从两边各探出一点，卷比头窄时纸缩在头的中段。
 * 结论是那句关键的：**卷的中线与头的中线是同一条线**。
 */
export function rollLeftDots(paper: PaperKind, machinePaper?: PaperKind): number {
  return (headDots(machinePaper ?? paper) - rollDots(paper)) / 2;
}

/**
 * 码的横向落点（点，从**打印头左端**起算）。
 *
 * **轴就是机头宽度。** 因为卷在机头下是居中的（见 [`rollLeftDots`]），
 * "在纸上居中"与"在机头上居中"是同一件事，落点于是恒为 `(头宽 − 码宽) / 2`。
 *
 * 这样定还与票上其余各行同一条轴：正文靠 `render.rs::aligned` 往 `cols` 列里补空格，
 * 而 `cols × 12 点` 正是头宽；码下方那行可读内容也走 `aligned`。三者同轴，
 * 码才不会和它自己的说明文字错开——从前按"卷幅"算落点，正文按头宽算，
 * 两者在 80 机装 58 卷时差 56 点（7mm），一眼就看得出是歪的。
 *
 * 为什么不交给固件的 `ESC a 1`：它居中的基准是**机身认的可打宽度**，是厂商写死的数，
 * 未必等于我们这里推出来的头宽，也不保证与正文那条轴重合。而二维码更没有别的选择
 * ——`GS ( k` 从当前位置起排点，只能靠前导空格推。两个码因此都在这里一次算清，
 * 机器只负责照点排（见 `escpos.ts` 与 `render.rs::barcode`）。
 *
 * **宽度预算（[`codeBudgetDots`]）才是"别出纸"那一半**，两者别混：预算按"票面纸型
 * 的可打宽度 ∩ 机头宽度"收，保证码不会宽过纸；落点只管把这条已经放得下的码摆到纸中间。
 * 2026-09-15 的现场事故就是把落点当成了第二道保险，结果 80 机装 58 卷时条码贴着纸的
 * 左边缘（左留白 1 点、右留白 112 点），看着就是左对齐。
 *
 * **轴认的是"这次出纸落在那张纸上"，不是票面声明的那张**：票面 A4 的结算凭证从热敏机
 * 出来时，正文已经被 Rust 按机器列数重排到那卷纸上，码却因为在票面上量不出卷纸而
 * 一律返回 0（贴着头左端起排）——既不居中，也与正文那条轴错开。所以判据取
 * `machinePaper ?? paper`：出的是卷纸就居中，出的是定长纸（走打印队列、可打区由驱动给）
 * 才返回 0。装态一致时（票面纸型 = 机器纸型）这个值与改前完全相同，老站点分毫不动。
 */
export function codeOffsetDots(codeDots: number, paper: PaperKind, machinePaper?: PaperKind): number {
  const out = machinePaper ?? paper; // 码真正落在的那张纸
  if (!isRollPaper(out)) return 0; // 定长纸走打印队列，落点由驱动的可打区说了算，见 queue_print.rs
  const head = headDots(out);
  return Math.max(0, Math.round((head - codeDots) / 2));
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

/**
 * 二维码的模块宽度（点/模块）：放不进预算时**向下取整**压档，绝不放大。
 *
 * 与一维码那条 [`fitModuleDots`] 刻意不同——一维码的条空由我们自己排 `GS v 0` 栅格，
 * 模块宽度可以是实数（Rust 按累计模块数把总宽分摊到整数点上）；二维码却是**固件**排点，
 * `GS ( k` 的 `size` 只认 1~16 的整数点，给不了 1.52。于是窄纸上的二维码只能整档地缩，
 * 而"向下"是硬要求：向上取整就是主动把码打出纸外，正是 2026-09-15 那次的另一半
 * （票面 A4 的凭证里那枚码按 182mm 的纸要地方，机器只有 48mm 可打）。
 *
 * 压到不足 1 点也按 1 点算：再小固件根本打不出来，宁可让纸裁掉右半截，
 * 也不能发一个 0 过去让机器什么都不打。
 */
export function fitQrModuleDots(totalModules: number, maxDots: number, want: number): number {
  if (totalModules <= 0) return want;
  return Math.max(MIN_MODULE_DOTS, Math.min(want, Math.floor(maxDots / totalModules)));
}
