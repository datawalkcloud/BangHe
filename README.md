# 磅禾粮站收粮系统

单机离线的粮站收粮过磅管理系统（Tauri 2 + React + Rust + SQLite）：制单、称重、化验、计价结算、付款、台账报表与小票打印，一台 Windows 电脑全程离线可用。

## 下载

Windows 64 位安装包，公网可直接下载：

- **国内高速（推荐）**：<https://gitee.com/SpringHgui/banghe-dl/raw/master/banghe-latest-windows-x64-setup.exe>
- **GitHub 备用**：<https://github.com/datawalkcloud/BangHe/releases/latest>

> `banghe-latest-windows-x64-setup.exe` 是稳定文件名，始终指向最新版（由 CI 每次发版同步到公开 Gitee 仓 `banghe-dl`）。本项目以 Apache-2.0 开源；安装包与在线更新清单直接挂在本仓的 GitHub Release。

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
