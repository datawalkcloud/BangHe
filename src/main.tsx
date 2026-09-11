import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { bootstrapTheme } from "@/lib/theme";

/**
 * 挂载前先把本机主题打上（.dark 类 + 色板覆盖）。
 * App.css 已由上一行的 import 链注入，这里追加的样式一定排在它后面，覆盖关系成立。
 */
bootstrapTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
