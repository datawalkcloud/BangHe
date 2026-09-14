# topics/print.md — 打印与票面（细则原文，从 MEMORY.md 搬来）

## 打印：三条出纸路
- **静默直打** `useSilentReceiptPrint()`（`print/receipt/silent.ts` + `useSilentPrint.tsx`）；出纸口解析**只在
  `silent.ts::resolveDirectTarget` 有一份**（热敏 → usbprint ESC/POS；A4/241 → Windows 队列）。入口：F9 /
  净重刚定自动出码单 / 结算框「凭票打印」/ 磅单详情（页+抽屉）/ 质检单详情 / 结算单详情 / 付款台账 / 扫码结算。
  其中**结算单详情每次「登记付款」成功也自动出一张结算凭证**（`printVoucherAfterPayment`，票面取
  `payment_add` 写完重读的那一行，见 `business.md` 末节）。
  行序列由 `escpos.ts::receiptLines(template, ctx)` 排出，纸型来自 `effectiveTemplate(scenario).paper`。
- **所见所得打印**走 `printJob()`（`print/printPage.ts`）：克隆 `#print-root` 到隐藏 iframe
  （`position:fixed;left:-20000px`，**不可** `display:none`/`visibility:hidden`），`importNode` 注入主文档
  style/link 并把 href 绝对化，覆写 `print-color-adjust:exact`、position→static、`[data-page-fixed=1]`
  padding 归零，按纸张像素宽设 viewport，等 `fonts.ready`+rAF 再 `print()`，`onAfterprint`+120s 回收。
  `ReceiptPrintPreview`/`TemplateEditor` 已统一用它，**别再写 `window.print()`**；请求可带
  `onFallbackClose`（"出票后还要收尾"的页面用）。
- **仍走 `window.print()` 三类**：报表页收购台账/日报表；系统页两处"打印当前页面"；
  `print/receipt/render.tsx` 内**不得**写 `@page{size:...}`（`auto` 不是合法长度会被丢弃→退回默认纸型，
  几何由 `printPage.ts` 在 iframe 内按纸宽毫米写入）。
- **出票前必先取最新**（`WorkstationPage.triggerPrint`，async）：先
  `await refetchQueries({queryKey:["order",no], type:"all"})`、再 `getQueryData` 取那一行、才
  `setPrintSeq`；净重未定直接拒出票。**`type:"all"` 不能省**——默认只重取 active，补打一张当前没显示的
  单时那份缓存是 inactive，会被原样留着。理由：出票总紧跟一次写库，而 `WeighPanel.capture.onSuccess`
  是"先 `onNetDetermined`（=出票）、后 `invalidateQueries`"，票面读到的必是写之前那份快照
  （皮重捕完票上皮重是空的，就是这么来的）。**新打印路径一律走 `triggerPrint`，别自己 setPrintTarget。**

## 票面版式与码制
`ReceiptTemplate.layout?: "receipt"|"sheet"`，缺省由 `defaultLayout(paper)` 推（卷纸→receipt，A4/241
→sheet）；用户可在编辑器里改，改纸型时同步 `patch({paper, layout: defaultLayout(p)})`。`receipt`：纯黑
热敏观感、12px SimSun、虚线 `Rule`、贴边无外框、表头只留单号/日期（`MAX_FIT=2.5`，58mm 按 250% 显示并
标注实际纸宽）；`sheet`：A4 风、实线分隔、表头含地址/电话。保存/读取走
`defaults.ts::withLayout(buildTemplate(scenario))`，**不要**直接 parse localStorage。
`ReceiptSection.codeStyle?: "qr"|"barcode"|"both"`**缺省恒为 `"qr"`**；出厂默认由 `defaults.ts` 定
（结算凭证 `{{settle_code}}` 即 `"barcode"`，过磅单 `{{ticket_code}}` 仍二维码）。改默认值要过
`scripts/receipt-code/check.ts` 的 F1–F4（esbuild 打包后 node 跑，前端无测试运行器）。`codeStyle` 与 kind
名 `qr` 都是**存进用户本机模板的字符串，不能改**。

## 码的横向落点：前端算，机器照点排（2026-09-14 新增规则）
**热敏侧一律不许用 `ESC a` 对齐**（`ESC a 1` 按**机身头宽**居中，与这卷纸无关）。80 机装 58 卷时
固件仍按 576 点（72mm）居中，48mm 宽的条码落在 12~60mm，纸只有 58mm → 右端连着 CODE128 停止符
一起出纸外："票看着打出来了，扫码枪读不出来"。正文早就绕开了（`render.rs::aligned` 补前导空格），
码是最后两个漏网的。

- 落点**只在 `code-size.ts::codeOffsetDots(codeDots, paper, machinePaper?)` 算一份**：
  `axis = min(纸卷整幅点宽, 机头点宽)`，`offset = (axis - codeDots) / 2`；定长纸恒 0
  （那是打印队列的地盘，落点归驱动）。宽度预算同理只在 `codeBudgetDots()`。
  两个辅助函数：`headDots()`（58 机 384 / 80 机 576）、`rollDots()`（58 卷 464 / 80 卷 640）。
  轴取 min 的理由：装态一致时它**恰好退回固件原来那个数**（80 纸对 576 点 → 576；58 卷对 384 点
  → 384），所以**80 装 80、58 装 58 的站点分毫不动**，只有"票面纸型 ≠ 机器纸型"才生效。
- **`machinePaper` 必须传**：它是这次出纸**告诉机器的**那张纸（`print_receipt` 的 paper 参数），
  与票面 `template.paper` 可能不同（模板按 80 存、机器装 58）。三个调用点在
  `silent.ts`（热敏 → `target.paper`）/ `ReceiptPrintPreview.tsx`（框里选的那张）/ `TemplateEditor.tsx`。
- 落点走 `NativePrintLine.qr/barcode` 的 `padLeft`（点）：`render.rs::qr` 折成前导半角空格
  （`pad_left / 12`，**向下取整**——宁可偏左一字符），`render.rs::barcode` 折成栅格前导零点后
  **左对齐**发出。`src-tauri/src/queue_print.rs` 那侧**刻意忽略 `pad_left`**（GDI 由驱动自己的
  可打区居中），别去"统一"它。
- **二维码的点宽这一侧算不出来**：`escpos` 只把载荷发给固件（`escpos::domain::codes::qrcode`
  连编码器都没有），版本由机器按自己的容量表/字符集挑。前端用 `QrGraphic.tsx::qrSideDots`
  （`qrcode` 库、纠错 H、含 4 模块静区）估一个，**估宽了是安全的**（落点更靠左、仍在纸内），
  估窄了才有风险；所以写死版式的两张老票（`write_weigh_ticket` / `write_self_test`）一律传 **0**，
  贴可打区左端起排。回归在 `render.rs::fixed_layout_tickets_never_delegate_alignment`。
- 自检脚本 H1–H12 在 `scripts/receipt-code/check.ts`。**改 `render.rs` 之后要真的 `cargo test`**，
  见 `toolchain.md`。

## 列宽：判据不手写码表，直接问 GBK（2026-09-14 新增规则）
`render.rs::char_width` 原来用一张手写 Unicode 区段表判全角，**漏一块就破相**：`—`(U+2014)、
`…`(U+2026)、`“”`、`·` 落在 General Punctuation / Latin-1 补充段，**不在任何 CJK 区段**，
却在 GBK 里是双字节、打印机按全角画。按 1 列算 → `kv`/`pair` 少算一列 → 行尾正好顶到纸宽 →
热敏机在边界上硬折 → 数值（空值时的横杠）被甩到下一行单独打。**有数值时全是 ASCII 算得对，
所以只有空值才犯**，排查时极易误判成"空值分支有问题"。

- 现在判据是**编出来双字节即 2 列，其余 1 列**（`GBK.encode`），与 `gbk_safe` 同一口径：
  编不出的出门前已是 `?`（1 列）、半角 `¥` 已是全角 `￥`（2 列），折点才不会和纸上错位。
- **断言行宽不能用 `display_width`**——那就是被测函数自己，算错了会连断言一起错、测试自洽通过。
  基准用测试里的 `physical_cols()`（数 GBK 字节：`<0x80` 记 1 列，否则 2 列）。第一版守卫就栽在这里。
- 回归：`gbk_full_width_punctuation_is_two_columns` +
  `an_empty_value_stays_at_the_end_of_its_row`（P58/P80 两种纸都验）。已用临时回退验证过
  确实会红（33 vs 32 列）。
- **预览永远看不出这类问题**：`render.tsx` 用 flex 画 SVG，不做列宽算术。凡是"预览对、纸上歪"，
  先怀疑 Rust 侧的列宽/折行，别在前端找。

## 条码压小：按实数压，不落到整数点（2026-09-14 新增规则）
**`fitModuleDots` 返回的 `dots` 是实数**（点/模块），不再取整。理由是一个实测出来的坑：
20 字符的凭票载荷连静区 **253 个模块**，58 纸可打 384 点 → 1 点/模块只占 29mm（**纸的一半**，
模块 0.125mm 细到扫不动），2 点/模块要 466 点直接出纸——**整数档之间没有中间值**，
纸就这么被缴掉一半。按实数压（384/253 ≈ 1.52）才兼得：条身 44.2mm、模块 0.19mm。
（这次投诉的原话是"条码宽度只有 58mm 纸张的一半"——正是上一轮把预算从 512 压到 384 之后暴露的。）

- **契约发的是整条点宽 `width`，不是"每模块几点"**：`NativePrintLine.Barcode` 与
  `PrintLine::Barcode` 都是 `{ runs, width, height, pad_left }`。小数那一份在前端
  `measureCode128` 里折进 `widthDots`，Rust `render.rs::barcode` 按累计模块数
  **`round(cum*width/total)`** 分摊——整条宽度分毫不差，且每段至少 1 点（不会有条被抹平）。
  `queue_print.rs`（A4/GDI）反过来按 `width / 总模块数` 摊回每模块几点。
- `BarcodeGeometry.dots`（实数，预览/SVG 用）与 `widthDots`（整数，栅格与落点用）**都在
  `measureCode128` 一处产出**，别在别处再乘一遍。
- 落点按 **`widthDots`（条身）** 算，不按 `modules * dots`：静区不进栅格，
  纸边那圈打不到的白纸本来就是静区。
- 回归：`check.ts` 的 **C10**（压过之后 footprint 仍 ≥ 可打宽度的 98%）、**C11**（整条仍在卷内）、
  **E5/E6**；Rust 侧 `barcode_shares_an_awkward_width_across_the_runs`（11 点宽摊到 6 模块 → 4/2/3/2）。

## 码下方那行可读内容（2026-09-14 新增规则）
`ReceiptSection.qrCaption` **缺省即印**（印的是**载荷原文** `BH1:` + 单号，与码制无关）——码被晒白、
磨花、缺针断线后它是票上唯一还认得出是哪张单的东西。三条出纸路**必须同一个开关**：
`render.tsx::CodeBlock`（预览 / A4 所见所得）与 `escpos.ts` 的 `qr` 分支（热敏直打 / 队列直打）各印一次，
**不许只有预览印**。老模板没这个字段 → `defaults.ts::normalizeTemplate`（私有 `withCodeCaptions`）在
**取用模板那一刻**补成 `true`；显式 `false` 一律不动（用户权衡过纸宽）。`normalizeTemplate` 无事可做时
**返回原对象**（引用稳定，别改成每帧新建）。新断言 G1–G7 在 `scripts/receipt-code/check.ts`。
`normalizeTemplate` 旧名 `ensureRequiredBlocks`，改名后全仓已无旧引用。
