# BangHe 项目长期备忘

## UI 框架纪律（2026-09-12 确立）

**全项目只用一个 UI 框架：shadcn（`components.json` 为 `base-maia` 风格，底层 `@base-ui/react`）。**
除少数有硬性技术理由的例外，页面/业务组件里不得再手写原生语义元素（`<button>` /
`<input>` / `<select>` / `<textarea>` / `<table>` / `<dialog>`），一律改用 `@/components/ui/*`。

- 组件清单与新增方式：`npx shadcn add <name>`，或从
  `https://ui.shadcn.com/r/styles/base-maia/<name>.json` 取回源码后把
  `@/registry/base-maia/ui/*` 改写为 `@/components/ui/*`、把 registry 私有的
  `IconPlaceholder` 换成本项目在用的 `lucide-react`。
- 下拉一律走 `business/Choose.tsx`（包 `ui/native-select.tsx`）。文件头注说明了为何
  **刻意不用** shadcn 的 `Select`：磅房要求键盘/小键盘直接录入，且 Tauri WebView 里
  原生 select 不会产生浮层焦点逃逸。
- 日期一律走 `ui/date-picker.tsx`（Popover + 自绘日历，不依赖 react-day-picker）。

### 允许的例外（改动前先读这一段）

| 位置 | 为何不换 |
| --- | --- |
| `print/sheets.tsx`、`print/receipt/render.tsx` 的 `<table>` | 打印票面。需要 `border-collapse` 与可换行排版；shadcn `Table` 的 `overflow-x-auto` 容器与 `whitespace-nowrap` 会改变出纸版面。 |
| `workstation/WorkstationGrid.tsx` 把手内的收起 `<button>` | 位于 react-grid-layout 的拖拽把手（`.ws-grip`）内，`Button` 的盒子尺寸/内边距会破坏把手几何与拖拽命中区。 |
| `business/ThemeSettingsPanel.tsx` 的 `<input type="radio" className="sr-only">` | 「整卡可点」的卡片式单选。shadcn `RadioGroup` 的 item 是 Base UI 的 button，放进 `<label>` 后失去原生 label 激活；`sr-only` 的 `position:absolute` 又和 item 自带的 `relative` 冲突。换过去是净损失。 |
| `components/ui/**` 内的原生元素 | 那些**就是** shadcn 的实现本体，不要动。 |

### 受控的排版覆盖方式

shadcn `Table` 的默认节奏（表头 `h-12`、单元格 `p-3`、表头 `font-medium` 且 `text-foreground`、
单元格 `whitespace-nowrap`）是给列表页用的。详情页里嵌在卡片内的紧凑明细表，要压回
`py-1.5` / 无左右内边距 / 表头随行取色，统一用**后代选择器**常量，不要逐个单元格写：

```ts
const DETAIL_TABLE =
  "border-collapse text-sm [&_th]:h-auto [&_th]:px-0 [&_th]:py-1.5 [&_th]:font-normal [&_th]:text-inherit [&_td]:px-0 [&_td]:py-1.5";
```

理由：`[&_th]:x` 的特异性是 0,1,1，**稳定高于**组件内置工具类的 0,1,0，不受 Tailwind
输出顺序影响；而把覆盖写在单元格 `className` 上只能靠 `tailwind-merge` 的同组覆盖，遇到
不同组（如 `p-3` vs `py-1.5`）会失效。

## 打印入口（2026-09-13 更新：引入 iframe 通道）

**热敏小票 / A4 静默出纸** 仍走 `useSilentReceiptPrint()`（`components/print/receipt/useSilentPrint.tsx`）：
`printReceiptSilently` 按**设备中心台账**解析出纸口（默认打印机优先：ESC/POS 直写 or
Windows 打印队列），无预览直打；只在真打不出去时回退 `ReceiptPrintPreview`。已收口的入口：
工作台 F9 / 第二刷自动出码单 / 结算框「凭票打印」/ 磅单详情（页面 + 抽屉）/ 质检单详情 /
结算单详情「打印凭证」/ 付款台账的付款小票 / 扫码结算（结完自动出凭证、卡片上的补打）。
**出纸口解析只在 `silent.ts::resolveDirectTarget` 有一份实现**，不要在外面重复写。

**预览框里的「打印测试」/ 任何「所见所得打印」** 一律走 `printJob()`（`components/print/printPage.ts`）：
把 `#print-root` 整段克隆到一个**隐藏 iframe**（`position:fixed;left:-20000px`，不要
`display:none` / `visibility:hidden`，部分引擎会把它们从打印里剥掉），把主文档的 `<style>`
与 `<link rel=stylesheet>` 通过 `doc.importNode()` 注入 iframe 并把 link href 绝对化，
覆写 `print-color-adjust: exact`、`body * { visibility: visible }`、把 `position`
拍回 `static`、`[data-page-fixed="1"]` 时把票面 padding 归零，再按纸张像素宽度设
iframe viewport、等 `doc.fonts?.ready` + `requestAnimationFrame` 后调用
`iframe.contentWindow!.print()`。`onAfterprint` + 120s 安全超时回收 iframe。
**`ReceiptPrintPreview` / `TemplateEditor` 的「打印测试」已统一改用 `printJob()`**，
不要再写 `window.print()`。

请求对象可带 `onFallbackClose`：兜底预览框关闭时回调，只有"出票后还要收尾"的页面需要
（扫码结算靠它把焦点交回扫码口、清掉 URL 上的单号）。

**仍走 `window.print()` 的三类例外**：
① 报表页的收购台账 / 日报表（多页 A4，且现场默认打印机可能是热敏小票机，
`ReportsPage` 另有 `printPage()` 明确走系统打印对话框）；
② 系统页的两处 `window.print()` 是"打印当前页面"（审计留痕、日结交接表）；
③ `print/receipt/render.tsx` 内**不得**再写 `@page { size: ... }` —— `auto`
不是合法 CSS 长度，浏览器会直接丢弃规则、退回打印机默认纸型，
导致 80mm 热敏被塞进 A4。几何由 `printPage.ts` 在 iframe 内部按纸张 mm 动态写入。

## 票面版式（2026-09-13 新增）

`ReceiptTemplate` 多了一个 `layout?: ReceiptLayout` 字段（`"receipt" | "sheet"`），
缺省时由 `defaultLayout(paper)` 按纸型推：热敏小票（58/80mm、241/241x279 等卷纸）
→ `receipt`，A4/241 等页纸 → `sheet`。版式是**用户可在模板编辑器里改的覆盖项**，
不是纸型派生的硬约束。`TemplateEditor` 改纸型时会同步
`patch({ paper: p, layout: defaultLayout(p) })`。

`receipt` 版式走纯黑底热敏小票观感：12px SimSun、虚线分隔 (`Rule`)、单倍行高、左右
贴边（`PaperFrame` `MAX_FIT = 2.5`，58mm 票会被放大 2.5× 显示，预览下边框显示
「按 250% 显示，实际纸宽 58 mm」），没有外框；表头只保留「单号 / 日期」两条 kv，
省掉地址 / 电话（escpos 直打的真票里本来也没有，省 3~4 行对 58mm 是救命）。
`sheet` 版式保留原 A4 风：实线分隔、上下结构、表头有完整「地址/电话」一行，
`data-page-fixed="1"` 触发打印时 padding 归零。

**保存 / 读取要走 `defaults.ts::withLayout(buildTemplate(scenario))`**，
不要直接 `JSON.parse(localStorage.getItem(...))` —— 老模板没有 `layout` 字段，
加载时不要回退成 `undefined` 触发 CSS 兜底分支。

## 类型检查现状（2026-09-13 更新：已干净）

**项目当前 typecheck 干净**：`npx tsc --noEmit --incremental false -p tsconfig.json` 连续多轮验证
exit=0、零输出（2026-09-13 两次：一次小票版式重构、一次过磅完成调整等级）。基线欠账已清，
见到任何 tsc 报错都应视为新引入的问题并当场修掉。

命令固定用 `npx tsc --noEmit --incremental false -p tsconfig.json` —— 不加
`--incremental false` 时会吃到 `tsconfig.tsbuildinfo` 的增量，输出不可信。

`package.json` 的 `tsc` 开了 `noUnusedLocals` + `noUnusedParameters`，
**删掉某段 JSX 后一定要检查它消掉的局部变量/导入是否变成未使用**，否则会新增 TS6133。

`vite build` 同步验证用 `vite build --outDir dist-verify --emptyOutDir`
（2026-09-13 重构后 4.55s 干净，仅 Tauri 动态导入 warning 是预存项）。

> **cargo test 基线告警**（2026-09-13 已知）：`cargo test --test mock_coverage_contract`
> 报 `every_native_module_is_merged_into_api_ts` 失败，原因是 `src/lib/window-native.ts` 导出了
> `windowApi` 但没被 `src/lib/api.ts` 展开链 `...windowApi` 引入——与本任务无关、且早于本次改动。
> `STILL_MOCK` 也没列它（清单不许发霉的规则见 `mock_coverage_contract.rs`）。
> 继续跑 `cargo test --test orders_contract --test settlements_contract --test command_wiring_contract`
> 是干净的（28+5+6=39 全过），属于本任务验证集的一部分。

## 本地工具环境

- 本机 **bash 不可用**（`cat`/`ls`/`head` 等均 not found），一律用 PowerShell 工具：
  `cd /g/...` 与 `&&` 在这台机器上不可用。
- PowerShell 5.1 的 stdout 有时收不到，**把结果 `Out-File -Encoding utf8` 落盘再 Read** 才稳。
- **禁止用 PowerShell here-string 写中文源码**：PS 5.1 按 ANSI 读脚本，中文字面量会乱码
  并吞掉换行。写文件一律用 Write/Edit 工具。
- `Edit`/`Write` 偶发 `UNKNOWN: unknown error, open` / `EBUSY`（文件被占用，IDE 在跑），
  **重试一次即可**。
- `vite build` 清 `dist/` 时会撞沙箱批量删除护栏，改用
  `vite build --outDir dist-verify --emptyOutDir` 验证。

## 业务定级（2026-09-13 确立：两条线，分清楚）

磅单上跑着**两条互不相干的等级字段**，迎检与纠纷翻账时混了就会出错：

| 字段 | 含义 | 谁能改 | 改的姿势 |
| --- | --- | --- | --- |
| `qc_report.grade` | 化验员按国标的判定 | **永不改写** | 复检另立新单，旧单 `is_effective=0`（不变式 7） |
| `weigh_order.grade` | 结算用的业务定级 | 化验员 / 出纳 / 站长 | `order_set_grade`（`write_tx` + `GRADE_ROLES`），留事由 ≥ 4 字 |

后端闸门：`order_set_grade` 沿用 `VOIDABLE` 状态集；settled/paid/archived/reversed
直接 `Err("已结算的单改等级请先由站长红冲")`——这是因为等级一旦进了结算单就是
"钱"的一部分，要更正经 02 §F6.3 红冲，不允许悄悄改掉已结过的账。

前端入口两条：

1. **结算时改判**：`SettleForm` 加等级 Choose；与化验定级不同显示 warning；
   等级是定价的第一因，若当前价来自价目表（`matchesList`）则改等级时自动跟价
   并 toast，手填/已偏离议价**不动**（避免覆盖现场议价）。
2. **过磅完成后改判**：`OrderDetailPage` 基本信息卡 CardAction 加「调整等级/
   定级」按钮（BadgeCheckIcon），与「登记去向」并排；Dialog 收等级 + 现状
   （含化验定级对照） + 事由 ≥ 4 字。

**事后追溯靠 audit_log，不要往 settlement_order 加 grade 列**：迁移代价大、
查询不受影响。`settle.create` 备注里的"等级 X → Y" + `order.grade` 动作的
`order.grade` 备注两条记录够用。
