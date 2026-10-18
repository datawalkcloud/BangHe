/**
 * CODE128 编码器（一维条码）。
 *
 * 为什么要有它：现场确有只认一维码的扫描枪——激光枪扫二维码是靠"模拟图像"硬解的，
 * 老型号根本解不动，而粮站结算窗口用的正是那种几十块钱的键盘口激光枪。票上只有二维码，
 * 客户递上来的就是一张扫不出来的纸。
 *
 * 为什么由我们算条空宽度、而不是让小票机自己画：
 *  ESC/POS 的 `GS k` 功能 A 只支持 UPC/EAN/CODE39/ITF/CODABAR 这七种，**没有 CODE128**
 *  （escpos 0.20 的 `BarcodeSystem` 就那几个枚举）；CODE39 的字符表里连 `:` 都没有，
 *  而存量票的载荷 `BH1:BD……` 偏偏以它开头（新载荷已是纯数字，见 02 §F1.4，但旧票还在流通里）。走 `GS ( k` 功能 B 要手搓字节、还得赌固件版本，
 *  而纸上一旦被固件自动压缩，预览里的宽度就成了假的。
 *  所以这里一次算出**条 / 空的模块宽度序列**，三条出纸路各自照着画：预览画 SVG、
 *  A4 走 GDI 涂方块、热敏发 `GS v 0` 栅格。宽度是同一个数组算出来的，
 *  "预览多宽的码、纸上就多宽"才是结构上成立的，而不是两处各自编码再盼它们一致。
 *
 * 表里的 107 个码字（0~105 六位、106 停止符七位）逐条对过两个独立来源
 * （GNU Barcode 的 `codeset[]` 与公开规范表），并由无头自检脚本
 * `scripts/receipt-code/` 把"每个码字 11 个模块、停止符 13 个模块、宽度只允许 1~4、
 * 107 个码字互不相同、校验码算法对得上规范样例"钉住。
 */
import { CODE_SCALE_DOTS, type CodeScale, dotsToMm, fitModuleDots, printableDots, scaleOf } from "./code-size";
import type { PaperKind } from "@/lib/constants";

/** 码值 → 条空宽度（从左到右，第一个元素一定是条）。索引即码值 */
const PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const START_B = 104;
const START_C = 105;
/** 码制切换：在 B 里发 99 进 C，在 C 里发 100 回 B */
const LATCH_C = 99;
const LATCH_B = 100;
const STOP = 106;

/** 静区：规范要求的 10 个模块宽，左右各一份。省了它就是"放在纸边上扫不出" */
export const CODE128_QUIET_MODULES = 10;

const isDigit = (ch: string) => ch >= "0" && ch <= "9";

/** Code B 覆盖 ASCII 32~127，码值 = 字符码 - 32；超出即编不了 */
function valueB(ch: string): number | null {
  const c = ch.charCodeAt(0);
  return c >= 32 && c <= 127 ? c - 32 : null;
}

/** 从 i 起连续数字的长度 */
function digitRun(data: string, i: number): number {
  let n = 0;
  while (i + n < data.length && isDigit(data[i + n])) n += 1;
  return n;
}

/**
 * 把字符串编成 CODE128 码值序列（含起始符、校验码、停止符）。
 *
 * 只用 B / C 两种码制：B 装下全部可打印 ASCII（凭票载荷就是 ASCII），
 * C 把连续数字两个一组压掉一半宽度——16 位单号全靠 B 编码是 209 个模块，
 * 80 热敏（可打 64mm）不压就放不下。A 码制只多出一批控制字符，票面用不到，
 * 需要它的地方也就不是单据了，故不实现（遇到非 ASCII 直接返回 null 让界面报错，
 * 绝不悄悄丢字——丢字产生的是一张扫出来对不上号的废票，比不打码更糟）。
 */
export function encodeCode128(data: string): number[] | null {
  if (!data) return null;
  const codes: number[] = [];
  // 整串是数字且个数为偶 → 直接 C 起步；否则 B 起步，遇到长数字串再咬合到 C
  let mode: "B" | "C";
  if (/^[0-9]+$/.test(data) && data.length % 2 === 0) {
    mode = "C";
    codes.push(START_C);
  } else {
    mode = "B";
    codes.push(START_B);
  }

  let i = 0;
  while (i < data.length) {
    const run = digitRun(data, i);
    if (mode === "C") {
      if (run >= 2) {
        codes.push(Number(data.slice(i, i + 2)));
        i += 2;
      } else {
        mode = "B";
        codes.push(LATCH_B);
      }
      continue;
    }
    // 4 位以上才值得切码制：为一个两位数来回切换反而多占一个码字
    if (run >= 4) {
      mode = "C";
      codes.push(LATCH_C);
      continue;
    }
    const v = valueB(data[i]);
    if (v == null) return null;
    codes.push(v);
    i += 1;
  }

  // 校验码 = (起始符 + Σ 位置×码值) mod 103，位置从 1 起算（起始符自身权重为 0）
  let sum = codes[0];
  for (let j = 1; j < codes.length; j++) sum += j * codes[j];
  codes.push(sum % 103);
  codes.push(STOP);
  return codes;
}

/**
 * 条 / 空宽度序列（单位：模块），第一个元素一定是条，奇数位是空。
 *
 * 相邻码字天然保持"条—空"交替（每个码字 3 条 3 空、以空收尾，停止符以条收尾且排在最后），
 * 所以直接串起来即可，不需要补空隙。
 */
export function code128Runs(data: string): number[] | null {
  const codes = encodeCode128(data);
  if (!codes) return null;
  const runs: number[] = [];
  for (const c of codes) {
    for (const ch of PATTERNS[c]) runs.push(Number(ch));
  }
  return runs;
}

/** 一条已量好尺寸、可以直接画的 CODE128 */
export interface BarcodeGeometry {
  /** 条空宽度序列（模块） */
  runs: number[];
  /**
   * 一个模块占几个点（203dpi，1 点 = 0.125mm）—— 放不下时已在此处压过。
   *
   * **可能是小数**：纸窄到"整数档之间没有中间值"时只能按实数压，
   * 否则整条码会从"铺满纸宽"直接掉到"只占半张纸"（见 `fitModuleDots` 的注释）。
   */
  dots: number;
  /**
   * 条身的**整数**点宽（不含左右静区）。
   *
   * 热敏栅格与横向落点只认这个数：`GS v 0` 按点排，落点也得落在点上，
   * 所以小数那一份在这里一次折好，Rust 那边不再自己乘（见 `render.rs::barcode`）。
   */
  widthDots: number;
  /** 总宽（模块），含左右静区 */
  modules: number;
  /** 总宽（mm），含左右静区——预览按它给 SVG 定宽，与纸上占的地方是同一个数 */
  widthMm: number;
  /** 用户原本想要的档位被压过 = 纸太窄，界面要如实说出来 */
  shrunk: boolean;
}

/**
 * 量一条条码在当前纸型上的几何：编码 + 静区 + 放不下时的等比压缩，一次算完。
 *
 * 预览与出纸都只调这个函数，两边看到的 `dots` 必然是同一个数。
 * 载荷含非 ASCII 时返回 null（画不出、也不该打）。
 *
 * `maxDots` 只有热敏直打那一路会传：那台机器装的纸可能比票面声明的更窄，
 * 宽度预算得跟着收（见 `code-size.ts::codeBudgetDots`）。不传 = 按票面纸型算，
 * 屏幕预览与 A4/针式队列都走这个口径。
 */
export function measureCode128(
  data: string,
  paper: PaperKind,
  scale: CodeScale | unknown,
  maxDots?: number,
): BarcodeGeometry | null {
  const runs = code128Runs(data);
  if (!runs) return null;
  const body = runs.reduce((a, b) => a + b, 0);
  const modules = body + CODE128_QUIET_MODULES * 2;
  const want = CODE_SCALE_DOTS[scaleOf(scale)];
  const dots = fitModuleDots(modules, maxDots ?? printableDots(paper), want);
  return {
    runs,
    dots,
    widthDots: Math.round(body * dots),
    modules,
    widthMm: dotsToMm(modules * dots),
    shrunk: dots < want - 1e-9,
  };
}
