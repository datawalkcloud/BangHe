/**
 * 整量化（`weigh_record.aligned_weight_01kg`）的无头自检。
 *
 * 这一列从前是死的：建库时就有、注释写着"按分度值取整后的值"、详情页专门占一栏，
 * 但落库那条 INSERT 把同一个参数写进了两列（`VALUES (..., ?4, ?4, ...)`），
 * 于是屏幕上那一栏永远是「读数」的复读。这类缺陷在界面上看不出来、在库里也看不出来
 * （两列都"有值"），只有把口径钉成断言才拦得住第二轮。
 *
 *   npx esbuild scripts/scale-align/check.ts --bundle --platform=node --format=cjs ^
 *       --outfile=.scratch/scale-align.cjs && node .scratch/scale-align.cjs
 *
 * （bash 下把行尾 `^` 换成 `\`；产物一律落 `.scratch/`，别落在仓库根目录）
 *
 * 必须在仓库根跑：C–I 段直读 `src/`、`src-tauri/src/`、`docs/` 的源码做静态守卫，
 * 找不到根就先红（L0），不许静默跳过。
 *
 * A 段是**双端对拍**的一半：`scripts/scale-align/cases.json` 那一整张用例表，
 * Rust 侧由 `src-tauri/tests/scale_contract.rs::align_apply_matches_the_shared_case_table`
 * 跑同一份。两边各写一遍公式，迟早有一边在 5650 / 负值 / 奇数分度上差一格。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALIGN_DEFAULT, ALIGN_NONE, applyAlign, captureAlign, type AlignCarrier } from "../../src/lib/scale-align";

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
  .find((p) => existsSync(join(p, "src-tauri", "src", "orders.rs")));
ok("L0 找得到仓库根（否则 C–I 段全是假绿）", ROOT !== undefined, { cwd: process.cwd(), dirname: __dirname });
const read = (rel: string): string => {
  if (!ROOT) throw new Error("仓库根未定位");
  const p = join(ROOT, rel);
  if (!existsSync(p)) throw new Error(`读不到 ${rel}（守卫的靶子挪了，请同步这一条断言）`);
  return readFileSync(p, "utf8");
};

/* ------------------------------------------------- A. 取整公式：与 Rust 同一份用例表对拍 */
{
  const table = JSON.parse(read("scripts/scale-align/cases.json")) as {
    cases: { raw: number; division: number; mode: string; expected: number; why?: string }[];
  };
  ok("A0 用例表至少 25 条（ fewer 说明字段名改了让断言空转）", table.cases.length >= 25, table.cases.length);
  let bad: unknown[] = [];
  for (const c of table.cases) {
    const got = applyAlign(c.raw, { division_01kg: c.division, mode: c.mode });
    if (got !== c.expected) bad.push({ ...c, got });
  }
  ok(`A1 applyAlign 跑通用例表全部 ${table.cases.length} 条`, bad.length === 0, bad);
  // 用例表必须真的覆盖到边界，否则 A1 只是"两边都算错得一样"
  const kinds = new Set(table.cases.map((c) => c.mode));
  ok("A2 用例表覆盖四种 mode（含空串与认不出的值）", kinds.has("nearest_div") && kinds.has("floor_div") && kinds.has("ceil_div") && kinds.has("none") && kinds.has(""), [...kinds]);
  ok("A3 用例表里有负读数", table.cases.some((c) => c.raw < 0));
  ok("A4 用例表里有奇数分度（d/2 截半那条最容易两边不一致）", table.cases.some((c) => c.division > 1 && c.division % 2 === 1));
  ok("A5 用例表里有 division<=0（无磅那一档）", table.cases.some((c) => c.division <= 0));
}

/* --------------------------------------- B. 挑哪台磅：启用 + 默认优先，查不到就不取整 */
{
  const dev = (id: number, over: Partial<AlignCarrier>): AlignCarrier =>
    ({ id, kind: "scale", is_enabled: 1, is_default: 0, config: {}, ...over });

  ok("B1 空台账 → 不取整", captureAlign([]) === ALIGN_NONE);
  ok("B2 只有停用的磅 → 不取整", captureAlign([dev(1, { is_enabled: 0, config: { division: "10 kg" } })]) === ALIGN_NONE);
  ok("B3 只有别的设备 → 不取整", captureAlign([dev(1, { kind: "camera" })]) === ALIGN_NONE);
  ok(
    "B4 默认优先于 id 更小的那台（与 default_scale_id 的 ORDER BY 同一条）",
    applyAlign(5650, captureAlign([
      dev(1, { config: { division: "20 kg" } }),
      dev(3, { is_default: 1, config: { division: "10 kg" } }),
    ])) === 5700,
  );
  ok(
    "B5 反过来：默认那台分度 20 kg 时按它算，不看 id 更大的",
    applyAlign(5650, captureAlign([
      dev(1, { is_default: 1, config: { division: "20 kg" } }),
      dev(3, { config: { division: "10 kg" } }),
    ])) === 5600,
  );
  ok(
    "B6 嵌套 align 段优先于人话字符串（帧监视器手调过的模板说了算）",
    applyAlign(5610, captureAlign([dev(1, { config: { division: "10 kg", align: { division_01kg: 20, mode: "ceil_div" } } })])) === 5620,
  );
  ok("B7 离谱分度（>100000 kg）退回不取整，不把一车粮就近成 0", applyAlign(5640, captureAlign([dev(1, { config: { align: { division_01kg: 2000000, mode: "nearest_div" } } })])) === 5640);
  ok("B8 扁平表单没写分度 → 文档默认 10 kg（与 Rust Align::default 同值）", captureAlign([dev(1, { config: { port: "COM3" } })]).division_01kg === ALIGN_DEFAULT.division_01kg);
}

/* ------------------------- C. 两枚站点参数退役干净：四处接线一处不许留（0032 的欠账） */
{
  const RETIRED = ["scale_division_01kg", "weight_rounding_mode"];
  // C1 参数目录：与 masters_contract::every_key_the_frontend_catalog_renders_exists_in_the_library 同一种解析法
  const catalog = read("src/lib/settings-catalog.ts");
  const keys = catalog.split("\n").flatMap((l) => (l.split('key: "')[1] ?? "").split('"').slice(0, 1));
  const stillListed = RETIRED.filter((k) => keys.includes(k));
  ok("C1 参数目录不再列这两枚键（否则设置页渲染出一行改了不生效的死项）", stillListed.length === 0, stillListed);
  ok("C2 参数目录仍有 ≥30 项（哨兵：别把整张表删了让 C1 空转）", keys.filter(Boolean).length >= 30, keys.length);

  // C3 03 §9.3.1 键集：照 schema_contract::parse_doc 的口径，只取 `--` 之前那段里的 `key=`
  const doc = read("docs/design/03-技术架构与数据模型.md");
  const inBlock = doc.split("\n").slice(
    (() => { const i = doc.split("\n").findIndex((l) => l.includes("9.3.1")); return i < 0 ? 0 : i; })(),
  );
  const docKeys = new Set<string>();
  for (const l of inBlock) {
    if (l.trim().startsWith("```") && docKeys.size > 0) break;
    const body = l.split("--")[0] ?? "";
    for (const m of body.matchAll(/([a-z][A-Za-z0-9_]*)\s*=/g)) docKeys.add(m[1]);
  }
  const stillInDoc = RETIRED.filter((k) => docKeys.has(k));
  ok("C3 03 §9.3.1 键集不再含这两枚（否则 seed_baseline_matches_design_doc 必红）", stillInDoc.length === 0, stillInDoc);
  ok("C4 §9.3.1 仍解析出 ≥20 枚键（哨兵：别把整段删了让 C3 空转）", docKeys.size >= 20, docKeys.size);

  // C5 读取点：注释里提到这两个名字是允许的，`useSetting(...)` 才是真读它
  const readers = walkSrc().filter((p) => new RegExp(`useSetting\\(\\s*["'](?:${RETIRED.join("|")})["']`).test(readFileSync(p, "utf8")));
  ok("C5 全站不再 useSetting 这两枚键", readers.length === 0, readers.map((p) => p.slice(ROOT!.length)));

  // C6 迁移已登记，且真的在删这两行
  // C6 迁移已登记，且真的在删这两行。两行都要在：`name:` 没了、只剩 `include_str!`，
  // 迁移照样不会执行（0032 就白写了），所以只查"文件名字样出现过一次"是假绿。
  const migrate = read("src-tauri/src/db/migrate.rs");
  const registered = migrate.includes('name: "0032_retire_scale_align_settings.sql"');
  const embedded = migrate.includes('include_str!("migrations/0032_retire_scale_align_settings.sql")');
  ok("C6 0032 的 name 与 include_str! 两行都在 migrate.rs::MIGRATIONS", registered && embedded, { registered, embedded });
  const mig = read("src-tauri/src/db/migrations/0032_retire_scale_align_settings.sql");
  ok("C7 0032 真的 DELETE 这两枚键", /DELETE FROM app_setting WHERE key IN \([^)]*scale_division_01kg[^)]*weight_rounding_mode[^)]*\)/.test(mig));
  ok("C8 历史脚本 0002 一字未改（改历史=装机版校验和拒启）", /'weight_rounding_mode',\s+'"nearest_div"'/.test(read("src-tauri/src/db/migrations/0002_seed.sql")));
}

/* --------------------------------- D. 落库那一刀：两条链都必须真的过 capture_align */
{
  for (const [file, docKind] of [["src-tauri/src/orders.rs", "weigh_order"], ["src-tauri/src/outbound.rs", "outbound_order"]] as const) {
    const src = read(file);
    const i = src.indexOf(`VALUES ('${docKind}', ?1, ?2, ?3, ?4, ?5,`);
    ok(`D1 ${docKind} 的 INSERT 是 ?4, ?5（两列两个值，不再 ?4, ?4 复读）`, i > 0);
    ok(`D2 ${docKind} 这一路真的调用了 capture_align`, src.includes("capture_align(conn).apply(input.weight_01kg)"));
    if (i > 0) {
      const stmt = src.slice(src.lastIndexOf("conn.execute(", i), i + 400);
      const params = stmt.slice(stmt.indexOf("params!["));
      ok(`D3 ${docKind} 的第 5 个入参是 aligned_01kg`, /input\.weight_01kg,\s*aligned_01kg,/.test(params), params.slice(0, 200));
    }
  }
  // 单头与结算没被整量化碰过（这是当轮拍板的边界，越界要重新拍）
  const orders = read("src-tauri/src/orders.rs");
  const upd = orders.slice(orders.indexOf("UPDATE weigh_order SET"));
  const updStmt = upd.slice(0, upd.indexOf("params!["));
  ok("D4 单头 UPDATE 里不出现 aligned_01kg（整量化只管轨迹列，不管钱）", !updStmt.includes("aligned"));
}

/* -------------------------------------- E. 取整公式全站只有一份（堵住下一个生成源） */
{
  // 只看代码行：这一轮的多处注释（含本脚本）都在**引用**那个被废掉的写法来解释为什么废它，
  // 把注释也算进来就是自己抓自己。
  const codeOnly = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");
  const files = walkSrc();
  const offenders = files
    .filter((p) => !/[\\/]lib[\\/]scale-align\.ts$/.test(p))
    .filter((p) => /Math\.round\([^)]*\/\s*\d+\)\s*\*\s*\d+|Math\.floor\([^)]*\/\s*\d+\)\s*\*\s*\d+/.test(codeOnly(readFileSync(p, "utf8"))));
  ok("E1 src 下不再有人自己写「除分度再乘回来」（第二份公式=下一次分叉）", offenders.length === 0, offenders.map((p) => p.slice(ROOT!.length)));
  const rng = read("src/mock/rng.ts");
  ok("E2 mock 造数用的 alignDiv 已委托给 applyAlign", /export function alignDiv[\s\S]{0,200}applyAlign\(/.test(rng));
}

/* ------------------------------------ F. mock 三个落库点都真的算了，不再复读原始值 */
{
  const sites: [string, RegExp][] = [
    ["src/mock/api.ts", /aligned_weight_01kg:\s*aligned\b/],
    ["src/mock/orders.ts", /aligned_weight_01kg:\s*applyAlign\(/],
    ["src/mock/outbound.ts", /aligned_weight_01kg:\s*applyAlign\(/],
  ];
  for (const [f, re] of sites) ok(`F1 ${f} 的整量化由 applyAlign 算出`, re.test(read(f)));
  const echo = sites.map(([f]) => f).filter((f) => /aligned_weight_01kg:\s*(?:i\.weight_01kg|w|gross|tare)\b/.test(read(f)));
  ok("F2 没有任何一处把原始值直接当整量化存（那正是这一列死掉的样子）", echo.length === 0, echo);
  ok("F3 演示侧的挑磅口径只有一处（masters 里的 DEMO_ALIGN）", (read("src/mock/masters.ts").match(/export const DEMO_ALIGN = captureAlign/g) ?? []).length === 1);
}

/* ------------------------------- G. 种子重量与演示分度不许各走一边（否则演示自己打自己） */
{
  // `rng.alignDiv` 用 ALIGN_DEFAULT 造"像真仪表吐的数"，而落库用 DEMO_ALIGN 取整。
  // 两者一旦不同（改了 mock 台账里 scale1 的 division 而没重造种子），演示数据自己就不自洽。
  const masters = read("src/mock/masters.ts");
  const scale1 = /code: "scale1"[\s\S]{0,400}/.exec(masters)?.[0] ?? "";
  const declared = /division:\s*"([^"]+)"/.exec(scale1)?.[1];
  ok("G1 mock 台账 1 号磅写了分度值", declared !== undefined, declared);
  ok("G2 1 号磅的分度与 ALIGN_DEFAULT 同一个数（种子口径不漂移）", declared === "10 kg", declared);
  ok("G3 ALIGN_DEFAULT 就是文档默认的 100（0.1 kg 单位）", ALIGN_DEFAULT.division_01kg === 100 && ALIGN_DEFAULT.mode === "nearest_div");
  ok("G4 captureAlign 对这份台账算出来的正是 ALIGN_DEFAULT", applyAlign(5640, captureAlign([{ id: 1, kind: "scale", is_enabled: 1, is_default: 1, config: { division: declared ?? "" } }])) === applyAlign(5640, ALIGN_DEFAULT));
}

/* --------------------------- H. 前端那一格不再凭空造分度（0032 之后没有兜底值可读了） */
{
  const panel = read("src/components/workstation/WeighPanel.tsx");
  ok("H1 称重区的分度读随帧下发的那个真值", /scale\.division01kg/.test(panel));
  ok("H2 没有真机帧时那一格不显示数字（凭空补一个数就是又造一处假真相）", /division01kg > 0/.test(panel));
  const ws = read("src/pages/WorkstationPage.tsx");
  ok("H3 工作台不再往称重区传站点参数分度", !/scaleDivision01kg/.test(ws));
  ok("H4 WeighPanel 的 props 里也没有 scaleDivision01kg 了", !/scaleDivision01kg/.test(panel));
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
