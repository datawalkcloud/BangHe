/**
 * 重量「量纲 → 显示单位」这条链的无头自检（04 §2.3）。
 *
 * 现场那一幕：1 号磅（COM5 柯力 D2008）面板显示 11.56 **吨**，界面显示 **11.6 kg**。
 * 数值一路都对——切帧过、异或过、判稳过——错的只有"帧内那串数字按什么单位解释"这一格，
 * 而这一格从前写死在型号预设里、界面又写死成 kg。所以这里钉三件事：
 *
 *  1. `payload.unit` → 0.1 kg 的因子表与显示除数**必须是同一个口径**（吨 ÷10000，不是 ÷1000）；
 *  2. 显示单位只能来自后端随帧下发的 `unit`（`ScaleEvent.unit`），前端不许再抄一份型号表；
 *  3. 设备中心那一栏「重量单位」真的落到扁平 `config_json.unit`，空值=跟随型号。
 *
 *   npx esbuild scripts/weight-unit/check.ts --bundle --platform=node --format=cjs \
 *       --outfile=.scratch/weight-unit.cjs && node .scratch/weight-unit.cjs
 *
 * 必须在仓库根跑：C–D 段直读 `src/`、`src-tauri/src/` 的源码做静态守卫，找不到根就先红。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { weight, weightUnit, weightUnitLabel, type WeightUnit } from "../../src/lib/format";

let fails = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`PASS ${name}`);
  else {
    fails++;
    console.log(`FAIL ${name}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}

/* --------------------------------------------------------- L0. 找得到仓库根（防假绿） */
const ROOT = [process.cwd(), join(__dirname, "..", ".."), join(__dirname, "..", "..", "..")]
  .map((p) => p.replace(/\\/g, "/"))
  .find((p) => existsSync(join(p, "src-tauri", "src", "scale.rs")));
ok("L0 找得到仓库根（否则 C–D 段全是假绿）", ROOT !== undefined, { cwd: process.cwd(), dirname: __dirname });
const read = (rel: string): string => {
  if (!ROOT) throw new Error("仓库根未定位");
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`读不到 ${rel}（守卫的靶子挪了，请同步这一条断言）`);
  return readFileSync(p, "utf8");
};

/* A. 2026-11-19 现场 COM5 那一帧（`STX +011560 3 1B ETX`）在 Rust 侧解析出的两个真值 */
{
  const rust = read("src-tauri/src/scale.rs");
  const scaleTest = read("src-tauri/tests/scale_contract.rs");
  ok("A1 柯力档预设的量纲是吨", /fn keli_d2008_cont[\s\S]{0,600}unit:\s*"t"/.test(rust), "keli_d2008_cont 的 payload.unit 不是 t");
  ok("A2 Rust 侧对同一帧算出 115600（= 11.560 t）", scaleTest.includes("115_600"), "Rust 用例里的吨读数变了，这边要同步");
  ok("A3 Rust 侧 kg 档的反证还是 116", scaleTest.includes("evs_kg[0].weight_01kg, 116"), "kg 档 1000 倍反证那一条被删了");
}

/* ------------------------------------------- B. weightUnit：后端那个字符串 → 显示口径 */
{
  const cases: [string | null | undefined, WeightUnit, string][] = [
    ["t", "t", "吨"],
    ["T", "t", "大写也认（手工改库的人）"],
    ["  t  ", "t", "首尾空格不算换单位"],
    ["吨", "t", "中文取值"],
    ["kg", "kg", "千克"],
    ["", "kg", "还没收到过帧：退回 kg，与改造前一致"],
    ["   ", "kg", "空串与空白都算没配"],
    [null, "kg", "null"],
    [undefined, "kg", "undefined"],
    ["斤", "kg", "认不出的取值不许当成吨（那是 1000 倍）"],
    ["ton", "kg", "「ton」不是这一栏的存储值"],
  ];
  for (const [raw, want, why] of cases) ok(`B1 weightUnit(${JSON.stringify(raw)}) = ${want}（${why}）`, weightUnit(raw) === want, weightUnit(raw));
  ok("B2 只有 2 个哨兵值被收窄进这张表（覆盖不到就说明有人在偷偷加分支）", new Set(cases.map((c) => c[1])).size === 2);
}

/* ------------------------------------------------- C. 显示除数：吨是 ÷10000，不是 ÷1000 */
{
  // 0.1 kg 定点：1 t = 1000 kg = 10000 个 0.1 kg。写成 ÷1000 就是把吨读成千克，正好是现场那 1000 倍
  ok("C1 现场那一帧按吨显示 = 11.560 t", weight(115_600, true, "t") === "11.560 t", weight(115_600, true, "t"));
  ok("C2 同一帧按 kg 显示 = 11,560.0 kg", weight(115_600, true, "kg") === "11,560.0 kg", weight(115_600, true, "kg"));
  ok("C3 kg 与 t 两档相差正好 1000 倍（数值同、除数不同）", weight(115_600, false, "t") === "11.560" && weight(115_600, false, "kg") === "11,560.0");
  ok("C4 那台 kg 仪表的错读数还是 11.6 kg", weight(116, true, "t") === "0.012 t" && weight(116, true, "kg") === "11.6 kg", [weight(116, true, "t"), weight(116, true, "kg")]);
  ok("C5 空值一律破折号，不显示 0", weight(null, true, "t") === weight(undefined, true, "kg") && weight(null, true, "t") === "—", weight(null, true, "t"));
  ok("C6 不带单位时只出数字（设备中心那格把单位单独排版）", weight(115_600, false, "t") === "11.560", weight(115_600, false, "t"));
  ok("C7 负读数（回皮）不被吞掉符号", weight(-115_600, true, "t") === "-11.560 t", weight(-115_600, true, "t"));
  ok("C8 weightUnitLabel 给的就是后缀本身", weightUnitLabel("t") === "t" && weightUnitLabel("kg") === "kg");
  ok("C9 吨那一档走的是同一个 ton()：÷10000 这个式子在本文件只许出现两次（ton + 单价换算）", (read("src/lib/format.ts").match(/\/\s*10000/g) ?? []).length <= 2, (read("src/lib/format.ts").match(/\/\s*10000/g) ?? []).length);
}

/* ------------------------------- D. 接线：单位只从后端随帧下来那条路走，前端不抄型号表 */
{
  const native = read("src/lib/scale-native.ts");
  ok("D1 事件类型里带了 unit", /unit\?:\s*string/.test(native) && /unit:\s*string/.test(native));
  ok("D2 归一化时没有帧就是空串（不是猜一个 kg 塞进去）", /unit:\s*f\.unit\s*\?\?\s*""/.test(native));
  const store = read("src/store/device.ts");
  ok("D3 store 的 ScaleState 有 unit 且初始为空串", /unit:\s*string;/.test(store) && /unit:\s*"",/.test(store));
  ok("D4 每一帧都把 unit 换进 state", /unit:\s*r\.unit/.test(store));
  // 前端不许自己维护「型号 → 单位」这张表（第三处真相，与 division01kg 同一口径）
  const offenders = walkSrc().filter((p) => /keli|ds822|yaohua|driverPresetUnit/i.test(readFileSync(p, "utf8")) && /["']t["']/.test(readFileSync(p, "utf8")) && !/config\.unit|unit:\s*""|options/.test(readFileSync(p, "utf8")));
  ok("D5 src 下没人按仪表型号自己判单位", offenders.length === 0, offenders.map((p) => p.slice(ROOT!.length)));

  // 显示侧：凡是把实时读数摆上屏的那几处，都得吃 weightUnit(scale.unit)
  const panels = [
    "src/components/workstation/WeighPanel.tsx",
    "src/components/outbound/OutboundWeighPanel.tsx",
    "src/components/business/DeviceStatusBar.tsx",
    "src/components/business/DisplayView.tsx",
  ];
  for (const f of panels) ok(`D6 ${f} 的读数单位来自帧`, /weightUnit\(scale\.unit\)/.test(read(f)));
  ok("D7 大字组件仍然有 unit 这个入参（否则 D6 传进来也白传）", /unit\?:\s*WeightUnit|unit\?:\s*"kg"\s*\|\s*"t"/.test(read("src/components/business/WeightDisplay.tsx")));
}

/* --------------------------- E. 设备中心那一栏：跟随型号 / 千克 kg / 吨 t → 扁平 config.unit */
{
  const page = read("src/pages/DevicesPage.tsx");
  ok("E1 磅的种类里有「重量单位」这一栏", /label:\s*"重量单位"/.test(page));
  ok("E2 三个取值：空（跟随型号）/ kg / t", /key:\s*"unit",[\s\S]{0,160}?options:\s*\[\s*"",\s*"kg",\s*"t"\s*\]/.test(page));
  ok("E3 文案是汉字 + 符号，不是裸的 kg/t", /跟随型号/.test(page) && /千克 kg/.test(page) && /吨 t/.test(page));
  ok("E4 换驱动时把手选单位清掉（别把上一台的「吨」带到新换的仪表上）", /if \(f\.kind === "scale"\)\s*delete cfg\.unit;/.test(page));
  ok("E5 Rust 侧那道门与这一栏同一份合法集合（空串与缺键=跟随型号）", /if !u\.trim\(\)\.is_empty\(\)\s*\{/.test(read("src-tauri/src/scale.rs")));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === ".scratch" || name === "dist") continue;
      walk(p, out);
    } else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
function walkSrc(): string[] {
  if (!ROOT) return [];
  return walk(join(ROOT, "src"));
}

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 条未通过`);
process.exit(fails === 0 ? 0 : 1);
