/**
 * 导出文件的统一出口（05 §5「Ctrl+E 导出当前列表」）。
 *
 * 为什么收成一处：磅单台账、付款流水、四张报表、操作审计、设备配置原先各写一遍
 * `downloadCsv` + 各编一句 toast，落点全凭浏览器默认下载目录——现场要的是"存 U 盘还是存桌面"
 * 由站长当场挑，提示还得说清文件到底在哪，点一下就打开。
 *
 * 桌面端：原生「保存」对话框给路径 → `export_write` 落盘（UTF-8 BOM 在后端加）→ 提示里的
 * 路径可点开（`export_open` 走系统关联程序，Excel 双击即为中文；打开动作留在 Rust 侧，
 * 不经 opener 插件给 webview 的那条 `open_path` 命令——它受 ACL 路径白名单管，站长存哪儿
 * 我们事先不知道，白名单只能把「存进 U 盘再当场点开」堵死）。浏览器预览没有文件系统，
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
 * @param piiEntity 只在**导出的列里含身份证号明文**时传（值仓/磅单台账那两处，04 §3.3），
 *   内容是这份 CSV 描述的是哪张表（如 `weigh_order`）。真库 `export_write` 收到它就在文件
 *   落盘之后补一条 `pii.read` 留痕，并且要求此刻有可署名的会话——没有就直接拒掉这次导出。
 *   不传＝普通导出，行为与今天完全一致。浏览器预览没有审计链可写，如实不留痕。
 */
export async function exportCsvFile(opts: {
  /** 文件名（不含扩展名），一般由 `csvName()` 带上日期时间，免得同一天两次导出互相覆盖 */
  filename: string;
  headers: string[];
  rows: CsvCell[][];
  unit?: string;
  piiEntity?: string;
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
    path = await invoke<string>("export_write", { path: picked, content: toCsv(headers, rows), piiEntity: opts.piiEntity });
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
      {/* 含身份证明文的导出：把"这一份要按个人信息件处理"当面说给他听，而不是只在审计页里躺着 */}
      {opts.piiEntity && <span className="block text-xs text-muted-foreground">证号是完整号码，这一份已记入审计，请按个人信息件保管、不要外发</span>}
    </>,
    // 比普通 toast 长：站长要来得及看清路径再点一下
    { duration: 10_000 },
  );
}

async function openFile(path: string) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("export_open", { path });
  } catch (e) {
    toast.error(`打开文件失败：${errText(e, "请到该位置手工打开")}`);
  }
}
