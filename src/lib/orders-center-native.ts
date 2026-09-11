/**
 * 磅单中心补口的原生通道（05 §3 `/orders/$orderNo`；02 §7 M2 / §F2.3）。
 *
 * 只有两个函数，因为磅单中心的读路径已经被 `orders-native.ts` 整体接上了真库
 * （`listOrders` / `getOrder` / `logPrint`，以及详情要的 `getParty` / `listQc`）。
 * 这里补的是那一份里没有、后端也刚新增的两条命令：
 *  - `voidOrder` → `order_void`：mock 的作废谁点都放行，真库补上「未到 settled 才能作废 /
 *    原因不少于 6 字 / 授权人必须是在职站长 / 已挂结算单的先拦住」，并写 `order.void` 审计。
 *  - `settlementOfOrderNo` → `settlement_of_order`：mock 每次都能按单号查到结算单，真库此前
 *    只在结算命令的返回值里给过一次，详情页刷新一下就再也拿不到「所属结算单」的跳转。
 *
 * 为什么不并进 `orders-native.ts`：同一批后端命令、两个并行改动面，写进同一个文件必然互相覆盖。
 * 收口时把两份展开合成一份即可，命令名与字段完全同源。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";
import type { Settlement, WeighOrder } from "@/mock/types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    // Rust 侧业务失败回的是人话短句（"本单当前为 settled，只能走红冲更正"），
    // 不包成 Error 页面就只剩"作废失败"，等于把原因吞了
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

export type VoidOrderInput = Parameters<typeof mock.voidOrder>[0];

export const ordersCenterApi = {
  settlementOfOrderNo: (no: string): Promise<Settlement | null> =>
    runningInTauri() ? call("settlement_of_order", { no }) : mock.settlementOfOrderNo(no),

  voidOrder: (input: VoidOrderInput): Promise<WeighOrder | null> =>
    runningInTauri() ? call("order_void", { input }) : mock.voidOrder(input),
};
