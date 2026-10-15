/**
 * 列表导出 CSV 的无头自检：把「Excel/WPS 双击打开会看到什么」钉成断言。
 *
 * 为什么单独留这一份：CSV 是纯文本、不带列类型，写出去的内容对不对，只有站长双击那一下
 * 才见分晓。现场已经炸过一次——磅单台账的「证号」列是 18 位全号（04 §3.3 那条迎检出口），
 * Excel 按 General 格式把它当数字，而数字只存 **15 位有效数字**，后三位就地补 0，
 * 屏幕上还缩成科学计数法。站长拿到的是一份尾号全 000 的表：库是对的、文件也是对的，
 * 坏在打开的那一下。这类回归在界面上、在文件里都看不出来，只能把 Excel 的行为建成模型钉住。
 *
 *   npx esbuild scripts/csv-export/check.ts --bundle --platform=node --format=cjs ^
 *       --outfile=.scratch/csv-export.cjs && node .scratch/csv-export.cjs
 *
 * （bash 下把行尾 `^` 换成 `\`；产物一律落 `.scratch/`，别落在仓库根目录）
 *
 * 必须 `--platform=node --format=cjs`：F 段要用 node 的 `fs` 直读源码，确认全站只有
 * `src/lib/csv.ts` 这一个落地口；出成 esm 就是一句 `Dynamic require of "fs" is not supported`。
 *
 * 覆盖的是纯函数那一层（`toCsv` 的转义与强制文本判据）：不碰 DOM、不碰 Tauri，不需要 stub。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { toCsv, type CsvCell } from "../../src/lib/csv";

let fails = 0;
function ok(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`PASS ${name}`);
  else {
    fails++;
    console.log(`FAIL ${name}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}

/* ---------------------------------------------- 1. 一个单元格：文件里的样子 / Excel 里的样子 */
/** 单值单独成表，返回**落在磁盘上的那一段文本**（转义后的原样） */
function rawCell(value: CsvCell): string {
  return toCsv(["列"], [[value]]).split("\r\n")[1];
}

/** RFC4180 解析器：引号、逗号、换行、CRLF 都得按规矩走，「列错位」就是这么来的 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\r" && text[i + 1] === "\n") (row.push(field), rows.push(row), (row = []), (field = ""), i++);
    else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

/** 解掉 CSV 那层壳——Excel 的 CSV 读手交给单元格的就是这一段 */
function cellForExcel(value: CsvCell): string {
  return parseCsv(toCsv(["列"], [[value]]))[1][0];
}

/* ----------------------------- 2. Excel General 格式模型：单元格打开后到底显示什么 */
/** 只留 sig 位有效数字、其后补 0（Excel 的四舍五入口径：第 16 位 ≥5 才进位） */
function roundToSig(digits: string, sig = 15): string {
  if (digits.length <= sig) return digits;
  const arr = digits.slice(0, sig).split("");
  if (digits[sig] >= "5") {
    let i = arr.length - 1;
    while (i >= 0 && arr[i] === "9") (arr[i] = "0", i--);
    if (i < 0) arr.unshift("1");
    else arr[i] = String(Number(arr[i]) + 1);
  }
  let kept = arr.join("");
  if (kept.length > sig) kept = kept.slice(0, sig); // 999…→1000…：Excel 同样只留 15 位
  return kept + "0".repeat(digits.length - kept.length);
}

/**
 * 「单元格里的这一段」→「站长在 Excel 里看到的」。只建三条规矩，多一条都不建：
 * ① 前导 `'` 是 Excel/WPS 的文本标记，打开时吃掉、剩下的原样一位不掉；② 纯整数按数字存
 * → 吃前导 0、只留 15 位有效数字；③ 其余形状（日期、混排代码、小数）原样。
 * 11 位以上整数还要被改写成科学计数法显示，那是 `goesScientific` 单独管的另一件事。
 */
function excelSees(cell: string): string {
  const text = /^'(\d+)$/.exec(cell);
  if (text) return text[1];
  if (/^-?\d+$/.test(cell)) {
    const neg = cell.startsWith("-") ? "-" : "";
    const digits = (neg ? cell.slice(1) : cell).replace(/^0+(?=\d)/, "");
    return neg + roundToSig(digits);
  }
  return cell;
}
/** 裸的 11 位以上整数会被缩成 `1.23E+10` 那副样子（05 §7 验收第 8 条明令不许） */
const goesScientific = (cell: string) => /^-?\d{11,}$/.test(cell);
/** 站长最终读到的：先解 CSV 壳，再喂 Excel 模型 */
const inExcel = (value: CsvCell) => excelSees(cellForExcel(value));

/* --------------------------------------------------------- A. 会被吃掉的那几列 */
const ID18 = "341222199001011234"; // 纯数字尾号：现场报上来的正是这一类
const ID18X = "34122219900101123X"; // 末位校验 X → 混排，Excel 本来就当文本
const ID15 = "341222900101123"; // 一代 15 位证号
const MOBILE = "13800001380"; // 11 位手机号，正好卡在科学计数法门槛上
const CREDIT = "913416001234567890"; // 统一社会信用代码里纯数字的那种
const PADDED = "0123456"; // 前导 0 的编号/卡号
// 单号本体（03 §3.5 新号形：站码 2 + 年 4 + 月 2 + 流水 1~12，全数字）。字母换成数字是为了
// 让扫码枪在中文输入法下打得出来（02 §F1.4），代价就是这一列从此也是 Excel 眼里的一个数：
// 站码 `02` 开头的先掉一个 0，流水排长了再吃尾号——对账时谁都看不出这串号被改过。
const DOC_NO = "02202610000053"; // 14 位：站码 02 + 2026 + 10 + 6 位流水
const DOC_NO_LONG = "02202610123456789012"; // 20 位：流水 12 位打满，Excel 只能存下前 15 位

for (const [label, value] of [
  ["A1 18 位证号（纯数字尾号）", ID18],
  ["A2 18 位证号（末位 X）", ID18X],
  ["A3 15 位老证号", ID15],
  ["A4 11 位手机号", MOBILE],
  ["A5 前导 0 的编号", PADDED],
  ["A6 18 位纯数字信用代码", CREDIT],
  ["A7 单号本体（站码 02 开头）", DOC_NO],
  ["A8 单号本体（流水打满 20 位）", DOC_NO_LONG],
] as const) {
  ok(`${label} → Excel 读到原号`, inExcel(value) === value, { cell: cellForExcel(value), excelSees: inExcel(value) });
  ok(`${label} → 不进科学计数法`, !goesScientific(cellForExcel(value)), cellForExcel(value));
}

/* ------------------------------------- B. 现场取证：这套模型测的确实是真问题 */
// 把同一串证号**裸写**进单元格（＝退回修复前的 esc），必须复现尾号 000。
// 这一组钉的是模型本身：哪天有人把 excelSees 改松了，整份自检就成了自娱自乐。
ok("B1 裸写 18 位证号，Excel 尾号确实变 000", excelSees(ID18) === "341222199001011000", excelSees(ID18));
ok("B2 裸写 11 位手机号，Excel 确实进科学计数法", goesScientific(MOBILE));
ok("B3 裸写前导 0 编号，Excel 确实把 0 吃掉", excelSees(PADDED) === "123456", excelSees(PADDED));
ok("B4 第 16 位是 5 时按 Excel 口径进位", excelSees("1234567890123455") === "1234567890123460", excelSees("1234567890123455"));
ok("B5 落盘的就是 `'` + 原号（Excel/WPS 打开时吃掉那个引号）", rawCell(ID18) === `'${ID18}`, rawCell(ID18));
ok("B6 单号本体裸写时同样被改：掉站码前导 0 + 吃尾号", excelSees(DOC_NO_LONG) === "2202610123456790000", excelSees(DOC_NO_LONG));

/* --------------------------------- C. 不该拦的：调用方要的就是一个能算的数 */
ok("C1 number 重量列不加壳（进 Excel 还能求和）", rawCell(1234.5) === "1234.5", rawCell(1234.5));
ok("C2 number 序号列原样", rawCell(1) === "1");
ok("C3 只拦 string：15 位以上的 number 也不加前缀（号本来就该按 string 传）", rawCell(123456789012345) === "123456789012345", rawCell(123456789012345));
ok("C4 业务日期串原样（不是数字形状，留给 Excel 自己认日期）", rawCell("2026-10-08") === "2026-10-08");
ok("C5 时间戳串原样", rawCell("2026-10-08 19:04:04") === "2026-10-08 19:04:04");
ok("C6 存量单号（两位字母开头，库里还有一整批）原样", rawCell("BD01202610000053") === "BD01202610000053");
ok("C7 混排信用代码原样", rawCell("91330100MA2XXXXXX4") === "91330100MA2XXXXXX4");
ok("C8 小数串（吨、金额）原样，不许被降级成文本", rawCell("-12.34") === "-12.34" && rawCell("1230.00") === "1230.00", [rawCell("-12.34"), rawCell("1230.00")]);
ok("C9 座机号（带横线）原样", rawCell("0394-8123456") === "0394-8123456");
ok("C10 短数字串不拦（等级、袋重这类两位值留给算术）", rawCell("2") === "2" && rawCell("10") === "10");
ok("C11 单个 0 不拦", rawCell("0") === "0");
ok("C12 空串/null/undefined 一律出空格", rawCell("") === "" && rawCell(null) === "" && rawCell(undefined) === "");

/* ------------------------------------- D. 转义层不许回归（列错位就出在这一步） */
ok("D1 含逗号的住址不裂列", parseCsv(toCsv(["住址"], [["城东村,3 组"]]))[1][0] === "城东村,3 组");
ok("D2 含引号的备注逐字回来", parseCsv(toCsv(["备注"], [['挂"半"账']]))[1][0] === '挂"半"账');
ok("D3 含换行的备注不撑出新行", (() => {
  const rows = parseCsv(toCsv(["备注"], [["第一行\n第二行"]]));
  return rows.length === 2 && rows[1][0] === "第一行\n第二行";
})());
ok("D4 强制文本与转义叠加后仍原样解回（先解 CSV 壳、再喂 Excel 模型）", (() => {
  const cell = parseCsv(toCsv(["证号"], [[ID18]]))[1][0];
  return cell === `'${ID18}` && excelSees(cell) === ID18;
})(), parseCsv(toCsv(["证号"], [[ID18]]))[1][0]);
ok("D5 表头照旧原样（中文列名不该被拦）", parseCsv(toCsv(["证件号", "净重kg"], [["a", "b"]]))[0].join("|") === "证件号|净重kg");

/* ---------- E. 整行回归：逐列「Excel 看到的」== 「调用方给进去的」（两张真表的列形状） */
// 磅单台账 23 列照 OrdersPage.exportCsv、付款流水 11 列照 PaymentsPage.exportCsv。
// 值取现场最刁的几种：全号、纯数字单号、14 位交易流水、小数、日期、含逗号引号的姓名。
const SHEETS: { name: string; headers: string[]; row: CsvCell[] }[] = [
  {
    name: "E-磅单台账",
    headers: ["磅单号", "业务日期", "售粮人", "证号", "品种", "等级", "车牌", "仓房/货位", "毛重kg", "皮重kg", "净重kg", "扣重kg", "结算重量kg", "单价元/公斤", "粮款元", "扣款元", "应付元", "已付元", "状态", "付款状态", "称重来源", "磅员", "制单时间"],
    row: [DOC_NO, "2026-10-08", "张庄李桂英", ID18, "晚粳稻", "二等", "皖S12345", "1号仓/西二", 18420.5, 6120, 12300.5, 180.5, 12120, 2.68, 32481.6, 0, 32481.6, 0, "已结算", "已付清", "地磅", "王建国", "2026-10-08 19:04:04"],
  },
  {
    name: "E-付款流水",
    headers: ["付款流水号", "付款时间", "收款人", "金额元", "方式", "结算单号", "磅单号", "交易流水", "凭证号", "经手人", "状态"],
    row: ["02202610000088", "2026-10-08 19:40:12", "李,串\"名\"", 32481.6, "银行转账", "02202610000053", DOC_NO_LONG, "20261008123456", "2026118", "周长江", "有效"],
  },
];
for (const sheet of SHEETS) {
  const back = parseCsv(toCsv(sheet.headers, [sheet.row]))[1];
  ok(`${sheet.name} 1 列数对得上号`, back.length === sheet.headers.length, { h: sheet.headers.length, got: back.length });
  const bad = sheet.row.map((v, i) => {
    const want = typeof v === "number" ? String(v) : (v ?? "");
    const seen = excelSees(back[i]);
    return seen === want ? null : `${sheet.headers[i]}：给「${want}」看到「${seen}」`;
  }).filter(Boolean);
  ok(`${sheet.name} 2 逐列 Excel 看到的 == 调用方给进去的`, bad.length === 0, bad);
  ok(`${sheet.name} 3 逐列没有一列被缩成科学计数法`, !back.some(goesScientific), back.filter(goesScientific));
}

/* ------------------------------ F. 闸门只有一处：csv.ts 必须是全站唯一落地口 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
{
  // esbuild 的产物在 .scratch/ 下，源码根就在它上一层；直接跑时落点未知，两种都认一次
  const srcDir = [join(process.cwd(), "src"), join(__dirname, "..", "src"), join(__dirname, "..", "..", "src")].find(existsSync);
  ok("F0 找得到 src 目录（否则下面两条是假绿）", srcDir !== undefined, { cwd: process.cwd(), dirname: __dirname });
  if (!srcDir) {
    console.log("跳过 F1/F2");
  } else {
    const files = walk(srcDir).filter((p) => !/[\\/]lib[\\/]csv\.ts$/.test(p));
    // 谁再自己拼一份 Blob + text/csv，就等于在闸门外面又开了一个不带强制文本的出口
    const offenders = files.filter((p) => /text\/csv/.test(readFileSync(p, "utf8")));
    ok("F1 src 下除 lib/csv.ts 外不再自己拼 text/csv（否则强制文本被绕过）", offenders.length === 0, offenders);
    const holders = files.filter((p) => /\btoCsv\(|\bdownloadCsv\(/.test(readFileSync(p, "utf8")));
    ok("F2 toCsv/downloadCsv 只由 lib/export-csv.tsx 持有（提示与 pii 留痕在那一层）", holders.length === 1 && /[\\/]lib[\\/]export-csv\.tsx$/.test(holders[0]), holders);
  }
}

console.log(fails === 0 ? "\n全部通过" : `\n${fails} 条未通过`);
process.exit(fails === 0 ? 0 : 1);
