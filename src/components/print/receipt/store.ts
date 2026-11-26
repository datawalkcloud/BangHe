/**
 * 打印模板的本地存储（用户自定义层）。
 *
 * 只存「用户改过的覆盖模板」，键是**场景 × 纸型**两维：没改过的那一格回退到 defaults.ts 的出厂模板。
 * 纸型是存储键而不是模板里一个可以随手改的字段——同一张磅单在 80 热敏与 A4 上是两份各自可改的版式，
 * 改哪张纸都不动其它纸上的票。打印时按「设备中心那台打印机选的纸」取对应那一格（见 silent.ts）。
 *
 * 这样 defaults 一旦微调，没改过的用户会自动拿到新默认；改过的用户以自己存的为准。
 * 落盘走 zustand persist（localStorage），桌面端即本机、刷新不丢。
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PaperKind } from "@/lib/constants";
import type { ReceiptScenario, ReceiptTemplate } from "./types";
import { defaultTemplate, normalizeTemplate } from "./defaults";
import { migrateCustom, type TemplateBuckets } from "./migrate";

/** 存储结构版本：v1 只按场景存，v2 按场景 × 纸型存（迁移见 migrate.ts） */
const STORE_VERSION = 2;

interface ReceiptStore {
  /** 用户保存过的覆盖模板（场景 → 纸型 → 模板） */
  custom: TemplateBuckets;
  /**
   * 小票机实测列数（汉字占 2 列）；null = 按纸型标称（80 → 48 / 58 → 32）。
   *
   * 刻意放在站点级、不进单张模板：列数是**机器属性**，一台机打所有场景，
   * 不该让站长给六种票据各填一遍。票面折行的头号原因就是这个数比实机大，
   * 实测入口在「打印模板 → 小票机列数」，值由自检票上的标尺读出来。
   */
  thermalCols: number | null;
  setThermalCols: (n: number | null) => void;
  saveTemplate: (t: ReceiptTemplate) => void;
  resetTemplate: (scenario: ReceiptScenario, paper: PaperKind) => void;
}

export const useReceiptStore = create<ReceiptStore>()(
  persist(
    (set) => ({
      custom: {},
      thermalCols: null,
      setThermalCols: (n) => set({ thermalCols: n }),
      saveTemplate: (t) =>
        set((s) => ({
          custom: {
            ...s.custom,
            [t.scenario]: { ...s.custom[t.scenario], [t.paper]: { ...t, updatedAt: new Date().toISOString() } },
          },
        })),
      // 只摘这一张纸上的覆盖，别的纸照旧用自己存的那份
      resetTemplate: (scenario, paper) =>
        set((s) => {
          const bucket = { ...s.custom[scenario] };
          delete bucket[paper];
          return { custom: { ...s.custom, [scenario]: bucket } };
        }),
    }),
    {
      name: "banghe-receipt-templates",
      version: STORE_VERSION,
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Partial<ReceiptStore>;
        return { ...state, custom: migrateCustom(state.custom) };
      },
    },
  ),
);

/**
 * 取某场景在**某张纸**上当前生效的模板（用户覆盖优先，否则该纸的出厂默认）。
 *
 * 缺项兜底（出库码单的必备码、码下方的可读内容）刻意放在**取用**这一侧而不是保存这一侧：
 * 覆盖模板是历史某一刻存的，而凭票码、码下方那行字都是后来才加进默认的——
 * 只在保存时校验等于放行所有已经存好的旧模板。见 `defaults.ts::normalizeTemplate`。
 */
export function effectiveTemplate(scenario: ReceiptScenario, paper: PaperKind): ReceiptTemplate {
  const saved = useReceiptStore.getState().custom[scenario]?.[paper];
  return normalizeTemplate(saved ?? defaultTemplate(scenario, paper));
}

/** 组件内响应式读取某场景在某张纸上生效的模板 */
export function useReceiptTemplate(scenario: ReceiptScenario, paper: PaperKind): ReceiptTemplate {
  const saved = useReceiptStore((s) => s.custom[scenario]?.[paper]);
  return normalizeTemplate(saved ?? defaultTemplate(scenario, paper));
}
