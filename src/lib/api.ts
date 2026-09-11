/**
 * 所有后端调用的唯一出口（05 §8：组件里不允许出现字符串命令名）。
 *
 * 当前阶段全部指向 mock 实现；接上 Rust 后改成：
 *   import { invoke } from "@tauri-apps/api/core";
 *   export const api = { listOrders: (f) => invoke("order_list", { f }), ... };
 * 函数签名保持不变，页面零改动。
 */
export { api } from "@/mock/api";
export type { Api, OrderRow, PartyDetail } from "@/mock/api";
