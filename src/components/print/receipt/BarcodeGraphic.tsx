/**
 * 小票上的一维条码图形（CODE128，屏幕预览与 A4 / 针式这一侧）。
 *
 * 与二维码的分工一样：热敏纸上的码不在这里画——那是 Rust 把同一份 `runs` 数组排成
 * `GS v 0` 栅格发出去的。这里只负责不走小票机的那两条出纸路（窗口打印、屏幕预览）。
 *
 * 几何全部来自 `code128.ts` 的 `measureCode128`（含"放不下就压到 1 点/模块"那条规则），
 * 单位仍是以 203dpi 的点为准（见 `code-size.ts`），所以预览里量到的毫米数与热敏纸上的
 * 毫米数是同一个式子算出来的，不是肉眼对出来的。
 */
import { BARCODE_HEIGHT_DOTS, DOT_MM } from "./code-size";
import { CODE128_QUIET_MODULES, type BarcodeGeometry } from "./code128";

export function BarcodeGraphic({
  geo,
  text,
  className,
}: {
  /** 已量好尺寸的条码（条空序列 + 模块点数），null 由调用方挡住 */
  geo: BarcodeGeometry;
  /** 码里装的原文，只用于无障碍朗读（画什么全看 geo） */
  text: string;
  className?: string;
}) {
  const quiet = CODE128_QUIET_MODULES;
  const bars = BARCODE_HEIGHT_DOTS / geo.dots; // 条高换算成"模块"这个 viewBox 单位
  let x = quiet;
  let d = "";
  // 偶数位是条、奇数位是空：CODE128 的码字天然 3 条 3 空交替，串起来仍是交替的
  geo.runs.forEach((w, i) => {
    if (i % 2 === 0) d += `M${x} 0h${w}v${bars}h-${w}z`;
    x += w;
  });

  return (
    <svg
      className={className}
      width={`${geo.widthMm}mm`}
      height={`${BARCODE_HEIGHT_DOTS * DOT_MM}mm`}
      viewBox={`0 0 ${geo.modules} ${bars}`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      // 静区必须纯白：暗色主题下不能让页面底色渗进码里，扫码枪把浅色当条就废了
      style={{ background: "#fff", display: "block" }}
      role="img"
      aria-label={`条码 ${text}`}
    >
      <rect width={geo.modules} height={bars} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
