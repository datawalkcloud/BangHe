/**
 * 主题配置的单一入口。
 *
 * 状态实际分两处（这是刻意的，不是历史遗留）：
 *  - 模式 light/dark/system → next-themes（往 <html> 打 .dark 类，sonner 的 toast 也读它）；
 *  - 色板 base/accent → store/theme.ts（注入 :root/.dark 令牌覆盖）。
 * 页面只认这一个 hook，避免有人绕过 next-themes 自己 add class。
 */
import { useCallback, useMemo } from "react";
import { useTheme } from "next-themes";
import { DEFAULT_MODE, readMode, type MenuStyle, type RadiusStyle, type ThemeMode, type ThemeStyle } from "@/lib/theme";
import { usePaletteIsDefault, useThemeStore } from "@/store/theme";

export interface ThemeConfig {
  /** 用户选择的模式，可能是 system */
  mode: ThemeMode;
  /** 实际生效的模式（system 已解析成 light/dark） */
  resolvedMode: "light" | "dark";
  setMode: (m: ThemeMode) => void;
  base: string;
  accent: string;
  setBase: (id: string) => void;
  setAccent: (id: string) => void;
  style: ThemeStyle;
  setStyle: (style: ThemeStyle) => void;
  radius: RadiusStyle;
  setRadius: (style: RadiusStyle) => void;
  chart: string;
  setChart: (color: string) => void;
  menu: MenuStyle;
  setMenu: (style: MenuStyle) => void;
  /** 模式与色板一起回到出厂值 */
  reset: () => void;
  /** 是否完全等同默认主题（决定"重置"按钮灰不灰、以及"当前为默认"提示） */
  isDefault: boolean;
}

function asMode(v: string | undefined): ThemeMode {
  return v === "light" || v === "dark" || v === "system" ? v : readMode();
}

export function useThemeConfig(): ThemeConfig {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const base = useThemeStore((s) => s.base);
  const accent = useThemeStore((s) => s.accent);
  const setBase = useThemeStore((s) => s.setBase);
  const setAccent = useThemeStore((s) => s.setAccent);
  const style = useThemeStore((s) => s.style);
  const setStyle = useThemeStore((s) => s.setStyle);
  const radius = useThemeStore((s) => s.radius);
  const setRadius = useThemeStore((s) => s.setRadius);
  const chart = useThemeStore((s) => s.chart);
  const setChart = useThemeStore((s) => s.setChart);
  const menu = useThemeStore((s) => s.menu);
  const setMenu = useThemeStore((s) => s.setMenu);
  const resetPalette = useThemeStore((s) => s.resetPalette);
  const paletteIsDefault = usePaletteIsDefault();

  const mode = asMode(theme);
  const resolvedMode = asMode(resolvedTheme) === "dark" ? "dark" : "light";

  const setMode = useCallback((m: ThemeMode) => setTheme(m), [setTheme]);
  const reset = useCallback(() => {
    setTheme(DEFAULT_MODE);
    resetPalette();
  }, [setTheme, resetPalette]);

  return useMemo(
    () => ({
      mode,
      resolvedMode,
      setMode,
      base,
      accent,
      setBase,
      setAccent,
      style,
      setStyle,
      radius,
      setRadius,
      chart,
      setChart,
      menu,
      setMenu,
      reset,
      isDefault: mode === DEFAULT_MODE && paletteIsDefault,
    }),
    [mode, resolvedMode, setMode, base, accent, setBase, setAccent, style, setStyle, radius, setRadius, chart, setChart, menu, setMenu, reset, paletteIsDefault],
  );
}
