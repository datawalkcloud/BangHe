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
//!
//! 还有一条与"覆盖安装"相关的口径：安装包（NSIS 钩子）每次装完会在 AppDataDir 落一个
//! `install.stamp` 记号；启动时记号的修改时间与库内记账不一致、或 `app_meta.app_version`
//! 与当前二进制版本不一致，就视为"覆盖安装后的首次启动"——在做任何写入（含迁移）之前
//! 先 `VACUUM INTO` 一份 `pre_upgrade_` 快照。库文件本体在 AppDataDir，安装器覆盖的是
//! Program Files，真正的风险从来是"新程序第一次开库"，快照钉在那一刻才有退路。

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
    Migration {
        name: "0012_reader_prompt_voice.sql",
        sql: include_str!("migrations/0012_reader_prompt_voice.sql"),
    },
    Migration {
        name: "0013_party_phone_unique.sql",
        sql: include_str!("migrations/0013_party_phone_unique.sql"),
    },
    Migration {
        name: "0014_idle_lock_setting.sql",
        sql: include_str!("migrations/0014_idle_lock_setting.sql"),
    },
    Migration {
        name: "0015_quick_option.sql",
        sql: include_str!("migrations/0015_quick_option.sql"),
    },
    Migration {
        name: "0016_card_auto_register.sql",
        sql: include_str!("migrations/0016_card_auto_register.sql"),
    },
    Migration {
        name: "0017_order_variety_nullable.sql",
        sql: include_str!("migrations/0017_order_variety_nullable.sql"),
    },
    Migration {
        name: "0018_default_warehouse.sql",
        sql: include_str!("migrations/0018_default_warehouse.sql"),
    },
    Migration {
        name: "0019_capture_on_weigh.sql",
        sql: include_str!("migrations/0019_capture_on_weigh.sql"),
    },
    Migration {
        name: "0020_outbound_order.sql",
        sql: include_str!("migrations/0020_outbound_order.sql"),
    },
    Migration {
        name: "0021_stock_movement_outbound.sql",
        sql: include_str!("migrations/0021_stock_movement_outbound.sql"),
    },
    Migration {
        name: "0022_warehouse_opening.sql",
        sql: include_str!("migrations/0022_warehouse_opening.sql"),
    },
    Migration {
        name: "0023_scan_test_input.sql",
        sql: include_str!("migrations/0023_scan_test_input.sql"),
    },
    Migration {
        name: "0024_device_scanner_kind.sql",
        sql: include_str!("migrations/0024_device_scanner_kind.sql"),
    },
    Migration {
        name: "0025_qc_sample_no.sql",
        sql: include_str!("migrations/0025_qc_sample_no.sql"),
    },
    Migration {
        name: "0026_retire_doc_no_prefix.sql",
        sql: include_str!("migrations/0026_retire_doc_no_prefix.sql"),
    },
    Migration {
        name: "0027_qc_labels_to_order.sql",
        sql: include_str!("migrations/0027_qc_labels_to_order.sql"),
    },
    Migration {
        name: "0028_retire_pii_mask_setting.sql",
        sql: include_str!("migrations/0028_retire_pii_mask_setting.sql"),
    },
    Migration {
        name: "0029_outbound_scale_weigh.sql",
        sql: include_str!("migrations/0029_outbound_scale_weigh.sql"),
    },
    Migration {
        name: "0030_print_doc_type_outbound.sql",
        sql: include_str!("migrations/0030_print_doc_type_outbound.sql"),
    },
    Migration {
        name: "0031_raise_attachment_max_kb.sql",
        sql: include_str!("migrations/0031_raise_attachment_max_kb.sql"),
    },
    Migration {
        name: "0032_retire_scale_align_settings.sql",
        sql: include_str!("migrations/0032_retire_scale_align_settings.sql"),
    },
];

/// 需要在**事务外关掉外键**才能跑的脚本，按文件名点名。
///
/// 为什么不做成 `Migration` 的结构体字段：那要改每一个已入库脚本的构造处，而校验和
/// 对的是脚本字节——历史脚本一字都不能动，否则已经应用过它的机器全部 `ChecksumMismatch`
/// 拒启（为一条注释把现场机器锁死是最糟的收场）。名字表放在程序侧，SQL 保持原字节。
///
/// **为什么 `defer_foreign_keys` 不够**（0024 在这台机器上实测，逐句 bisect 定位）：
/// 表重建走的是"建新表 → 搬数据 → `DROP` 旧表 → `RENAME` 回原名"，而 `device_config`
/// 有两张子表带着外键指它（`weigh_record.device_id`、`attachment.source_device_id`）。
/// `PRAGMA defer_foreign_keys=ON` 把检查推迟到 COMMIT，可它记的是 **DROP 那一刻**那笔账：
/// 当时父表已经被删掉，这笔账在 COMMIT 时无论如何对不上——哪怕新表已在同一事务里改回同名、
/// 行 id 一个不差、子表一行悬挂都没有。同一事务里 `PRAGMA foreign_key_check` 查却是空的
/// （它按当前 schema 现算，看不出那笔过期账）。现场表现就是 setup 钩子 panic、程序秒退，
/// 用户只看见"双击没反应"，连一句人话都拿不到。bisect 结果：前 5 句单独提交都过，
/// 第 6 句 `DROP TABLE device_config` 一进事务就必炸。
///
/// 所以这类脚本只能走 SQLite 官方表重建流程的前半条规矩：`PRAGMA foreign_keys=OFF`
/// **必须在 BEGIN 之前**设（事务内它是空操作，0017 头注里记的就是这条坑），跑完开回来。
///
/// 敢关，是因为收尾有人查：[`post_checks`] 在全部迁移跑完后照旧做一遍
/// `PRAGMA foreign_key_check` 体检，真有悬挂引用就中止启动并列出示例行——
/// 关外键只放行"重建期间父表短暂缺席"，不放行把数据搬坏。
///
/// 往这里加名字之前先想清楚：只有"重建被外键指向的表"才需要它。加列、建索引、
/// 灌参数键（0010/0012/0014/0016/0018/0023 那一类）都不必，别顺手把闸门开松。
static FK_OFF_MIGRATIONS: &[&str] = &["0024_device_scanner_kind.sql"];

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
    /// 启动前自动备份（§6 迁移前 / §7 覆盖安装后首启）生成的文件；空库首装时为 None
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
/// `install_marker` 是 `install.stamp` 的修改时间（[`crate::db::install_stamp`]），
/// `None` = 装机记号不存在（开发调试或老安装包），只按版本号判定升级。
pub fn apply(
    conn: &mut Connection,
    app_version: &str,
    install_marker: Option<&str>,
    backup_dir: Option<&Path>,
) -> Result<Report, MigrateError> {
    apply_with(conn, app_version, install_marker, backup_dir, MIGRATIONS)
}

/// 同 [`apply`]，但可指定脚本子集——测试用它模拟"现场停在旧版本、装上新版补跑中间脚本"。
pub fn apply_with(
    conn: &mut Connection,
    app_version: &str,
    install_marker: Option<&str>,
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
    // 升级检测（覆盖安装的第一道闸）：
    //  - 记号新：`install.stamp` 的修改时间与上次消费记账不一致——同版本重装也算；
    //  - 版本变：`app_meta.app_version` 与当前二进制不一致——绿色拷贝、老安装包
    //    （还没带钩子）走这一条。两者都是拿"上次成功启动记下的账"对比，比对发生在
    //    任何写入之前，快照拍到的永远是**旧程序最后一次落库**的状态。
    let stored_version = app_meta_value(conn, "app_version");
    let stored_marker = app_meta_value(conn, "install_stamp_seen");
    let version_changed = stored_version.as_deref().is_some_and(|prev| prev != app_version);
    let fresh_install = install_marker.is_some() && stored_marker.as_deref() != install_marker;
    let snapshot_due = fresh_install || version_changed || !pending.is_empty();
    if backup_dir.is_some() && snapshot_due && has_user_tables(conn)? {
        // §6/§7 启动前自动备份。空库首装没有可回退的东西，跳过。
        // 有待跑脚本时名字保留 pre_migrate（起止结构号是排障要用的信息，
        // 同一份快照已经覆盖"覆盖安装"这件事，不再叠第二份）；
        // 纯换包不动结构的覆盖安装才是 pre_upgrade。
        report.backup_path = Some(if pending.is_empty() {
            pre_upgrade_backup(conn, backup_dir.unwrap(), stored_version.as_deref(), app_version)?
        } else {
            pre_migrate_backup(conn, backup_dir.unwrap(), from_version, target_max)?
        });
    }
    for m in pending {
        apply_one(conn, m, app_version)?;
    }
    // 无论本次有没有跑脚本都要记账：记号消费掉了，下一次启动才不会被同一份
    // install.stamp 再触发一次备份；版本没变的普通重启则只是原地重写同样的值。
    sync_app_meta(conn, app_version, report.to_version, install_marker)?;

    post_checks(conn)?;
    Ok(report)
}

/// `app_meta` 读一个键。表还不存在（首装跑到 0001 之前）或键缺失一律 None。
fn app_meta_value(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_meta WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

fn apply_one(
    conn: &mut Connection,
    m: &Migration,
    app_version: &str,
) -> Result<(), MigrateError> {
    // Immediate：一进迁移就拿写锁，第二个实例并发启动会 SQLITE_BUSY 而不是交错迁移。
    conn.set_transaction_behavior(TransactionBehavior::Immediate);
    if FK_OFF_MIGRATIONS.contains(&m.name) {
        return apply_one_fk_off(conn, m, app_version);
    }
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
    record_applied(&tx, m, app_version).map_err(|e| MigrateError::Failed {
        name: m.name.to_string(),
        reason: format!("写入迁移记录失败：{e}"),
    })?;
    tx.commit()?;
    Ok(())
}

/// 记一条已应用台账。`Transaction` 可 deref 成 `Connection`，两条路共用这一份。
fn record_applied(conn: &Connection, m: &Migration, app_version: &str) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO schema_migration (name, checksum, applied_at, app_version) VALUES (?1, ?2, ?3, ?4)",
        params![m.name, m.checksum(), now_iso(), app_version],
    )
    .map(|_| ())
}

/// 点名过的脚本（表重建那一类）走这条路：外键开关必须在事务**外**设置，
/// 所以这里手工管 `BEGIN`/`COMMIT`，不碰 `conn.transaction()`。
/// 无论脚本成败，`foreign_keys` 都要开回来——这条连接后面就是业务连接，
/// 留着 OFF 等于把整个运行期的外键约束都关了，那比不迁移更坏。
fn apply_one_fk_off(
    conn: &mut Connection,
    m: &Migration,
    app_version: &str,
) -> Result<(), MigrateError> {
    let fail = |e: rusqlite::Error| MigrateError::Failed {
        name: m.name.to_string(),
        reason: e.to_string(),
    };
    conn.execute_batch("PRAGMA foreign_keys=OFF;").map_err(fail)?;
    let ran = (|| -> Result<(), rusqlite::Error> {
        // 与 TransactionBehavior::Immediate 同规：一进迁移就拿写锁
        conn.execute_batch("BEGIN IMMEDIATE;")?;
        match conn.execute_batch(m.sql).and_then(|()| record_applied(conn, m, app_version)) {
            Ok(()) => conn.execute_batch("COMMIT;"),
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    })();
    // 恢复放在闭包外：上面任何一条 return 都不能把外键留在关闭状态
    let restored = conn.execute_batch("PRAGMA foreign_keys=ON;");
    ran.map_err(fail)?;
    restored.map_err(fail)?;
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

/// §6：`backup/pre_migrate_<起>_<止>_<时间>.db`。
fn pre_migrate_backup(
    conn: &Connection,
    backup_dir: &Path,
    from: u32,
    to: u32,
) -> Result<PathBuf, MigrateError> {
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    snapshot_to(conn, backup_dir, format!("pre_migrate_{from:04}_to_{to:04}_{stamp}.db"))
}

/// §7：`backup/pre_upgrade_<旧版>_to_<新版>_<时间>.db`——版本变了；
/// 同版本覆盖安装（只有记号是新的）则记作 `pre_upgrade_<版本>_<时间>.db`。
fn pre_upgrade_backup(
    conn: &Connection,
    backup_dir: &Path,
    prev_version: Option<&str>,
    app_version: &str,
) -> Result<PathBuf, MigrateError> {
    let stamp = Local::now().format("%Y%m%d-%H%M%S");
    let mid = match prev_version {
        Some(prev) if prev != app_version => format!("{prev}_to_{app_version}"),
        _ => app_version.to_string(),
    };
    snapshot_to(conn, backup_dir, format!("pre_upgrade_{mid}_{stamp}.db"))
}

/// 快照落盘的唯一实现：`VACUUM INTO` 自带一致性且不需停写。
fn snapshot_to(conn: &Connection, backup_dir: &Path, name: String) -> Result<PathBuf, MigrateError> {
    std::fs::create_dir_all(backup_dir)
        .map_err(|e| MigrateError::BackupDir(format!("{}：{e}", backup_dir.display())))?;
    let path = backup_dir.join(name);
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

/// 把当前版本写进 §9.1 `app_meta`，供「系统信息」页与多台机器对版本；
/// 顺带消费掉本次启动见过的 `install.stamp` 记号（`install_stamp_seen`），
/// 同一次覆盖安装只备份一次。现在**每次成功启动**都会跑（不再只跟着迁移），
/// 版本没变时就是原地重写同样的值。`app_meta` 还不存在（0001 之前的空库）则跳过。
fn sync_app_meta(
    conn: &Connection,
    app_version: &str,
    to_version: u32,
    install_marker: Option<&str>,
) -> Result<(), rusqlite::Error> {
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
    if let Some(marker) = install_marker {
        conn.execute(
            "INSERT INTO app_meta(key, value) VALUES ('install_stamp_seen', ?1)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![marker],
        )?;
    }
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

/// 启动失败时白捡的一条事实：**库文件头声明的页数与实际大小对不对得上**。
///
/// 现场有过这么一次：程序还开着库，站长用文件管理器把 U 盘拷回来的备份副本整个
/// 盖到 `banghe.db` 上。旧连接的页缓存按自己认下的页数继续往同一个文件里刷，于是
/// 落成一个「头部声明 348 页、文件实际只有 140 页」的半拷贝。SQLite 对此只回一句
/// `database disk image is malformed`——看不出是文件被截断、看不出跟迁移无关、
/// 更看不出该走哪条退路，只能反复双击再反复闪退。
///
/// 所以这里只补一句体检结论，**不改任何判定**：该拒的启动照样拒，只是把拒绝的理由
/// 写得现场能自救。返回 `None` 表示这个文件看不出问题（不打无意义的话）。
pub fn db_file_diagnosis(app_dir: &Path) -> Option<String> {
    use std::io::Read;

    let path = super::db_path(app_dir);
    let size = std::fs::metadata(&path).ok()?.len();
    // 空库首装时文件可能刚建出来（0 字节），那不是"损坏"，没什么可说的
    if size == 0 {
        return None;
    }
    if size < 100 {
        return Some(format!(
            "补充体检：{} 只有 {size} 字节，连 100 字节的库文件头都装不下——这是个空壳或半截文件，\
             不是数据算错，也不是迁移写坏。",
            path.display()
        ));
    }
    let mut head = [0u8; 100];
    std::fs::File::open(&path)
        .ok()?
        .read_exact(&mut head)
        .ok()?;
    if &head[..16] != b"SQLite format 3\0" {
        return Some(format!(
            "补充体检：{} 的文件头不是 SQLite 库（缺少「SQLite format 3」魔数）——被不是库的文件盖掉了。",
            path.display()
        ));
    }
    // 头部口径（SQLite File Format §1.3）：偏移 16 每页字节数（值 1 表示 65536），
    // 偏移 28 数据库页数。两个都是大端。
    let page_size = match u16::from_be_bytes([head[16], head[17]]) {
        1 => 65536,
        n => n as u64,
    };
    let declared = u32::from_be_bytes([head[28], head[29], head[30], head[31]]) as u64;
    let actual = size / page_size;
    if declared <= actual || declared == 0 {
        return None;
    }
    Some(format!(
        "补充体检：{} 的头部声明 {declared} 页（每页 {page_size} 字节，完整应为 {} 字节），\
         实际只有 {size} 字节 ≈ {actual} 页——「库文件被截断，只落了前半份」，\
         不是账算错，也不是这次启动写坏的：程序开着库时用文件拷贝覆盖 banghe.db 就会留下这种东西。\n\
         退路：完整副本都在 backup/ 下（每个都配了同名 .sha256，可先校验）。必须先完全退出本程序，\
         再用「系统 → 恢复备份」把那份副本换回来；手工整份拷贝副本覆盖 banghe.db 也能救，\
         但顺序不能反——先退程序再拷文件，拷完再启动。当前这个半截文件改名留着即可，别删。",
        path.display(),
        declared * page_size
    ))
}

/// 启动失败时把可读提示留在磁盘上——磅房机没有控制台，弹窗也要等 UI 起来才有。
pub fn write_startup_error(app_dir: &Path, err: &MigrateError) {
    let _ = std::fs::create_dir_all(app_dir);
    // 同一段体检既落盘也进 stderr：装机版只看得到文件，`tauri dev` 下的人不必再去翻 AppData。
    let hint = db_file_diagnosis(app_dir);
    if let Some(hint) = &hint {
        eprintln!("[banghe] {hint}");
    }
    let text = format!(
        "[{}] 应用版本 {}\n{err}\n{}请携此文件联系维护人员。数据库文件未被改动（失败已回滚）。\n",
        now_iso(),
        env!("CARGO_PKG_VERSION"),
        match &hint {
            // 有体检结论时前后各留一个空行；没有时保持原有的"错误后空一行"版式
            Some(h) => format!("\n{h}\n\n"),
            None => "\n".to_string(),
        },
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

    /// 造一个只有文件头、没有真实结构的"库文件"，用于体检函数的断言。
    /// 只填 SQLite 头里我们读的三个字段：魔数、每页字节数（偏移 16）、页数（偏移 28）。
    fn fake_db_file(
        app_dir: &Path,
        magic: &[u8; 16],
        page_size: u16,
        declared_pages: u32,
        real_pages: u64,
    ) {
        let mut bytes = vec![0u8; (page_size as u64 * real_pages) as usize];
        bytes[..16].copy_from_slice(magic);
        bytes[16..18].copy_from_slice(&page_size.to_be_bytes());
        bytes[28..32].copy_from_slice(&declared_pages.to_be_bytes());
        std::fs::write(crate::db::db_path(app_dir), &bytes).unwrap();
    }

    fn probe_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "banghe-dbprobe-{tag}-{}-{}",
            std::process::id(),
            Local::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 半拷贝（头部 348 页、文件只有 140 页）必须被点名，且要说清"截断"和退路。
    #[test]
    fn truncated_db_file_is_diagnosed_as_such() {
        let dir = probe_dir("trunc");
        fake_db_file(&dir, b"SQLite format 3\0", 4096, 348, 140);
        let hint = db_file_diagnosis(&dir).unwrap_or_else(|| panic!("截断的库文件应当给出体检结论"));
        for want in ["348", "140", "截断", "backup/", "系统 → 恢复备份", "别删"] {
            assert!(hint.contains(want), "体检结论缺少「{want}」：\n{hint}");
        }
        // 结论必须进 startup_error.log，且排在"请携此文件"之前——现场只会从头往下读
        write_startup_error(&dir, &MigrateError::Integrity("database disk image is malformed".into()));
        let log = std::fs::read_to_string(dir.join("startup_error.log")).unwrap();
        assert!(log.contains("补充体检"), "{log}");
        assert!(
            log.find("补充体检") < log.find("请携此文件"),
            "体检结论应排在结尾致歉语之前：\n{log}"
        );
        // 版式给人看过才作数：--nocapture 时把整段日志打出来
        println!("{log}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 反面：文件自洽（页数对得上）时不许废话——退回这条必须红。
    #[test]
    fn healthy_db_file_gets_no_diagnosis_noise() {
        let dir = probe_dir("ok");
        fake_db_file(&dir, b"SQLite format 3\0", 4096, 140, 140);
        assert_eq!(db_file_diagnosis(&dir), None, "页数对得上就不该编造结论");
        write_startup_error(&dir, &MigrateError::Integrity("别的原因".into()));
        let log = std::fs::read_to_string(dir.join("startup_error.log")).unwrap();
        assert!(!log.contains("补充体检"), "{log}");
        assert!(
            log.contains("别的原因\n\n请携此文件"),
            "没有体检结论时要保持原来的空行版式：\n{log}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 另外两种"一眼假"的文件：被非库文件盖掉、只剩空壳。
    #[test]
    fn wrong_magic_and_stub_file_are_called_out() {
        let dir = probe_dir("magic");
        fake_db_file(&dir, b"NOT-SQLITE-HEAD!", 4096, 2, 2);
        let hint = db_file_diagnosis(&dir).unwrap_or_else(|| panic!("魔数不对必须报出来"));
        assert!(hint.contains("魔数"), "{hint}");

        let dir = probe_dir("stub");
        std::fs::write(crate::db::db_path(&dir), b"tiny-file").unwrap();
        let hint = db_file_diagnosis(&dir).unwrap_or_else(|| panic!("装不下文件头必须报出来"));
        assert!(hint.contains("空壳") || hint.contains("半截"), "{hint}");

        // 库文件根本不存在（首装前的空目录）时不许凭空报错
        let dir = probe_dir("absent");
        assert_eq!(db_file_diagnosis(&dir), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
