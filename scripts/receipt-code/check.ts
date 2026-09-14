/**
 * 票面"码"这条链路的无头自检（小票模板 → 条码 / 二维码）。
 *
 * 为什么单独留这一份：CODE128 的条空宽度表、校验码、尺寸换算全是"错一位就在现场炸"的东西——
 * 表错一个数字、校验码权重差一位，打出来的票照样好看，只是结算窗口扫不出来。
 * 这类回归在预览里看不出来，只能靠把规范里的已知向量钉成断言。
 * 前端没有测试运行器，也不必为此装一套：用 vite 自带的 esbuild 打成 node 能跑的脚本即可。
 *
 *   npx esbuild scripts/receipt-code/check.ts --bundle --platform=node --format=cjs --outfile=.tmp-receipt-code.cjs && node .tmp-receipt-code.cjs
 *
 * 必须 `--format=cjs`：这条链路把 `qrcode` 的 node 入口一起打了进来，它内部要 `require("fs")`，
 * 出成 esm 就是在 node 里一句 `Dynamic require of "fs" is not supported`。
 *
 * 覆盖的是纯函数那一层（`code-size` / `code128` / `render.kvClusters` / `escpos.receiptLines`）：
 * 不碰 DOM、不碰设备，所以不需要任何 stub。
 */
import { BARCODE_HEIGHT_DOTS, CODE_SCALE_DOTS, DOT_MM, codeBudgetDots, codeOffsetDots, fitModuleDots, printableDots, printableMm, scaleOf } from "../../src/components/print/receipt/code-size";
import { CODE128_QUIET_MODULES, code128Runs, encodeCode128, measureCode128 } from "../../src/components/print/receipt/code128";
import { kvClusters } from "../../src/components/print/receipt/render";
import { qrSideDots } from "../../src/components/print/receipt/QrGraphic";
import { receiptLines } from "../../src/components/print/receipt/escpos";
import { defaultTemplate, normalizeTemplate } from "../../src/components/print/receipt/defaults";
import { SCENARIOS } from "../../src/components/print/receipt/scenarios";
import type { ReceiptSection } from "../../src/components/print/receipt/types";
import type { NativePrintLine } from "../../src/lib/native";

let fails = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`PASS ${name}`);
  else {
    fails++;
    console.log(`FAIL ${name}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}
const mm1 = (n: number) => Math.round(n * 10) / 10;

/* ------------------------------------------------- A. CODE128 规范里的已知向量 */
// Code B 的码值 = ASCII − 32（空格 32 是 0 号）；校验码 = (起始符 + Σ 位置×码值) mod 103，位置从 1 起算。
ok("A1 Code B 起步 + 字母数字混排", JSON.stringify(encodeCode128("AB12")) === JSON.stringify([104, 33, 34, 17, 18, 19, 106]), encodeCode128("AB12"));
ok("A2 全数字偶数位 → Code C 起步", JSON.stringify(encodeCode128("1234")) === JSON.stringify([105, 12, 34, 82, 106]), encodeCode128("1234"));
ok("A3 两位数据的校验码权重", JSON.stringify(encodeCode128("BD")) === JSON.stringify([104, 34, 36, 4, 106]), encodeCode128("BD"));
// 凭票载荷 = "BH1:" + 单据号：前 6 个字符走 B，后面 14 位数字咬合成 C（不咬合的话 80 纸上放不下）
const TICKET = "BH1:BD310120260913000031";
const symbols = encodeCode128(TICKET) ?? [];
ok("A4 单号里长数字段被压成 Code C", symbols.includes(99) && symbols.length < TICKET.length + 4, { n: symbols.length });
ok("A5 非 ASCII 一律拒编（宁可不打也不丢字）", encodeCode128("滨河粮站") === null && code128Runs("票 BH1") === null);
ok("A6 空串不编", encodeCode128("") === null);

/* ------------------------------------------------------------- B. 条空序列结构 */
const runs = code128Runs(TICKET) ?? [];
ok("B1 首元素是条、末元素是停止符的条", runs.length > 0 && runs.length % 2 === 1, runs.length);
ok("B2 每个码字 6 元素、停止符 7 元素", (symbols.length - 1) * 6 + 7 === runs.length, { runs: runs.length, symbols: symbols.length });
ok("B3 模块总数含静区后不小于码身", (runs.reduce((a, b) => a + b, 0) + CODE128_QUIET_MODULES * 2) > 0);
// 1 个字符 = 起始B + 数据 + 校验（3×11 模块）+ 停止（13 模块）
ok("B4 码表每个码字恰好 11 个模块、停止符 13 个", (code128Runs("A") ?? []).reduce((a, b) => a + b, 0) === 46, (code128Runs("A") ?? []).reduce((a, b) => a + b, 0));

/* --------------------------------------------------------- C. 尺寸与纸宽这条轴 */
ok("C1 2 档 = 0.5mm/模块（机器出厂值）", CODE_SCALE_DOTS[2] * DOT_MM === 0.5);
ok("C2 档位表单调递增", [1, 2, 3, 4, 5].every((s, i) => i === 0 || CODE_SCALE_DOTS[s] > CODE_SCALE_DOTS[[1, 2, 3, 4, 5][i - 1]]));
ok("C3 脏档位回落到「中」，绝不放大", scaleOf(undefined) === 2 && scaleOf(0) === 2 && scaleOf(99) === 2 && scaleOf(5) === 5);
const modules = runs.reduce((a, b) => a + b, 0) + CODE128_QUIET_MODULES * 2;
ok("C4 热敏纸的可打宽度取的是机内栅格", printableMm("thermal58") === 48 && printableMm("thermal80") === 64, printableMm("thermal58"));
for (const paper of ["thermal58", "thermal80", "A4", "dot241"] as const) {
  const max = printableDots(paper);
  for (const scale of [1, 2, 3, 4, 5] as const) {
    const want = CODE_SCALE_DOTS[scale];
    const got = fitModuleDots(modules, max, want);
    ok(`C5 ${paper}/档${scale} 放得下或压到极限`, got <= want && modules * got <= max, { got, w: mm1(modules * got * DOT_MM), max });
  }
}
const bar58 = measureCode128(TICKET, "thermal58", 4);
const barA4 = measureCode128(TICKET, "A4", 2);
ok("C6 58 纸上是压过的、A4 用出厂档放得下", !!bar58?.shrunk && barA4?.shrunk === false, { s58: bar58?.dots, sA4: barA4?.dots });
ok("C7 条高固定 12mm", BARCODE_HEIGHT_DOTS * DOT_MM === 12);
ok("C8 没压的时候点数就等于所选档位", !!barA4 && barA4.dots === CODE_SCALE_DOTS[2]);
ok("C9 压过之后一定放得进这张纸", (["thermal58", "thermal80", "A4", "dot241"] as const).every((p) => {
  for (const s of [1, 2, 3, 4, 5] as const) {
    const g = measureCode128(TICKET, p, s);
    if (!g) return false;
    if (g.widthMm > printableMm(p) + DOT_MM) return false;
    if (!g.shrunk && Math.abs(g.dots - CODE_SCALE_DOTS[s]) > 1e-9) return false;
  }
  return true;
}));
// 「58 纸上条码只占半张纸」的回归：压小**必须按实数压**，压完仍要铺满可打宽度。
// 只取整数点的话，253 个模块在 384 点上只有 1 点（29mm，纸的一半）和 2 点（出纸）两档，
// 中间没有值——纸就这么被缴掉一半，而且 0.125mm 的模块细到枪读不动。
// 这里的 `>= 0.98` 是"铺满"的判据：允许四舍五入丢掉不到 2% 的边。
ok("C10 压过之后仍然铺满可打宽度（不是掉到整数档只占半张纸）", (["thermal58", "thermal80"] as const).every((p) => {
  const g = measureCode128(TICKET, p, 5); // 5 档 = 10 点/模块，任何热敏纸都必然要压
  if (!g) return false;
  return g.modules * g.dots >= printableDots(p) * 0.98;
}), (["thermal58", "thermal80"] as const).map((p) => {
  const g = measureCode128(TICKET, p, 5);
  return { paper: p, dots: g?.dots, footprint: g ? mm1(g.modules * g.dots * DOT_MM) : 0, bars: g ? mm1(g.widthDots * DOT_MM) : 0, max: printableMm(p) };
}));
// 铺满不等于突破：条身 + 落点仍要落在卷内（超出就是"条码超出纸张"那一次）。
// 落点的轴是 min(卷幅, 机头)，所以判据就是卷幅本身——与 H3 同一条，这里按真实载荷再走一遍。
ok("C11 铺满之后整条仍在卷内", (["thermal58", "thermal80"] as const).every((p) => {
  const roll = p === "thermal58" ? 464 : 640;
  for (const m of [undefined, "thermal58", "thermal80"] as const) {
    const g = measureCode128(TICKET, p, 5, m ? codeBudgetDots(p, m) : undefined);
    if (!g) return false;
    if (codeOffsetDots(g.widthDots, p, m) + g.widthDots > roll) return false;
  }
  return true;
}));

/* --------------------------------------------- D. 字段区顺序 = 票面顺序（切段不重排） */
const fakeSpec = {
  fields: [
    { key: "a", label: "售粮人", group: "售粮人", kind: "text" },
    { key: "b", label: "毛重", group: "重量", kind: "weight" },
    { key: "c", label: "身份", group: "售粮人", kind: "text" },
  ],
  resolveField: (k: string) => k.toUpperCase(),
} as never;
const clusters = kvClusters(fakeSpec, ["a", "b", "c"], {} as never);
ok(
  "D1 同组但不相邻的字段不再被合并回首段",
  clusters.map((cl) => cl.rows.map((r) => r.key).join("")).join("|") === "a|b|c",
  clusters.map((cl) => cl.group + ":" + cl.rows.map((r) => r.key).join(",")),
);
ok("D2 相邻同字段仍合成一段", kvClusters(fakeSpec, ["b", "b"], {} as never).length === 1);
ok("D3 票面行序逐字等于 fields 顺序", kvClusters(fakeSpec, ["c", "a", "b"], {} as never).flatMap((cl) => cl.rows.map((r) => r.key)).join("") === "cab");

/* --------------------------------------------------- E. 模板 → 小票机行序列（契约） */
const tpl = defaultTemplate("weigh_order");
const ctx = SCENARIOS.weigh_order.sampleContext();
const codeSec = tpl.sections.find((s) => s.kind === "qr") as ReceiptSection;
const lines = receiptLines({ ...tpl, sections: tpl.sections.map((s) => (s === codeSec ? { ...s, codeStyle: "both" as const } : s)) }, ctx);
const qrLine = lines.find((l) => l.kind === "qr") as Extract<NativePrintLine, { kind: "qr" }> | undefined;
const barLine = lines.find((l) => l.kind === "barcode") as Extract<NativePrintLine, { kind: "barcode" }> | undefined;
ok("E1 两种码都发，且载荷就是单号契约那一串", !!qrLine?.text.startsWith("BH1:") && !!barLine && barLine.runs.length > 0, { qr: qrLine?.text });
ok("E2 二维码的档位真的发到了机器上", qrLine?.size === CODE_SCALE_DOTS[scaleOf(codeSec.qrScale)], { size: qrLine?.size });
ok("E3 条高与预览同一常数", barLine?.height === BARCODE_HEIGHT_DOTS);
// 发的是"整条的点宽"而不是"每模块几点"：模块宽度可能是小数，栅格只认整数点
const barGeo = measureCode128(qrLine?.text ?? "", tpl.paper, scaleOf(codeSec.qrScale));
ok("E5 条码发的是整条点宽（= 条身模块数 × 每模块点数，四舍五入）", barLine?.width === barGeo?.widthDots, {
  width: barLine?.width,
  want: barGeo?.widthDots,
  dots: barGeo?.dots,
});
ok("E6 落点按条身算（静区不进栅格）", barLine?.padLeft === codeOffsetDots(barGeo?.widthDots ?? 0, tpl.paper));
const legacy = receiptLines(tpl, ctx).filter((l) => l.kind === "barcode");
ok("E4 没动过码制的老模板只发二维码（一维码不无中生有）", legacy.length === 0);

/* ------------------------------------- F. 各票出厂默认的码制（改默认值必须过这一关） */
// 两种枪对应两种票：结算窗口那支键盘口激光枪解不动二维码，凭证因此出厂就出条码；
// 而码单那枚凭票码是给影像枪/手机扫的，不能顺手一起改——这两条各自钉一条断言。
const settleTpl = defaultTemplate("settlement_voucher");
const settleCode = settleTpl.sections.find((s) => s.kind === "qr") as ReceiptSection;
ok("F1 结算凭证出厂那枚凭单码是仅一维条码", settleCode.codeStyle === "barcode", settleCode.codeStyle);
const settleCtx = SCENARIOS.settlement_voucher.sampleContext();
const settleTx = receiptLines(settleTpl, settleCtx);
ok(
  "F2 结算凭证发到机器上的是条码、且不发二维码",
  !settleTx.some((l) => l.kind === "qr") && settleTx.some((l) => l.kind === "barcode"),
  settleTx.filter((l) => l.kind === "qr" || l.kind === "barcode").map((l) => l.kind),
);
const settleBar = settleTx.find((l) => l.kind === "barcode") as Extract<NativePrintLine, { kind: "barcode" }> | undefined;
// A4 上不必压缩 → 整条点宽就是"条身模块数 × 出厂档位"，一点不多一点不少
ok(
  "F3 结算凭证的条码在 A4 上不必压缩、条高固定",
  !!settleBar && settleBar.width === settleBar.runs.reduce((a, b) => a + b, 0) * CODE_SCALE_DOTS[2] && settleBar.height === BARCODE_HEIGHT_DOTS,
  { width: settleBar?.width, dots: CODE_SCALE_DOTS[2] },
);
ok("F4 过磅单出厂那枚凭票码仍是二维码（不被顺手改掉）", (codeSec.codeStyle ?? "qr") === "qr", codeSec.codeStyle);

/* ---------------------- G. 码下方那行可读内容（码磨花之后唯一还认得出的东西） */
// 这行字是现场兜底、不是版式偏好，所以"出厂默认印、老模板取用时补印、用户明确关过的不动"
// 三条都得钉住：任何一条松掉，出纸那一刻的现场表现都是"票上少一行字"，而预览里看着一切正常。
const ALL_SCENARIOS = Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[];
const defaultCodes = ALL_SCENARIOS.flatMap((s) => defaultTemplate(s).sections).filter((b) => b.kind === "qr");
ok(
  "G1 出厂带码的票据一律显式「印内容」",
  defaultCodes.length > 0 && defaultCodes.every((b) => b.qrCaption === true),
  defaultCodes.map((b) => b.qrCaption),
);

const stripCaption = (t: typeof tpl) => ({ ...t, sections: t.sections.map((s) => (s.kind === "qr" ? { ...s, qrCaption: undefined } : s)) });
const legacy2 = normalizeTemplate(stripCaption(tpl));
ok(
  "G2 没写过这个字段的老模板，取用时补成「印」",
  legacy2.sections.filter((s) => s.kind === "qr").every((s) => s.qrCaption === true),
  legacy2.sections.filter((s) => s.kind === "qr").map((s) => s.qrCaption),
);
ok(
  "G3 用户明确关过的不被兜底改回来",
  normalizeTemplate({ ...tpl, sections: tpl.sections.map((s) => (s.kind === "qr" ? { ...s, qrCaption: false } : s)) })
    .sections.filter((s) => s.kind === "qr")
    .every((s) => s.qrCaption === false),
);
// 内容不变时必须还回同一个引用：useReceiptTemplate 直接把它交给 React，换新对象等于每帧白重渲染
ok("G4 无需兜底时返回原对象（引用不变）", normalizeTemplate(tpl) === tpl);

// 热敏那一路：这行字必须真的排在码之后发到机器上。少了它＝预览有、纸上没有
const capTx = receiptLines(tpl, ctx);
const capQr = capTx.find((l) => l.kind === "qr") as Extract<NativePrintLine, { kind: "qr" }>;
const capLine = capTx[capTx.findIndex((l) => l.kind === "qr") + 1];
ok(
  "G5 热敏：码之后紧接一行居中文本，内容就是码的载荷",
  capLine?.kind === "text" && capLine.text === capQr?.text && capLine.align === "center",
  capLine,
);
// 出厂那枚凭单码是**仅一维条码**，没有 qr 行可依附——正是最该有这行字的一张票
const settleCap = settleTx[settleTx.findIndex((l) => l.kind === "barcode") + 1];
const settlePayload = String(SCENARIOS.settlement_voucher.resolveField("settle_code", settleCtx));
ok(
  "G6 热敏：仅条码的凭证也在条码下方印出内容",
  settleCap?.kind === "text" && settleCap.text === settlePayload && settleCap.align === "center",
  { got: settleCap, want: settlePayload },
);
ok(
  "G7 关掉之后纸上真的少这一行",
  !receiptLines({ ...tpl, sections: tpl.sections.map((s) => (s.kind === "qr" ? { ...s, qrCaption: false } : s)) }, ctx).some(
    (l) => l.kind === "text" && l.text === capQr?.text,
  ),
);

/* ---------------- H. 码的横向落点（"80 机装 58 卷，条码跑出纸外"那条现场投诉） */
// 故障机制：固件的 `ESC a 1` 是按**机身头宽**居中的，与这卷纸无关。80 机装 58 卷时它仍按
// 576 点（72mm）居中，48mm 宽的条码就落在 12~60mm，而纸只有 58mm——右端连着停止符一起出纸外，
// 票看着打出来了，扫码枪读不出来。落点因此由前端算：见 `code-size.ts::codeOffsetDots`。
const FULL58 = 464; // 58 卷整幅 = 58mm / 0.125mm
const hBar = measureCode128(TICKET, "thermal58", 4);
const hBw = (hBar?.modules ?? 0) * (hBar?.dots ?? 0);

// 一致装态（票面纸型 = 机器纸型）必须**分毫不动**：这是"老站点不出问题"的前提。
// 80 纸比头宽，卷在头下面居中，量到卷心的距离正好就是头宽——与固件一直在用的轴重合。
ok("H1 80 机 80 纸：落点就是固件原来那个（按头宽居中）", codeOffsetDots(hBw, "thermal80", "thermal80") === Math.round((576 - hBw) / 2), codeOffsetDots(hBw, "thermal80", "thermal80"));
ok("H2 58 机 58 纸：同样分毫不动", codeOffsetDots(hBw, "thermal58", "thermal58") === Math.round((384 - hBw) / 2));

// 投诉那一幕：58 卷装在 80 机上
const hPad = codeOffsetDots(hBw, "thermal58", "thermal80");
ok("H3 80 机装 58 卷：整条码落在纸内", hPad + hBw <= FULL58, { pad: hPad, bw: hBw, full: FULL58 });
ok("H4 且是在卷上居中（左右留白相等）", Math.abs(FULL58 - hBw - 2 * hPad) <= 1, { pad: hPad, bw: hBw });
// 改前的位置是固件按 576 点居中 → 右端 = (576 + W) / 2。58 卷只有 464 点，
// 于是**只要码宽超过 352 点（44mm）右端就出纸**，而这张纸允许的宽度是 384 点（48mm）：
// 48mm 那一档必然被切掉最后 2mm——停止符和静区都在那儿，票印得出来、扫不出来。
const oldRight = (w: number) => Math.round((576 - w) / 2) + w;
ok(
  "H5 回归锚：改前的位置在 44mm 以上必然出纸（48mm 那档正是被切的那一档）",
  oldRight(384) > FULL58 && oldRight(352) <= FULL58,
  { w384: oldRight(384), w352: oldRight(352), full: FULL58 },
);

// 反向那种装态：票面按 80 排、机器是 58 机 —— 预算必须被机头压下来，不许再按 64mm 算
const hBar80 = measureCode128(TICKET, "thermal80", 2, codeBudgetDots("thermal80", "thermal58"));
ok("H6 票面 80 装 58 机：宽度预算被机头压到 384 点", !!hBar80 && hBar80.modules * hBar80.dots <= 384, hBar80 && hBar80.modules * hBar80.dots);
ok("H7 一致装态的预算不变（80/512、58/384）", codeBudgetDots("thermal80", "thermal80") === 512 && codeBudgetDots("thermal58", "thermal58") === 384);

// 两个码共用同一条轴：`codeStyle: "both"` 时二维码与条码必须同一条中线
const hQrDots = qrSideDots(TICKET, 2) ?? 0;
const hMid = (w: number) => codeOffsetDots(w, "thermal58", "thermal80") + w / 2;
ok("H8 二维码与条码同轴（中线相差不超过 1 点）", Math.abs(hMid(hBw) - hMid(hQrDots)) <= 1, { bar: hMid(hBw), qr: hMid(hQrDots) });

// 定长纸不参与：A4 / 241 走打印队列，可打区由驱动给，落点不归我们算（queue_print.rs 自己居中）
ok("H9 定长纸的落点恒为 0", codeOffsetDots(400, "A4") === 0 && codeOffsetDots(400, "dot241") === 0);

// 端到端：真排一遍热敏行序列，把落点钉在行上（别只在算得对、发不出去）
const t58Tpl = { ...settleTpl, paper: "thermal58" as const };
const t58Lines = receiptLines(t58Tpl, settleCtx, { machinePaper: "thermal80" });
const t58Bar = t58Lines.find((l) => l.kind === "barcode") as Extract<NativePrintLine, { kind: "barcode" }> | undefined;
ok(
  "H10 58 卷 + 80 机出票：条码整条落在纸内（落点真的挂到了行上）",
  !!t58Bar && (t58Bar.padLeft ?? 0) + t58Bar.width <= FULL58,
  t58Bar && { pad: t58Bar.padLeft, 条身点宽: t58Bar.width, 整条: (t58Bar.padLeft ?? 0) + t58Bar.width, full: FULL58 },
);
ok(
  "H11 同一张票排给 80 纸时，落点按 80 算（不是抄上一张纸的数）",
  (() => {
    const bar = receiptLines({ ...settleTpl, paper: "thermal80" as const }, settleCtx, { machinePaper: "thermal80" }).find((l) => l.kind === "barcode") as
      | Extract<NativePrintLine, { kind: "barcode" }>
      | undefined;
    const w = bar ? bar.width : 0;
    return !!bar && w + (bar.padLeft ?? 0) <= 576;
  })(),
);
ok("H12 A4 / 针式那一侧不带落点（落点归驱动）", receiptLines(settleTpl, settleCtx).every((l) => (l.kind === "barcode" || l.kind === "qr" ? (l.padLeft ?? 0) === 0 : true)));

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 条不通过`);
process.exit(fails === 0 ? 0 : 1);

/** 给上面两处 `Extract` 用的样板值：只取其类型，不参与运行 */
const l0 = { kind: "text", text: "" } as import("../../src/lib/native").NativePrintLine;
