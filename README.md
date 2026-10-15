# 磅禾粮站收粮系统 · BangHe

面向乡镇粮站 / 个体收粮点的**单机桌面版**收粮管理系统。覆盖建档登记 → 扦样化验 → 一次称重（毛重）→ 二次称重（皮重）→ 核算结算 → 台账归档的完整闭环，直连地磅仪表、证卡阅读器、摄像头与小票打印机，**全部功能离线可用**。

- 技术底座：Tauri 2（Rust）+ React 19 + Vite + TypeScript + Tailwind + shadcn/ui，数据落地本地 SQLite
- 许可证：[Apache-2.0](./LICENSE)
- 平台：Windows 10/11（x64）。这是粮站单机软件（地磅串口 / 读卡器 / 打印机），不含 macOS / Linux 用户

## 功能一览

| 模块 | 说明 |
| --- | --- |
| 工作台 | 磅房主界面：新建过磅单、一次/二次称重、留痕抓拍、复称、打印磅单 |
| 扦样化验 | 水分 / 杂质等指标逐项录入，为未来计价引擎结构化预留 |
| 核算结算 | 按净重与单价结算，一个售粮人多车次可合并为一张结算单 |
| 台账报表 | 磅单 / 结算 / 日汇总等台账，支持导出 |
| 基础档案 | 售粮人、车辆、粮种、站点参数等主数据 |
| 对外大屏 | `F2` 独立窗口，超大字号显示当前读数，供农户当场确认 |
| 磅房语音 | 本机声卡直连的人工话筒喊话 + 系统语音播报（`F4` PTT） |
| 小票打印 | 三通道：A4 套打 / PDF 静默 / ESC/POS 热敏直打 |

## 三条硬约束（设计基线，不可动摇）

1. **单据永不物理删除**——只能作废 / 红冲，且留授权人与原因。
2. **金额与重量全链路禁浮点**——重量以 0.1 kg、金额以「分」定点整数存储。
3. **无硬件可全流程跑通**——外设走 Mock + 手录，便于开发、演示与回归。

## 技术栈与目录结构

```
banghe/
├── src/                  前端（React 19 + Vite + TypeScript + Tailwind + shadcn/ui）
├── src-tauri/            Rust 主程序、SQLite 迁移、集成测试（tests/schema_contract.rs）
├── crates/ticket-core/   票据 / 小票渲染核心（独立 crate，src-tauri 路径依赖）
├── tools/escpos-probe/   ESC/POS 打印机探测工具
├── scripts/              契约 / 一致性校验脚本（receipt-code、scale-align 等）
└── docs/design/          设计基线（01–07 七篇 + 索引）
```

- 前端与 Rust 之间经 Tauri `invoke` 通道；开发态无原生通道时自动回落到浏览器预览 Mock。
- 数据库落在系统用户目录下的 `banghe.db`（标识 `cn.datawalk.bh`）。
- 应用版本号四处单源（`package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock`），由 `schema_contract::app_version_is_single_sourced` 守卫，漏改一处即测试红。

## 环境要求

- Windows 10/11 x64
- [Rust](https://www.rust-lang.org/tools/install) 稳定版工具链（MSVC 构建依赖）
- [Node.js](https://nodejs.org/) ≥ 22
- WebView2 运行时（现代 Windows 通常已内置；装机包按 `downloadBootstrapper` 首次联网补齐）

## 开发

```bash
npm install

# 桌面端开发（热重载，含 Rust 侧编译）
npm run tauri dev

# 仅浏览器预览前端（无原生通道，走 Mock，不需要 Rust/硬件）
npm run dev
```

## 构建与本地校验

```bash
# 生产构建（先 tsc + vite build，再 cargo release-fast）
npm run build:fast

# 各 crate 独立校验（仓库根无 Cargo.toml）
cd src-tauri && cargo check
cd crates/ticket-core && cargo test
```

> 临时产物（日志、验证构建、截图等）请一律落在仓库根 `.scratch/`，勿散落他处。详见 [AGENTS.md](./AGENTS.md)。

## 打包发布

打 `v*` 标签会触发 `.github/workflows/release.yml`：构建 Windows NSIS 安装包、做 minisign 分离签名、生成更新清单 `latest.json`，并在**本仓库**发布一个正式 GitHub Release（源码与产物同仓，应用内「检查更新」匿名从 `releases/latest` 拉取）。发布只需配置 `TAURI_SIGNING_PRIVATE_KEY` 一个 Secrets（验签公钥配在 `tauri.conf.json` 的 `plugins.updater.pubkey`）。

## 文档

完整设计与验收口径见 [docs/design/README.md](./docs/design/README.md)（业务调研、功能规划、技术架构与数据模型、硬件对接、UI 规范、IC 卡流转、语音播报七篇，含 Mermaid 流程 / 状态 / ER 图）。

## 许可

本仓库采用 [Apache License 2.0](./LICENSE)。

© 2026 datawalkcloud
