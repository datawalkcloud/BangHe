/**
 * 原生标题栏深浅的通道与同步入口（对端命令见 `src-tauri/src/titlebar.rs`）。
 *
 * 为什么需要这一层：界面里的深色是 `.dark` 类 + 色板令牌（05 §7.4），而窗口上沿那条标题栏是
 * Windows 自己画的，跟网页 CSS 没有任何关系。Tauri 自带的 `window.setTheme()` 在本工程用的
 * 版本里只设 WebView2 的 preferred color scheme，碰不到标题栏，所以把「此刻是深色吗」加上
 * 界面底色一起送到 Rust 去涂 DWM——底色那条把标题栏压成与页面同一块纯色（深浅两态都涂），
 * 不让系统自绘深浅过渡；取不到纯色就只翻深浅，绝不拿 0 当"默认"传过去。
 *
 * 为什么用 MutationObserver 盯 `<html class>` 而不是在各处 setTheme 的调用点补一句：
 *  1. 只有一个真相来源——**页面上实际挂着 .dark 就把标题栏涂深**。谁改的（设置面板、
 *     next-themes 解析"跟随系统"、还是以后新增的某条路径）都自动覆盖，不会有"接了三处漏一处"；
 *  2. 挂载点唯一（`main.tsx`），主窗口与对外大屏窗各跑一遍自己的 `main.tsx`，两边都零接线；
 *     而命令参数收的是「谁 invoke 就涂谁的窗口」，正好对上。
 * 代价是一行 attribute 观察，比给两个根各挂一个同步组件便宜。
 *
 * 这个模块**故意不导出 `xxxApi` 对象**：它不在数据接口面上（不参与 mock 覆盖链，
 * 见 `src-tauri/tests/mock_coverage_contract.rs` 认的形状），浏览器预览直接空操作就对了。
 *
 * 失败一律静默：标题栏是装饰性的，老系统涂不动不该在磅房屏幕上留下一个错误框。
 */
import { runningInTauri } from "@/lib/native";

/** 界面当前是不是深色——以 `<html>` 上真正生效的类为准，不读 next-themes 的上下文 */
export function isDocumentDark(): boolean {
  return document.documentElement.classList.contains("dark");
}

/** 复用同一个 1px canvas 做颜色换算，不每次新建 */
let swatchCtx: CanvasRenderingContext2D | null | undefined;
/** 换算用的哨兵色：只要它被 fillStyle 认下来，回读值就跟"没被覆盖过"区分得开 */
const SENTINEL = "#010203";

/**
 * 把界面此刻的底色折成 0x00RRGGBB，给原生标题栏涂成同一块纯色。深浅两态都要涂：
 * 浅色下不涂的话标题栏留着系统那条浅灰，跟白页面还是两截。
 *
 * 读的是 `--background` 这个令牌本身，不是 body 的已用背景色：`main.tsx` 里
 * `bootstrapTheme()` 排在前面，首帧推这一次令牌已经就位，而自定义属性经 getComputedStyle
 * 原样吐回声明（`oklch(...)`），换算交给 1px canvas——`fillStyle` 吃完整 CSS 颜色语法
 * （oklch 要 Chromium 111+，本工程跑常青版 WebView2），读回来正是 DWM 要的那份 sRGB 字节。
 */
function readBackgroundCaption(): number | null {
  const cssColor = window.getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
  if (!cssColor) return null;
  if (swatchCtx === undefined) {
    swatchCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  }
  if (!swatchCtx) return null;
  // 非法颜色会被 fillStyle 静默丢弃、留着上一次的值得不到报错，所以先立个哨兵再比。
  // 比的是哨兵**被规范化后**的回读形式，不猜各家的序列化写法。
  swatchCtx.fillStyle = SENTINEL;
  const untouched = swatchCtx.fillStyle;
  swatchCtx.fillStyle = cssColor;
  if (swatchCtx.fillStyle === untouched) return null;
  swatchCtx.fillRect(0, 0, 1, 1);
  const [r, g, b] = swatchCtx.getImageData(0, 0, 1, 1).data;
  // 纯黑当"没读出来"处理：真配出纯黑底的用户极少，误判也只是回到系统自绘
  if (r === 0 && g === 0 && b === 0) return null;
  return (r << 16) | (g << 8) | b;
}

/** 送出去的一份值：深浅 + 该涂的纯色。两样都判等，省掉重复 invoke */
type TitlebarState = { dark: boolean; caption: number | null };

function readTitlebarState(): TitlebarState {
  return { dark: isDocumentDark(), caption: readBackgroundCaption() };
}

/** 涂一次标题栏。浏览器预览没有原生通道，空操作 */
async function applyTitlebarTheme(state: TitlebarState): Promise<void> {
  if (!runningInTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("titlebar_set_dark", { dark: state.dark, caption: state.caption });
  } catch {
    // 见 titlebar.rs 边界 3：Win10 1809 之前 / 无桌面合成时 DWM 会拒，只影响观感
  }
}

let started = false;
/** 已送达的值，省掉重复 invoke（observer 会因为任何类变动被触发，包括跟深浅无关的类） */
let applied: TitlebarState | null = null;
let inFlight = false;
/** 打印期间挂起：见 theme.ts 的 guardPrintTheme，它会把 .dark 临时摘掉、打完装回来 */
let suspended = false;

function same(a: TitlebarState, b: TitlebarState): boolean {
  return a.dark === b.dark && a.caption === b.caption;
}

function push(): void {
  if (suspended) return;
  const state = readTitlebarState();
  if (inFlight || (applied && same(state, applied))) return;
  inFlight = true;
  void applyTitlebarTheme(state).finally(() => {
    inFlight = false;
    applied = state;
    // 这轮在飞的时候用户又切了一次（或打印守卫刚把类装回来）——以真实类名补一次
    if (!same(readTitlebarState(), applied)) push();
  });
}

/** 打印前后的挂起闸门。恢复时立刻按当前界面补一次，免得打完纸标题栏还停在浅色 */
export function setTitlebarSyncSuspended(value: boolean): void {
  suspended = value;
  if (!value) push();
}

/**
 * 启动标题栏同步：首帧涂一次，之后跟着界面走。只在 `main.tsx` 调一次。
 *
 * 除了 `<html class>` 还要盯 `<head>`：换色板（外观设置里点一下主题色）走的是
 * `#banghe-theme` 那张样式表的 textContent，类名一点不动——只盯 class 的话深浅是对的，
 * 但纯色会停在换色前的那一块。
 */
export function startTitlebarThemeSync(): void {
  if (started || typeof MutationObserver === "undefined") return;
  started = true;
  push();
  const observer = new MutationObserver(push);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  observer.observe(document.head, { childList: true, subtree: true, attributes: true });
}
