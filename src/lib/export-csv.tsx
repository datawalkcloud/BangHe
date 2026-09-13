/**
 * 导出文件的统一出口（05 §5「Ctrl+E 导出当前列表」）。
 *
 * 为什么收成一处：磅单台账、付款流水、四张报表、操作审计、设备配置原先各写一遍
 * `downloadCsv` + 各编一句 toast，落点全凭浏览器默认下载目录——现场要的是"存 U 盘还是存桌面"
 * 由站长当场挑，提示还得说清文件到底在哪，点一下就打开。
 *
 * 桌面端：原生「保存」对话框给路径 → `export_write` 落盘（UTF-8 BOM 在后端加）→ 提示里的
 * 路径可点开（`openPath` 走系统关联程序，Excel 双击即为中文）。浏览器预览没有文件系统，
 * 如实回落到浏览器下载，不演"已保存"。
 */
import { toast } from "sonner";
import { downloadCsv, toCsv, type CsvCell } from "@/lib/csv";
import { runningInTauri } from "@/lib/native";

/** 中文错误短句：命令层回的就是字符串，别把 `[object Object]` 弹给站长 */
function errText(e: unknown, fallback: string): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : fallback;
}

/**
 * 导出 CSV。调用前先自己判好权限与空数据（各页的话术不同）。
 *
 * @param unit 提示语里的量词，缺省「行」；审计用「条审计记录」、设备用「台设备配置快照」
 */
export async function exportCsvFile(opts: {
  /** 文件名（不含扩展名），一般由 `csvName()` 带上日期时间，免得同一天两次导出互相覆盖 */
  filename: string;
  headers: string[];
  rows: CsvCell[][];
  unit?: string;
}): Promise<void> {
  const { filename, headers, rows } = opts;
  const unit = opts.unit ?? "行";
  const n = rows.length;

  if (!runningInTauri()) {
    downloadCsv(filename, headers, rows);
    toast.success(`已导出 ${n} ${unit}到 CSV（浏览器预览：文件在浏览器下载目录）`);
    return;
  }

  const { save } = await import("@tauri-apps/plugin-dialog");
  const picked = await save({
    title: "选择保存位置",
    defaultPath: `${filename}.csv`,
    filters: [{ name: "CSV 文件（Excel 双击即为中文）", extensions: ["csv"] }],
  });
  if (typeof picked !== "string") return; // 站长按了取消，什么都不做

  const { invoke } = await import("@tauri-apps/api/core");
  let path: string;
  try {
    path = await invoke<string>("export_write", { path: picked, content: toCsv(headers, rows) });
  } catch (e) {
    toast.error(`导出失败：${errText(e, "文件没能写出去，请重新导出")}`);
    return;
  }

  toast.success(
    <>
      已导出 {n} {unit}到 CSV{" "}
      <button
        type="button"
        className="break-all text-left underline underline-offset-2 hover:opacity-80"
        onClick={() => void openFile(path)}
      >
        {path}
      </button>
    </>,
    // 比普通 toast 长：站长要来得及看清路径再点一下
    { duration: 10_000 },
  );
}

async function openFile(path: string) {
  try {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
  } catch (e) {
    toast.error(`打开文件失败：${errText(e, "请到该位置手工打开")}`);
  }
}
