/**
 * 个人界面偏好的原生通道（§9.25 `user_preference`，命令见 `src-tauri/src/prefs.rs`）。
 *
 * 归属上它是"按账号的一份显示偏好"，与站点参数（`app_setting`，全站一份、站长改、写审计）
 * 是两回事，所以另开一条通道而不是往 `mastersApi` 里塞。键的作用域由服务端按当前会话定，
 * 这里传的只是偏好名本身。
 *
 * 浏览器预览没有 Rust 侧，退到 localStorage：演示机上仍然"拖完刷新还在"，
 * 只是那台机器上的每个人都共用同一份。
 */
import { runningInTauri } from "@/lib/native";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // 服务端回的是人话短句（"偏好内容过大…已拒绝保存"），不包出来页面只剩"保存失败"
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

const localKey = (key: string) => `banghe.pref.${key}`;

export const prefsApi = {
  /** 读本人某键的偏好原文（JSON 文本）。没存过回 null，由调用方回落默认值 */
  getPref: async (key: string): Promise<string | null> => {
    if (!runningInTauri()) return window.localStorage.getItem(localKey(key));
    return await call("prefs_read", { key });
  },

  /** 覆盖式写入，回落库时间。失败要能上屏，否则界面会假装"已经保存好了" */
  setPref: async (key: string, valueJson: string): Promise<string> => {
    if (!runningInTauri()) {
      window.localStorage.setItem(localKey(key), valueJson);
      return new Date().toISOString();
    }
    return await call("prefs_write", { key, valueJson });
  },
};
