/**
 * 报表与结算读力的原生通道（03 §9.17 结算、§9.24 视图；05 §3 `/system/shift`）。
 *
 * 目前只覆盖「日结交班」这个页面用得上的两个读接口，实现在
 * `src-tauri/src/reports.rs`：
 *  - `report_daily`：按 `business_date` 归日的品种汇总（跨零点作业的单归过磅那天）；
 *  - `settlement_list`：未付清的挂账清单，含 `payment_status` 筛选。
 * 两者都不改数据，所以没有角色闸门，与看板一样只读。
 *
 * 付款登记、结算单详情、红冲这些**写**路径还没接：它们要动
 * `settlement` / `payment_record` 的状态机，属于结算中心那一轮，别在这里半接半留。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";
import type { DailyReport, Settlement } from "@/mock/types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

/** 服务端 `settlement_list` 的取回上限（reports.rs 的 MAX_SETTLEMENT_LIMIT）。
 *  默认值是 200——交接页要对结果加总金额，不显式给 limit 就会在 200 条处静默截断。 */
export const SETTLEMENT_SCAN_LIMIT = 2000;

export const reportsApi = {
  reportDaily: (date: string): Promise<DailyReport> =>
    runningInTauri() ? call<DailyReport>("report_daily", { date }) : mock.reportDaily(date),

  listSettlements: (
    filter: { paymentStatus?: Settlement["payment_status"] | "all"; keyword?: string; limit?: number } = {},
  ): Promise<Settlement[]> => {
    if (!runningInTauri()) return mock.listSettlements(filter);
    const { paymentStatus, keyword, limit } = filter;
    return call<Settlement[]>("settlement_list", {
      filters: {
        // "all" 是前端的"不限"，不是库里的取值，透传进去会查出空表
        paymentStatus: paymentStatus && paymentStatus !== "all" ? paymentStatus : null,
        keyword: keyword ?? null,
        limit: limit ?? null,
      },
    });
  },
};
