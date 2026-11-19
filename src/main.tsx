import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DisplayWindowApp } from "@/components/business/DisplayView";
import { preloadPages, router } from "@/router";
import { dismissBootSplash, dismissBootSplashWhenPainted } from "@/lib/boot-splash";
import { bootstrapTheme } from "@/lib/theme";
import { startTitlebarThemeSync } from "@/lib/titlebar-native";
import { setupGlobalScrollbar } from "@/lib/scrollbar";

/**
 * 挂载前先把本机主题打上（.dark 类 + 色板覆盖）。
 * App.css 已由上一行的 import 链注入，这里追加的样式一定排在它后面，覆盖关系成立。
 */
bootstrapTheme();
/**
 * 原生标题栏跟着界面深浅走（Windows 上那条标题栏不归 CSS 管，见 lib/titlebar-native.ts）。
 * 放在这里而不是各根组件里挂 effect：主窗口与对外大屏窗都跑这一份 main.tsx，两边同时生效，
 * 且早于 React 挂载，深色用户启动时不会先看到一条白标题栏。
 */
startTitlebarThemeSync();
/** 滚动条默认隐藏、滚动时才浮现：CSS 拿不到"正在滚动"，这里补状态类（见 lib/scrollbar.ts） */
setupGlobalScrollbar();

const isDisplayWindow = new URLSearchParams(window.location.search).get("display") === "1";

/**
 * 骨架撑到第一屏真的画出东西才撤（判据见 lib/boot-splash.ts 的 dismissBootSplashWhenPainted）：
 * 挂在 React 挂载或路由 onRendered 上都会早撤——那两下正文还在 await 懒加载 chunk，
 * 而 React 对新挂载的 Suspense 边界要压约 500ms 才画骨架，撤早了就是露一屏空壳灰。
 * 兜底那条是给 onRendered 意外不来的场合留的——品牌画面多杵一会儿，总比整屏点不动强。
 *
 * 撤完顺手预热其余页面 chunk（router.tsx 的 preloadPages）：侧栏是 `navigate()` 不是 `<Link>`，
 * 路由的 intent 预读一次都不会触发，不预热的话每个页面头一次打开都要现读现解析、先闪一帧骨架。
 * 挂在这里而不是启动那几毫秒：预热要和首屏抢同一份 CPU，正白屏时不该去拖后腿。
 */
const offFirstRender = router.subscribe("onRendered", () => {
  offFirstRender();
  dismissBootSplashWhenPainted();
  void preloadPages();
});
setTimeout(dismissBootSplash, 12_000);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isDisplayWindow ? <DisplayWindowApp /> : <App />}</React.StrictMode>,
);
