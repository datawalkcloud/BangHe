# AGENTS.md — BangHe 仓库约定

本文件是**给 AI 编码会话看的**硬约束，随仓库分发。只放"违反了别人会踩坑"的条目；
本机环境与工具链的细则在 `.workbuddy/memory/topics/`（该目录不入库，新克隆的机器上可能不存在）。

## 临时产物落盘（硬约束，先读这条）

**一切临时产物只能写进仓库根的 `.scratch/`。** 包括：命令输出转储、验证构建目录、
冒烟截图、一次性脚本、AI 生成素材的中间图。目录不在就先建（`mkdir .scratch`），
已在 `.gitignore` 里整目录忽略，随便扔、不用收拾。

- **禁止往仓库根目录散落文件。** 这里堆过 570 多个 `_tsc.txt` / `build-verify*.txt` /
  `dist-verify/` 之类的会话残留，而且它们**曾被 git 跟踪**——对已跟踪文件加 `.gitignore`
  完全无效，最后只能 `git rm --cached` 逐个退库。别再制造第二轮。
- 落盘文件名带上用途：`.scratch/tsc-结算闸门.txt`，不要 `_tmp2.txt`。
- 用 PowerShell 收不到 stdout 而 `Out-File` 落盘时，路径同样必须是 `.scratch/` 下的文件。
- `.gitignore` 里带前导 `/` 的那批（`/*.txt`、`/_*`、`/build-*` …）是**会话没守规矩时的
  兜底网**，只匹配仓库根一层；别把它当成"反正会被忽略"的许可。

## 会产生产物的验证命令

统一按下面的写法，产物落点已经指好：

```bash
npx tsc --noEmit --incremental false -p tsconfig.json        # 必须 --incremental false，否则吃 tsbuildinfo
npx vite build --outDir .scratch/dist-verify --emptyOutDir   # 别清 dist/，会撞沙箱批量删除护栏
npx esbuild scripts/receipt-code/check.ts --bundle --platform=node --format=cjs \
    --outfile=.scratch/receipt-code.cjs && node .scratch/receipt-code.cjs
```

`cargo` 没有工作区根（仓库根没有 `Cargo.toml`），三个 crate 各自独立：
`cd src-tauri; cargo check`、`cd crates/ticket-core; cargo test`、`cd tools/escpos-probe; cargo check`。

## 三个静默坑

- **`vite.config.js` 会遮蔽 `vite.config.ts`。** Vite 查找配置的顺序里 `.js` 在 `.ts` 之前，
  而 `tsc` 会顺手把 `vite.config.ts` 编译成同名 `.js`。一旦根目录出现这个文件，
  今后所有对 `vite.config.ts` 的修改都不生效且毫无报错。它已在 `.gitignore` 里，
  发现落在盘上直接删。
- **`crates/ticket-core` 是源码，不是产物。** 它是 `src-tauri/Cargo.toml` 的路径依赖
  （`ticket-core = { path = "../crates/ticket-core" }`）。`.gitignore` 只忽略
  `crates/*/target/`；以前那条 `/crates` 整目录忽略是误加，会让新增的 `.rs` 被静默漏提交。
- **程序开着库的时候，绝不用文件拷贝覆盖 `%APPDATA%\cn.datawalk.bh\banghe.db`。**
  现象是双击闪退，`startup_error.log` 里只有孤零零一句 `database disk image is malformed`。
  机制：旧连接的页缓存按自己认下的页数继续往同一个文件里刷，两份内容叠在一个文件上，
  落成一个「头部声明 348 页、实际只有 140 页」的半拷贝（`db_file_diagnosis` 现在会把这条
  体检写进日志，但拦不住人）。换库一律走界面「系统 → 恢复备份」，它按
  收敛 WAL → 释放句柄 → 旧库改名留退路 → 整份拷副本 → 失败自动换回 的顺序做；
  非要手工拷文件，先完全退出程序，拷完再启动。
