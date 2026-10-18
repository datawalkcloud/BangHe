/**
 * 首页看板的原生通道（05 §3；02 §7 M1）。
 *
 * 与 `masters-native.ts` 同一套规矩：桌面端 `invoke("dashboard_data")` 走真库
 * （weigh_order / settlement / device_config / app_setting 聚合，见
 * `src-tauri/src/dashboard.rs`），浏览器预览回落 mock，演示与联机不断线。
 *
 * 覆盖的是 `api.dashboard(from, to)` 一个函数：看板上从区间汇总、在途作业、告警到
 * 品种/人群分组，全部换成真库口径。`from`/`to` 是 business_date 闭区间，由页面
 * 时间选择器（今天/昨天/近 7 天/近 30 天/本月/上月）解析后传入。`api.listDevices()` **不动**——设备中心
 * 的写入还在 mock，整体迁库是它自己那一轮的事；看板设备面板改用
 * `Dashboard.devices`（与告警同源），页面里不再有"半真半假"的第二次取数。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";
import type { Dashboard } from "@/mock/types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

export const dashboardApi = {
  dashboard: (from: string, to: string): Promise<Dashboard> =>
    runningInTauri() ? call<Dashboard>("dashboard_data", { from, to }) : mock.dashboard(from, to),
};
