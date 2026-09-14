# topics/ui.md — 界面与组件（细则原文，从 MEMORY.md 搬来）

## UI：全项目只用 shadcn
`components.json` = base-maia，底层 `@base-ui/react`。页面/业务组件禁写原生
`<button>/<input>/<select>/<textarea>/<table>/<dialog>`，一律 `@/components/ui/*`。新增用
`npx shadcn add <name>`，或取 `ui.shadcn.com/r/styles/base-maia/<name>.json` 源码，把
`@/registry/base-maia/ui/*` 改写为 `@/components/ui/*`、`IconPlaceholder` 换 `lucide-react`。
下拉一律 `business/Choose.tsx`（包 `ui/native-select.tsx`）——**刻意不用** shadcn `Select`：磅房要键盘
直接录入，且原生 select 在 Tauri WebView 里不会浮层焦点逃逸。

## 日期：一律 shadcn Calendar + Popover，禁手写日历、禁 `<input type="date">`
`ui/date-picker.tsx`（单日）与 `ui/date-range-picker.tsx`（区间）都是 **shadcn
`Popover` + `Calendar`**（`react-day-picker` v10，`zhCN` + `weekStartsOn={0}` 周日打头）外面套一层
字符串适配：对外仍是 `YYYY-MM-DD`，`Date`↔字符串只用 `dayjs`（本地时区），**不许 `toISOString()`**——
那会把东八区当天算成前一天。日期列/日历网格一律不再自己用 `<button>` 画。
- `DateRangePicker` 半程选择只留在内部 `draft`，凑齐两端才 `onChange`（避免没选完就刷新筛选）。
- `mode="range"` 必须带 `min={1}`：否则 RDP 第一次点击就补 `to=同一天` 并立刻收敛成单日区间。
- 想要新增日期控件，先 `npx shadcn add calendar/popover`，不要自己写第二套日历。
- **shadcn CLI 会顺手覆盖 `ui/button.tsx` 并删掉 `nativeButton={props.render ? false : true}`**
  （用 render 换 `<a>`/`<Link>` 时的兜底），每次跑完 `shadcn add` 记得 `git diff` 检查并贴回去。

例外（改动前先读）：`print/sheets.tsx`、`print/receipt/render.tsx` 的 `<table>`（票面要 border-collapse
与换行，shadcn Table 的 overflow-x-auto / whitespace-nowrap 会改出纸版面）；`WorkstationGrid.tsx` 把手内
的收起 `<button>`（Button 尺寸破坏 `.ws-grip` 命中区）；`ThemeSettingsPanel.tsx` 的 `sr-only` radio
（整卡可点）；`components/ui/**`（实现本体）。

紧凑明细表统一用**后代选择器常量**（`[&_th]:x` 特异性 0,1,1 稳定高于内置工具类的 0,1,0，不受
Tailwind 输出顺序影响），不要逐格写 className —— 范式见 `DETAIL_TABLE`（`OrderDetailPage.tsx`）。

## user_preference 写入纪律
走 `prefsApi.setPref/getPref` 的偏好，写库成功后**必须同时**
`queryClient.setQueryData(["pref", KEY, actorId], json)` 回填（偏好查询全是 `staleTime: Infinity`：
`useCloseBehavior`/`useSoftKeyboard`/`useSidebarWidth`/`workstation/layout`）。不回填就会踩"改过、保存过，
切走再切回来又变回去"。并发 IPC 回执可能倒序 → 照 `layout.ts` 的 `writeSeq` 只认最新意图。失败路径也要回填。
