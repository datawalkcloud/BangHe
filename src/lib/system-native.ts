/**
 * 系统与审计的原生通道（03 §9.21 审计留痕、§7 备份与恢复、02 §非功能指标）。
 *
 * 桌面端 invoke 走真库，浏览器预览回落 mock；备份/恢复/体检这类**只有真库才有意
 * 义**的动作没有 mock 等价物，浏览器里直接拒绝并说明原因，而不是演一遍进度条——
 * 与 `masters-native.ts` 里仓房写入那条处理一致。
 *
 * 返回字段一律 snake_case，与 `src/mock/types.ts` 的既有命名对齐（05 §8：页面零改动）。
 * 命令实现在 `src-tauri/src/system.rs`。
 */
import { runningInTauri } from "@/lib/native";
import { api as mock } from "@/mock/api";
import type { AuditLog } from "@/mock/types";

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw new Error(typeof e === "string" ? e : e instanceof Error ? e.message : `${cmd} 调用失败`);
  }
}

const NO_CHANNEL = "浏览器预览没有原生通道：这一项要落文件系统与 SQLite，只在桌面端可用";

/** 审计行：TS 的 AuditLog 加上真库里的前后值与机器信息（页面按存在与否才展开对比） */
export type AuditRow = AuditLog & {
  actor_id: number | null;
  entity_id: number | null;
  error_msg: string | null;
  session_id: string | null;
  client_info: string | null;
  before_json: string | null;
  after_json: string | null;
};

export interface AuditFilters {
  keyword?: string;
  result?: "ok" | "denied" | "error";
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export interface BackupFile {
  name: string;
  path: string;
  size_bytes: number;
  created_at: string;
  kind: string;
  sha256: string | null;
  sha256_ok: boolean | null;
}

/** 自动备份线程一轮检查的结论：`ok=false` 时 `detail` 就是中文失败原因 */
export interface AutoBackupState {
  ran_at: string;
  ok: boolean;
  detail: string;
}

/** 备份页的整屏状态。参数只从 app_setting 按**库里的真实键名**读；
 *  库里没有的键如实给 null（前端显示"库中未设此参数"），不在前端造默认值。 */
export interface BackupStatus {
  backup_dir: string;
  keep_count: number;
  /** 自动备份间隔（天）与本次运行里线程最近一次检查的结论；null = 还没查过 */
  auto_interval_days: number;
  auto_last: AutoBackupState | null;
  attachment_keep_days: number;
  retention_sample_days: number | null;
  pii_mask_id_card: boolean | null;
  db_path: string;
  db_size_bytes: number;
  wal_size_bytes: number;
  backups: BackupFile[];
  last_backup_at: string | null;
  doc_oldest_date: string | null;
  audit_rows: number;
}

export interface VerifyReport {
  ok: boolean;
  integrity: string;
  sha256_expected: string | null;
  sha256_actual: string;
  sha256_matches: boolean;
  orders: number;
  settlements: number;
  audit_rows: number;
  page_count: number;
}

export interface HealthReport {
  integrity: string;
  integrity_ok: boolean;
  fk_violations: string[];
  db_size_bytes: number;
  wal_size_bytes: number;
  journal_mode: string;
  page_size: number;
  counts: { weigh_order: number; settlement: number; audit_log: number; attachment: number };
  last_backup_at: string | null;
  app_version: string | null;
  schema_version: string | null;
}

export interface Preflight {
  ok: boolean;
  name: string;
  size_bytes: number;
  created_at: string | null;
  integrity: string;
  schema_version: string | null;
  current_schema_version: string | null;
  station_code: string | null;
  station_name: string | null;
  orders: number;
  settlements: number;
  oldest_date: string | null;
  errors: string[];
  warnings: string[];
}

export interface RestoreResult {
  ok: boolean;
  old_db_path: string;
  safety_backup: string;
  restart_required: boolean;
}

/** 恢复必须逐字确认的文案，与 Rust 侧 restore_apply 的校验值同源 */
export const RESTORE_CONFIRM_TEXT = "恢复备份";

export const systemApi = {
  /* -------------------------------------------------------------- 操作审计 */
  /** 筛选全部交给库：关键字命中人名/动作码/单号/事由，日期按业务留痕时间 at 取区间 */
  listAudits: (filters: AuditFilters = {}): Promise<AuditRow[]> => {
    const { keyword = "", result, dateFrom, dateTo, limit } = filters;
    if (!runningInTauri())
      // mock 只认关键字，结果与日期区间在这里补筛：页面上的筛选器在演示模式下
      // 也得真的改变列表，否则"选了被拒绝却纹丝不动"会被当成界面坏了。
      return mock
        .listAudits(keyword)
        .then((rows) =>
          rows.filter(
            (r) =>
              (result == null || r.result === result) &&
              (dateFrom == null || r.at.slice(0, 10) >= dateFrom) &&
              (dateTo == null || r.at.slice(0, 10) <= dateTo),
          ),
        ) as Promise<AuditRow[]>;
    return call<AuditRow[]>("audit_list", {
      filters: { keyword, result: result ?? null, dateFrom: dateFrom ?? null, dateTo: dateTo ?? null, limit: limit ?? null },
    });
  },

  /* ---------------------------------------------------------- 备份与恢复 */
  backupStatus: (): Promise<BackupStatus> =>
    runningInTauri() ? call<BackupStatus>("backup_status") : Promise.reject(new Error(NO_CHANNEL)),
  backupRun: (kind = "manual"): Promise<BackupFile> =>
    runningInTauri() ? call<BackupFile>("backup_run", { input: { kind } }) : Promise.reject(new Error(NO_CHANNEL)),
  backupVerify: (name: string): Promise<VerifyReport> =>
    runningInTauri() ? call<VerifyReport>("backup_verify", { name }) : Promise.reject(new Error(NO_CHANNEL)),
  dbHealth: (): Promise<HealthReport> =>
    runningInTauri() ? call<HealthReport>("db_health") : Promise.reject(new Error(NO_CHANNEL)),
  backupReveal: (): Promise<string> =>
    runningInTauri() ? call<string>("backup_reveal") : Promise.reject(new Error(NO_CHANNEL)),
  /** 把备份目录之外的一份 .db 副本（U 盘 / 移动硬盘）收进备份目录。
   *  落盘后就与本机备份同权：预检、校验、恢复全都走原来那套，没有第二条恢复路径。 */
  backupImport: (path: string): Promise<BackupFile> =>
    runningInTauri() ? call<BackupFile>("backup_import", { input: { path } }) : Promise.reject(new Error(NO_CHANNEL)),
  restorePreflight: (name: string): Promise<Preflight> =>
    runningInTauri() ? call<Preflight>("restore_preflight", { name }) : Promise.reject(new Error(NO_CHANNEL)),
  restoreApply: (name: string, confirm: string): Promise<RestoreResult> =>
    runningInTauri()
      ? call<RestoreResult>("restore_apply", { input: { name, confirm } })
      : Promise.reject(new Error(NO_CHANNEL)),
  restart: (): Promise<void> =>
    runningInTauri() ? call<void>("app_restart") : Promise.reject(new Error(NO_CHANNEL)),
};

export type SystemApi = typeof systemApi;
