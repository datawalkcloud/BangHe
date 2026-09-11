/**
 * 色板的客户端状态（zustand）。
 *
 * 只放"改了就立刻生效、且不进服务端"的显示偏好：基础色板 + 主题色。
 * 深色模式不在这里（next-themes 持有），否则会出现两个地方各自往 <html> 打类名。
 *
 * 这里刻意在 set 之前先落盘再注入样式：注入失败（例如 WebView 拒绝写 head）也不该让
 * 界面显示成"已经改了"，顺序是 写 → 应用 → 更新状态，状态更新是最后一步。
 */
import { create } from "zustand";
import { applyPalette, DEFAULT_PALETTE, isDefaultPalette, readPalette, writePalette, type ThemePalette } from "@/lib/theme";

interface ThemeStore extends ThemePalette {
  setBase: (base: string) => void;
  setAccent: (accent: string) => void;
  /** 回到内置默认主题：撤掉注入样式，界面重新由 App.css 决定 */
  resetPalette: () => void;
}

function commit(next: ThemePalette) {
  writePalette(next);
  applyPalette(next, { withTransition: false });
  return next;
}

export const useThemeStore = create<ThemeStore>((set, get) => ({
  ...readPalette(),
  setBase: (base) => set(commit({ base, accent: get().accent })),
  setAccent: (accent) => set(commit({ base: get().base, accent })),
  resetPalette: () => set(commit({ ...DEFAULT_PALETTE })),
}));

/** 当前是否已是默认色板（界面用它决定"重置"按钮灰不灰） */
export function usePaletteIsDefault(): boolean {
  return useThemeStore((s) => isDefaultPalette({ base: s.base, accent: s.accent }));
}
