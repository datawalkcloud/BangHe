/**
 * 付款流水的原生通道（05 §3 `/payments`；03 §9.18 payment_record）。
 *
 * 补上 `settlements-native.ts` 那轮留在注释里的欠账：同一屏的挂账账龄已经读库，
 * 但「流水」与「付款方式分布」还指着 mock，页头上的两个数来自两个世界。
 * 后端在 `src-tauri/src/payments.rs`，读的是工作台 `order_settle` 与台账
 * `payment_add` 写进真库的同一批行——登记完立刻在页面上出现，不再需要 mock 演一遍。
 *
 * 与 mock 的有意差异（详细理由写在该模块头注）：渠道配色按 method 固定而不是按下标轮转；
 * 日期留空 = 这一头不限（mock 传 `""` 会整表空掉）；非法日期与超过服务端上限的区间
 * 都用中文短句拒绝——`call()` 把 invoke reject 的字符串包成 Error 交给 react-query，
 * 页面因此不会拿到一份"看起来正确"的半截合计。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

// 形状从 mock 那份函数签名推导：两边一旦分叉，这里先编译不过
type PaymentRecord = Awaited<ReturnType<typeof mock.listPayments>>[number];
type MethodSlice = Awaited<ReturnType<typeof mock.paymentMethodDist>>[number];

export const paymentsApi = {
  /** 期间内付款流水（含已冲销，页面自己显示状态） */
  listPayments: (from: string, to: string): Promise<PaymentRecord[]> =>
    runningInTauri() ? call("payment_list", { from, to }) : mock.listPayments(from, to),

  /** 期间内有效流水的渠道分布，金额倒序 */
  paymentMethodDist: (from: string, to: string): Promise<MethodSlice[]> =>
    runningInTauri() ? call("payment_method_dist", { from, to }) : mock.paymentMethodDist(from, to),
};
