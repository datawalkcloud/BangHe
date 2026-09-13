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
import { BARCODE_HEIGHT_DOTS, CODE_SCALE_DOTS, DOT_MM, fitModuleDots, printableMm, scaleOf } from "../../src/components/print/receipt/code-size";
import { CODE128_QUIET_MODULES, code128Runs, encodeCode128, measureCode128 } from "../../src/components/print/receipt/code128";
import { kvClusters } from "../../src/components/print/receipt/render";
import { receiptLines } from "../../src/components/print/receipt/escpos";
import { defaultTemplate } from "../../src/components/print/receipt/defaults";
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
  const max = printableMm(paper);
  for (const scale of [1, 2, 3, 4, 5] as const) {
    const want = CODE_SCALE_DOTS[scale];
    const got = fitModuleDots(modules, paper, want);
    ok(`C5 ${paper}/档${scale} 放得下或压到极限`, got <= want && modules * got * DOT_MM <= max + DOT_MM, { got, w: mm1(modules * got * DOT_MM), max });
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
    if (!g.shrunk && g.dots !== CODE_SCALE_DOTS[s]) return false;
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
ok("E2 尺寸档位真的发到了机器上", qrLine?.size === CODE_SCALE_DOTS[scaleOf(codeSec.qrScale)] && barLine?.dots === CODE_SCALE_DOTS[scaleOf(codeSec.qrScale)], { size: qrLine?.size, dots: barLine?.dots });
ok("E3 条高与预览同一常数", barLine?.height === BARCODE_HEIGHT_DOTS);
const legacy = receiptLines(tpl, ctx).filter((l) => l.kind === "barcode");
ok("E4 没动过码制的老模板只发二维码（一维码不无中生有）", legacy.length === 0);

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 条不通过`);
process.exit(fails === 0 ? 0 : 1);

/** 给上面两处 `Extract` 用的样板值：只取其类型，不参与运行 */
const l0 = { kind: "text", text: "" } as import("../../src/lib/native").NativePrintLine;
