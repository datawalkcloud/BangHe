/**
 * 列表导出 xlsx/csv。
 *
 * 05 §5 要求 `Ctrl+E` 导出当前列表。真实现场要的是 xlsx（`tauri-plugin-shell` 打开
 * 或 Rust 侧 writing 库生成），这里先落 CSV：带 UTF-8 BOM，Excel 双击直接是中文，
 * 不用改区域设置。将来换成 xlsx 只需改本文件，调用方签名不变。
 *
 * 导出内容一律与屏幕同源：证号在此处已由界面 mask，不会带出明文。
 */

export type CsvCell = string | number | null | undefined;

function esc(v: CsvCell): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // 含分隔符/引号/换行必须整体加引号，内部引号翻倍
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
