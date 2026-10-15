/**
 * 主窗口的关闭行为（`user_preference` 里的 `window.close-behavior`）。
 *
 * 归属与工作台布局同一条：这是**每个人自己的本机偏好**——磅员想点 ✕ 收进右下角托盘，
 * 不该把站长那台也一起改了。所以走 `prefs` 通道（按账号一行、不写审计），
 * 而不是 `app_setting`（全站一份、站长改、留痕）。
 *
 * 值只写 JSON 字符串：`"exit"` / `"hide"`。判定在 Rust 侧
 * （`src-tauri/src/window.rs`）：前端只负责改这一行，改完下次点 ✕ 就生效，
 * 不需要任何"同步给后端"的动作——后端每次关窗都现读。
 */
import { prefsApi } from "@/lib/prefs-native";

/** 退出还是藏进托盘。存进库的就是这两个字面量 */
export type CloseBehavior = "exit" | "hide";

/**
 * 偏好键，与 Rust `window::CLOSE_BEHAVIOR_KEY` 同源，`tests/window_contract.rs` 钉着两边一致。
 * 值是 `"exit"` / `"hide"`；`"minimize"` 是上一版（收进任务栏）存下的名字，仍按隐藏处理。
 */
export const CLOSE_BEHAVIOR_KEY = "window.close-behavior";

/**
 * 没存过这一行时的默认行为：**藏进托盘**（与 Rust `CloseBehavior::DEFAULT` 同源，
 * `tests/window_contract.rs` 钉着两边一致）。磅房那台机器本来就该一直开着。
 *
 * 注意它与"读不到"是两回事：没登录 / 读失败时 Rust 侧一律按退出处理（宁可退得掉），
 * 只有"这个人从没设过"才走这个默认值。
 */
export const DEFAULT_CLOSE_BEHAVIOR: CloseBehavior = "hide";

const VALUES: readonly CloseBehavior[] = ["exit", "hide"];
/** 老值 → 新值。改过设置的人不该因为改名就丢掉偏好 */
const LEGACY: Record<string, CloseBehavior> = { minimize: "hide" };

/**
 * 从偏好原文解析，与 Rust `CloseBehavior::parse` 同口径：
 *  - **没存过**（`null` / `undefined`）→ [`DEFAULT_CLOSE_BEHAVIOR`]；
 *  - 存了但认不出来 → `"exit"`。
 *
 * 第二条是刻意的"与 Rust 对齐"而不是"与默认值对齐"：库里躺着一行看不懂的东西时，
 * Rust 关窗会走退出，界面上却高亮"隐藏"的话，就成了骗人的设置页。
 */
export function parseCloseBehavior(raw: string | null | undefined): CloseBehavior {
  if (raw == null) return DEFAULT_CLOSE_BEHAVIOR;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "string") return "exit";
    if (VALUES.includes(v as CloseBehavior)) return v as CloseBehavior;
    return LEGACY[v] ?? "exit";
  } catch {
    return "exit";
  }
}

export const windowApi = {
  readCloseBehavior: () => prefsApi.getPref(CLOSE_BEHAVIOR_KEY),
  /** 覆盖式写入，返回落库时间。浏览器预览落到 localStorage（与布局偏好同一条降级路径） */
  writeCloseBehavior: (behavior: CloseBehavior) => prefsApi.setPref(CLOSE_BEHAVIOR_KEY, JSON.stringify(behavior)),
};
