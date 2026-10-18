/**
 * 分度取整（整量化）的前端半边 —— 与 Rust `src-tauri/src/scale.rs::Align` 同口径。
 *
 * 干什么用：`weigh_record` 一次捕获存两个数——`weight_01kg` 是原始读数，
 * `aligned_weight_01kg` 是按这台磅的**分度值**取整后的法定读数（04 §2.4 第 4 点
 * 「存原始值 + 取整值」）。真机上取整发生在服务端（`scale::capture_align`），
 * 这个模块承担两件事：
 *
 *  1. **浏览器演示（mock）里的那一次取整**：没有 Rust 就得有人算，而算错一位
 *     演示数据就会与装机版对不上，纸面 review 看不出、现场看得出来；
 *  2. **自检的靶子**（`scripts/scale-align/check.ts`）：两边吃同一份用例表
 *     （`scripts/scale-align/cases.json`），Rust 的 `Align::apply` 与本函数各自跑一遍。
 *     谁改了口径、只改一边，另一边就红。
 *
 * 分度值从哪来（与 `capture_align` 逐条同口径）：只读这台磅的帧模板 `align` 段
 * （04 §2.3），**不读站点参数**——`scale_division_01kg` / `weight_rounding_mode` 已在
 * 0032 退役，它们只驱动过屏幕上的一行字、不驱动任何计算，而分度值是设备属性
 * （1 号磅 10 kg、2 号磅 20 kg 是合法现场，一枚全局键表达不了）。
 * 台账里没有启用的磅就回 [`ALIGN_NONE`]：没有设备就没有分度，整量化 = 读数，
 * 绝不拿文档默认的 10 kg 去改动磅员亲手敲进去的数。
 */

/** 与 Rust `scale::Align` 逐字一致的形状（`config_json` 的 `align` 段，snake_case 直通） */
export interface ScaleAlign {
  /** 分度值，0.1 kg 为单位：100 = 10 kg；`<= 0` 等于不取整 */
  division_01kg: number;
  /** `nearest_div` | `floor_div` | `ceil_div` | `none`；认不出的值按 `nearest_div` 走（与 Rust 的 `_` 分支一致） */
  mode: string;
}

/** 「这一现场说不清分度值」那一档：原样回传（Rust `Align::none()`） */
export const ALIGN_NONE: ScaleAlign = { division_01kg: 0, mode: "none" };

/** 文档默认（Rust `Align::default()`：60 t 汽车衡 10 kg、就近分度） */
export const ALIGN_DEFAULT: ScaleAlign = { division_01kg: 100, mode: "nearest_div" };

/**
 * 分度取整。逐式对齐 `scale.rs::Align::apply`：
 *  - `d <= 0` 或 `mode` 为 `none`/空串 → 原样；
 *  - `floor_div` 向下（含负值方向，`div_euclid` 是地板除）；`ceil_div` 向上；
 *  - 其余（含 `nearest_div`）按 `d/2` 偏移做四舍五入，**负值远离零**进位，与仪表显示一致。
 *
 * 全程只在整数上算（0.1 kg 为单位），不引浮点：`Math.round(w / d) * d` 那种写法在
 * `d` 不整除时会经过 double，与 Rust 的整数式在边界值上可能差一格。
 */
export function applyAlign(w01kg: number, align: ScaleAlign): number {
  const d = align.division_01kg;
  if (d <= 0) return w01kg;
  switch (align.mode) {
    case "none":
    case "":
      return w01kg;
    case "floor_div":
      return Math.floor(w01kg / d) * d;
    case "ceil_div":
      return -Math.floor(-w01kg / d) * d;
    default:
      // Rust 的 `(w + d / 2) / d * d`：`d / 2` 也是整数除（先截半，再整除，再乘回）
      return w01kg >= 0
        ? Math.floor((w01kg + Math.floor(d / 2)) / d) * d
        : -Math.floor((Math.abs(w01kg) + Math.floor(d / 2)) / d) * d;
  }
}

/** [`captureAlign`] 只用到台账这几列，形参写成结构类型以免 lib 反向依赖 mock 的整张 DTO */
export interface AlignCarrier {
  id: number;
  kind: string;
  is_enabled: number;
  is_default: number;
  config: Record<string, unknown>;
}

/**
 * 这一现场落库该按什么取整：取「启用 + 默认优先」那台磅的 `align`。
 *
 * 挑哪台磅的 SQL 口径与 `orders::default_scale_id` 一字不差
 * （`kind='scale' AND is_enabled=1 ORDER BY is_default DESC, id LIMIT 1`）——
 * 轨迹里 `device_id` 指着那台磅，取整依据若是另一台，同一行数据就自相矛盾了。
 *
 * 读 `align` 的顺序照 [`alignOf`]。
 */
export function captureAlign(devices: AlignCarrier[]): ScaleAlign {
  const scales = devices
    .filter((d) => d.kind === "scale" && d.is_enabled === 1)
    .sort((a, b) => b.is_default - a.is_default || a.id - b.id);
  const dev = scales[0];
  if (!dev) return ALIGN_NONE;
  const align = alignOf(dev.config);
  // 与 `resolve_template` / `capture_align` 同一条离谱值判据：分度大过 100000 kg 不可能是
  // 汽车衡，宁可退回不取整，也不让 564.0 被"就近"成 0.0。
  if (align.division_01kg > 1_000_000) return ALIGN_NONE;
  return align;
}

/**
 * 一台设备的 `config` → 取整口径。
 *
 * 两种写法都吃，因为台账里两种都真实存在：
 *  1. **嵌套帧模板**（`config_json` 直接摊平成 `config`）：读 `align.division_01kg` /
 *     `align.mode`，这是装机版读线程用的同一份东西；
 *  2. **扁平表单**（设备中心「编辑」只给波特率与帧族）：装机版在这一步会套驱动预设
 *     （`scale.rs::maybe_apply_driver_preset`），而预设表在 Rust 里，前端不抄一份
 *     （抄了就是第三处真相）；mock 侧的台账用 `division: "10 kg"` 这类人话字符串
 *     表达分度，这里解析它。
 *
 * 都没有就回 [`ALIGN_DEFAULT`]（与 Rust `Align::default()` 同值），
 * 因为「这台磅的模板没写 align」在两边都意味着"用文档默认的 10 kg 就近分度"，
 * 而不是"不取整"——不取整只发生在**压根没有启用的磅**那一档，见 [`captureAlign`]。
 */
export function alignOf(config: Record<string, unknown>): ScaleAlign {
  const nested = config.align;
  if (nested && typeof nested === "object") {
    const o = nested as Record<string, unknown>;
    const d = toInt(o.division_01kg);
    if (d !== undefined && d > 0) {
      return { division_01kg: d, mode: typeof o.mode === "string" ? o.mode : ALIGN_DEFAULT.mode };
    }
    // 写了 align 段却没写得出分度值：与 Rust `parse_template` 的"字段缺落到文档默认值"同口径
    if (d !== undefined) return ALIGN_NONE;
  }
  const flat = parseDivision(config.division);
  return flat !== undefined ? { division_01kg: flat, mode: ALIGN_DEFAULT.mode } : ALIGN_DEFAULT;
}

/** `"10 kg"` / `"10kg"` / `"0.5 t"` / `100`（已是 0.1 kg 的整数）→ 0.1 kg 单位的分度值 */
function parseDivision(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : undefined;
  if (typeof v !== "string") return undefined;
  const m = /^\s*([\d.]+)\s*(t|kg)?\s*$/i.exec(v);
  if (!m) return undefined;
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = (m[2] ?? "kg").toLowerCase();
  return Math.round(unit === "t" ? n * 10000 : n * 10);
}

function toInt(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : undefined;
  }
  return undefined;
}
