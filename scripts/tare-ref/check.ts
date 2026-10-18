/**
 * 皮重参考口径的无头自检（05 §4 ②、03 §4.2）。
 *
 * 为什么单独留这一份：`tareMean01kg` / `tareOverTolerance` 都是纯函数，算错一分钱也不会当场看见——
 * 它只表现为"某个农户的皮重参考卡片哪天起再也没亮过红"，或反过来"每车都超差"。
 * 更要紧的是**这一份口径被四个地方共用**（卡片汇总行、卡片那五行明细、称重区捕获那一捕、
 * 农户档案页皮重档案）：谁在本地再抄一个 `slice(0, 5)` 或 `Math.round(m * pct / 100)`，
 * 两处就会安静地分叉，界面上一句解释都没有。所以 F 段拿文件扫一道闸，把"第二份口径"钉死。
 *
 * 血泪在册：档案页以前那两处写的是 `x.source === WEIGHT_SOURCE.scale.label`——
 * 库里存的是枚举值 `scale`，比中文标签恒假，于是"手录不进均值"这条规矩**从来没生效过**，
 * 而来源列每一行都染成警示色（显示的是英文 `scale`）。F2 专门钉这一条形状。
 *
 * 在仓库根跑（F 段按 `src/` 相对路径扫文件，换目录会扫空、假绿）：
 *
 *   npx esbuild scripts/tare-ref/check.ts --bundle --platform=node --format=cjs ^
 *     --outfile=.scratch/tare-ref.cjs && node .scratch/tare-ref.cjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WEIGHT_SOURCE, isManualWeightSource, weightSourceLabel } from "../../src/lib/constants";
import {
  TARE_REF_WINDOW,
  tareDev01kg,
  tareMean01kg,
  tareOverTolerance,
  tareRefRows,
  tareTolerance01kg,
  type TareRefRow,
} from "../../src/lib/tare-ref";

let fails = 0;
let checks = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  checks++;
  if (cond) console.log(`PASS ${name}`);
  else {
    fails++;
    console.log(`FAIL ${name}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}
const eq = (name: string, got: unknown, want: unknown) => ok(`${name}（回 ${JSON.stringify(got)}）`, got === want, want);

/** L0 哨兵：脚本必须在仓库根跑。换目录时 F 段的文件扫描会扫成"零命中"而全绿，那是假绿 */
if (!existsSync("src/lib/tare-ref.ts") || !existsSync("src-tauri/src/orders.rs")) {
  console.error("FAIL L0 必须在仓库根目录跑本脚本（找不到 src/lib/tare-ref.ts 或 src-tauri/src/orders.rs）");
  process.exit(1);
}
ok("L0 哨兵：工作目录是仓库根，F 段扫得到文件", true);

const R = (date: string, kg: number, source = "scale"): TareRefRow => ({ date, tare_01kg: kg, source });

/* ─────────────────────────────── A. 参考窗口 */
const six = [R("2026-10-08", 18400), R("2026-10-07", 18300), R("2026-10-06", 18200), R("2026-10-05", 18100), R("2026-10-04", 18000), R("2026-10-03", 99999)];
eq("A1 窗口是 5", TARE_REF_WINDOW, 5);
eq("A2 六条只取最近五条", tareRefRows(six).length, 5);
eq("A3 第六条（99999）进不了窗口", tareRefRows(six).some((r) => r.tare_01kg === 99999), false);
eq("A4 窗口再切一次幂等（面板自己还会切一遍）", tareRefRows(tareRefRows(six)).length, 5);
eq("A5 不足五条有几条算几条", tareRefRows([R("2026-10-08", 18400)]).length, 1);
eq("A6 空历史不炸", tareMean01kg([]), null);

/* ─────────────────────────────── B. 均值：手录不进基准 */
eq("B1 五条地磅读数取平均", tareMean01kg(six.slice(0, 5)), 18200);
const withManual = [R("2026-10-08", 18400), R("2026-10-07", 18300, "manual"), R("2026-10-06", 18200), R("2026-10-05", 18100), R("2026-10-04", 18000)];
eq("B2 手录那一行不计入均值（四条 18000/18100/18200/18400）", tareMean01kg(withManual), 18175);
eq("B3 均值要是不剔手录就会是 18200 —— 二者必须不同", tareMean01kg(withManual) === 18200, false);
eq("B4 第 6 条是手录也够不着窗口（窗口先于来源）", tareMean01kg(six), 18200);
const allManual = [R("2026-10-08", 18400, "manual"), R("2026-10-07", 18300, "manual")];
eq("B5 全窗手录时退回全量（宁可粗糙，不说「没有参考」）", tareMean01kg(allManual), 18350);
eq("B6 四舍五入到 0.1kg 整数", tareMean01kg([R("d", 1001), R("d", 1002)]), 1002);

/* ─────────────────────────────── C. 偏差与容差 */
eq("C1 正偏差带符号", tareDev01kg(18500, 18200), 300);
eq("C2 负偏差带符号", tareDev01kg(18000, 18200), -200);
eq("C3 没有基准时回 null（不拿 0 冒充「不多不少」）", tareDev01kg(18500, null), null);
eq("C4 本单还没捕皮重时回 null", tareDev01kg(null, 18200), null);
eq("C5 容差 3% of 18200 = 546.0kg", tareTolerance01kg(18200, 3), 546);
eq("C6 恰好等于容差不算超（差多少都放行到这一格为止）", tareOverTolerance(18200 + 546, 18200, 3), false);
eq("C7 超一丁点就算超", tareOverTolerance(18200 + 547, 18200, 3), true);
eq("C8 低于均值同样按绝对值算", tareOverTolerance(18200 - 547, 18200, 3), true);
eq("C9 容差参数关到 0 → 永不超差（默认不拦人）", tareOverTolerance(999999, 18200, 0), false);
eq("C10 没历史 → 不判超差", tareOverTolerance(18200, null, 3), false);
eq("C11 基准为 0 的脏数据不判（防「零皮重」把每车都点红）", tareOverTolerance(18200, 0, 3), false);

/* ─────────────────────────────── D. 与 Rust 那道闸同一条阈值
 * `orders.rs::capture`：`pct` 以 0.01% 计，阈值 `(m * pct + 5000) / 10000`（整数除法＝四舍五入）。
 * 这边 `tolerancePct` 已被调用方除以 100 变成"百分之"。两头必须给同一个公斤数。 */
function rustTol01kg(m: number, pctHundredths: number): number {
  return Math.floor((m * pctHundredths + 5000) / 10000);
}
let mismatch = 0;
const samples: [number, number][] = [];
for (const m of [1, 5, 999, 1000, 12345, 18000, 18201, 30000, 99999, 123457]) {
  for (const pct of [0, 1, 2, 50, 100, 101, 299, 300, 555, 1000, 3001]) {
    samples.push([m, pct]);
    if (rustTol01kg(m, pct) !== tareTolerance01kg(m, pct / 100)) mismatch++;
  }
}
ok(`D1 阈值与 Rust 逐点等价（${samples.length} 个组合）`, mismatch === 0, { mismatch });
ok("D2 那道 `+5000` 是真四舍五入，不是截断（m=1000 pct=1.06% → 11 而非 10）", rustTol01kg(1000, 106) === 11 && Math.floor((1000 * 106) / 10000) === 10, { rust: rustTol01kg(1000, 106) });
ok("D3 半进位那一格两边同向（m=50 pct=1% → 0.5 进成 1）", rustTol01kg(50, 100) === 1 && tareTolerance01kg(50, 1) === 1);

/* ─────────────────────────────── E. 来源判据（枚举值 ≠ 中文标签） */
eq("E1 枚举值 scale 不是手录", isManualWeightSource("scale"), false);
eq("E2 枚举值 manual 是手录", isManualWeightSource("manual"), true);
eq("E3 中文标签「手录」认不出来＝按不可信处理（认不出 scale 一律显眼的方向）", isManualWeightSource("手录"), true);
eq("E4 标签取的是枚举值", weightSourceLabel("manual"), WEIGHT_SOURCE.manual.label);
eq("E5 认不出的值原样显示，不崩也不瞎猜", weightSourceLabel("unknown-x"), "unknown-x");
ok("E6 判据与标签互不越界（scale 的标签里没有「手录」二字）", !WEIGHT_SOURCE.scale.label.includes("手录"));

/* ─────────────────────────────── F. 接线闸门：不许长出第二份口径 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p.split("\\").join("/"));
  }
  return out;
}
const files = walk("src");
const read = (p: string) => readFileSync(p, "utf8");
const hits = (re: RegExp, skip = "") => files.filter((p) => !p.endsWith(skip) && re.test(read(p)));

ok(
  "F1 近 5 次窗口只有一处（别人再写一个 slice(0, 5) 就是第二份口径）",
  hits(/slice\(\s*0\s*,\s*5\s*\)/).every((p) => !/[Tt]are/.test(read(p).match(/.*slice\(\s*0\s*,\s*5\s*\).*/)?.[0] ?? "")),
  hits(/slice\(\s*0\s*,\s*5\s*\)/).filter((p) => /[Tt]are/.test(read(p).match(/.*slice\(\s*0\s*,\s*5\s*\).*/)?.[0] ?? "")),
);
ok(
  `F2 没有人再拿中文标签比枚举值（档案页那次恒假判据的形状）`,
  hits(/===\s*WEIGHT_SOURCE\.\w+\.label/).length === 0,
  hits(/===\s*WEIGHT_SOURCE\.\w+\.label/),
);
ok("F3 中文标签只往界面上写，不拿来比（`=== \"手录\"` 这一类形状一律不许出现）", hits(/===\s*["'](地磅读数|手录)["']/).length === 0, hits(/===\s*["'](地磅读数|手录)["']/));
ok("F4 容差公式只有一份", hits(/\*\s*\(?\w*[Tt]olerancePct\)?\s*\/\s*100/, "src/lib/tare-ref.ts").length === 0, hits(/\*\s*\(?\w*[Tt]olerancePct\)?\s*\/\s*100/, "src/lib/tare-ref.ts"));
const panel = read("src/components/workstation/IdentityPanel.tsx");
ok("F5 皮重参考卡片确实吃的是这份口径", /tareRefRows\(/.test(panel) && /tareOverTolerance\(/.test(panel) && /tareDev01kg\(/.test(panel));
ok("F6 卡片那五行明细逐行给出「日期·皮重·与均值偏差·手录」", /近 \{rows\.length\} 次明细/.test(panel) && /weightSourceLabel\(r\.source\)/.test(panel) && /r\.date/.test(panel));
ok("F7 卡片不再把明细压成一串数字（`近 5 次 ${…}` 那句已撤）", !/近 5 次 \$\{/.test(panel));
const ws = read("src/pages/WorkstationPage.tsx");
ok("F8 工作台的均值与警示态走同一份口径", /tareMeanOf\(tareRecent\)/.test(ws) && /tareOverTolerance\(currentTare01kg/.test(ws));
const pd = read("src/pages/PartyDetailPage.tsx");
ok("F9 档案页皮重档案也走同一份口径", /tareMeanOf\(tareList\)/.test(pd) && /tareOverTolerance\(t\.tare_01kg/.test(pd));
const wp = read("src/components/workstation/WeighPanel.tsx");
ok("F10 捕获那一捕的超差判据走同一份口径", /tareOverTolerance\(value01kg/.test(wp) && !/Math\.round\(\(mean01kg/.test(wp));

/* ─────────────────────────────── G. DTO 形状（mock ↔ Rust 逐字一致） */
const mockApi = read("src/mock/api.ts");
const ordersRs = read("src-tauri/src/orders.rs");
ok("G1 mock 的 tareHistory 三字段齐", /tareHistory: \{ date: string; tare_01kg: number; source: string \}\[\]/.test(mockApi));
ok("G2 Rust 的 TareRow 三字段齐", /pub struct TareRow \{[\s\S]*?pub date: String,[\s\S]*?pub tare_01kg: i64,[\s\S]*?pub source: String,/.test(ordersRs));
ok("G3 Rust 侧读的是 weigh_order.weight_source（枚举值，不是中文）", /SELECT business_date, tare_weight_01kg, weight_source FROM weigh_order/.test(ordersRs));
ok("G4 前端那两份读回键名并存（camelCase 与 snake_case 都认）", /\?\.tareHistory \?\? .*\.tare_history/.test(ws) && /\?\.tareHistory \?\? .*\.tare_history/.test(pd));

/* ─────────────────────────────── S. 自证：退回即红
 * 把"手录不进均值"撤掉（拿全窗平均）后，本文件的断言必须转红——否则这些断言是摆设。 */
const naiveMean = (rows: readonly TareRefRow[]) => {
  const w = tareRefRows(rows);
  return w.length === 0 ? null : Math.round(w.reduce((s, r) => s + r.tare_01kg, 0) / w.length);
};
ok("S1 撤掉「手录不进均值」→ B2/B3 的数就变了（断言有牙）", naiveMean(withManual) !== tareMean01kg(withManual), { naive: naiveMean(withManual), real: tareMean01kg(withManual) });
ok("S2 恒假判据（比中文标签）一行都挑不出「地磅读数」→ 只能走全窗兜底，手录就此混进基准", withManual.filter((x) => x.source === WEIGHT_SOURCE.scale.label).length === 0);
ok("S3 阈值公式退成截断（丢掉 `+5000`）→ D1 那 110 个点里必有红（断言有牙）", samples.filter(([m, pct]) => Math.floor((m * pct) / 10000) !== rustTol01kg(m, pct)).length > 0);

console.log(`\n${checks - fails}/${checks} 通过${fails ? `，${fails} 条失败` : ""}`);
process.exit(fails ? 1 : 0);
