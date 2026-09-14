/**
 * 原生标题栏深浅的通道与同步入口（对端命令见 `src-tauri/src/titlebar.rs`）。
 *
 * 为什么需要这一层：界面里的深色是 `.dark` 类 + 色板令牌（05 §7.4），而窗口上沿那条标题栏是
 * Windows 自己画的，跟网页 CSS 没有任何关系。Tauri 自带的 `window.setTheme()` 在本工程用的
 * 版本里只设 WebView2 的 preferred color scheme，碰不到标题栏，所以只能把「此刻是深色吗」
 * 这一个布尔值送到 Rust 去涂 DWM。
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

/** 涂一次标题栏。浏览器预览没有原生通道，空操作 */
async function applyTitlebarTheme(dark: boolean): Promise<void> {
  if (!runningInTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    await invoke("titlebar_set_dark", { dark });
  } catch {
    // 见 titlebar.rs 边界 3：Win10 1809 之前 / 无桌面合成时 DWM 会拒，只影响观感
  }
}

let started = false;
/** 已送达的值，省掉重复 invoke（observer 会因为任何类变动被触发，包括跟深浅无关的类） */
let applied: boolean | null = null;
let inFlight = false;
/** 打印期间挂起：见 theme.ts 的 guardPrintTheme，它会把 .dark 临时摘掉、打完装回来 */
let suspended = false;

function push(): void {
  if (suspended) return;
  const dark = isDocumentDark();
  if (inFlight || dark === applied) return;
  inFlight = true;
  void applyTitlebarTheme(dark).finally(() => {
    inFlight = false;
    applied = dark;
    // 这轮在飞的时候用户又切了一次（或打印守卫刚把类装回来）——以真实类名补一次
    if (isDocumentDark() !== applied) push();
  });
}

/** 打印前后的挂起闸门。恢复时立刻按当前界面补一次，免得打完纸标题栏还停在浅色 */
export function setTitlebarSyncSuspended(value: boolean): void {
  suspended = value;
  if (!value) push();
}

/** 启动标题栏同步：首帧涂一次，之后跟着 `<html class>` 走。只在 `main.tsx` 调一次 */
export function startTitlebarThemeSync(): void {
  if (started || typeof MutationObserver === "undefined") return;
  started = true;
  push();
  new MutationObserver(push).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}
