/**
 * 主题配置的唯一来源：令牌合成、注入、持久化与重置。
 *
 * 为什么拆成"基础色板 + 主题色"两层：这是 shadcn 官方主题编辑器的模型
 * （registry:theme 里基础色板给全套灰阶令牌，主题色只覆盖 primary/secondary/chart 等少数令牌），
 * 数值全部来自 tools/gen-theme-presets.mjs 生成的 src/lib/theme-presets.ts，不在这里手抄。
 *
 * 四条边界，避免以后有人把这里改成第二套真相：
 *  1. **只管颜色，不管模式**。light/dark/system 由 next-themes 持有（storageKey 用下面的
 *     THEME_MODE_KEY），因为 src/components/ui/sonner.tsx 已经读 useTheme()，
 *     再另起一套会让 toast 配色与界面分叉。
 *  2. **不覆盖 --radius**。官方表里照抄了 radius（0.625rem），但本工程是 base-maia 直角体系、
 *     --radius 固定 0（05 §7.2），所以输出 CSS 声明时跳过它。
 *  3. **不动 --chart-color-1..5**。那是报表业务语义色（05 §7.2 要求能区分配品种/等级）。
 *     官方主题色覆盖的是 --chart-1..5，而 @theme inline 已把 --color-chart-* 指向 --chart-color-*，
 *     所以换主题色不会影响图表配色——这是有意的，界面里也写明了。
 *  4. **不进 app_setting**。主题是本机显示偏好，不需要站长权限、不写审计（05 §7.4）。
 */
import { ACCENT_THEMES, BASE_THEMES, type ThemePreset, type ThemeTokens } from "@/lib/theme-presets";

/** light/dark/system，与 next-themes 的 themes 取值一致 */
export type ThemeMode = "light" | "dark" | "system";

/** accent 为 "default" 时只跟基础色板，不叠加主题色 */
export interface ThemePalette {
  base: string;
  accent: string;
}

/** next-themes 的 storageKey 必须用同一个值，改这里要同步改 App.tsx */
export const THEME_MODE_KEY = "banghe.theme.mode";
export const THEME_PALETTE_KEY = "banghe.theme.palette";
/** 注入样式表的 id，重置时按它整块移除 */
export const THEME_STYLE_ID = "banghe-theme";

/**
 * 深色模式策略（05 §7.4）：磅房白天强光下深色对比更差，所以默认浅色，
 * 但仍提供深色——夜班与遮阳棚下更省力；跟随系统给两面班的人。
 */
export const DEFAULT_MODE: ThemeMode = "light";
export const DEFAULT_PALETTE: ThemePalette = { base: "neutral", accent: "default" };

export const THEME_MODES: readonly { value: ThemeMode; label: string; hint: string }[] = [
  { value: "light", label: "浅色", hint: "出厂默认，强光下最清楚" },
  { value: "dark", label: "深色", hint: "夜班 / 弱光棚内" },
  { value: "system", label: "跟随系统", hint: "随 Windows 应用模式切换" },
];

export const BASE_COLOR_THEMES: readonly ThemePreset[] = BASE_THEMES;

/** 主题色列表：第一项"跟随基础色板"= 不叠加，其余取自官方色板 */
export const ACCENT_COLOR_THEMES: readonly ThemePreset[] = [
  { key: "default", title: "Default", zh: "跟随基础色板", light: {}, dark: {} },
  ...ACCENT_THEMES,
];

export function findBase(key: string): ThemePreset {
  return BASE_THEMES.find((t) => t.key === key) ?? BASE_THEMES[0];
}

export function findAccent(key: string): ThemePreset {
  return ACCENT_COLOR_THEMES.find((t) => t.key === key) ?? ACCENT_COLOR_THEMES[0];
}

/** 基础色板 + 主题色 → 两套完整令牌（主题色覆盖同名项） */
export function resolveTokens(p: ThemePalette): { light: ThemeTokens; dark: ThemeTokens } {
  const base = findBase(p.base);
  const accent = findAccent(p.accent);
  return { light: { ...base.light, ...accent.light }, dark: { ...base.dark, ...accent.dark } };
}

/** 是否等价于内置默认（默认时不注入任何样式，让 App.css 说话） */
export function isDefaultPalette(p: ThemePalette): boolean {
  return p.base === DEFAULT_PALETTE.base && p.accent === DEFAULT_PALETTE.accent;
}

function toDecls(tokens: ThemeTokens): string {
  return Object.entries(tokens)
    .filter(([k]) => k !== "radius")
    .map(([k, v]) => `  --${k}: ${v};`)
    .join("\n");
}

/**
 * 生成 CSS 文本。
 *
 * 用"基础块 + 深色块"两段而不是往 <html> 写 inline style：
 * 行内变量会同时压住 :root 与 .dark 两块，切到深色就拿着一套浅色值。
 *
 * selectors 分两种写法是有原因的：
 *  - 复制给人粘进 App.css 时用惯用的 `:root` / `.dark`；
 *  - 运行时注入必须用 `html:root` / `html.dark`（特异度 0,1,1 > 0,1,0），
 *    否则 Vite dev 的 HMR 会把 App.css 的 style 重新插到 head 末尾，反过来压住我们的覆盖。
 */
export function paletteToCss(p: ThemePalette, selectors: { root: string; dark: string } = { root: ":root", dark: ".dark" }): string {
  const { light, dark } = resolveTokens(p);
  return `${selectors.root} {\n${toDecls(light)}\n}\n\n${selectors.dark} {\n${toDecls(dark)}\n}`;
}

/** 注入专用：与样式插入顺序无关 */
const INJECT_SELECTORS = { root: "html:root", dark: "html.dark" };

/** 复制给用户粘进 App.css 的完整片段（带抬头注释，免得粘进去看不出是哪套色板） */
export function paletteToClipboardCss(p: ThemePalette): string {
  const base = findBase(p.base);
  const accent = findAccent(p.accent);
  const tail = p.accent === "default" ? "" : ` + 主题色 ${accent.title}（${accent.zh}）`;
  return `/* 邦禾 · 基础色板 ${base.title}（${base.zh}）${tail} —— 粘进 src/App.css 即为出厂默认 */\n${paletteToCss(p)}\n`;
}

/**
 * 注入 / 更新主题样式。默认色板时整块移除，避免留下一份和 App.css 等价的冗余覆盖。
 * withTransition=false 时临时掐掉过渡，切色板不播放半成品动画（与 next-themes 同做法）。
 */
export function applyPalette(p: ThemePalette, { withTransition = true }: { withTransition?: boolean } = {}): void {
  if (typeof document === "undefined") return;
  const restore = withTransition ? null : disableTransitions();
  const el = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null;
  if (isDefaultPalette(p)) {
    el?.remove();
    restore?.();
    return;
  }
  const style = el ?? document.createElement("style");
  if (!el) {
    style.id = THEME_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = paletteToCss(p, INJECT_SELECTORS);
  restore?.();
}

function disableTransitions(): () => void {
  const prev = document.getElementById("banghe-no-transition");
  prev?.remove();
  const style = document.createElement("style");
  style.id = "banghe-no-transition";
  style.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
  document.head.appendChild(style);
  // 下一帧再放开，否则这次改动本身就带着过渡
  return () => requestAnimationFrame(() => requestAnimationFrame(() => style.remove()));
}

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // WebView 数据目录异常时不能把界面带崩，退回默认值即可
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* 存不下只是下次启动回到默认主题，不值得弹错误框 */
  }
}

/** 读回色板；脏数据（手改过 localStorage、老版本残留）一律回落默认 */
export function readPalette(): ThemePalette {
  const raw = safeGet(THEME_PALETTE_KEY);
  if (!raw) return { ...DEFAULT_PALETTE };
  try {
    const v = JSON.parse(raw) as Partial<ThemePalette>;
    const base = typeof v.base === "string" && BASE_THEMES.some((t) => t.key === v.base) ? v.base : DEFAULT_PALETTE.base;
    const accent =
      typeof v.accent === "string" && ACCENT_COLOR_THEMES.some((t) => t.key === v.accent) ? v.accent : DEFAULT_PALETTE.accent;
    return { base, accent };
  } catch {
    return { ...DEFAULT_PALETTE };
  }
}

export function writePalette(p: ThemePalette): void {
  safeSet(THEME_PALETTE_KEY, JSON.stringify(p));
}

export function readMode(): ThemeMode {
  const v = safeGet(THEME_MODE_KEY);
  return v === "light" || v === "dark" || v === "system" ? v : DEFAULT_MODE;
}

/**
 * React 挂载前先把模式类与色板打上，避免"先白一下再变深"。
 * 语义与 next-themes 注入的那段脚本一致（同 storageKey、同 system 解析、同 colorScheme 写法），
 * 挂载后由 next-themes 接管，这里只负责首帧。
 */
export function bootstrapTheme(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const root = document.documentElement;
  const mode = readMode();
  const resolved = mode === "system" ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode;
  root.classList.remove("light", "dark");
  root.classList.add(resolved);
  root.style.colorScheme = resolved;
  applyPalette(readPalette(), { withTransition: false });
  guardPrintTheme();
}

/**
 * 打印一律用浅色。
 *
 * 单据模板本身是固定黑白（components/print/sheets.tsx），但列表页与审计页直接用 Ctrl+P 出纸，
 * 深色模式会把一整页底纹打上去。这里只临时摘掉 .dark 类——等价于用当前色板的 light 值出纸，
 * 比在 CSS 里再抄一份浅色令牌少一套真相。afterprint 必须还原，否则打完一次界面就自己变浅色了。
 */
function guardPrintTheme(): void {
  let darkBeforePrint = false;
  window.addEventListener("beforeprint", () => {
    darkBeforePrint = document.documentElement.classList.contains("dark");
    if (darkBeforePrint) document.documentElement.classList.remove("dark");
  });
  window.addEventListener("afterprint", () => {
    if (darkBeforePrint) document.documentElement.classList.add("dark");
    darkBeforePrint = false;
  });
}
