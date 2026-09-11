//! 连接与库文件位置（docs/design/03 §1.2 连接管理、§7 存储位置、§10.4 pragma）
//!
//! 单 `Connection` 挂 `Mutex` 由 Tauri 托管：站点机单用户单磅房，没有并发写，
//! 串行化天然规避锁冲突，也让"事务边界"这件事只有一个地方需要操心。

pub mod migrate;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::Connection;

pub use migrate::{MigrateError, Migration, Report, MIGRATIONS};

/// §7：库文件名。与附件、备份同在 `AppDataDir`，**不得**放安装目录（升级会覆盖）
/// 或 OneDrive 同步目录（会引发文件锁与损坏）。
pub const DB_FILE: &str = "banghe.db";

pub fn db_path(app_dir: &Path) -> PathBuf {
    app_dir.join(DB_FILE)
}

/// §7：迁移前快照与每日备份的目录
pub fn backup_dir(app_dir: &Path) -> PathBuf {
    app_dir.join("backup")
}

/// §10.4 连接级 pragma。`journal_mode` 必须在事务外设置，所以单独成函数、
/// 在打开连接后立刻调用一次。
fn pragma_sql(wal: bool) -> String {
    let head = if wal { "PRAGMA journal_mode=WAL;\n" } else { "" };
    format!(
        "{head}PRAGMA synchronous=NORMAL;
         PRAGMA cache_size=-65536;
         PRAGMA mmap_size=268435456;
         PRAGMA foreign_keys=ON;"
    )
}

pub fn setup_pragmas(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(&pragma_sql(true))?;
    // 与并发的备份/体检读连接抢锁时等 5 秒，而不是立刻把 SQLITE_BUSY 抛给现场
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

/// 测试用：内存库不支持 WAL，其余 pragma 与生产保持一致。
pub fn setup_pragmas_memory(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute_batch(&pragma_sql(false))?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

/// Tauri 托管状态。命令里用 [`Db::conn`] 拿锁，再 `spawn_blocking` 包住耗时读写。
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

impl Db {
    pub fn new(conn: Connection) -> Self {
        Self {
            conn: Arc::new(Mutex::new(conn)),
        }
    }

    /// 取连接锁。迁移失败已中止启动，这里不会再遇到"库没打开"的状态。
    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 复制出连接句柄。命令要把锁搬进 `spawn_blocking` 闭包时用这个，
    /// 而不是 [`Db::conn`]——后者借的是 `&self`，进不了 `'static` 闭包。
    pub fn shared(&self) -> Arc<Mutex<Connection>> {
        self.conn.clone()
    }

    /// §7 WAL 收尾：退出时收敛 `-wal` 文件并更新查询计划统计。
    pub fn checkpoint_wal(&self) {
        let conn = self.conn();
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;");
    }
}

/// 锁内执行一小段。命令侧把连接句柄 [`Db::shared`] 出来、在 `spawn_blocking` 里
/// 分几段取锁时用（argon2 这类重活要在两次取锁之间跑，见 `crate::auth` 模块头）。
pub fn locked<T>(pool: &Arc<Mutex<Connection>>, f: impl FnOnce(&Connection) -> T) -> T {
    let conn = pool.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    f(&conn)
}

/// 打开（必要时创建）站点库并完成启动迁移。
pub fn open_and_migrate(app_dir: &Path, app_version: &str) -> Result<(Db, Report), MigrateError> {
    std::fs::create_dir_all(app_dir)?;
    let mut conn = Connection::open(db_path(app_dir))?;
    setup_pragmas(&conn)?;
    let report = migrate::apply(
        &mut conn,
        app_version,
        Some(&backup_dir(app_dir)),
    )?;
    Ok((Db::new(conn), report))
}

/// 供测试使用：内存库 + 指定脚本清单，不做迁移前备份。
pub fn in_memory_migrated(
    app_version: &str,
    migrations: &'static [Migration],
) -> Result<Connection, MigrateError> {
    let mut conn = Connection::open_in_memory()?;
    setup_pragmas_memory(&conn)?;
    migrate::apply_with(&mut conn, app_version, None, migrations)?;
    Ok(conn)
}
