# topics/toolchain.md — 验证与本机环境（细则原文，从 MEMORY.md 搬来）

## 验证命令
- `npx tsc --noEmit --incremental false -p tsconfig.json`（必须带 `--incremental false`，否则吃
  tsbuildinfo）。基线干净，见报错即视为新引入。开了 `noUnusedLocals/noUnusedParameters` → 删 JSX 后要
  清掉变成未使用的局部量与导入。
- `npx vite build --outDir dist-verify --emptyOutDir`（清 `dist/` 会撞沙箱批量删除护栏）。
- 前端**没有测试运行器**，票面/码这条链路的自检是独立脚本：
  `npx esbuild scripts/receipt-code/check.ts --bundle --platform=node --format=cjs --outfile=.tmp-receipt-code.cjs`
  然后 `node .tmp-receipt-code.cjs`（必须 `--format=cjs`，`qrcode` 的 node 入口内部 `require("fs")`）。
  改动票面默认值必须让它全绿。
- **别用裸 `cargo test`**（`masters_contract` 编译不过会卡死第一步），逐个 `--test`：`orders_contract /
  settlements_contract / command_wiring_contract / cards_contract / qc_contract / payments_contract /
  search_contract / dashboard_contract / reports_contract / ledger_contract / outbound_contract`。
  已知欠账（与业务无关）：`mock_coverage_contract`（`windowApi` 未进 `api.ts`）、`masters_contract`
  （`WarehouseInput` 加期初库存后契约没跟上，E0063）、`schema_contract`（期初库存快照未重生成）。
- **`cargo` 没有工作区根**：仓库根没有 `Cargo.toml`。`ticket-core` 的测试是 `src/render.rs` 里的
  `#[cfg(test)] mod tests`，没有 `tests/` 目录，所以进目录跑：`cd crates/ticket-core; cargo test`。
  另外两个 crate 各自独立：`cd src-tauri; cargo check`、`cd tools/escpos-probe; cargo check`。
- **改了 Rust 函数签名，必须真编译一遍**：`tsc` 与前端自检脚本**完全覆盖不到 Rust**，
  `tsc` 绿 ≠ Rust 能过。同一个签名（本章那次是 `render.rs::qr` 多一个 `pad_left`）改完要
  回头把**全部调用点**找齐，包括"不在主链路上"的写死版式老票（`write_weigh_ticket`/
  `write_self_test`）——它们最容易漏，而 `cargo` 会在下一次构建时才告诉你（E0061）。

## 本地工具环境
- 本机 **bash 不可用**（`cat`/`ls` 均 not found），用 PowerShell（`Bash` 工具里的 `cd /g/...`、`&&` 也不可用）。
- PowerShell 5.1 stdout 有时收不到 → `Out-File -Encoding utf8` 落盘再 Read。
- **禁止用 PowerShell here-string 写中文源码**（PS 5.1 按 ANSI 读，中文乱码并吞换行）；写文件用 Write/Edit。
- `Edit`/`Write` 偶发 `EBUSY` / `UNKNOWN: unknown error, open` → 重试一次。
- 文件可能在本会话读完后被外部改动；`old_string` 不匹配时重新 Read 再改。
