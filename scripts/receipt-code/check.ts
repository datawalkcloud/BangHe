/**
 * 票面"码"这条链路的无头自检（小票模板 → 条码 / 二维码）。
 *
 * 为什么单独留这一份：CODE128 的条空宽度表、校验码、尺寸换算全是"错一位就在现场炸"的东西——
 * 表错一个数字、校验码权重差一位，打出来的票照样好看，只是结算窗口扫不出来。
 * 这类回归在预览里看不出来，只能靠把规范里的已知向量钉成断言。
 * 前端没有测试运行器，也不必为此装一套：用 vite 自带的 esbuild 打成 node 能跑的脚本即可。
 *
 *   npx esbuild scripts/receipt-code/check.ts --bundle --platform=node --format=cjs --outfile=.scratch/receipt-code.cjs && node .scratch/receipt-code.cjs
 *
 * 产物落 `.scratch/`（已在 .gitignore 里整目录忽略），别落在仓库根目录。
 *
 * 必须 `--format=cjs`：这条链路把 `qrcode` 的 node 入口一起打了进来，它内部要 `require("fs")`，
 * 出成 esm 就是在 node 里一句 `Dynamic require of "fs" is not supported`。
 *
 * 覆盖的是纯函数那一层（`code-size` / `code128` / `render.kvClusters` / `escpos.receiptLines`）：
 * 不碰 DOM、不碰设备，所以不需要任何 stub。K 段之后另外扫一遍 `src/` 的源码文本（L 段是接线守卫，
 * 读文件而已），所以**必须在仓库根目录跑**——找不到 `src/` 时它会自己报红，不会给假绿灯。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BARCODE_HEIGHT_DOTS, CODE_SCALE_DOTS, DOT_MM, MIN_MODULE_DOTS, codeBudgetDots, codeOffsetDots, fitModuleDots, fitQrModuleDots, headDots, printableDots, printableMm, rollDots, rollLeftDots, scaleOf } from "../../src/components/print/receipt/code-size";
import { CODE128_QUIET_MODULES, code128Runs, encodeCode128, measureCode128 } from "../../src/components/print/receipt/code128";
import { kvClusters } from "../../src/components/print/receipt/render";
import { measureQr, qrSideDots } from "../../src/components/print/receipt/QrGraphic";
import { receiptLines } from "../../src/components/print/receipt/escpos";
import { defaultTemplate, normalizeTemplate } from "../../src/components/print/receipt/defaults";
import { SCENARIOS } from "../../src/components/print/receipt/scenarios";
import { DOC_KIND_BY_CODE, encodeOrderCode, parseScannedCode, searchKeyword, settleable } from "../../src/lib/ticket-code";
import type { ReceiptSection, ReceiptTemplate } from "../../src/components/print/receipt/types";
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
// 凭票载荷 = 票面那行单号本体，14 位纯数字（02 §F1.4 本版：一位前缀都不加）：整串咬合成 Code C。
// 历史两串：`BH1:BD310120260913000031`（24 字符，字母在中文输入法下会被扫码枪吞掉）→
// 上一版的 `11` + 单号（16 位，票种位在里头）→ 本版就是号。三段数字都走 Code C，码宽一样。
const TICKET = "01202609000031";
const symbols = encodeCode128(TICKET) ?? [];
ok("A4 整串偶数位纯数字 → Code C 直接起步，码字数近乎减半", symbols[0] === 105 && symbols.length < TICKET.length / 2 + 4, { n: symbols.length });
ok("A4b 载荷里没有前缀：码里那串 == 票面那行单号", TICKET === encodeOrderCode(TICKET), encodeOrderCode(TICKET));
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
// 落点是**头坐标**，卷心与头心重合，所以判据是"左右留白都不为负"——直接拿点数比卷幅
// 会漏掉 80 机装 58 卷那一档（卷的左沿在头坐标 56，不在 0）。
ok("C11 铺满之后整条仍在卷内", (["thermal58", "thermal80"] as const).every((p) => {
  const roll = p === "thermal58" ? 464 : 640;
  for (const m of [undefined, "thermal58", "thermal80"] as const) {
    const g = measureCode128(TICKET, p, 5, m ? codeBudgetDots(p, m) : undefined);
    if (!g) return false;
    const left = rollLeftDots(p, m);
    const pad = codeOffsetDots(g.widthDots, p, m);
    if (pad - left < 0 || left + roll - (pad + g.widthDots) < 0) return false;
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
ok(
  "E1 两种码都发，且载荷就是票面那行单号（02 §F1.4 本版：一位前缀都不加）",
  !!qrLine && qrLine.text === String(ctx.order?.order_no) && /^\d{14}$/.test(qrLine.text) && !!barLine && barLine.runs.length > 0,
  { qr: qrLine?.text, order: ctx.order?.order_no },
);
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
// 02 §F1.4 本版：**只有磅单这一张纸带码**。结算凭证从前出厂带一枚仅一维条码的「凭单码」
// （伺候窗口那支解不动二维码的键盘口激光枪），随"扫凭证核销挂账"那条入口一起退役了：
// 一枚没人会去扫、装的又是与磅单同形的纯数字号的条码，留在纸上就是一个"扫错纸、结错单"的口。
// 所以这一关钉的是"没有"——从前这里钉的是"是条码不是二维码"，那个前提已经不存在。
const settleTpl = defaultTemplate("settlement_voucher");
const settleCtx = SCENARIOS.settlement_voucher.sampleContext();
ok("F1 结算凭证出厂不带任何码块", !settleTpl.sections.some((s) => s.kind === "qr"), settleTpl.sections.map((s) => s.kind));
const settleTx = receiptLines(settleTpl, settleCtx);
ok(
  "F2 结算凭证发到机器上没有可扫的行（qr 与 barcode 都不许出现）",
  !settleTx.some((l) => l.kind === "qr" || l.kind === "barcode"),
  settleTx.filter((l) => l.kind === "qr" || l.kind === "barcode").map((l) => l.kind),
);
ok(
  "F3 撤码不撤身份：票头那一行「单号」就是结算单号（字段表里的 settle_no 也仍可排进正文）",
  String(SCENARIOS.settlement_voucher.resolveField("settle_no", settleCtx)) === (settleCtx.settlement?.settle_no ?? "") &&
    settleTx.some((l) => l.kind === "kv" && l.label === "单号" && l.value === settleCtx.settlement?.settle_no),
  settleTx.filter((l) => l.kind === "kv").slice(0, 2),
);
ok(
  "F4 退役彻底：老字段键与别的票的载荷键在结算场景一律取不到值",
  String(SCENARIOS.settlement_voucher.resolveField("settle_code", settleCtx)) === "—" && String(SCENARIOS.settlement_voucher.resolveField("ticket_code", settleCtx)) === "—",
);
ok("F5 过磅单出厂那枚凭票码仍是二维码（不被顺手改掉）", (codeSec.codeStyle ?? "qr") === "qr", codeSec.codeStyle);
// **带码的票每多一种，"一串号是不是磅单"就多一个反例**：各票种共用同一个号形（`next_no`，
// 票种键 BD / CK / JS… 各自从 1 排起，同站同月必然出现同号），而本版载荷里没有票种位。
// 磅房那条路的底线是"只认磅单"，所以这里钉的是**配对关系**：除了磅单，哪一种票的出厂默认带码，
// 工作台扫码那一段就必须有一道"同号就说破"的闸门。加一种带码的票而忘了配对——直接红，
// 且红的是"没人认识这个新面孔"，逼人来把 02 §F1.4 这一段重读一遍。
const codedScenarios = (Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]).filter((s) => defaultTemplate(s).sections.some((b) => b.kind === "qr"));
const wsSrc = readFileSync("src/pages/WorkstationPage.tsx", "utf8");
const extraCoded = codedScenarios.filter((s) => s !== "weigh_order");
ok(
  "F6 磅单之外带码的票据，磅房那条路必须配一道同号闸门（闸门不认识的新码 = 直接红）",
  extraCoded.every((s) => s === "outbound_order" && wsSrc.includes("api.getOutbound(")) && codedScenarios.includes("weigh_order"),
  { 带码的票: codedScenarios },
);
ok(
  "F7 那道闸门开框之前就跑（同号时绝不让结算框先弹出来）",
  (() => {
    // 只在 `handleScan` 那一段里比顺序：文件别处也有 `requestSettle`，全局 indexOf 会撞车
    const from = wsSrc.indexOf("const handleScan = useCallback");
    const body = wsSrc.slice(from, wsSrc.indexOf("\n  );", from));
    const gone = body.indexOf("查不到磅单");
    const gate = body.indexOf("api.getOutbound(");
    const open = body.indexOf("requestSettle(");
    return from > 0 && gone >= 0 && gate > gone && open > gate;
  })(),
);

// 票面按**连续同组**切段（`render.kvClusters`，D 段钉住切段不重排）。所以出厂模板里同一组的
// 字段必须连着排：把 `stock_warning`（基本信息组）排到重量组后面，票上就会印出**第二个
// 「基本信息」小标题**——出库码单初版真就这么排错了，肉眼在预览里看得见、单测一条都抓不到。
const splitGroupRuns = (Object.keys(SCENARIOS) as (keyof typeof SCENARIOS)[]).flatMap((s) =>
  defaultTemplate(s)
    .sections.filter((b) => b.kind === "kv" && (b.fields?.length ?? 0) > 0)
    .map((b) => {
      const groupOf = (k: string) => SCENARIOS[s].fields.find((f) => f.key === k)?.group ?? "?";
      const runs = (b.fields ?? []).map(groupOf).filter((g, i, a) => i === 0 || a[i - 1] !== g);
      return { 票: s as string, 重复的小标题: runs.filter((g, i) => runs.indexOf(g) !== i) };
    }),
);
ok(
  "F8 出厂票面里同一组的字段连着排（隔开就会在票上印出两个同名小标题）",
  splitGroupRuns.every((x) => x.重复的小标题.length === 0),
  splitGroupRuns.filter((x) => x.重复的小标题.length > 0),
);

/* ---------------------- G. 码下方那行可读内容（码磨花之后唯一还认得出的东西） */// 这行字是现场兜底、不是版式偏好，所以"出厂默认印、老模板取用时补印、用户明确关过的不动"
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
// 自定义的**仅一维条码**块：出厂默认已经不带码了（F 段钉的就是"没有"），但历史上存过
// 那版模板的站点、以及站长自己新加一枚码（收款码、内部流转条码）的场合都还在，
// G6 与 I 段钉的是那种码的行为，与出不出厂家无关。
const customBarTpl: ReceiptTemplate = {
  ...settleTpl,
  sections: [...settleTpl.sections, { id: "custom-bar", kind: "qr", title: "自定义条码", text: "{{settle_no}}", codeStyle: "barcode", qrCaption: true }],
};
const CUSTOM_PAYLOAD = String(SCENARIOS.settlement_voucher.resolveField("settle_no", settleCtx));
// 仅条码、没有二维码行可依附的那一枚，下方照样要印一行字（从前由出厂的凭单码替它验）
const customTx = receiptLines(customBarTpl, settleCtx);
const settleCap = customTx[customTx.findIndex((l) => l.kind === "barcode") + 1];
ok(
  "G6 热敏：仅条码的自定义块也在条码下方印出内容",
  settleCap?.kind === "text" && settleCap.text === CUSTOM_PAYLOAD && settleCap.align === "center",
  { got: settleCap, want: CUSTOM_PAYLOAD },
);
ok(
  "G7 关掉之后纸上真的少这一行",
  !receiptLines({ ...tpl, sections: tpl.sections.map((s) => (s.kind === "qr" ? { ...s, qrCaption: false } : s)) }, ctx).some(
    (l) => l.kind === "text" && l.text === capQr?.text,
  ),
);

/* ---------------- H. 码的横向落点（“80 机装 58 卷”连着两次现场投诉） */
// 同一处故障报了两回，第二回是修第一回时修歪的：
//  ① 条码超出纸张——宽度预算按 80 纸的 64mm 算，条身 58mm，58 卷只有 464 点，装不下；
//  ② 条码左对齐  ——修①时把落点的轴取成了 min(卷幅, 机头)：80 机装 58 卷时轴成了卷幅 464，
//     落点只有 57 点。可卷在机头下是**居中**卡着的（左沿在头坐标 56），于是左留白 1 点、
//     右留白 112 点——条码紧贴纸的左边缘，右边空出 14mm。
// 两回的根是同一个：这条轴只有同时知道"头宽"与"卷宽"的那一侧才定得下来。现在的口径是
//   · 落点的轴 = **机头宽度**（卷在头下居中，卷心与头心是同一条线）；
//   · 宽度预算 = 票面可打宽 ∩ 机头宽（这一半才负责"别出纸"）。
// 与正文同一条轴：正文靠 `render.rs::aligned` 往 `cols` 列里补空格，而 cols × 12 点正是头宽。
// 落点是**头坐标**，要量"在纸上偏没偏"得先减掉 `rollLeftDots`——混着比正是漏掉②的原因。
const FULL58 = rollDots("thermal58"); // 58 卷整幅 = 464 点
const FULL80 = rollDots("thermal80"); // 80 卷整幅 = 640 点
const HEAD58 = headDots("thermal58");
const HEAD80 = headDots("thermal80");
const hBar = measureCode128(TICKET, "thermal58", 4);
// 落点按**条身**算（静区不进栅格），所以这里必须用 widthDots，不能用 modules × dots
const hBw = hBar?.widthDots ?? 0;

// 一致装态（票面纸型 = 机器纸型）必须**分毫不动**：这是"老站点不出问题"的前提。
ok(
  "H1 80 机 80 纸：落点就是固件原来那个（按头宽居中）",
  codeOffsetDots(hBw, "thermal80", "thermal80") === Math.round((HEAD80 - hBw) / 2),
  codeOffsetDots(hBw, "thermal80", "thermal80"),
);
ok("H2 58 机 58 纸：同样分毫不动", codeOffsetDots(hBw, "thermal58", "thermal58") === Math.round((HEAD58 - hBw) / 2));

// 投诉那一幕：58 卷装在 80 机上
const hPad = codeOffsetDots(hBw, "thermal58", "thermal80");
const hLeft = rollLeftDots("thermal58", "thermal80"); // 卷在机头下的左沿 = (576-464)/2 = 56
ok("H3 80 机装 58 卷：轴是机头宽度，不是卷幅", hPad === Math.round((HEAD80 - hBw) / 2), { pad: hPad, bw: hBw });
ok(
  "H4 且在卷上居中（左右留白相等，都在纸内）",
  hPad - hLeft >= 0 && hLeft + FULL58 - (hPad + hBw) >= 0 && Math.abs(FULL58 - hBw - 2 * (hPad - hLeft)) <= 1,
  { 左留白: hPad - hLeft, 右留白: hLeft + FULL58 - (hPad + hBw) },
);
// 改前的落点按卷幅算（轴 464），可卷的左沿在头坐标 56 而不是 0 —— 落点少算了 56 点（7mm），
// 条码于是顶到纸的左沿上：当年那串 24 字符的载荷下是左留白 1 点、右留白 112 点。
// 这就是"条码是左对齐的"那一幕。判据写的是**左右留白之差**而不是各自的绝对值——载荷换成
// 16 位纯数字后条身窄了一半，绝对值跟着变，而"偏左"这件事的强度一点没变。
// （右留白同样要减掉卷的左沿——写这条锚的时候自己也踩了同一个坐标坑，被它抓出来了）
const oldPad = Math.round((FULL58 - hBw) / 2);
const oldLeft = oldPad - hLeft;
const oldRight = hLeft + FULL58 - (oldPad + hBw);
ok("H5 回归锚：按卷幅算落点会把条码顶向纸的左沿（左右留白差 ≥100 点）", oldRight - oldLeft >= 100, { 改前落点: oldPad, 左留白: oldLeft, 右留白: oldRight });

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
// 载体换成上面那张自定义条码的凭证：出厂不带码了（F 段），但落点这段几何对
// 站长自己加的码、以及历史上存过那版模板的站点照样成立，撤了默认块不等于撤了判据。
const t58Tpl = { ...customBarTpl, paper: "thermal58" as const };
const t58Lines = receiptLines(t58Tpl, settleCtx, { machinePaper: "thermal80" });
const t58Bar = t58Lines.find((l) => l.kind === "barcode") as Extract<NativePrintLine, { kind: "barcode" }> | undefined;
ok(
  "H10 58 卷 + 80 机出票：条码在纸上居中（落点真的挂到了行上）",
  !!t58Bar &&
    (() => {
      const left = (t58Bar.padLeft ?? 0) - rollLeftDots("thermal58", "thermal80");
      const right = rollLeftDots("thermal58", "thermal80") + FULL58 - ((t58Bar.padLeft ?? 0) + t58Bar.width);
      return left >= 0 && right >= 0 && Math.abs(left - right) <= 1;
    })(),
  t58Bar && {
    pad: t58Bar.padLeft,
    条身点宽: t58Bar.width,
    左留白: (t58Bar.padLeft ?? 0) - rollLeftDots("thermal58", "thermal80"),
    右留白: rollLeftDots("thermal58", "thermal80") + FULL58 - ((t58Bar.padLeft ?? 0) + t58Bar.width),
  },
);
ok(
  "H11 同一张票排给 80 纸时，落点按 80 算（不是抄上一张纸的数）",
  (() => {
    const bar = receiptLines({ ...customBarTpl, paper: "thermal80" as const }, settleCtx, { machinePaper: "thermal80" }).find((l) => l.kind === "barcode") as
      | Extract<NativePrintLine, { kind: "barcode" }>
      | undefined;
    const w = bar ? bar.width : 0;
    return !!bar && w + (bar.padLeft ?? 0) <= 576;
  })(),
);
ok("H12 A4 / 针式那一侧不带落点（落点归驱动）", receiptLines(customBarTpl, settleCtx).every((l) => (l.kind === "barcode" || l.kind === "qr" ? (l.padLeft ?? 0) === 0 : true)));

// 最要紧的那条不变量，四种装态各验一遍：**码的中线与机头中线重合**。
// 它不依赖"卷有多宽"这个建模，也就不会被某一档装态的特殊值蒙过去——
// 正文、码、码下方那行说明文字都落在这条中线上，票面才是齐的。
ok(
  "H13 四种装态：码的中线就是机头中线（也是卷的中线）",
  ([["thermal58", undefined], ["thermal58", "thermal58"], ["thermal58", "thermal80"], ["thermal80", "thermal58"], ["thermal80", "thermal80"]] as const).every(([p, m]) => {
    const g = measureCode128(TICKET, p, 4, codeBudgetDots(p, m));
    if (!g) return false;
    const head = headDots(m ?? p); // 不传机器纸型 = 按票面纸型算
    const mid = codeOffsetDots(g.widthDots, p, m) + g.widthDots / 2;
    // 卷心与头心重合：卷的左沿 + 半个卷幅 = 头宽的一半
    return Math.abs(mid - head / 2) <= 1 && Math.abs(rollLeftDots(p, m) + rollDots(p) / 2 - head / 2) <= 1;
  }),
);

/* --------- I. 票面写定长纸、这次却从热敏卷纸出纸（2026-09-15「结算凭证的条码超出纸张」） */
// 那一次的现场：结算凭证出厂是 A4 票面 + 仅一维条码，出票机是 80 机装 58 卷、台账纸填报 58，
// 正文由 Rust 按 32 列重排到那卷纸上，码却仍按 A4 的 182mm 要地方：一条 126mm 的 CODE128
// 原样发给可打只有 48mm 的卷，右半截连着停止符出纸，票打得出来、结算窗口的枪扫不出来。
// 改后的口径：**码的预算与落点都认这次出纸的那张纸**，票面声明的是 A4 还是 241 都不例外。
// 出厂默认如今已不带码（F 段），这条几何判据照旧要钉住——站长自己加的码、以及历史上存过
// 那版模板的站点走的是同一段代码，所以这里拿一张 A4 票面 + 自定义条码的模板来验。
const B58 = printableDots("thermal58"); // 58 卷可打 384 点 = 48mm
for (const p of ["A4", "dot241"] as const) {
  for (const m of ["thermal58", "thermal80"] as const) {
    const budget = codeBudgetDots(p, m);
    const g = measureCode128(CUSTOM_PAYLOAD, p, 5, budget);
    const pad = g ? codeOffsetDots(g.widthDots, p, m) : 0;
    const rollLeft = rollLeftDots(m, m); // 这次出纸的那卷纸在机头下的左沿
    const left = pad - rollLeft; // 留白要以**纸**的坐标量（H4 同一个式子）
    const right = rollLeft + rollDots(m) - (pad + (g?.widthDots ?? 0));
    ok(
      `I1 ${p} 票面排给 ${m}：条码被那卷纸收住（≤${budget} 点）`,
      !!g && g.modules * g.dots <= budget + 1,
      g && { dots: g.dots, footprint: mm1(g.modules * g.dots * DOT_MM), budget },
    );
    ok(`I2 ${p} 票面排给 ${m}：整条在纸内且左右留白相等（贴左沿那一次的回归锚）`, left >= 0 && right >= 0 && Math.abs(left - right) <= 1, { pad, left, right });
  }
}
// 端到端：真排一次行序列，落点必须挂在发出去的 barcode 行上（光算得对、发不出去等于没修）
const a4To58 = receiptLines(customBarTpl, settleCtx, { machinePaper: "thermal58" }).find((l) => l.kind === "barcode") as
  | Extract<NativePrintLine, { kind: "barcode" }>
  | undefined;
ok(
  "I3 A4 票面的自定义条码打到 58 卷：条身 + 落点都在 384 点里，且落点按 58 机居中",
  !!a4To58 && a4To58.width + (a4To58.padLeft ?? 0) <= B58 && (a4To58.padLeft ?? 0) === Math.round((B58 - a4To58.width) / 2),
  a4To58 && { width: a4To58.width, pad: a4To58.padLeft },
);
ok(
  "I4 同一张票排给 80 卷：预算换 512 点、落点换 80 机那条轴（不抄上一张纸的数）",
  (() => {
    const bar = receiptLines(customBarTpl, settleCtx, { machinePaper: "thermal80" }).find((l) => l.kind === "barcode") as
      | Extract<NativePrintLine, { kind: "barcode" }>
      | undefined;
    return !!bar && bar.width + (bar.padLeft ?? 0) <= headDots("thermal80") && bar.width <= printableDots("thermal80");
  })(),
);
// 不动的那一档同样要钉住：定长纸走打印队列时不带机器纸型，可打区由驱动给（queue_print.rs）
ok(
  "I5 不传机器纸型 = 口径分毫不变（A4 票面不压缩、不带落点）",
  (() => {
    const bar = receiptLines(customBarTpl, settleCtx).find((l) => l.kind === "barcode") as Extract<NativePrintLine, { kind: "barcode" }> | undefined;
    return !!bar && (bar.padLeft ?? 0) === 0 && bar.width === bar.runs.reduce((a, b) => a + b, 0) * CODE_SCALE_DOTS[2];
  })(),
);
// 二维码那一半：固件自己排点，超预算时只能整档往小压（size 给不了 1.52 点/模块）。
// 这串 14 位载荷编出来的模块数不多，58 卷的 384 点连最大档都放得下，所以真实票面上
// "压档"不会发生——但**判据必须写在这里**：换长载荷、换更窄的机器时，出不出纸就看这一条。
for (const s of [1, 2, 3, 4, 5] as const) {
  const g = measureQr(CUSTOM_PAYLOAD, s, B58);
  ok(`I6 档${s}排给 58 卷：边长不出纸、点数是整数（压过的档只能 floor）`, !!g && g.sideDots <= B58 && Number.isInteger(g.dots) && g.dots >= 1, g);
}
const tightQr = measureQr(CUSTOM_PAYLOAD, 5, 200);
ok(
  "I6b 预算紧到放不下时向下压档，并把「压过」如实报出来",
  !!tightQr && tightQr.shrunk && tightQr.dots === Math.floor(200 / tightQr.modules) && tightQr.sideDots <= 200,
  tightQr,
);
// 磅单那枚凭票码的真载荷（票面单号本体）：I7 拿它验"放得下就不压档"
const ORDER_PAYLOAD = String(SCENARIOS.weigh_order.resolveField("ticket_code", ctx));
ok("I7 二维码放得下时一档不动（磅单小票那枚凭票码的口径不变）", (() => { const g = measureQr(ORDER_PAYLOAD, 2, B58); return !!g && !g.shrunk && g.dots === CODE_SCALE_DOTS[2]; })());
ok("I8 再窄也不发 0 点/模块（发 0 机器什么都不打，比打歪更难查）", fitQrModuleDots(400, 100, 10) === MIN_MODULE_DOTS && fitQrModuleDots(400, 100, 1) === MIN_MODULE_DOTS);
ok("I9 排给热敏的二维码行带的是同一份几何（点数 + 按那卷纸的落点）", (() => {
  const geo = measureQr(CUSTOM_PAYLOAD, 5, B58);
  const both = receiptLines({ ...customBarTpl, sections: customBarTpl.sections.map((s) => (s.kind === "qr" ? { ...s, codeStyle: "qr" as const, qrScale: 5 as const } : s)) }, settleCtx, { machinePaper: "thermal58" });
  const line = both.find((l) => l.kind === "qr") as Extract<NativePrintLine, { kind: "qr" }> | undefined;
  return !!line && !!geo && line.size === geo.dots && (line.padLeft ?? 0) === codeOffsetDots(geo.sideDots, "A4", "thermal58");
})());

/* ---------------- J. 票面码载荷的解析（02 §F1.4 契约；现场"扫三次失败三次"的那道闸） */
// 这一轨以前**零测试**：它错一个字符的表现是结算窗口扫不出票，而预览里一切都好看。
// 载荷三段历史：`BH1:BD01…`（字母被中文输入法吞）→ `11` + 纯数字号（票种写在码里）→
// 本版**码里就是单号本体**。读的一侧三条轨永久并存（老纸已经发到农户手里），写的一侧只有新轨。
const P = (raw: string) => parseScannedCode(raw);
ok(
  "J1 本版载荷＝单号本体：认下来，种类不猜，交调用方按磅单查库",
  P("01202610000053")?.docNo === "01202610000053" && P("01202610000053")?.kind === "unknown" && P("01202610000053")?.source === "bare",
  P("01202610000053"),
);
ok(
  "J2 上一版的数字载荷仍认：剥掉版本位 + 票种位才是库里的号，种类照票种位报",
  P("1101202610000053")?.docNo === "01202610000053" && P("1101202610000053")?.kind === "order" && P("1101202610000053")?.source === "payload",
  P("1101202610000053"),
);
ok("J3 同一串老载荷，票种位不同就是两张票（结算凭证那张在本版只会被打发走）", P("1301202610000053")?.kind === "settlement" && P("1401202610000053")?.kind === "payment" && P("1501202610000053")?.kind === "outbound" && P("1201202610000053")?.kind === "qc");
ok("J4 最早那版照旧认：BH1: + 带字母前缀的号，解析结果与改版前逐字一致", P("BH1:BD01202610000053")?.docNo === "BD01202610000053" && P("BH1:BD01202610000053")?.kind === "order" && P("BH1:BD01202610000053")?.source === "legacy", P("BH1:BD01202610000053"));
ok("J5 吞掉版本位的老票也认（全角冒号 / 无冒号都算）", P("BH：BD01202610000053")?.kind === "order" && P("BH1BD01202610000053")?.kind === "order");
ok("J6 全角数字与枪的回车后缀（本版：一串号 + 后缀）", P("０１２０２６１０００００５３\r\n")?.docNo === "01202610000053", P("０１２０２６１０００００５３\r\n"));
ok("J7 补打存量字母号：码里就是号本体，种类从前两位字母认（不再套 BH1: 头）", P("BD01202610000053")?.kind === "order" && P("BD01202610000053")?.source === "bare" && P("JS01202610000009")?.kind === "settlement", [P("BD01202610000053"), P("JS01202610000009")]);
ok("J8 吞键残串与半截码一律拒收（不做任何模糊匹配）", P("D0120261000069") === null && P("110120261") === null && P("1101202613000053") === null);
ok("J9 外来条码拒收：EAN-13 / 超长串 / 卡 UID", P("4006381333931") === null && P("11012026100000531234567") === null && P("04A21F01") === null);
ok(
  "J10 编码出口：一串单号本体，不带版本位、不带票种位、不带 BH1:（老纸读得到，新纸不再打）",
  encodeOrderCode("01202610000053") === "01202610000053" && encodeOrderCode("BD01202610000053") === "BD01202610000053" && !encodeOrderCode("01202610000053").startsWith("11"),
  encodeOrderCode("01202610000053"),
);
ok("J11 编出来必能被自己解回去，且号一字不动（往返不变）", ["01202610000053", "01202610000009", "BD01202610000053"].every((n) => parseScannedCode(encodeOrderCode(n))?.docNo === n));
ok(
  "J12 老载荷报出的种类里只有磅单能进结算框（其余四种走打发话术；本版的号交给查库判）",
  !settleable(P("1301202610000053")) && !settleable(P("1401202610000053")) && !settleable(P("1501202610000053")) && !settleable(P("1201202610000053")) && !settleable(P("BH1:JS01202610000009")) && settleable(P("1101202610000053")),
);
ok(
  "J13 老载荷的票种码表钉死（1 磅单 2 质检 3 结算 4 付款 5 出库；6…9 不许预先占位）",
  Object.keys(DOC_KIND_BY_CODE).join(",") === "1,2,3,4,5" && Object.values(DOC_KIND_BY_CODE).map((v) => v.kind).join(",") === "order,qc,settlement,payment,outbound",
  Object.keys(DOC_KIND_BY_CODE),
);

/* ---------------- K. 票面码落进"关键字"检索框（同一份载荷的下游那一格） */
// 扫码枪就是一个键盘：扫一下 = 把载荷原样打进当时聚焦的那个框。本版的码就是单号本体，
// 打进检索框一字不改就能查到；这一步兜的是**手上的老纸**（上一版多两位、更早的带 `BH1:` 头）
// 和枪与输入法留下的渣，否则现场看到的永远是"扫了没反应"（05 §5 磅单中心）。
// 与 J 段的分工：那边管结算窗口认不认得这张票，这边管台账检索找不找得着这张票。
const SK = searchKeyword;
ok("K1 本版的码：号原样进框，一个字符都不动（码与票面那行字同值）", SK("01202610000053") === "01202610000053", SK("01202610000053"));
ok("K2 老纸（上一版）剥成单号本体", SK("1101202610000053") === "01202610000053", SK("1101202610000053"));
ok(
  "K3 四种老载荷各剥各的（同一串号，票种位不同就在不同的台账里查）",
  SK("1201202610000009") === "01202610000009" && SK("1301202610000009") === "01202610000009" && SK("1401202610000009") === "01202610000009" && SK("1501202610000009") === "01202610000009",
);
ok("K4 最早那版的 BH1: 头一样剥（含被输入法吞掉版本位那一种）", SK("BH1:BD01202610000053") === "BD01202610000053" && SK("BH：BD01202610000053") === "BD01202610000053");
ok("K5 枪的回车与制表后缀、全角数字、首尾空白", SK("１１０１２０２６１０００００５３\r\n") === "01202610000053" && SK(" 1101202610000053\t") === "01202610000053");
ok("K6 手打的姓名 / 车牌 / 证号后 4 位原样不动", SK("张伟") === "张伟" && SK("皖A12345") === "皖A12345" && SK("0053") === "0053" && SK("  张伟  ") === "张伟");
ok(
  "K7 站码 1x 的单号不被误剥两位（剥完过不了 DOC_NO_RE，退回单号本体那一轨）",
  SK("12202610000053") === "12202610000053" && SK("11202610000053") === "11202610000053",
  [SK("12202610000053"), SK("11202610000053")],
);
ok("K8 幂等：剥过的串再进一次不会又少两位", SK(SK("1101202610000053")) === "01202610000053");
ok("K9 空串与全空白不炸", SK("") === "" && SK("   ") === "");

/* ---------------- M. 退役兜底：存过「凭单码」那版模板的站点，取用时把那块摘掉 */
// 出厂默认已经不带那枚码了（F 段），但用户模板存在本机 localStorage 里、取值规则是
// "改过就以用户的为准"：一个早就保存过结算凭证版式的站点，它的覆盖模板里天生还留着那块——
// 只在 `defaultTemplate` 里删等于什么也没做，那张纸会一直打到站长自己点「恢复默认」为止。
// 留着它不是难看的问题：那枚条码装的是一串与磅单同形的纯数字号，被顺手扫进窗口就是拿
// 别的票的形状去查磅单。
const legacyVoucher: ReceiptTemplate = {
  ...settleTpl,
  sections: [...settleTpl.sections, { id: "old-settle-code", kind: "qr", title: "凭单码（挂账核销时扫）", text: "{{settle_code}}", codeStyle: "barcode", qrCaption: true }],
};
const retired = normalizeTemplate(legacyVoucher);
ok("M1 取模板那一刻把历史的凭单码块摘掉", !retired.sections.some((s) => s.kind === "qr"), retired.sections.map((s) => s.kind));
ok("M2 摘完打到机器上没有任何可扫的行（qr 与 barcode 都不许出现）", !receiptLines(retired, settleCtx).some((l) => l.kind === "qr" || l.kind === "barcode"));
ok("M3 只摘那一块：其余区块一个不动", retired.sections.length === legacyVoucher.sections.length - 1, { had: legacyVoucher.sections.length, now: retired.sections.length });
ok("M4 站长自己新加的条码不摘（退役的是出厂那枚凭单码，不是码块这个能力）", normalizeTemplate(customBarTpl).sections.some((s) => s.kind === "qr"));
ok("M5 没有可摘的东西时返回原对象（引用不变，别让下游白重渲染）", normalizeTemplate(settleTpl) === settleTpl);

/* ---------------- N. 场景 id 就是 print_log.doc_type（加一种票最容易漏的那一格） */

/**
 * `silent.ts` 里 `doc_type: scenario`——打印留痕把**前端场景 id 原样写进库那一列**，中间不设
 * 第二份映射。于是同一个值域实际存在三处：
 *   ① 库：`print_log.doc_type` 的 CHECK（`tests/schema_snapshot.sql` 那行就是实际结构）
 *   ② 前端场景注册表：`SCENARIOS` 的键（= `ReceiptScenario`）
 *   ③ 读回来那一份：`mock/types.ts` 里 `PrintLog["doc_type"]` 的联合
 * `schema_contract` 只钉得到 ①↔Rust 枚举（它解析 `src/lib/constants.ts` 的联合，够不着
 * `ReceiptScenario`），②③ 这两处历史上真漏过：付款小票在 ② ③ 都有、① 里没有——
 * **桌面端每打一张付款小票，纸出来了、留痕那句 INSERT 撞 CHECK**，而浏览器预览因为 mock
 * 不校验值域完全看不出来（迁移 0030 补回）。出库码单是第四种带码的票，这里把三处钉成一处。
 */
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

const snap = readFileSync("src-tauri/tests/schema_snapshot.sql", "utf8");
const printLogDdl = snap.split("\n").find((l) => l.startsWith("table\tprint_log\t")) ?? "";
const dbDocTypes = (/(?:CHECK )?\(doc_type IN \(([^)]*)\)/.exec(printLogDdl)?.[1] ?? "")
  .split(",")
  .map((s) => s.trim().replace(/^'|'$/g, ""))
  .filter(Boolean);
// 解析不出来就等于这一整段是假绿——先钉住它自己读到了东西
ok("N0 读到了 print_log.doc_type 的实际值域（读不到就是快照路径或写法变了，不给假绿）", dbDocTypes.length >= 6, { 读到: dbDocTypes, 那行开头: printLogDdl.slice(0, 60) });

const scenarioIds = Object.keys(SCENARIOS);
const notInDb = scenarioIds.filter((s) => !dbDocTypes.includes(s));
ok(
  "N1 每个场景 id 都是 print_log.doc_type 允许的值（漏一个=那张票打完留痕撞 CHECK、已打几张永远不准）",
  notInDb.length === 0,
  { 库里没有的场景: notInDb, 库里允许: dbDocTypes },
);

const mockTypes = readFileSync("src/mock/types.ts", "utf8");
const printLogIface = /export interface PrintLog \{[\s\S]*?\n\}/.exec(mockTypes)?.[0] ?? "";
const tsDocTypes = [...printLogIface.matchAll(/doc_type:\s*([^;]+);/g)].flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((q) => q[1]));
ok(
  "N2 前端 PrintLog.doc_type 联合与场景注册表一一对应（少一个读不回来，多一个写不进去）",
  tsDocTypes.length > 0 && sameSet(tsDocTypes, scenarioIds),
  { 联合: tsDocTypes, 场景: scenarioIds },
);

// 库里有、但还没有对应票的预留值——只有 §9.19 那一种内部流转单。钉死这一条，
// 免得"先加个值占位、票以后再说"变成常态：占位的值永远不会被写，也就永远不会被发现写错。
const noScenario = dbDocTypes.filter((v) => !scenarioIds.includes(v));
ok("N3 库里多出来的 doc_type 只有 internal_flow 这一个预留值", sameSet(noScenario, ["internal_flow"]), { 多出来: noScenario });

/* ---------------- L. 接线守卫：每一个"按单号查"的框都吃了这颗剥皮 */
// 约定只写在文档里等于没写：下一个新框照抄上一个没接的，现场就又回到"扫了没反应"。
// 判据挑最省事的字面量——placeholder 里写了「单号」的输入框，它所在的文件必须出现 searchKeyword。
/** 不接的必须写清为什么（与 mock_coverage_contract.rs 里 STILL_MOCK 同一套路） */
const BOX_EXEMPT: Record<string, string> = {
  "src/components/business/ThemeSettingsPanel.tsx": "主题配色预览里那只假输入框，不接任何查询",
};
function listTsx(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listTsx(p);
    return e.name.endsWith(".tsx") ? [p.split(/[\\/]+/).join("/")] : [];
  });
}
const tsxFiles = listTsx("src");
ok("L0 守卫哨兵：不在仓库根目录跑就不许给绿灯", existsSync(join("src", "lib", "ticket-code.ts")) && tsxFiles.length > 100, tsxFiles.length);
const boxMisses = tsxFiles.filter((f) => {
  const text = readFileSync(f, "utf8");
  const isDocNoBox = /placeholder="[^"]*单号/.test(text);
  return isDocNoBox && !text.includes("searchKeyword") && !(f in BOX_EXEMPT);
});
ok("L1 写了「单号」的输入框都过了 searchKeyword（漏的文件列在这里）", boxMisses.length === 0, boxMisses);
const staleExempt = Object.keys(BOX_EXEMPT).filter((f) => !existsSync(f) || !/placeholder="[^"]*单号/.test(readFileSync(f, "utf8")));
ok("L2 豁免名单没有过时条目（不写「单号」了就把它删掉）", staleExempt.length === 0, staleExempt);

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 条不通过`);
process.exit(fails === 0 ? 0 : 1);

/** 给上面两处 `Extract` 用的样板值：只取其类型，不参与运行 */
const l0 = { kind: "text", text: "" } as import("../../src/lib/native").NativePrintLine;
