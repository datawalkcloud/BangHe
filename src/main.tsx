import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DisplayWindowApp } from "@/components/business/DisplayView";
import { bootstrapTheme } from "@/lib/theme";
import { setupGlobalScrollbar } from "@/lib/scrollbar";

/**
 * 挂载前先把本机主题打上（.dark 类 + 色板覆盖）。
 * App.css 已由上一行的 import 链注入，这里追加的样式一定排在它后面，覆盖关系成立。
 */
bootstrapTheme();
/** 滚动条默认隐藏、滚动时才浮现：CSS 拿不到"正在滚动"，这里补状态类（见 lib/scrollbar.ts） */
setupGlobalScrollbar();

const isDisplayWindow = new URLSearchParams(window.location.search).get("display") === "1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{isDisplayWindow ? <DisplayWindowApp /> : <App />}</React.StrictMode>,
);
