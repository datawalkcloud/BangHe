/**
 * 化验单读的原生通道（05 §3 `/qc/$reportNo`；02 §F3）。
 *
 * 补的是质检页最后两块 mock：待检队列与质检单详情。实现见 `src-tauri/src/qc.rs`，
 * 与工作台 `qc_save` / 列表 `qc_list` 读写同一批表，桌面端「登记 → 待检 → 出单 →
 * 复检对比」自此不再出现"列表是真库单号、点进去查 mock 查不到"的裂缺。
 *
 * 队列口径与 mock 有一处有意差异（真库把「已毛重未化验」的车也算待检，且只认
 * `is_effective` 的化验单），细节写在后端模块头注，页面不感知。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";
import type { WeighOrder } from "@/mock/types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

type QcDetail = NonNullable<Awaited<ReturnType<typeof mock.getQc>>>;

export const qcApi = {
  getQc: (reportNo: string): Promise<QcDetail | null> => runningInTauri() ? call<QcDetail | null>("qc_get", { no: reportNo }) : mock.getQc(reportNo),

  qcQueue: (): Promise<WeighOrder[]> => runningInTauri() ? call<WeighOrder[]>("qc_queue_list") : mock.qcQueue(),
};
