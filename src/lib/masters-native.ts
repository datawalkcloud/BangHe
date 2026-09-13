/**
 * 基础档案的原生通道（02 §7 M6、03 §9.2 / §9.4 / §9.8–§9.10）。
 *
 * 单开一份而不是改 `src/mock/api.ts`，因为这层只负责三件事：
 *  1. **桌面端发 `master_*` 命令，浏览器预览回落 mock**——演示不断线，
 *     与 `lib/auth.ts` 的 `channel === "demo"` 是同一条纪律。
 *  2. **把 invoke reject 出来的字符串包成 Error**。Rust 侧业务失败回的是人话短句
 *     （"品种编码「YM」已存在"），而页面一律写 `onError: (e: Error) => e.message`；
 *     不包这一层，提示就成了"保存失败：undefined"，等于把原因吞了。
 *  3. 入参原样透传：Rust 的 `*Input` 结构与 mock 的 `saveXxx` 签名逐字段同名，
 *     多出来的字段（如 `operator_id`）由 serde 忽略——操作人以会话为准，不信前端。
 *
 * 字段命名保持 snake_case 与 `src/mock/types.ts` 一致（05 §8：页面零改动）。
 * `settings` / `saveSetting` 也在本模块：库里只有键、值、类型、说明四列，
 * 「分几组、标签怎么写、单位是什么」这层界面信息在 `lib/settings-catalog.ts`，
 * 读回来由它拼成页面的 `AppSetting`。写入的打印门禁仍留在前端——Rust 不知道真机
 * 测没测过，只收一句 `verify_note` 进审计。
 */
import { runningInTauri } from "@/lib/native";
import { mergeSettings, type SettingRow } from "@/lib/settings-catalog";
import type { PrintVerify } from "@/lib/print-guard";
import { api as mock } from "@/mock/api";
import type {
  AppSetting,
  GrainVariety,
  PriceList,
  QuickOption,
  StorageSlot,
  Station,
  UserAccount,
  Warehouse,
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

/** 写入同理，但要带上前端传来的 input；返回值是后端**重新读出的那一行**，
 *  不是把入参回显——这样 id、created_at 这类后端生成的字段才是真的。 */
function routeSave<T, I>(cmd: string, demo: (input: I) => Promise<T>) {
  return (input: I): Promise<T> => (runningInTauri() ? call<T>(cmd, { input }) : demo(input));
}

export type VarietyInput = Parameters<typeof mock.saveVariety>[0];
export type DeleteVarietyInput = { id: number; operator_id: number };
export type PriceInput = Parameters<typeof mock.savePrice>[0];
export type StaffInput = Parameters<typeof mock.saveStaff>[0];
/** 仓房/货位的写入接口 mock 层从来没有（那个分区一直标着"只读"），签名按 Rust 的 Input 定 */
export type WarehouseInput = {
  id?: number | null;
  code: string;
  name: string;
  /** 线上值受 Rust 侧 `WarehouseKind::VALUES` 约束，不在白名单里直接报错 */
  kind: string;
  /** null = 容量尚未核定（落 NULL）；0 是一条明确的"不允许存粮" */
  capacity_ton: number | null;
  is_active: 0 | 1;
  operator_id: number;
};
export type SlotInput = {
  id?: number | null;
  warehouse_id: number;
  code: string;
  label: string;
  is_active: 0 | 1;
  operator_id: number;
};

export type QuickOptionInput = Parameters<typeof mock.saveQuickOption>[0];
export type DeleteQuickOptionInput = { id: number; operator_id: number };

export const mastersApi = {
  station: route<Station>("master_station", () => mock.station()),
  staff: route<UserAccount[]>("master_staff", () => mock.staff()),
  varieties: route<GrainVariety[]>("master_varieties", () => mock.varieties()),
  warehouses: route<Warehouse[]>("master_warehouses", () => mock.warehouses()),
  slots: route<StorageSlot[]>("master_slots", () => mock.slots()),
  prices: route<PriceList[]>("master_prices", () => mock.prices()),
  /** 常用语快捷选项整表读（含停用行），字段用侧的下拉在前端按 kind + is_active 过滤 */
  quickOptions: route<QuickOption[]>("master_quick_options", () => mock.quickOptions()),
  /** 库里只有键值，界面看到的是目录拼出来的行：浏览器预览照旧读 mock 那一份 */
  settings: (): Promise<AppSetting[]> =>
    runningInTauri() ? call<SettingRow[]>("master_settings").then(mergeSettings) : mock.settings(),

  saveVariety: routeSave<GrainVariety, VarietyInput>("master_save_variety", (i) => mock.saveVariety(i)),
  deleteVariety: routeSave<GrainVariety, DeleteVarietyInput>("master_delete_variety", (i) => mock.deleteVariety(i.id, i.operator_id)),
  savePrice: routeSave<PriceList, PriceInput>("master_save_price", (i) => mock.savePrice(i)),
  saveStaff: routeSave<UserAccount, StaffInput>("master_save_staff", (i) => mock.saveStaff(i)),

  saveQuickOption: routeSave<QuickOption, QuickOptionInput>("master_save_quick_option", (i) =>
    mock.saveQuickOption(i),
  ),
  deleteQuickOption: routeSave<QuickOption, DeleteQuickOptionInput>("master_delete_quick_option", (i) =>
    mock.deleteQuickOption(i),
  ),

  saveWarehouse: (input: WarehouseInput) =>
    runningInTauri()
      ? call<Warehouse>("master_save_warehouse", { input })
      : Promise.reject(new Error("浏览器预览不落库：仓房与货位的维护请在桌面端做")),
  saveSlot: (input: SlotInput) =>
    runningInTauri()
      ? call<StorageSlot>("master_save_slot", { input })
      : Promise.reject(new Error("浏览器预览不落库：仓房与货位的维护请在桌面端做")),

  /** 签名与 `mock.saveSetting` 逐字一致，页面察觉不到差别：`operator_id` 桌面端忽略，以会话为准 */
  saveSetting: async (
    key: string,
    value: string,
    operator_id: number,
    verify: PrintVerify | null = null,
  ): Promise<AppSetting[]> => {
    if (!runningInTauri()) return mock.saveSetting(key, value, operator_id, verify);
    // 门禁在发命令之前：测不过就不该有那次写入，而不是写完了再告诉用户回滚
    if (verify && verify.mode === "device" && !verify.ok) {
      throw new Error(`联机测试未通过，参数未保存：${verify.message}`);
    }
    const rows = await call<SettingRow[]>("master_save_setting", {
      input: { key, value, verify_note: verify?.mode === "none" ? "未经真机验证" : null },
    });
    return mergeSettings(rows);
  },
};
