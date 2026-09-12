/**
 * 流转卡原生通道（06 篇；§9.26 `card`）。
 *
 * 与其它 `*-native.ts` 同一套：`runningInTauri()` 分流 `invoke`/mock，命令名一律以字面量出现
 * （`tests/command_wiring_contract.rs` 要拿它对账 `generate_handler!`），mock 同名方法兜底，
 * 保证浏览器预览也能走完"登记→发卡→刷卡推进→回收"全链（03 硬约束：无原生通道也要能闭环）。
 *
 * 这些方法被工作台后台编排器 `useIcWorkflow` 与「流转卡」卡池页调用；本文件只搬运，
 * "读到卡→看这张单缺什么→决定这一刷干什么"的判断不在这里（06 §6.3）。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";
import type { CardIssueResult, CardLocateResult, CardPoolRow } from "@/mock/types";
import type { CardStatus } from "@/lib/constants";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

export type CardPoolFilter = { status?: CardStatus | "all" | ""; keyword?: string };
export type CardRegisterInput = { card_no: string; label?: string | null; remark?: string | null; operator_id: number };
export type CardIssueInput = { order_no?: string | null; card_no: string };
export type CardReleaseInput = { card_no?: string | null; order_no?: string | null };
export type CardRetireInput = { card_no: string; reason: string };

export const cardsApi = {
  /** 卡池列表（含空闲预警计数用） */
  cardPoolList: (input: CardPoolFilter = {}): Promise<CardPoolRow[]> =>
    runningInTauri() ? call("card_pool_list", { input }) : mock.cardPoolList(input),

  /** 卡池登记入库：卡号由现场读卡得到或手输贴签号（只登记不写卡） */
  cardPoolRegister: (input: CardRegisterInput): Promise<CardPoolRow> =>
    runningInTauri() ? call("card_pool_register", { input }) : mock.cardPoolRegister(input),

  /** 注销（需站长）：在用的卡不能直接注销 */
  cardPoolRetire: (input: CardRetireInput): Promise<CardPoolRow> =>
    runningInTauri() ? call("card_pool_retire", { input }) : mock.cardPoolRetire(input),

  /** 发卡：空闲卡 → 绑到在途单；省略 order_no 由服务端取最近一张无卡单（06 §4.1） */
  cardIssue: (input: CardIssueInput): Promise<CardIssueResult> =>
    runningInTauri() ? call("card_issue", { input }) : mock.cardIssue(input),

  /** 只读定位：编排器每读到一张卡先问它，决定发卡 / 推进 / 拦下 */
  cardLocate: (card_no: string): Promise<CardLocateResult> =>
    runningInTauri() ? call("card_locate", { cardNo: card_no }) : mock.cardLocate(card_no),

  /** 人工退卡回收（终态自动释放不在此列，由 settle/void 内部完成） */
  cardRelease: (input: CardReleaseInput): Promise<CardPoolRow | null> =>
    runningInTauri() ? call("card_release", { input }) : mock.cardRelease(input),
};
