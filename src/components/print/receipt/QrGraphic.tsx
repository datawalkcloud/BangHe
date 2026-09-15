/**
 * 小票上的二维码图形（A4 / 针式与屏幕预览这一侧）。
 *
 * 热敏纸上的码不是这里画的——那是 Rust `ticket-core` 发 ESC/POS 的 `qrcode` 指令，
 * 由机器固件自己排点。这里只负责**不走小票机的那两条出纸路**（窗口打印、屏幕预览）。
 * 于是必须和机器对齐的是**尺寸档位表**本身：两边的模块边长都出自 `code-size.ts`
 * 的同一张表（档位 → 点 → ×0.125mm），模板里选的档位既进这里的 SVG、也进 ESC/POS 的
 * `size` 参数（见 `escpos.ts` 往 qr 行上挂的 `size`）。从前这里改档位在纸上毫无效果——
 * 机器恒用 `QRCodeOption::default()` 的 4 点，站长调到「超大」也只在大纸上看得见。
 *
 * 还有一个数必须一致，对不齐就是"预览里扫不出来 / 纸上能扫"或反过来：
 *  - **纠错等级 H**：`escpos` crate 的 `QRCodeOption::default()` 就是 H（30% 恢复），
 *    粮站的票要在口袋里揣一周、晒一个月，H 不是奢侈是必需。前端跟它同一个等级，
 *    两边生成的模块矩阵才相同，预览所见即纸上的点阵。
 */
import { useMemo } from "react";
import QRCode from "qrcode";
import { CODE_SCALE_DOTS, type CodeScale, DOT_MM } from "./code-size";

/** 静区（二维码四周留白）：规范要求的 4 个模块，机器侧由固件自己留，画 SVG 必须自己补上 */
const QUIET = 4;

/** 按纠错 H 生成模块矩阵（与热敏固件同等级，两边矩阵才相同）。编不出来返回 null */
function buildQr(m: string): { size: number; data: ArrayLike<number> } | null {
  try {
    const qr = QRCode.create(m, { errorCorrectionLevel: "H" });
    return { size: qr.modules.size, data: qr.modules.data as ArrayLike<number> };
  } catch {
    // 载荷超出版本 40 的容量（现实中不可能：码里只有一个单号），或字符集不受支持
    return null;
  }
}

/**
 * 载荷编成二维码后的边长（点，含静区）。
 *
 * 热敏那一路算"码在纸上落在第几个点"要用它（见 `code-size.ts::codeOffsetDots`）：
 * 二维码由固件自己排点，我们唯一能控制的只有让它从哪个位置开始排。
 */
export function qrSideDots(text: string, scale: CodeScale): number | null {
  const built = buildQr(text.trim());
  if (!built) return null;
  return (built.size + QUIET * 2) * CODE_SCALE_DOTS[scale];
}

/**
 * 载荷编成二维码后的物理边长（mm，含静区）。编辑器用它报"这一档实际多大"，
 * 与这里画 SVG 用的是同一个式子——写进说明里的数字必须和票面上量得出来的一致。
 */
export function qrSideMm(text: string, scale: CodeScale): number | null {
  const dots = qrSideDots(text, scale);
  return dots == null ? null : dots * DOT_MM;
}

export function QrGraphic({
  text,
  scale = 2,
  className,
}: {
  /** 已解析完占位的最终载荷，空串不画 */
  text: string;
  /** 尺寸档位，对应 ReceiptSection.qrScale */
  scale?: CodeScale;
  className?: string;
}) {
  const m = text.trim();
  const built = useMemo(() => (m ? buildQr(m) : null), [m]);

  if (!m) return null;

  const side = (built ? built.size : 0) + QUIET * 2;
  const mm = CODE_SCALE_DOTS[scale] * DOT_MM * side;

  if (!built) {
    return (
      <div className={`border border-black px-2 py-1 text-center text-[10px] ${className ?? ""}`} style={{ width: `${mm || 20}mm` }}>
        二维码无法生成：{m}
      </div>
    );
  }

  const n = built.size;
  // 所有黑模块合成一条 path：40×40 的矩阵也不会在打印时生成上千个 DOM 节点
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (built.data[y * n + x]) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
    }
  }

  return (
    <svg
      className={className}
      width={`${mm}mm`}
      height={`${mm}mm`}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      // 静区必须是纯白：热敏纸底色本就是白，但屏幕预览在暗色主题下不能让页面底色渗进码里
      style={{ background: "#fff", display: "block" }}
      role="img"
      aria-label={`二维码 ${m}`}
    >
      <rect width={side} height={side} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}
