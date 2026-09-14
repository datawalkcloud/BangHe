/**
 * 粮食出库与库存账的原生通道（02 §M11、03 §9.28 / §9.23）。
 *
 * 与 `masters-native.ts` / `orders-native.ts` 同一条纪律，只做三件事：
 *  1. 桌面端发 `outbound_*` / `stock_*` 命令，浏览器预览回落 mock——演示不断线；
 *  2. 把 invoke reject 出来的字符串包成 `Error`。Rust 侧业务失败回的是人话短句
 *     （"登记出库不计价，单价请留空"），页面一律写 `onError: (e) => e.message`，
 *     不包这层提示就成了"操作失败：undefined"，等于把原因吞了；
 *  3. 入参原样透传：Rust 的 `*Input` 与 mock 签名逐字段同名（snake_case，
 *     与 `src/mock/types.ts` 一致），`operator_id` 由服务端忽略、以会话为准。
 *
 * 命令名与 `src-tauri/src/lib.rs` 的 `generate_handler!` 由
 * `tests/command_wiring_contract.rs` 逐字对账，两边缺一侧都会红。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";
import type {
  MovementFilters,
  MovementPage,
  OutboundCloseInput,
  OutboundCompleteInput,
  OutboundDetail,
  OutboundFilters,
  OutboundOrder,
  OutboundPage,
  OutboundSaveInput,
  StockBalanceRow,
} from "@/mock/types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

/** 桌面端走真库，浏览器走 mock：两边返回同一份字段，页面察觉不到差别 */
function route<T>(cmd: string, demo: () => Promise<T>, args?: Record<string, unknown>) {
  return (): Promise<T> => (runningInTauri() ? call<T>(cmd, args) : demo());
}

/** 带参只读：位置参数按 ARGS_MAP 映射成 invoke 的键（Rust 命令的形参名） */
function route1<A extends unknown[], T>(cmd: string, demo: (...a: A) => Promise<T>) {
  return (...a: A): Promise<T> => (runningInTauri() ? call<T>(cmd, a2args(cmd, a)) : demo(...a));
}

/** 写入：input 原样透传，返回值是真库重读出来的行（不是回显入参） */
function routeSave<T, I>(cmd: string, demo: (input: I) => Promise<T>) {
  return (input: I): Promise<T> => (runningInTauri() ? call<T>(cmd, { input }) : demo(input));
}

const ARGS_MAP: Record<string, string[]> = {
  outbound_list: ["input"],
  outbound_get: ["no"],
  stock_movements: ["input"],
};
function a2args(cmd: string, a: unknown[]): Record<string, unknown> {
  const keys = ARGS_MAP[cmd] ?? [];
  const out: Record<string, unknown> = {};
  keys.forEach((k, i) => {
    if (a[i] !== undefined) out[k] = a[i];
  });
  return out;
}

export type {
  MovementFilters,
  MovementPage,
  OutboundCloseInput,
  OutboundCompleteInput,
  OutboundDetail,
  OutboundFilters,
  OutboundOrder,
  OutboundPage,
  OutboundSaveInput,
  StockBalanceRow,
};

export const outboundApi = {
  /* ------------------------------------------------------------ 出库单据 */
  listOutbound: route1<[f: OutboundFilters], OutboundPage>("outbound_list", (f) => mock.listOutbound(f)),
  getOutbound: route1<[no: string], OutboundDetail | null>("outbound_get", (no) => mock.getOutbound(no)),
  /** 新建（`order_no` 空）与改草稿（带单号）共用一条命令，与 Rust `outbound_save` 同形 */
  saveOutbound: routeSave<OutboundOrder, OutboundSaveInput>("outbound_save", (i) => mock.saveOutbound(i)),
  /** 完成出库：算货款 + 判超库存（只警示不拦）+ 同事务写一条出库流水 */
  completeOutbound: routeSave<OutboundOrder, OutboundCompleteInput>("outbound_complete", (i) => mock.completeOutbound(i)),
  /** 过账前作废：不动库存 */
  voidOutbound: routeSave<OutboundOrder | null, OutboundCloseInput>("outbound_void", (i) => mock.voidOutbound(i)),
  /** 过账后红冲：原单置 reversed，补一条对称入库流水，原流水不删 */
  reverseOutbound: routeSave<OutboundOrder | null, OutboundCloseInput>("outbound_reverse", (i) => mock.reverseOutbound(i)),

  /* -------------------------------------------------------------- 库存账 */
  // 键名必须与 mock 同名（stockBalance / stockMovements），否则 api.ts 展开时盖不住 mock 那一份：
  // 名字叫错，桌面端这两查询会静默回到演示数据，而 tsc 与页面都不报错。
  stockBalance: route<StockBalanceRow[]>("stock_balance", () => mock.stockBalance()),
  stockMovements: route1<[f: MovementFilters], MovementPage>("stock_movements", (f) => mock.stockMovements(f)),
};
