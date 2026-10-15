/**
 * 台账报表四个视图的原生通道（05 §3 `/reports/$kind`；口径 03 §10、02 §F6/F7）。
 *
 * 实现在 `src-tauri/src/ledger.rs`，覆盖 `ReportsPage` 的四个 tab：
 *  - `report_ledger`：收购明细台账（逐单全字段，报送与稽查用）；
 *  - `report_quality`：质量分析（品种汇总 + 等级分布 + 水分分箱）；
 *  - `report_parties`：售粮人排行（含全历史皮重均值）；
 *  - `report_staff`：作业量与异常（手录占比、作废、皮重授权、补打）。
 *
 * 日报仍走 `reports-native.ts` 的 `report_daily`，两边共用 `STAT_WHERE` 同一条口径。
 * 四个都是只读聚合、所有岗位可见，所以不加角色闸门；导出权限留在页面的
 * `useExportGuard()`（`data.export`）上，与 mock 时期一致。
 *
 * 返回的 DTO 字段名与 `src/mock/types.ts` 逐字一致（含 `QualityReport` 外层的
 * `dateFrom` / `byVariety` 驼峰写法），页面与导出逻辑零改动即可换真库。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";
import type { LedgerRow, PartyRankRow, QualityReport, StaffLoadRow } from "@/mock/types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

/** 日期区间原样透传：起止由页面用 `business_date` 口径拼好，非法日期由 Rust 侧报可读错误 */
function range(from: string, to: string) {
  return { from, to };
}

export const ledgerApi = {
  reportLedger: (from: string, to: string): Promise<LedgerRow[]> =>
    runningInTauri() ? call<LedgerRow[]>("report_ledger", range(from, to)) : mock.reportLedger(from, to),

  reportQuality: (from: string, to: string): Promise<QualityReport> =>
    runningInTauri() ? call<QualityReport>("report_quality", range(from, to)) : mock.reportQuality(from, to),

  reportParties: (from: string, to: string): Promise<PartyRankRow[]> =>
    runningInTauri() ? call<PartyRankRow[]>("report_parties", range(from, to)) : mock.reportParties(from, to),

  reportStaff: (from: string, to: string): Promise<StaffLoadRow[]> =>
    runningInTauri() ? call<StaffLoadRow[]>("report_staff", range(from, to)) : mock.reportStaff(from, to),
};
