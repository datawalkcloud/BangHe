/**
 * 全局检索（05 §5 顶栏 Ctrl/Alt+K）的原生通道。
 *
 * 后端在 `src-tauri/src/search.rs`：磅单（单号 / 姓名 / 证号后 4 位 / 车牌）、
 * 售粮人（姓名 / 证号 / 手机号）、结算单（单号 / 姓名）三组命中，
 * 上限 8 / 6 / 6 在 SQL 的 LIMIT 里做。返回体与 `mock.search` 逐字段同名——
 * `OrderRow` 侧靠 Rust 的 `skip_serializing_if` 省掉 records / photos / prints /
 * timeline 四个"详情才带"的键，所以 `GlobalSearch.tsx` 一行都不用改。
 *
 * 浏览器预览仍走 mock（桌面端才是真数据的那一侧）。搜索**不落审计**：
 * 关键词里常有身份证后 4 位与手机号，落进 audit_log 是把 PII 明文摊开，
 * 理由同 `search.rs` 的头注。
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

/** 契约以 mock 那份为准：`{ orders: OrderRow[]; parties: Party[]; settlements: Settlement[] }` */
export type SearchResult = Awaited<ReturnType<typeof mock.search>>;

export const searchApi = {
  search: (kw: string): Promise<SearchResult> => (runningInTauri() ? call<SearchResult>("search_global", { kw }) : mock.search(kw)),
};
