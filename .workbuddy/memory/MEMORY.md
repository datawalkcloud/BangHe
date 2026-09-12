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

## 类型检查现状（2026-09-12 更新：已干净）

**项目当前 typecheck 干净**：`npx tsc --noEmit --incremental false -p tsconfig.json` 连续多轮验证
exit=0、零输出（2026-09-12 三次）。早先"41 条既存错误、对照 `tsc-out.txt` 基线"的说法已过时，
基线欠账已清，见到任何 tsc 报错都应视为新引入的问题并当场修掉。

命令固定用 `npx tsc --noEmit --incremental false -p tsconfig.json` —— 不加
`--incremental false` 时会吃到 `tsconfig.tsbuildinfo` 的增量，输出不可信。

`package.json` 的 `tsc` 开了 `noUnusedLocals` + `noUnusedParameters`，
**删掉某段 JSX 后一定要检查它消掉的局部变量/导入是否变成未使用**，否则会新增 TS6133。

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
