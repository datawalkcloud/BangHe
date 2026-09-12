/**
 * 小票模板的本地存储（用户自定义层）。
 *
 * 只存「用户改过的覆盖模板」；未改过的场景回退到 defaults.ts 的出厂模板。
 * 这样 defaults 一旦微调，没改过的用户会自动拿到新默认；改过的用户以自己存的为准。
 * 落盘走 zustand persist（localStorage），桌面端即本机、刷新不丢。
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ReceiptScenario, ReceiptTemplate } from "./types";
import { defaultTemplate, ensureRequiredBlocks } from "./defaults";

interface ReceiptStore {
  /** 用户保存过的覆盖模板（按场景） */
  custom: Partial<Record<ReceiptScenario, ReceiptTemplate>>;
  /**
   * 小票机实测列数（汉字占 2 列）；null = 按纸型标称（80 → 48 / 58 → 32）。
   *
   * 刻意放在站点级、不进单张模板：列数是**机器属性**，一台机打所有场景，
   * 不该让站长给六种票据各填一遍。票面折行的头号原因就是这个数比实机大，
   * 实测入口在「小票模板 → 小票机列数」，值由自检票上的标尺读出来。
   */
  thermalCols: number | null;
  setThermalCols: (n: number | null) => void;
  saveTemplate: (t: ReceiptTemplate) => void;
  resetTemplate: (scenario: ReceiptScenario) => void;
}

export const useReceiptStore = create<ReceiptStore>()(
  persist(
    (set) => ({
      custom: {},
      thermalCols: null,
      setThermalCols: (n) => set({ thermalCols: n }),
      saveTemplate: (t) =>
        set((s) => ({ custom: { ...s.custom, [t.scenario]: { ...t, updatedAt: new Date().toISOString() } } })),
      resetTemplate: (scenario) =>
        set((s) => {
          const next = { ...s.custom };
          delete next[scenario];
          return { custom: next };
        }),
    }),
    { name: "banghe-receipt-templates" },
  ),
);

/**
 * 取某场景当前生效的模板（用户覆盖优先，否则出厂默认）。
 *
 * 「必备区块」的兜底刻意放在**取用**这一侧而不是保存这一侧：覆盖模板是历史某一刻存的，
 * 而码单上的凭票码是后加进默认的——只在保存时校验等于放行所有已经存好的旧模板。
 */
export function effectiveTemplate(scenario: ReceiptScenario): ReceiptTemplate {
  return ensureRequiredBlocks(useReceiptStore.getState().custom[scenario] ?? defaultTemplate(scenario));
}

/** 组件内响应式读取某场景的生效模板 */
export function useReceiptTemplate(scenario: ReceiptScenario): ReceiptTemplate {
  const custom = useReceiptStore((s) => s.custom[scenario]);
  return ensureRequiredBlocks(custom ?? defaultTemplate(scenario));
}
