# BangHe 长期备忘（索引）

**细则按主题拆到 `memory/topics/`，动手前读对应那一份**（原文照搬，只搬家不改写）：

| 要做什么 | 先读 |
| --- | --- |
| 写页面/业务组件、加 shadcn 组件、改 user_preference | `topics/ui.md` |
| 改票面、码制、打印（预览 / A4 队列 / 热敏三条出纸路） | `topics/print.md` |
| 改定级、结算、化验、品种、定价、净重刚定那一步、结算单结清呈现 | `topics/business.md` |
| 跑验证命令、被本机工具环境坑到 | `topics/toolchain.md` |

## 不看细则也不能踩的四条
1. **UI 只用 shadcn**：页面/业务组件禁写原生 `<button>/<input>/<select>/<table>/<dialog>`；下拉一律
   `business/Choose.tsx`（**刻意不用** shadcn `Select`：磅房要键盘直录，原生 select 在 Tauri WebView 里
   不浮层逃逸）。例外清单在 `topics/ui.md`，改到那些文件前先读。
2. **动落库偏好必回填缓存**：`prefsApi.setPref` 成功后必须
   `queryClient.setQueryData(["pref", KEY, actorId], json)` ——偏好查询全是 `staleTime: Infinity`，
   不回填就是"改过、保存过，切走再切回来又变回去"。
3. **每个判定/公式只有一份**：出纸口解析只在 `silent.ts::resolveDirectTarget`、算钱只在
   `calc.ts::previewSettlement`、净重刚定的判定只在 `settle-defaults.ts::postWeighAction`、
   默认模板与取用侧兜底只在 `defaults.ts::normalizeTemplate`、出票前拉最新只在 `triggerPrint`。
   别在第二处重写——这仓库的坑几乎全出在"同一个判定被抄了两遍，后来只改了一处"。
4. **三条硬闸**：`weigh_order.variety_id` 制单必填、`qc_report.grade` 永不改写、扣重只能从 `settle` 落库。
   细节见 `topics/business.md`。
5. **日期一律 shadcn**：`ui/date-picker.tsx` / `ui/date-range-picker.tsx` 内部是 shadcn
   `Popover + Calendar`。禁手写日历网格（`<button>` 画 6×7）、禁 `<input type="date">`；
   `Date`↔`YYYY-MM-DD` 只用 dayjs 本地时区，不用 `toISOString()`。细节见 `topics/ui.md`。

## 验证速记（全文见 `topics/toolchain.md`）
`npx tsc --noEmit --incremental false -p tsconfig.json`（**必须**带 `--incremental false`）；
`npx vite build --outDir dist-verify --emptyOutDir`（别清 `dist/`）；Rust 契约测试逐个 `--test` 跑，
**别用裸 `cargo test`**；票面/码改完跑 `scripts/receipt-code/check.ts`。
本机 bash 不可用 → 用 PowerShell，stdout 常收不到 → `Out-File -Encoding utf8` 落盘再 Read。
