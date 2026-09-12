//! 迁移执行器（docs/design/03 §6）
//!
//! 语义与 EF Core 的 `Database.Migrate()` 相同：安装包里内嵌**全部**历史脚本，
//! 库里用 `schema_migration` 表记账，启动时把缺的按序补齐。因此现场从 0.1.3 直接
//! 更到 0.2.0 时会自动补跑中间每个脚本，不存在"漏跑一个语句"这种状态。
//!
//! 三条硬规矩（改这里之前先读）：
//!   1. 每个脚本各自在**单个事务**内执行，DDL 与记账一起提交：任一脚本失败只回滚它自己，
//!      绝不会留下"这一条改了一半、账上没记"的库（`app_meta.schema_version` 同理）。
//!      注意粒度是逐脚本——序号更早的脚本此时已经提交，数据库不保证回到迁移前的原样。
//!   2. 已应用的脚本被改动 → 校验和比对失败，直接拒绝启动。要修数据请新开一个脚本。
//!      校验和按内容算（哈希前 CRLF→LF 归一），换行符差异不算改动。
//!   3. 库结构版本高于本程序能理解的版本 → 拒绝启动并提示从 `backup/` 恢复迁移前快照，
//!      不做任何"忽略未知列"的乐观兜底。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use chrono::{Local, SecondsFormat};
use rusqlite::{params, Connection, TransactionBehavior};
use sha2::{Digest, Sha256};
use thiserror::Error;

/// 一个内嵌的迁移脚本。`name` 必须是 `<四位序号>_<说明>.sql`，按序号顺序执行。
pub struct Migration {
    pub name: &'static str,
    pub sql: &'static str,
}

impl Migration {
    /// 脚本内容 SHA-256，记入 `schema_migration.checksum`。
    ///
    /// 哈希前先把 CRLF 归一成 LF：校验和要对的是**脚本内容**，不是各人机器上的
    /// 检出换行符。`core.autocrlf=true` 的 Windows 机器会把 `.sql` 检出成 CRLF，
    /// 逐字节哈希会让同一份脚本算出两个值，两台「内容完全一样」的机器互相拒启。
    /// 语义与 Flyway 一致——换行差异不算改动；真正的改动照样被拦住
    /// （见 tests/schema_contract.rs 的 tampered_applied_script_refuses_startup
    /// 与 checksum_ignores_line_endings）。
    /// 另一半防线是仓库根的 `.gitattributes`（文本统一 LF 检出），两者都要。
    pub fn checksum(&self) -> String {
        sha256_hex(self.sql.replace("\r\n", "\n").as_bytes())
    }

    /// 按 **CRLF 检出** flavor 算的 SHA-256（先归一再统一换成 `\r\n`）。
    ///
    /// 只用于一处兼容：换行归一之前，`core.autocrlf=true` 的 Windows 机器构建出来的
    /// 程序给老库记的就是这个值。见 [`apply_with`] 里的一次性补记。
    pub fn crlf_checksum(&self) -> String {
        sha256_hex(self.sql.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes())
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let out = h.finalize();
    let mut s = String::with_capacity(64);
    for b in out.iter() {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// 全部迁移。新增 `.sql` 文件必须在这里登记，`tests/schema_contract.rs::
/// every_migration_file_is_registered` 会比对目录，防止"写了脚本忘了注册"。
pub static MIGRATIONS: &[Migration] = &[
    Migration {
        name: "0001_init.sql",
        sql: include_str!("migrations/0001_init.sql"),
    },
    Migration {
        name: "0002_seed.sql",
        sql: include_str!("migrations/0002_seed.sql"),
    },
    Migration {
        name: "0003_seed_superadmin.sql",
        sql: include_str!("migrations/0003_seed_superadmin.sql"),
    },
    Migration {
        name: "0004_fix_station_brand.sql",
        sql: include_str!("migrations/0004_fix_station_brand.sql"),
    },
    Migration {
        name: "0005_fix_view_timezone.sql",
        sql: include_str!("migrations/0005_fix_view_timezone.sql"),
    },
    Migration {
        name: "0006_settings_parity.sql",
        sql: include_str!("migrations/0006_settings_parity.sql"),
    },
    Migration {
        name: "0007_user_preference.sql",
        sql: include_str!("migrations/0007_user_preference.sql"),
    },
    Migration {
        name: "0008_backup_auto_interval.sql",
        sql: include_str!("migrations/0008_backup_auto_interval.sql"),
    },
    Migration {
        name: "0009_ic_flow_card.sql",
        sql: include_str!("migrations/0009_ic_flow_card.sql"),
    },
    Migration {
        name: "0010_card_required_on_create.sql",
        sql: include_str!("migrations/0010_card_required_on_create.sql"),
    },
    Migration {
        name: "0011_retire_print_channel.sql",
        sql: include_str!("migrations/0011_retire_print_channel.sql"),
    },
];

#[derive(Error, Debug)]
pub enum MigrateError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("迁移脚本 {name} 执行失败并已回滚；注意本次运行中更早序号的脚本已经单独提交，数据库并非保持原样——\n请按 schema_migration 台账核对当前实际版本，必要时从 backup/ 下的 pre-migrate 快照恢复：\n{reason}")]
    Failed { name: String, reason: String },
    #[error("已应用的迁移脚本 {name} 与程序内嵌的内容不一致（库内记录 {recorded}，当前 {current}）。\n历史脚本一律不允许修改；需要修正数据请新增一个脚本。")]
    ChecksumMismatch {
        name: String,
        recorded: String,
        current: String,
    },
    #[error("库中记录了本程序不认识的迁移脚本 {name}，说明这台机器的数据库来自更新的版本。请勿继续写入。")]
    UnknownScript { name: String },
    #[error("本机数据库结构版本为 {db}，本程序最高只支持 {app}（疑似降级安装）。\n如需回退：在「系统 → 恢复备份」中选择 backup/ 下的 pre_migrate 快照，恢复前系统会自动备份当前库。")]
    Downgrade { db: u32, app: u32 },
    #[error("迁移后外键体检发现 {count} 条悬挂引用（示例：{sample}）。建表或表重建脚本的外键关系有错，已中止启动。")]
    ForeignKey { count: usize, sample: String },
    #[error("迁移后完整性检查未通过：{0}")]
    Integrity(String),
    #[error("备份目录不可用：{0}")]
    BackupDir(String),
}

/// 一次迁移的结果，供启动日志与「系统信息」页展示。
#[derive(Debug, Clone, Default)]
pub struct Report {
    /// 本次实际执行的脚本名
    pub applied: Vec<String>,
    pub from_version: u32,
    pub to_version: u32,
    /// 迁移前自动备份（§6）生成的文件；空库首装时为 None
    pub backup_path: Option<PathBuf>,
    /// 本次启动做过「换行符兼容补记」的脚本名：内容一字未改，只是老库里记的是
    /// CRLF 检出 flavor 的哈希。正常应当永远为空，非空说明这台机器装过历史构建。
    pub healed: Vec<String>,
}

/// `0007_xxx.sql` → 7
pub fn version_of(name: &str) -> u32 {
    name.split('_').next().unwrap_or("").parse().unwrap_or(0)
}

pub fn max_version(migrations: &[Migration]) -> u32 {
    migrations.iter().map(|m| version_of(m.name)).max().unwrap_or(0)
}

/// §3.2 的 ISO 8601 本地时间 + 偏移，例如 `2026-09-11T15:30:00.123+08:00`
pub fn now_iso() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::Millis, false)
}

pub fn applied_names(conn: &Connection) -> Result<Vec<String>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT name FROM schema_migration ORDER BY name")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

/// 打开库并补齐迁移。`backup_dir` 为 `None` 时跳过迁移前备份（仅测试用）。
pub fn apply(
    conn: &mut Connection,
    app_version: &str,
    backup_dir: Option<&Path>,
) -> Result<Report, MigrateError> {
    apply_with(conn, app_version, backup_dir, MIGRATIONS)
}

/// 同 [`apply`]，但可指定脚本子集——测试用它模拟"现场停在旧版本、装上新版补跑中间脚本"。
pub fn apply_with(
    conn: &mut Connection,
    app_version: &str,
    backup_dir: Option<&Path>,
    migrations: &'static [Migration],
) -> Result<Report, MigrateError> {
    ensure_history_table(conn)?;

    let applied = applied_rows(conn)?;
    let target_max = max_version(migrations);
    let mut healed: Vec<String> = Vec::new();
    for (name, recorded) in &applied {
        let v = version_of(name);
        if v > target_max {
            return Err(MigrateError::Downgrade { db: v, app: target_max });
        }
        match migrations.iter().find(|m| m.name == name.as_str()) {
            None => return Err(MigrateError::UnknownScript { name: name.clone() }),
            Some(m) => {
                let current = m.checksum();
                if current != *recorded {
                    // 一次性兼容：换行归一之前，Windows `core.autocrlf=true` 的机器构建出来的
                    // 程序给老库记的是「脚本按 CRLF 检出时」的哈希。这个值能对上，说明脚本
                    // 内容一字未改、只是检出换行不同，就地补记成规范值继续启动；
                    // 对不上才是要拦的改动。
                    if m.crlf_checksum() == *recorded {
                        conn.execute(
                            "UPDATE schema_migration SET checksum = ?1 WHERE name = ?2",
                            params![current, name],
                        )?;
                        healed.push(name.clone());
                    } else {
                        return Err(MigrateError::ChecksumMismatch {
                            name: name.clone(),
                            recorded: recorded.clone(),
                            current,
                        });
                    }
                }
            }
        }
    }

    let seen: BTreeSet<&str> = applied.iter().map(|(n, _)| n.as_str()).collect();
    let mut pending: Vec<&Migration> = migrations
        .iter()
        .filter(|m| !seen.contains(m.name))
        .collect();
    pending.sort_by_key(|m| version_of(m.name));

    let from_version = applied.iter().map(|(n, _)| version_of(n)).max().unwrap_or(0);
    let report = Report {
        applied: pending.iter().map(|m| m.name.to_string()).collect(),
        from_version,
        to_version: target_max,
        backup_path: None,
        healed,
    };

    let mut report = report;
    if !pending.is_empty() {
        // §6 迁移前自动备份。空库首装没有可回退的东西，跳过。
        if backup_dir.is_some() && has_user_tables(conn)? {
            report.backup_path =
                Some(pre_migrate_backup(conn, backup_dir.unwrap(), from_version, target_max)?);
        }
        for m in pending {
            apply_one(conn, m, app_version)?;
        }
        sync_app_meta(conn, app_version, report.to_version)?;
    }

    post_checks(conn)?;
    Ok(report)
}

fn apply_one(
    conn: &mut Connection,
    m: &Migration,
    app_version: &str,
) -> Result<(), MigrateError> {
    // Immediate：一进迁移就拿写锁，第二个实例并发启动会 SQLITE_BUSY 而不是交错迁移。
    conn.set_transaction_behavior(TransactionBehavior::Immediate);
    let tx = conn.transaction().map_err(|e| MigrateError::Failed {
        name: m.name.to_string(),
        reason: e.to_string(),
    })?;
    if let Err(e) = tx.execute_batch(m.sql) {
        // tx 在此被 drop → 自动 ROLLBACK，脚本要么全成要么全无
        return Err(MigrateError::Failed {
            name: m.name.to_string(),
            reason: e.to_string(),
        });
    }
    tx.execute(
        "INSERT INTO schema_migration (name, checksum, applied_at, app_version) VALUES (?1, ?2, ?3, ?4)",
        params![m.name, m.checksum(), now_iso(), app_version],
    )
    .map_err(|e| MigrateError::Failed {
        name: m.name.to_string(),
        reason: format!("写入迁移记录失败：{e}"),
    })?;
    tx.commit()?;
    Ok(())
}

fn ensure_history_table(conn: &Connection) -> Result<(), rusqlite::Error> {
    // 独立于迁移事务提交：否则某个脚本失败回滚后，连"跑到哪一号"的账也会一起消失
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migration (
            name        TEXT NOT NULL PRIMARY KEY,
            checksum    TEXT NOT NULL,
            applied_at  TEXT NOT NULL,
            app_version TEXT NOT NULL
         );",
    )
}

fn applied_rows(conn: &Connection) -> Result<Vec<(String, String)>, rusqlite::Error> {
    let mut stmt = conn.prepare("SELECT name, checksum FROM schema_migration ORDER BY name")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    rows.collect()
}

fn has_user_tables(conn: &Connection) -> Result<bool, rusqlite::Error> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migration'",
        [],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// §6：`backup/pre_migrate_<起>_<止>_<时间>.db`。VACUUM INTO 自带一致性且不需停写。
fn pre_migrate_backup(
    conn: &Connection,
    backup_dir: &Path,
    from: u32,
    to: u32,
) -> Result<PathBuf, MigrateError> {
    std::fs::create_dir_all(backup_dir)
        .map_err(|e| MigrateError::BackupDir(format!("{}：{e}", backup_dir.display())))?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let path = backup_dir.join(format!("pre_migrate_{from:04}_to_{to:04}_{stamp}.db"));
    if path.exists() {
        return Err(MigrateError::BackupDir(format!(
            "备份文件已存在：{}",
            path.display()
        )));
    }
    // 路径作为字符串字面量拼接（SQL 里单引号转义为两个单引号；Windows 反斜杠在
    // SQLite 字面量中不是转义符，可原样保留）。VACUUM INTO 不能在事务内执行。
    let lit = path.display().to_string().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{lit}';"))?;
    if !path.exists() {
        return Err(MigrateError::BackupDir(format!(
            "VACUUM INTO 未生成备份文件：{}",
            path.display()
        )));
    }
    Ok(path)
}

/// 把当前版本写进 §9.1 `app_meta`，供「系统信息」页与多台机器对版本。
fn sync_app_meta(conn: &Connection, app_version: &str, to_version: u32) -> Result<(), rusqlite::Error> {
    let exists: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='app_meta'",
        [],
        |r| r.get(0),
    )?;
    if exists == 0 {
        return Ok(());
    }
    let version = to_version.to_string();
    conn.execute_batch(
        "INSERT INTO app_meta(key, value) VALUES ('schema_version', '0')
            ON CONFLICT(key) DO NOTHING;",
    )?;
    conn.execute(
        "UPDATE app_meta SET value = ?1 WHERE key = 'schema_version'",
        params![version],
    )?;
    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES ('app_version', ?1)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![app_version],
    )?;
    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES ('installed_at', ?1)
            ON CONFLICT(key) DO NOTHING",
        params![now_iso()],
    )?;
    Ok(())
}

/// 迁移收尾体检（AGENTS.md 里 EF 影子外键事故的 SQLite 版守卫）：
/// 悬挂外键与页完整性问题必须在启动时炸出来，而不是等现场点打印才发现。
fn post_checks(conn: &Connection) -> Result<(), MigrateError> {
    // 注意用 PRAGMA 语句而不是 `SELECT ... FROM foreign_key_check`：后者需要
    // SQLITE_INTROSPECTION_PRAGMAS 编译开关，rusqlite 的 bundled 构建默认没开。
    let mut stmt = conn.prepare("PRAGMA foreign_key_check")?;
    let rows: Vec<(String, i64, String)> = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<Result<_, _>>()?;
    if !rows.is_empty() {
        let sample = rows
            .iter()
            .take(3)
            .map(|(t, id, p)| format!("{t}(rowid {id}) → {p}"))
            .collect::<Vec<_>>()
            .join("；");
        return Err(MigrateError::ForeignKey {
            count: rows.len(),
            sample,
        });
    }
    let ok: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if ok != "ok" {
        return Err(MigrateError::Integrity(ok));
    }
    Ok(())
}

/// 启动失败时把可读提示留在磁盘上——磅房机没有控制台，弹窗也要等 UI 起来才有。
pub fn write_startup_error(app_dir: &Path, err: &MigrateError) {
    let _ = std::fs::create_dir_all(app_dir);
    let text = format!(
        "[{}] 应用版本 {}\n{err}\n\n请携此文件联系维护人员。数据库文件未被改动（失败已回滚）。\n",
        now_iso(),
        env!("CARGO_PKG_VERSION")
    );
    let path = app_dir.join("startup_error.log");
    match std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        Ok(mut f) => {
            use std::io::Write;
            let _ = f.write_all(text.as_bytes());
        }
        Err(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsed_from_file_name() {
        assert_eq!(version_of("0001_init.sql"), 1);
        assert_eq!(version_of("0042_add_slot.sql"), 42);
        assert_eq!(version_of("init.sql"), 0);
    }

    #[test]
    fn checksum_is_stable_and_sensitive() {
        let a = Migration { name: "x.sql", sql: "SELECT 1;" };
        let b = Migration { name: "x.sql", sql: "SELECT 2;" };
        assert_eq!(a.checksum(), a.checksum());
        assert_ne!(a.checksum(), b.checksum());
        assert_eq!(a.checksum().len(), 64);
    }

    #[test]
    fn now_iso_carries_local_offset() {
        let s = now_iso();
        // §3.2：形如 2026-09-11T15:30:00.123+08:00
        let time_part = s.split('T').nth(1).unwrap_or_else(|| panic!("缺少 T 分隔：{s}"));
        let offset_pos = time_part
            .rfind(['+', '-'])
            .unwrap_or_else(|| panic!("未带时区偏移：{s}"));
        assert_eq!(
            time_part[offset_pos..].chars().count(),
            6,
            "偏移应形如 +08:00：{s}"
        );
        assert!(
            time_part[..offset_pos].contains(':'),
            "偏移之前应是时分秒：{s}"
        );
    }
}
