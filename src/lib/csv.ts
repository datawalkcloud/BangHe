/**
 * 列表导出 xlsx/csv。
 *
 * 05 §5 要求 `Ctrl+E` 导出当前列表。真实现场要的是 xlsx（`tauri-plugin-shell` 打开
 * 或 Rust 侧 writing 库生成），这里先落 CSV：带 UTF-8 BOM，Excel 双击直接是中文，
 * 不用改区域设置。将来换成 xlsx 只需改本文件，调用方签名不变。
 *
 * 证号在这一层是**完整号码**，不是屏显那个掩码：磅单台账/收购台账的「证号」列就是
 * 迎检要全号的那条出口（04 §3.3），`exportCsvFile` 带 `piiEntity` 时落盘后补 `pii.read`
 * 留痕。屏显掩码与导出全号是两条路，别再拿"界面是掩码"来推断导出。
 *
 * 全号要能活着走到站长眼前，还差下面 `EXCEL_WOULD_REWRITE` 那一档：CSV 不带列类型，
 * 18 位证号会被 Excel 当数字吃掉尾号。全站十处列表导出（磅单台账、五张报表、付款流水、
 * 库存流水、操作审计、设备配置）都只从这里落地，闸门放这里，不放某一页。
 */

export type CsvCell = string | number | null | undefined;

/**
 * Excel/WPS 双击打开 CSV 时会「自己猜」成数字、且一猜就改数据的字符串形状。
 *
 * CSV 是纯文本，不带列类型：`341222199001011234` 躺在文件里是 18 个字符，Excel 按
 * General 格式认它是数字，而它只存 **15 位有效数字**——后三位就地补 0，屏幕上还缩成
 * `3.41222E+17`。现场报上来的「导出的磅单证号尾号全变成 000」就是这一步：库是对的、
 * 写出去的文件也是对的，坏在双击打开的那一下。前导 0 同理会直接掉。
 *
 * 门槛取 11 位：那是 General 格式开始改写成科学计数法的位置（手机号正好踩在边上），
 * 05 §7 验收第 8 条要的就是「Excel 与 WPS 打开均无列错位、无数字变科学计数法」。
 * 再短的数字串（序号、年份、两位等级）不拦——那是调用方真想让人拿去做算术的形状。
 *
 * 命中的两类现场都在这条链上：**18 位身份证全号**（台账那条迎检出口），以及
 * **纯数字化的单号本体**（03 §3.5 新号形：站码 2 + 年 4 + 月 2 + 流水 1~12，
 * 9~20 位全数字）——站码是 `01`/`02` 这类时还会先掉一个前导 0，流水排到 9 位以上
 * 就是第二个尾号 000。两者一律按 string 传（真库 DTO 就是 String），这条判据才管得住。
 */
const EXCEL_WOULD_REWRITE = /^(?:0\d+|\d{11,})$/;

function esc(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  // 只判 string：调用方给 number（毛重、金额、序号）就是要它进 Excel 后还能求和排序，一律原样。
  // 带 `-`/`.`/字母的形状也不判——`2026-10-08`、`-12.34`、`9133…MA2X`、`0394-8123456`
  // Excel 都认不错，拦它们只会把该算的列变成文本。
  const forced = typeof v === "string" && EXCEL_WOULD_REWRITE.test(v);
  // 前导 `'` 就是 Excel/WPS 自己那套「这是文本」标记：打开时吃掉，格子里剩原样一串数字。
  // 代价是记事本/非 Excel 的读手会看见那个引号——台账是给站长双击看的，认了。
  return quote(forced ? `'${v}` : String(v));
}

/** RFC4180：含分隔符/引号/换行必须整体加引号，内部引号翻倍 */
function quote(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: CsvCell[][]): string {
  return [headers.map(esc).join(","), ...rows.map((r) => r.map(esc).join(","))].join("\r\n");
}

/** 文件名带业务日期，便于对账时按日查找；导出动作本身也要留痕 */
export function downloadCsv(filename: string, headers: string[], rows: CsvCell[][]): number {
  const blob = new Blob(["\uFEFF" + toCsv(headers, rows)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 立即 revoke 会让部分 WebView 取消下载，留 1 s 足够落盘
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return rows.length;
}

/** 导出文件名统一加时间戳，避免同一天两次导出互相覆盖 */
export function csvName(base: string, ext = ""): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${base}${ext ? `_${ext}` : ""}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
