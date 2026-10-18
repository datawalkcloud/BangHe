/**
 * 主题配置的唯一来源：令牌合成、注入、持久化与重置。
 *
 * 为什么拆成"基础色板 + 主题色"两层：这是 shadcn 官方主题编辑器的模型
 * （registry:theme 里基础色板给全套灰阶令牌，主题色只覆盖 primary/secondary/chart 等少数令牌），
 * 数值全部来自 tools/gen-theme-presets.mjs 生成的 src/lib/theme-presets.ts，不在这里手抄（唯一例外是下面的品牌色板）。
 *
 * 五条边界，避免以后有人把这里改成第二套真相：
 *  1. **只管颜色，不管模式**。light/dark/system 由 next-themes 持有（storageKey 用下面的
 *     THEME_MODE_KEY），因为 src/components/ui/sonner.tsx 已经读 useTheme()，
 *     再另起一套会让 toast 配色与界面分叉。
 *  2. **--radius 只在用户显式选了圆角档时才覆盖**。官方表里照抄了 radius（0.625rem），但本工程是
 *     base-maia 直角体系、App.css 出厂 --radius 固定 0（05 §7.2），所以色板令牌里的 radius 与
 *     "默认"档都不注入，只有"无/小/中/大"四档会覆盖 --radius（见 resolveAppearanceVars）。
 *  3. **不动 --chart-color-1..5**。那是报表业务语义色（05 §7.2 要求能区分配品种/等级）。
 *     官方主题色覆盖的是 --chart-1..5，而 @theme inline 已把 --color-chart-* 指向 --chart-color-*，
 *     所以换主题色不会影响图表配色——这是有意的，界面里也写明了。
 *  4. **不进 app_setting**。主题是本机显示偏好，不需要站长权限、不写审计（05 §7.4）。
 *  5. **BRAND_ACCENT_THEME 是本文件里唯一手写的色板**（官方表重跑脚本会整体覆盖，品牌色不能放那儿）。
 *     它是出厂默认，而默认色板不注入样式，所以同一批值在 src/App.css 里还有一份镜像——改这里必须改那里。
 */
import { ACCENT_THEMES, BASE_THEMES, type ThemePreset, type ThemeTokens } from "@/lib/theme-presets";
import { setTitlebarSyncSuspended } from "@/lib/titlebar-native";

/** light/dark/system，与 next-themes 的 themes 取值一致 */
export type ThemeMode = "light" | "dark" | "system";

/** accent 为 "default" 时只跟基础色板，不叠加主题色 */
export type ThemeStyle = "vega" | "nova" | "maia" | "lyra" | "mira" | "luma" | "sera" | "rhea";
export type RadiusStyle = "default" | "none" | "small" | "medium" | "large";
export type MenuStyle = "default" | "solid";

export interface ThemePalette {
  base: string;
  accent: string;
  style: ThemeStyle;
  radius: RadiusStyle;
  chart: string;
  menu: MenuStyle;
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
/**
 * 出厂主题色 = 品牌绿（BRAND_ACCENT_THEME，取自 logo 主色）。
 * 注意它走的是"默认色板"分支：isDefaultPalette 命中时 applyPalette 不注入任何样式，
 * 界面完全由 src/App.css 的 :root / .dark 决定，所以那两段必须与本文件的令牌逐值一致。
 */
export const DEFAULT_PALETTE: ThemePalette = { base: "neutral", accent: "banghe", style: "maia", radius: "default", chart: "default", menu: "default" };

export const THEME_STYLES: readonly { value: ThemeStyle; label: string; shadow: string; surface: string }[] = [
  { value: "vega", label: "Vega", shadow: "0 1px 3px color-mix(in oklch, var(--foreground) 12%, transparent)", surface: "var(--card)" },
  { value: "nova", label: "Nova", shadow: "0 0 0 1px color-mix(in oklch, var(--border) 72%, transparent)", surface: "color-mix(in oklch, var(--card) 94%, var(--background))" },
  { value: "maia", label: "Maia", shadow: "none", surface: "transparent" },
  { value: "lyra", label: "Lyra", shadow: "0 2px 5px color-mix(in oklch, var(--foreground) 10%, transparent)", surface: "var(--card)" },
  { value: "mira", label: "Mira", shadow: "0 0 0 1px color-mix(in oklch, var(--primary) 22%, transparent)", surface: "var(--card)" },
  { value: "luma", label: "Luma", shadow: "0 2px 8px color-mix(in oklch, var(--foreground) 9%, transparent)", surface: "color-mix(in oklch, var(--card) 90%, var(--background))" },
  { value: "sera", label: "Sera", shadow: "0 0 0 1px color-mix(in oklch, var(--border) 50%, transparent)", surface: "var(--muted)" },
  { value: "rhea", label: "Rhea", shadow: "0 3px 10px color-mix(in oklch, var(--foreground) 12%, transparent)", surface: "var(--card)" },
];

export const RADIUS_STYLES: readonly { value: RadiusStyle; label: string; hint: string; radius: string }[] = [
  { value: "default", label: "默认", hint: "跟随组件样式", radius: "0.625rem" },
  { value: "none", label: "无", hint: "直角边框", radius: "0" },
  /* 控件圆角走 --radius-4xl = --radius × 2.6（App.css @theme），小控件（h-6/h-7）
     的可渲染上限只有 12~14px，基准值超过 0.375rem 后各档全被钳成胶囊、看不出差异，
     所以档位刻意压在 0.125~0.375rem 区间。 */
  { value: "small", label: "小", hint: "微圆角", radius: "0.125rem" },
  { value: "medium", label: "中", hint: "常见圆角", radius: "0.25rem" },
  { value: "large", label: "大", hint: "明显圆角", radius: "0.375rem" },
];

export const MENU_STYLES: readonly { value: MenuStyle; label: string }[] = [
  { value: "default", label: "默认 / 实色" },
  { value: "solid", label: "实色" },
];

export const THEME_MODES: readonly { value: ThemeMode; label: string; hint: string }[] = [
  { value: "light", label: "浅色", hint: "出厂默认，强光下最清楚" },
  { value: "dark", label: "深色", hint: "夜班 / 弱光棚内" },
  { value: "system", label: "跟随系统", hint: "随 Windows 应用模式切换" },
];

export const BASE_COLOR_THEMES: readonly ThemePreset[] = BASE_THEMES;

/**
 * 品牌主题色（手写，不在 tools/gen-theme-presets.mjs 的生成范围内）。
 *
 * 色相取自 logo 主色 #34914f = oklch(0.585 0.133 150)，但出厂直接用这个值不合格：
 * 它相对白底只有 3.79:1，而 --primary 在本工程既当按钮底色又当 text-primary 前景色
 * （ChoiceCard / OperatorSwitch / TemplateEditor / badge link 等 6 处以上直接落在页面背景上），
 * 对比度是对称的，所以同一个值必须同时撑住两种用法——只能往下压明度。
 * 这里压到 oklch(0.515 0.105 151)（≈ #327847，5.14:1），色相与观感仍跟 logo 一致，只是深一档。
 * 深色档反过来：--primary 要亮于背景（0.145）才读得出来，所以用 0.75 配深绿前景，
 * 与 neutral 基础色板"深色下 primary 是浅色"的约定同向。
 */
const BRAND_ACCENT_THEME: ThemePreset = {
  key: "banghe",
  title: "BangHe",
  zh: "磅禾绿",
  light: {
    "primary": "oklch(0.515 0.105 151)",
    "ring": "oklch(0.62 0.11 151)",
    "sidebar-primary": "oklch(0.515 0.105 151)",
    "chart-1": "oklch(0.871 0.15 154.449)",
    "chart-2": "oklch(0.723 0.219 149.579)",
    "chart-3": "oklch(0.627 0.194 149.214)",
    "chart-4": "oklch(0.527 0.154 150.069)",
    "chart-5": "oklch(0.448 0.119 151.328)",
  },
  dark: {
    "primary": "oklch(0.75 0.11 151)",
    "primary-foreground": "oklch(0.24 0.06 151)",
    "ring": "oklch(0.62 0.11 151)",
    "sidebar-primary": "oklch(0.55 0.13 151)",
    "chart-1": "oklch(0.871 0.15 154.449)",
    "chart-2": "oklch(0.723 0.219 149.579)",
    "chart-3": "oklch(0.627 0.194 149.214)",
    "chart-4": "oklch(0.527 0.154 150.069)",
    "chart-5": "oklch(0.448 0.119 151.328)",
  },
};

/** 主题色列表：第一项"跟随基础色板"= 不叠加，其余取自官方色板 */
export const ACCENT_COLOR_THEMES: readonly ThemePreset[] = [
  { key: "default", title: "Default", zh: "跟随基础色板", light: {}, dark: {} },
  BRAND_ACCENT_THEME,
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
  return p.base === DEFAULT_PALETTE.base && p.accent === DEFAULT_PALETTE.accent && p.style === DEFAULT_PALETTE.style && p.radius === DEFAULT_PALETTE.radius && p.chart === DEFAULT_PALETTE.chart && p.menu === DEFAULT_PALETTE.menu;
}

export function resolveAppearanceVars(palette: ThemePalette): ThemeTokens {
  const style = THEME_STYLES.find((item) => item.value === palette.style) ?? THEME_STYLES[0];
  const radius = RADIUS_STYLES.find((item) => item.value === palette.radius) ?? RADIUS_STYLES[0];
  return {
    "component-shadow": style.shadow,
    "component-surface": style.surface,
    // "默认"＝不注入，让 App.css 的出厂 --radius（base-maia 直角体系）说话。
    // 曾经照官方表把默认档也写成 0.625rem，结果只要换过色板没动圆角，
    // 全界面就被悄悄改成圆角，Alert 等组件和主题观感分叉（见 05 §7.2）。
    ...(palette.radius === "default" ? {} : { "radius": radius.radius }),
  };
}

function toDecls(tokens: ThemeTokens, palette: ThemePalette): string {
  const chart = palette.chart === "default" ? null : findAccent(palette.chart).light;
  const menu = palette.menu === "solid" ? [`  --sidebar-accent: var(--sidebar-primary);`, `  --sidebar-accent-foreground: var(--sidebar-primary-foreground);`, `  --sidebar-active-fg: var(--sidebar-primary-foreground);`] : [];
  return Object.entries(tokens)
    .filter(([k]) => k !== "radius")
    .map(([k, v]) => `  --${k}: ${v};`)
    .concat(Object.entries(resolveAppearanceVars(palette)).map(([key, value]) => `  --${key}: ${value};`), ...menu, ...(chart ? [1, 2, 3, 4, 5].map((index) => `  --chart-color-${index}: ${chart[`chart-${index}`]};`) : []))
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
  return `${selectors.root} {\n${toDecls(light, p)}\n}\n\n${selectors.dark} {\n${toDecls(dark, p)}\n}`;
}

/** 注入专用：与样式插入顺序无关 */
const INJECT_SELECTORS = { root: "html:root", dark: "html.dark" };

/** 复制给用户粘进 App.css 的完整片段（带抬头注释，免得粘进去看不出是哪套色板） */
export function paletteToClipboardCss(p: ThemePalette): string {
  const base = findBase(p.base);
  const accent = findAccent(p.accent);
  const tail = p.accent === "default" ? "" : ` + 主题色 ${accent.title}（${accent.zh}）`;
  return `/* 磅禾 · 基础色板 ${base.title}（${base.zh}）${tail} —— 粘进 src/App.css 即为出厂默认 */\n${paletteToCss(p)}\n`;
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
    const style = THEME_STYLES.some((item) => item.value === v.style) ? v.style! : DEFAULT_PALETTE.style;
    const radius = RADIUS_STYLES.some((item) => item.value === v.radius) ? v.radius! : DEFAULT_PALETTE.radius;
    const chart = typeof v.chart === "string" && ACCENT_COLOR_THEMES.some((item) => item.key === v.chart) ? v.chart : DEFAULT_PALETTE.chart;
    const menu = v.menu === "solid" ? v.menu : DEFAULT_PALETTE.menu;
    return { base, accent, style, radius, chart, menu };
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
    // 出纸这几秒标题栏不参与：打印守卫摘 .dark 是给纸面用的，不是用户改了主题。
    // 不挂起的话每打一张纸，原生标题栏就闪一次浅色（见 lib/titlebar-native.ts 的挂起闸门）
    setTitlebarSyncSuspended(true);
    darkBeforePrint = document.documentElement.classList.contains("dark");
    if (darkBeforePrint) document.documentElement.classList.remove("dark");
  });
  window.addEventListener("afterprint", () => {
    if (darkBeforePrint) document.documentElement.classList.add("dark");
    darkBeforePrint = false;
    setTitlebarSyncSuspended(false);
  });
}
