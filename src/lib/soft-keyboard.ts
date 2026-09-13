/**
 * 屏幕软键盘（点选键阵）的显隐偏好，存在 `user_preference` 的 `ui.soft-keyboards`。
 *
 * 为什么不进 `app_setting`（站点参数）：这是**每个人自己的界面偏好**，与工作台布局、
 * 窗口关闭行为同一条通道——会打字的人嫌屏幕上多点一个按钮想收掉，不该把旁边
 * 那位不会打字的操作员的键盘一起关掉。全站一份的参数页也不该被界面开关淹掉。
 *
 * 关掉的只是点选通路：输入框本身、逐字键入、光标改中间某位全都照旧，
 * 「事由快捷选项」（ReasonChips）也不算软键盘，不受这项偏好影响。
 */
import { prefsApi } from "@/lib/prefs-native";

/** 偏好键。键名口径要过 `prefs.rs::check_key`：小写字母起始，可含 `.` `_` `-` */
export const SOFT_KEYBOARD_KEY = "ui.soft-keyboards";

/** 从没设过的人默认**显示**：新加的通路不该靠用户自己去开 */
export const DEFAULT_SOFT_KEYBOARD = true;

/** 只认真正存进去的 true/false；读不出或存了别的东西一律回落默认值 */
export function parseSoftKeyboard(raw: string | null | undefined): boolean {
  if (raw == null) return DEFAULT_SOFT_KEYBOARD;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "boolean" ? v : DEFAULT_SOFT_KEYBOARD;
  } catch {
    return DEFAULT_SOFT_KEYBOARD;
  }
}

export const softKeyboardApi = {
  read: () => prefsApi.getPref(SOFT_KEYBOARD_KEY),
  write: (on: boolean) => prefsApi.setPref(SOFT_KEYBOARD_KEY, JSON.stringify(on)),
};
