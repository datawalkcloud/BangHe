/**
 * 结算台账的原生通道（05 §3 `/settlements`、`/settlements/$settleNo`；01 §F5.2）。
 *
 * 补上 orders-native / orders-center-native 两份注释里"下一轮"的欠账：
 * 结算单详情、待结算池、挂账账龄、出纳补录付款。
 * 后端在 `src-tauri/src/settlements.rs`，与工作台 `order_settle` 读写同一批表，
 * 桌面端"当场结清 → 台账查得到 → 挂账补付 → 凭证打印"自此一条真数据链。
 * 台账**列表**不在这里：走 `reports-native.ts` 的 `settlement_list`（那份筛选实现
 * 覆盖收款人姓名、带关键字转义与日期/limit 参数，是超集，不再重复一份）。
 *
 * 有意差异（详细口径写在该模块头注）：补录付款不再顺手置 `signed_by_party`；
 * 超额付款、给已撤销单付款会被命令层用中文短句拒绝——详情页的 toast 原样上屏。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";
import type { Settlement } from "@/mock/types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

type PendingGroup = Awaited<ReturnType<typeof mock.pendingSettlements>>[number];
type CreditRow = Awaited<ReturnType<typeof mock.credits>>[number];
type SettlementDetail = NonNullable<Awaited<ReturnType<typeof mock.settlementOf>>>;
type RecordPaymentInput = Parameters<typeof mock.recordPayment>[0];

export const settlementsApi = {
  settlementOf: (no: string): Promise<SettlementDetail | null> =>
    runningInTauri() ? call("settlement_get", { no }) : mock.settlementOf(no),

  pendingSettlements: (): Promise<PendingGroup[]> =>
    runningInTauri() ? call("settlement_pending") : mock.pendingSettlements(),

  credits: (): Promise<CreditRow[]> => runningInTauri() ? call("settlement_credits") : mock.credits(),

  recordPayment: (input: RecordPaymentInput): Promise<Settlement | null> =>
    runningInTauri() ? call("payment_add", { input }) : mock.recordPayment(input),
};
