//! 系统与审计页的真实现（03 §9.21 留痕、§7 存储位置、02 §非功能指标「备份保留 30 份」）
//!
//! 这个文件存在的理由：页面原来两个 tab 演的是假动作——审计列表来自 mock 数组，
//! 「手动备份 / 校验 / 恢复 / 体检」几个按钮是灰的，因为**背后没有接口**。而备份与
//! 恢复恰恰是整个应用里唯二会直接碰磁盘上库文件本身的操作：打印机坏了明天还能收粮，
//! 备份做错了当天的粮款就找不回来。所以这里的代码全部按"真文件、真字节、真删除"
//! 的口径写，宁可拒绝也不能假装成功。
//!
//! **备份与恢复属不可逆动作，顺序即安全措施**（`restore_apply` 是主线）：
//!  1. 预检全程只读——先证明"这个副本确实能用、确实是这台站点的库"再动手；
//!  2. 换库前**强制**先生成一份当前库的 `pre-restore` 副本，这一步失败就直接中止：
//!     没有退路的换库等于赌博；
//!  3. 旧库一律**改名保留**（`banghe.db.old-<时间戳>`），绝不删除。改错了还能改回来；
//!  4. 换完库不自动重启，只回 `restart_required`——现场可能还有单没录完，
//!     重启必须由站长在界面上确认（`app_restart` 另外要求"本次运行确实恢复成功过"）。
//!
//! 本轮补上的两个缺口（都来自"备份做错了当天的粮款就找不回来"这一条）：
//!  - **自动备份**：01 §数据留存承诺过"自动备份"，而此前备份只有三个触发点——手动按钮、
//!    迁移前、恢复前。站长连续几周不点按钮，磁盘上就一份副本都没有。现在起由 `lib.rs` 起的
//!    守护线程每小时查一次，超过 `backup_auto_interval_days`（缺省 1 天）没有新副本就补一份
//!    `kind = auto`。无人值守时没有登录人，留痕的 `actor_id` 如实留 NULL、名字写"系统自动"
//!    （与 `authorized_by` 那条同口径：不拿 0 冒充一个不存在的人）。
//!  - **从备份目录之外导入副本**：现场把副本拷去 U 盘之后，**拷回来恢复**曾经做不到——
//!    [`resolve_backup`] 拒绝任何路径分隔符，页面只能列 `backup_dir` 里的名字。新增
//!    [`import_backup`]：认一个绝对路径，验完校验和再落进备份目录，之后走的就是原来那条
//!    预检 + 换库路径。zip 副本仍不支持（解压缩包要引新依赖，且解压面本身是新攻击面）。
//!
//! 其它几条与页面口径相关的取舍：
//!  - **审计页只读不设岗**：留痕的意义是"谁都能查"，viewer 也看得着；写入侧的岗位
//!    闸门在 [`crate::orders`] / [`crate::masters`] 那边，这里不重复判。
//!  - **`authorized_by` 回人名不回 id**：§9.21 该列是 `user_account` 外键（整数），
//!    前端那一列直接渲染字符串，所以查询里 LEFT JOIN 出 `display_name`。授权人被删时
//!    如实为 null——宁可显示"—"，也不拿 id 冒充一个不存在的人。
//!  - **站点参数只从 `app_setting` 读，读不到就回 null，不造默认值**：
//!    `retention_sample_days`（留样天数）与 `pii_mask_id_card`（界面掩码）到 0006 才补进
//!    `app_setting`。规则不是"这两个键没有"，而是**键不在就如实回 null**：库里被恢复成
//!    0006 之前的老副本、或站长自己删过参数行时，界面要显示"库中未设此参数"，而不是由
//!    后端塞一个 30 天 / 开启——合规自查那一栏等于替站长签了字。同理 `keep_count` 这类
//!    有历史默认值的键走 `setting_int`，缺失才回退到 0002 种的那个值。
//!  - **业务失败回中文人话短句**：`UNIQUE constraint failed` / `disk I/O error` 对站长
//!    没有意义，前端把字符串直接当 Error.message 弹（见 `src/lib/system-native.ts`）。
//!  - **备份名是注入面**：`kind` 只放行 `[a-z0-9_-]`，`name` 拒绝任何路径分隔符与 `..`，
//!    拼完再确认结果仍在备份目录内——被篡改的入参最多毁掉一个副本，不能顺带读走
//!    `AppData` 里的别的东西。
//!  - **时间一律用文件名与 mtime，不碰 SQL 的日期函数**：`at` 落库是带 +08:00 的本地时间，
//!    `date()` 会先折算 UTC 再取日，跨零点那几小时的留痕会被归到前一天（0005 迁移修过的
//!    同一个坑），所以区间筛选用 `substr(at, 1, 10)` 逐字比。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::{DateTime, Local, SecondsFormat};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::auth::{self, AuthProfile};
use crate::db::{self, Db};

type Pool = Arc<Mutex<Connection>>;

/// 备份保留数下限：`backup_keep_count` 被填成 0 时不能把用户的副本清空。
const KEEP_FLOOR: i64 = 1;
/// 审计列表默认条数与上限（页面一次拉完，避免"看着有、翻页就丢了"）
const AUDIT_LIMIT_DEFAULT: i64 = 300;
const AUDIT_LIMIT_MAX: i64 = 2000;
/// 体检最多列几条悬挂外键——现场要的是"有没有、示例是哪些"，不是全量清单
const FK_SAMPLE_MAX: usize = 50;
/// 库文件名后缀（WAL 边文件要跟着一起改名，否则新库会读到上一次会话的 -wal）
const WAL_SUFFIX: &str = "-wal";
const SHM_SUFFIX: &str = "-shm";

/// 手动备份与恢复预检的岗位（05 §6.1 `backup.restore`；其余岗位提示找站长）。
pub const BACKUP_ROLES: &[&str] = &["station_master", "cashier"];
/// 换库与重启：只有站长。
pub const RESTORE_ROLES: &[&str] = &["station_master"];
/// 恢复命令要求逐字确认的文案，与 `src/lib/system-native.ts` 的 `RESTORE_CONFIRM_TEXT` 同源。
const RESTORE_CONFIRM_TEXT: &str = "恢复备份";
/// 自动备份间隔（天）。这个键**没有种子**：`app_setting` 里有就照它跑，没有按
/// [`AUTO_BACKUP_INTERVAL_DEFAULT`] 跑——自动备份是兜底能力，默认开着比等站长建键有用。
const AUTO_BACKUP_INTERVAL_KEY: &str = "backup_auto_interval_days";
const AUTO_BACKUP_INTERVAL_DEFAULT: i64 = 1;
/// 守护线程的轮询粒度。到期判定只看文件名时间戳，一小时一次的成本是一次 read_dir。
const AUTO_BACKUP_POLL_SECS: u64 = 3600;
/// 无人值守动作的留痕主体：`actor_id` 留 NULL，名字如实写这个，不冒充任何真实账号。
pub const SYSTEM_ACTOR_NAME: &str = "系统自动";

/// 本进程是否刚成功换过库。[`app_restart`] 用它挡"顺手重启一下"——磅房里重启一次
/// 就可能丢一张正在录的单，这个按钮只属于恢复向导的最后一步。
static RESTORE_DONE: AtomicBool = AtomicBool::new(false);

// ------------------------------------------------------------------ 入参清洗

/// 备份类型直接进文件名：只放行 `[a-z0-9_-]`，别的一律拒绝而不是悄悄改写——
/// 静默改写会让界面显示的 kind 和磁盘上的文件对不上。
fn check_kind(kind: &str) -> Result<String, String> {
    let k = kind.trim().to_ascii_lowercase();
    if k.is_empty() {
        return Ok("manual".to_string());
    }
    if k.len() > 24 {
        return Err("备份类型太长了，不超过 24 个字符".into());
    }
    let head_ok = k.chars().next().is_some_and(|c| c.is_ascii_alphanumeric());
    let body_ok = k
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if !head_ok || !body_ok {
        return Err(format!(
            "备份类型「{kind}」不合法：只能用英文小写字母、数字、下划线与短横线"
        ));
    }
    Ok(k)
}

/// 备份时间戳：`YYYYMMDD-HHMMSS`。命令层用真实时间，测试传合成值以免同秒重名。
fn stamp_now() -> String {
    Local::now().format("%Y%m%d-%H%M%S").to_string()
}

fn check_stamp(stamp: &str) -> Result<(), String> {
    let b = stamp.as_bytes();
    let ok = b.len() == 15
        && b.iter().enumerate().all(|(i, c)| if i == 8 { *c == b'-' } else { c.is_ascii_digit() });
    if ok {
        Ok(())
    } else {
        Err("备份时间戳格式不对（由系统生成，请勿手工传）".into())
    }
}

/// 备份文件名 → 磁盘路径。这是**唯一**的入参清洗点：页面传回的名字直接参与拼路径。
fn resolve_backup(backup_dir: &Path, name: &str) -> Result<PathBuf, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("请先在备份列表里选中一个副本".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains(':') {
        return Err("备份文件名不合法：不能包含路径分隔符或 ..".into());
    }
    if !name.ends_with(".db") {
        return Err("只能校验或恢复 .db 备份文件".into());
    }
    let path = backup_dir.join(name);
    // 拼完再确认一次仍在备份目录内：分隔符校验已经拦住了绝大多数花样，
    // 这一条是防"文件名里塞了别的写法"（如尾随点、平台保留名）绕出去。
    if path.parent().map(|p| p != backup_dir).unwrap_or(true) {
        return Err("备份文件名不合法：落在备份目录之外".into());
    }
    if !path.is_file() {
        return Err(format!(
            "备份文件不存在，可能已被淘汰或不在本机：{name}（备份目录 {}）",
            display(backup_dir)
        ));
    }
    Ok(path)
}

// ------------------------------------------------------------------ 连接与岗位

fn pool_of(app: &AppHandle) -> Result<Pool, String> {
    app.try_state::<Db>()
        .map(|d| d.shared())
        .ok_or_else(|| "数据库尚未就绪（启动迁移未完成）".to_string())
}

fn now_iso() -> String {
    crate::db::migrate::now_iso()
}

fn locations(app: &AppHandle) -> Result<Locations, String> {
    app.path()
        .app_data_dir()
        .map(Locations::new)
        .map_err(|e| format!("取不到应用数据目录：{e}"))
}

/// 当前登录人（不判岗位）。
fn actor(app: &AppHandle) -> Result<AuthProfile, String> {
    auth::current_actor(app).ok_or_else(|| "登录已失效，请重新登录后再继续".to_string())
}

/// 岗位闸门。抽成纯函数是因为命令层要 `AppHandle` 才拿得到会话，测试没法直接跑命令；
/// 但"磅房岗能不能恢复数据库"这条边界必须被钉住，所以让它只依赖 [`AuthProfile`]。
pub fn check_role(actor: &AuthProfile, roles: &[&str], what: &str) -> Result<(), String> {
    if actor.must_change_pwd {
        return Err("当前账号尚未完成首登改密，不能进行备份与恢复".into());
    }
    if !roles.contains(&actor.role.as_str()) {
        return Err(format!(
            "岗位「{}」无权{what}，需要：{}",
            actor.role,
            roles.join(" / ")
        ));
    }
    Ok(())
}

fn actor_with_roles(app: &AppHandle, roles: &[&str], what: &str) -> Result<AuthProfile, String> {
    let actor = actor(app)?;
    check_role(&actor, roles, what)?;
    Ok(actor)
}

/// 留痕主体的最小投影。[`create_backup`] 有两个调用方——命令层（有登录人）与自动备份
/// 线程（没有）——与其把 actor 参数做成 `Option<&AuthProfile>` 让每个调用点自己拆字段，
/// 不如在这里一次说清"这次动磁盘的是谁"。`From<&AuthProfile>` 让既有调用点原样编译。
#[derive(Debug, Clone)]
pub struct ActorRef {
    pub id: Option<i64>,
    pub name: String,
}

impl ActorRef {
    /// 无人值守：`actor_id` 留 NULL，名字写"系统自动"。
    pub fn system() -> Self {
        Self { id: None, name: SYSTEM_ACTOR_NAME.to_string() }
    }
}

impl From<&AuthProfile> for ActorRef {
    fn from(a: &AuthProfile) -> Self {
        Self { id: Some(a.id), name: a.display_name.clone() }
    }
}

// -------------------------------------------------------------------- 留痕写入
// 与 [`crate::orders`] 的 audit() 同一条 INSERT、同一套取舍：写失败只打 stderr，
// 不回滚已经成功的业务动作（备份文件已经在磁盘上了，不能因为一条审计把它说成失败）。
// 唯一例外是 [`apply_restore`] 里换库之后的那条——那里用 try_audit，失败要原样上报。

fn client_info() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "未知机器".into());
    format!("{host} / banghe {}", env!("CARGO_PKG_VERSION"))
}

/// 一条留痕的落库动作。**没有登录人时 actor_id 就是 NULL**（见 [`SYSTEM_ACTOR_NAME`]），
/// 不拿 0 或某个真实账号顶名。
fn audit_row(
    conn: &Connection,
    actor_id: Option<i64>,
    actor_name: &str,
    action: &str,
    entity: &str,
    entity_no: &str,
    reason: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_no, reason, result, client_info)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ok', ?8)",
        params![now_iso(), actor_id, actor_name, action, entity, entity_no, reason, client_info()],
    )
    .map(|_| ())
    .map_err(|e| format!("{action} 的审计写入失败：{e}"))
}

fn try_audit(
    conn: &Connection,
    actor: &AuthProfile,
    action: &str,
    entity: &str,
    entity_no: &str,
    reason: &str,
) -> Result<(), String> {
    audit_row(conn, Some(actor.id), &actor.display_name, action, entity, entity_no, reason)
}

fn audit(conn: &Connection, actor: &ActorRef, action: &str, entity: &str, entity_no: &str, reason: &str) {
    if let Err(e) = audit_row(conn, actor.id, &actor.name, action, entity, entity_no, reason) {
        eprintln!("[banghe] {e}（{entity} {entity_no}）");
    }
}

// -------------------------------------------------------------------- 站点参数
// value_json 是 JSON 串（§9.3）。缺键与键在但类型不对一律回 None：这两种情况在
// 合规自查里是同一件事——"这台机器没配过它"，编个默认值等于替站长签字。

fn setting_raw(conn: &Connection, key: &str) -> Option<serde_json::Value> {
    conn.query_row("SELECT value_json FROM app_setting WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
}

fn setting_int(conn: &Connection, key: &str, default: i64) -> i64 {
    setting_raw(conn, key).and_then(|v| v.as_i64()).unwrap_or(default)
}

fn setting_opt_int(conn: &Connection, key: &str) -> Option<i64> {
    setting_raw(conn, key).and_then(|v| v.as_i64())
}

fn setting_opt_bool(conn: &Connection, key: &str) -> Option<bool> {
    setting_raw(conn, key).and_then(|v| v.as_bool())
}

fn meta_value(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_meta WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
}

// ------------------------------------------------------------------ 文件位置

/// 库文件与备份目录的位置。`app_dir` 线上来自 `AppHandle::path().app_data_dir()`，
/// 测试里换成临时目录就能跑同一套代码（备份/恢复本质是文件操作，必须能真跑）。
#[derive(Debug, Clone)]
pub struct Locations {
    pub app_dir: PathBuf,
}

impl Locations {
    pub fn new(app_dir: impl Into<PathBuf>) -> Self {
        Self { app_dir: app_dir.into() }
    }

    pub fn db_path(&self) -> PathBuf {
        db::db_path(&self.app_dir)
    }

    fn side(&self, suffix: &str) -> PathBuf {
        PathBuf::from(format!("{}{suffix}", self.db_path().display()))
    }

    /// §9.3 的 `backup_dir` 键允许把备份指到别处（现场要拷 U 盘）。空串 = AppDataDir/backup。
    /// 这个键一直躺在种子数据里没人消费，界面上"备份目录"因此是句假话，这里接上；
    /// 只认绝对路径，相对路径会被解释成进程工作目录——那不在任何人预期里。
    pub fn backup_dir(&self, conn: &Connection) -> PathBuf {
        let raw = setting_raw(conn, "backup_dir")
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let p = Path::new(trimmed);
            if p.is_absolute() {
                return p.to_path_buf();
            }
            eprintln!("[banghe] 参数 backup_dir「{trimmed}」不是绝对路径，已忽略并回用默认目录");
        }
        db::backup_dir(&self.app_dir)
    }

    pub fn data_bytes(&self) -> i64 {
        file_size(&self.db_path())
    }

    pub fn wal_bytes(&self) -> i64 {
        file_size(&self.side(WAL_SUFFIX))
    }
}

fn file_size(path: &Path) -> i64 {
    std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0)
}

fn display(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// 文件系统时间 → §3.2 的 ISO 本地时间带偏移。备份列表按它排序、页面按它显示。
/// 取 mtime 而不是创建时间：跨机器拷贝历史副本时创建时间会变成"拷贝那一刻"，
/// 排序就乱了；mtime 至少跟着数据本身走。
fn mtime_iso(path: &Path) -> Option<String> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(|t| DateTime::<Local>::from(t).to_rfc3339_opts(SecondsFormat::Millis, false))
}

/// 流式 SHA-256：几十 MB 的库文件不能整读进内存（磅房机常年代用，内存留给 UI）。
pub fn sha256_of(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).map_err(|e| format!("读取备份文件失败：{e}"))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("读取备份文件失败：{e}"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// `xxx.db` 的校验和旁文件 `xxx.db.sha256`。缺文件或内容不像哈希一律回 None（无从判定）。
fn sidecar_path(db: &Path) -> PathBuf {
    PathBuf::from(format!("{}.sha256", db.display()))
}

fn read_sidecar(db: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(sidecar_path(db)).ok()?;
    let token = raw.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
    if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(token)
    } else {
        None
    }
}

fn write_sidecar(db: &Path, hex: &str) -> Result<(), String> {
    std::fs::write(sidecar_path(db), format!("{hex}\n")).map_err(|e| format!("写入校验和文件失败：{e}"))
}

/// 副本的"类型"：`banghe_<时间>_<kind>.db` 取尾段，`pre_migrate_*` 取头段。纯展示用
/// （页面按它给个"手动 / 迁移前 / 恢复前"标签），认不出来就退回文件名主干。
pub fn kind_of(name: &str) -> String {
    let stem = name.trim_end_matches(".db");
    if let Some(rest) = stem.strip_prefix("banghe_") {
        // banghe_20260912-083011_manual → manual
        if let Some(idx) = rest.find('_') {
            return rest[idx + 1..].to_string();
        }
    } else if let Some(idx) = stem.find('_') {
        return stem[..idx].to_string();
    }
    stem.to_string()
}

/// 只读打开副本。**必须只读**：校验与预检的意义就是"不碰它地证明它能用"，
/// 顺手写一笔就把待恢复的副本改脏了，退路也就不成立了。
fn open_copy_read_only(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法以只读方式打开副本：{e}"))
}

// -------------------------------------------------------------------- 输出结构
// 字段名与 `src/lib/system-native.ts` 逐字一致（05 §8：页面零改动）。

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AuditRow {
    pub id: i64,
    pub at: String,
    pub actor_id: Option<i64>,
    pub actor_name: String,
    pub action: String,
    pub entity: String,
    pub entity_id: Option<i64>,
    pub entity_no: Option<String>,
    pub reason: Option<String>,
    /// 授权人**姓名**（§9.21 存的是 id，页面这一列直接显示人名）；无人授权为 null
    pub authorized_by: Option<String>,
    pub result: String,
    pub error_msg: Option<String>,
    pub session_id: Option<String>,
    pub client_info: Option<String>,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AuditFilters {
    pub keyword: Option<String>,
    pub result: Option<String>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BackupFile {
    pub name: String,
    pub path: String,
    pub size_bytes: i64,
    /// 文件系统时间（ISO 本地时间带偏移）
    pub created_at: String,
    /// 旁文件里记的值；没有旁文件 = null
    pub sha256: Option<String>,
    /// 旁文件与实算值是否一致；无旁文件时 null = 无从判定
    pub sha256_ok: Option<bool>,
    pub kind: String,
    /// 下面两项只有 [`backup_run`] 的回执会带（历史副本列表里整字段缺席）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pruned: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prune_error: Option<String>,
}

/// 自动备份线程一次检查的结果。放在进程内静态变量里而不是库里：它说的是"这台机器
/// 上的线程最近跑没跑、有没有报错"，换库或拷走备份目录都不该把它一起带过去。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AutoBackupState {
    pub ran_at: String,
    pub ok: bool,
    /// 成功：副本名或"未到间隔"；失败：中文原因，页面照原样显示
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct BackupStatus {
    pub backup_dir: String,
    pub keep_count: i64,
    /// 自动备份间隔（天）与守护线程上次检查的结果。`auto_last` 为 null = 本次运行还没查过。
    pub auto_interval_days: i64,
    pub auto_last: Option<AutoBackupState>,
    pub attachment_keep_days: i64,
    /// 0006 起 `app_setting` 里有这两个键（留样 30 天 / 掩码开启），值原样从库里取；
    /// 规则是**键真不在才回 null**，代码不替站长兜一个合规默认值
    pub retention_sample_days: Option<i64>,
    pub pii_mask_id_card: Option<bool>,
    pub db_path: String,
    pub db_size_bytes: i64,
    pub wal_size_bytes: i64,
    pub backups: Vec<BackupFile>,
    pub last_backup_at: Option<String>,
    pub doc_oldest_date: Option<String>,
    pub audit_rows: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct VerifyReport {
    pub ok: bool,
    pub integrity: String,
    pub sha256_expected: Option<String>,
    pub sha256_actual: String,
    pub sha256_matches: bool,
    pub orders: i64,
    pub settlements: i64,
    pub audit_rows: i64,
    pub page_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HealthCounts {
    pub weigh_order: i64,
    pub settlement: i64,
    pub audit_log: i64,
    pub attachment: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct HealthReport {
    pub integrity: String,
    pub integrity_ok: bool,
    pub fk_violations: Vec<String>,
    pub db_size_bytes: i64,
    pub wal_size_bytes: i64,
    pub journal_mode: String,
    pub page_size: i64,
    pub counts: HealthCounts,
    pub last_backup_at: Option<String>,
    pub app_version: Option<String>,
    pub schema_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Preflight {
    pub ok: bool,
    pub name: String,
    pub size_bytes: i64,
    pub created_at: Option<String>,
    pub integrity: String,
    pub schema_version: Option<String>,
    pub current_schema_version: Option<String>,
    pub station_code: Option<String>,
    pub station_name: Option<String>,
    pub orders: i64,
    pub settlements: i64,
    pub oldest_date: Option<String>,
    /// TS 里暂未消费，但"最晚业务日期"是恢复前必须让人看见的事实（换库会丢掉这之后的单）
    pub newest_date: Option<String>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct RestoreResult {
    pub ok: bool,
    pub old_db_path: String,
    pub safety_backup: String,
    pub restart_required: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupRunInput {
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RestoreApplyInput {
    pub name: Option<String>,
    pub confirm: Option<String>,
}

/// 导入外部副本的入参。`path` 是站长在文件选择框里挑中的**绝对路径**，
/// 清洗与落盘规则见 [`check_source`] 与 [`import_backup`]。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupImportInput {
    pub path: Option<String>,
}

// ------------------------------------------------------------------- 审计查询

pub fn list_audit(conn: &Connection, filters: &AuditFilters) -> Result<Vec<AuditRow>, String> {
    let kw = filters
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "all")
        .map(str::to_ascii_lowercase);
    // 结果值域与 §9.21 的 CHECK 一致；'all'/空 = 不筛（页面下拉框会传 "all"）
    let result = match filters.result.as_deref().map(str::trim) {
        None | Some("") | Some("all") => None,
        Some(r @ ("ok" | "denied" | "error")) => Some(r.to_string()),
        Some(other) => return Err(format!("结果筛选「{other}」不在值域内（ok / denied / error）")),
    };
    let date_from = pick_date(&filters.date_from)?;
    let date_to = pick_date(&filters.date_to)?;
    if let (Some(f), Some(t)) = (&date_from, &date_to) {
        if f > t {
            return Err("日期区间反了：开始日期晚于结束日期".into());
        }
    }
    let limit = filters.limit.unwrap_or(AUDIT_LIMIT_DEFAULT).clamp(1, AUDIT_LIMIT_MAX);

    let mut sql = String::from(
        "SELECT a.id, a.at, a.actor_id, a.actor_name, a.action, a.entity, a.entity_id, a.entity_no,
                a.reason, u.display_name, a.result, a.error_msg, a.session_id, a.client_info,
                a.before_json, a.after_json
           FROM audit_log a
           LEFT JOIN user_account u ON u.id = a.authorized_by
          WHERE 1 = 1",
    );
    let mut args: Vec<String> = Vec::new();
    if let Some(k) = kw {
        // SQLite 的 lower() 只管 ASCII，中文原样通过——instr 因此能同时命中
        // "bd2026"（忽略大小写）与"张伟"（按字节子串），不需要 FTS 也不需要排序规则改动。
        sql.push_str(
            " AND (instr(lower(a.actor_name), ?1) > 0
                   OR instr(lower(a.action), ?1) > 0
                   OR instr(lower(a.entity), ?1) > 0
                   OR instr(lower(coalesce(a.entity_no, '')), ?1) > 0
                   OR instr(lower(coalesce(a.reason, '')), ?1) > 0)",
        );
        args.push(k);
    }
    if let Some(r) = result {
        let n = args.len() + 1;
        sql.push_str(&format!(" AND a.result = ?{n}"));
        args.push(r);
    }
    if let Some(d) = date_from {
        let n = args.len() + 1;
        sql.push_str(&format!(" AND substr(a.at, 1, 10) >= ?{n}"));
        args.push(d);
    }
    if let Some(d) = date_to {
        let n = args.len() + 1;
        sql.push_str(&format!(" AND substr(a.at, 1, 10) <= ?{n}"));
        args.push(d);
    }
    let n = args.len() + 1;
    // at 是定长 ISO 串（同偏移），字典序即时间序；id 兜底防同毫秒并列时翻页跳行。
    sql.push_str(&format!(" ORDER BY a.at DESC, a.id DESC LIMIT ?{n}"));
    args.push(limit.to_string());

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("审计查询准备失败：{e}"))?;
    let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let rows = stmt
        .query_map(refs.as_slice(), |r| {
            Ok(AuditRow {
                id: r.get(0)?,
                at: r.get(1)?,
                actor_id: r.get(2)?,
                actor_name: r.get(3)?,
                action: r.get(4)?,
                entity: r.get(5)?,
                entity_id: r.get(6)?,
                entity_no: r.get(7)?,
                reason: r.get(8)?,
                authorized_by: r.get(9)?,
                result: r.get(10)?,
                error_msg: r.get(11)?,
                session_id: r.get(12)?,
                client_info: r.get(13)?,
                before_json: r.get(14)?,
                after_json: r.get(15)?,
            })
        })
        .map_err(|e| format!("审计查询失败：{e}"))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| format!("审计读取失败：{e}"))
}

fn pick_date(v: &Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = v.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "all") else {
        return Ok(None);
    };
    let b = raw.as_bytes();
    let ok = b.len() == 10
        && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    if !ok {
        return Err(format!("日期「{raw}」格式不对，应为 YYYY-MM-DD"));
    }
    Ok(Some(raw.to_string()))
}

// ------------------------------------------------------------- 备份列表与淘汰

/// 从文件名里取出 `YYYYMMDD-HHMMSS` 时间戳。`banghe_<时间>_<kind>.db` 与
/// `pre_migrate_<起>_<止>_<时间>.db` 都带它。
///
/// 排序为什么信名字而不是 mtime：副本拷去 U 盘再拷回来、或从另一台磅房机复制过来时，
/// mtime 会变成"拷贝那一刻"，只看 mtime 会把这份**旧**副本当成最新的，淘汰时
/// 反过来把真正的新备份删掉。名字里的时间戳才是它真正的生成时刻。
pub fn name_stamp(name: &str) -> Option<String> {
    let b = name.as_bytes();
    if b.len() < 15 {
        return None;
    }
    (0..=b.len() - 15).find_map(|i| {
        let w = &b[i..i + 15];
        let shape = w.iter().enumerate().all(|(j, c)| match j {
            8 => *c == b'-',
            _ => c.is_ascii_digit(),
        });
        if shape {
            Some(String::from_utf8_lossy(w).to_string())
        } else {
            None
        }
    })
}

/// 排序键：名字里的时间戳优先，认不出来才退回 mtime（两者同为字典序可比的字符串）。
fn sort_key(file: &BackupFile) -> String {
    name_stamp(&file.name).unwrap_or_else(|| file.created_at.clone())
}

/// 列出备份目录里的副本，新→旧。只在**有旁文件**时才实算 SHA-256：
/// 历史快照多半没有旁文件，为一个判定不了的字段把几十 MB 全读一遍，
/// 会让备份页首次打开卡住。
pub fn list_backups(backup_dir: &Path) -> Vec<BackupFile> {
    let entries = match std::fs::read_dir(backup_dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut out: Vec<BackupFile> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".db") {
            continue;
        }
        let expected = read_sidecar(&path);
        let sha256_ok = expected
            .as_ref()
            .map(|want| sha256_of(&path).map(|got| got.eq_ignore_ascii_case(want)).unwrap_or(false));
        out.push(BackupFile {
            created_at: mtime_iso(&path).unwrap_or_else(|| "未知时间".to_string()),
            size_bytes: file_size(&path),
            sha256_ok,
            path: display(&path),
            sha256: expected,
            kind: kind_of(&name),
            name,
            pruned: None,
            prune_error: None,
        });
    }
    // 同一秒内的两份备份（连点、或迁移快照与手动备份撞秒）用名字兜底，结果必须稳定
    out.sort_by(|a, b| (sort_key(b), b.name.as_str()).cmp(&(sort_key(a), a.name.as_str())));
    out
}

/// 按 `backup_keep_count` 淘汰更旧的副本，**成对**删 `.db` 与 `.sha256`（留下孤零零的
/// 旁文件会让下一次校验把"文件不存在"当成篡改）。三条刻意的例外：
///  - `protect` 列出的名字永不删：调用方会把"刚生成的那一份"放进来——哪怕保留数被填成
///    0/1，也不能把用户这一次备份吃掉；恢复流程还会把**待恢复的那份副本**放进来，
///    否则淘汰会先把要换上去的文件删掉（自毁退路）；
///  - `pre_migrate_` 快照不参与淘汰：它是"库结构版本超前"时唯一的退路
///    （见 `migrate.rs` 的 Downgrade 文案），不该被手动备份的次数挤掉。
/// 删除失败既不 panic 也不否决已经成功的备份——失败项原样回给界面。
pub fn prune_backups(backup_dir: &Path, keep: i64, protect: &[&str]) -> (Vec<String>, Vec<String>) {
    let all = list_backups(backup_dir);
    let is_plain = |f: &BackupFile| !f.name.starts_with("pre_migrate_");
    // keep 是"普通副本的总份数"，受保护的这几份也占名额；否则每备份一次就多留一份，
    // 页面上写着"保留 30 份"、磁盘上却是 31、32 份在长。
    let held = all.iter().filter(|f| is_plain(f) && protect.contains(&f.name.as_str())).count();
    let budget = (keep.max(KEEP_FLOOR) as usize).saturating_sub(held);
    let mut victims: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let cands: Vec<&BackupFile> = all.iter().filter(|f| is_plain(f) && !protect.contains(&f.name.as_str())).collect();
    for f in cands.iter().skip(budget) {
        let db = backup_dir.join(&f.name);
        if let Err(e) = std::fs::remove_file(&db) {
            errors.push(format!("删除旧备份失败（{}）：{e}", f.name));
            continue;
        }
        let side = sidecar_path(&db);
        if side.exists() {
            if let Err(e) = std::fs::remove_file(&side) {
                errors.push(format!("删除旧备份的校验和文件失败（{}）：{e}", side.display()));
            }
        }
        victims.push(f.name.clone());
    }
    (victims, errors)
}

/// 生成一份备份：`VACUUM INTO` → 校验和旁文件 → 淘汰更旧副本 → 留痕。
///
/// 拆成收 `&Connection` 的纯函数，是因为 [`apply_restore`] 必须在**同一次取锁**里
/// 先拿当前库做退路备份、再换库；自己再去抢一次锁会死锁。
///
/// `VACUUM INTO` 走 SQLite 自己的页拷贝，得到的是**一致**副本；文件级 `copy` 主库
/// 则可能截到一半（WAL 里已提交未合并的页不在主文件内）。它不能在事务里执行。
pub fn create_backup(
    conn: &Connection,
    loc: &Locations,
    actor: impl Into<ActorRef>,
    kind: &str,
    stamp: &str,
    extra_protect: &[&str],
) -> Result<BackupFile, String> {
    let actor = actor.into();
    let kind = check_kind(kind)?;
    check_stamp(stamp)?;
    let backup_dir = loc.backup_dir(conn);
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("创建备份目录失败（{}）：{e}", display(&backup_dir)))?;
    let name = format!("banghe_{stamp}_{kind}.db");
    let path = backup_dir.join(&name);
    if path.exists() {
        // 同一秒内两次备份会撞名。宁可让人重按一次，也不能悄悄覆盖掉一份退路。
        return Err(format!("同一秒内已经生成过同名备份（{name}），请隔一秒再点"));
    }
    conn.execute("VACUUM INTO ?1", params![display(&path)])
        .map_err(|e| format!("生成备份失败（VACUUM INTO）：{e}"))?;
    if !path.is_file() {
        return Err(format!("VACUUM INTO 未生成备份文件：{}", display(&path)));
    }
    let size = file_size(&path);
    let hex = sha256_of(&path)?;
    write_sidecar(&path, &hex)?;

    let created_at = mtime_iso(&path).unwrap_or_else(|| "未知时间".to_string());
    let keep = setting_int(conn, "backup_keep_count", 30);
    // 只有调用方知道自己正盯着哪个副本（恢复流程要保待换上去的那一份），所以往外传。
    let mut protect: Vec<&str> = extra_protect.to_vec();
    protect.push(&name);
    let (pruned, prune_errors) = prune_backups(&backup_dir, keep, &protect);
    // 淘汰结果除了进回执还要进留痕：页面对 backup_run 只显示文件名，prune_error 留在结构体里
    // 等于没人看；写进事由后，"备份越来越多、盘却不见小"这类事在审计 tab 一查就有。
    let mut reason = format!("{kind} 备份 {name}，{size} 字节，校验和 {hex}");
    if !pruned.is_empty() {
        reason.push_str(&format!("；按保留 {keep} 份清理掉 {}", pruned.join("、")));
    }
    if !prune_errors.is_empty() {
        reason.push_str(&format!("；注意有旧备份删不掉，磁盘并未释放：{}", prune_errors.join("；")));
    }
    audit(conn, &actor, "backup", "app_meta", &name, &reason);
    Ok(BackupFile {
        pruned: Some(pruned),
        prune_error: if prune_errors.is_empty() {
            None
        } else {
            Some(prune_errors.join("；"))
        },
        name,
        path: display(&path),
        size_bytes: size,
        created_at,
        sha256: Some(hex),
        sha256_ok: Some(true),
        kind,
    })
}

/// 备份页整屏数据。口径全部来自真库与真文件系统：`last_backup_at` 取磁盘上最新的
/// 副本时间而不是 `app_meta` 的记账——账上记了、文件不在的备份不算备份。
pub fn collect_backup_status(conn: &Connection, loc: &Locations) -> Result<BackupStatus, String> {
    let backup_dir = loc.backup_dir(conn);
    let backups = list_backups(&backup_dir);
    // 空磅单表上 min() 返回的是"一行 NULL"而不是"没有行"，必须按 Option 取，
    // 否则新装的站点点开备份页就是一条 Invalid column type Null。
    let doc_oldest_date: Option<String> = conn
        .query_row("SELECT min(business_date) FROM weigh_order", [], |r| r.get::<_, Option<String>>(0))
        .map_err(|e| format!("读取最早业务日期失败：{e}"))?
        .filter(|s| !s.is_empty());
    let audit_rows: i64 = count_in(conn, "audit_log").map_err(|e| format!("统计审计留痕失败：{e}"))?;
    Ok(BackupStatus {
        backup_dir: display(&backup_dir),
        keep_count: setting_int(conn, "backup_keep_count", 30),
        auto_interval_days: auto_interval_days(conn),
        auto_last: auto_backup_note(),
        attachment_keep_days: setting_int(conn, "attachment_keep_days", 3650),
        retention_sample_days: setting_opt_int(conn, "retention_sample_days"),
        pii_mask_id_card: setting_opt_bool(conn, "pii_mask_id_card"),
        db_path: display(&loc.db_path()),
        db_size_bytes: loc.data_bytes(),
        wal_size_bytes: loc.wal_bytes(),
        last_backup_at: backups.first().map(|f| f.created_at.clone()),
        backups,
        doc_oldest_date,
        audit_rows,
    })
}

// ------------------------------------------------------------------ 自动备份

/// 当前生效的自动备份间隔（天）。填 0 或负数一律夹到 1：轮询每小时一次，真按 0 跑
/// 等于一天备份 24 份，把 `backup_keep_count` 的名额在当天占满，反而挤掉真正更老但
/// 还没到期的副本。想少留几份应该调大间隔，不是调小这个数。
pub fn auto_interval_days(conn: &Connection) -> i64 {
    setting_int(conn, AUTO_BACKUP_INTERVAL_KEY, AUTO_BACKUP_INTERVAL_DEFAULT).max(1)
}

/// `YYYYMMDD-HHMMSS` 距今多少天（向下取整）。认不出来的时间戳回 None。
fn stamp_age_days(stamp: &str) -> Option<i64> {
    let then = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d-%H%M%S").ok()?;
    Some((Local::now().naive_local() - then).num_days())
}

/// 该不该补一份自动备份：只看**最新那份普通副本**的名字时间戳。
/// `pre_migrate_*` 不算数——它只在库结构要变时才有，一个从不备份的站点光靠它撑不起
/// "数据留存"这件事；淘汰规则同样不计它（见 [`prune_backups`]），两处口径保持一致。
fn auto_backup_needed(conn: &Connection, backup_dir: &Path) -> bool {
    let interval = auto_interval_days(conn);
    let newest_plain = list_backups(backup_dir)
        .into_iter()
        .find(|f| !f.name.starts_with("pre_migrate_"));
    match newest_plain.as_ref().and_then(|f| name_stamp(&f.name)).as_deref().and_then(stamp_age_days) {
        // 认不出时间戳的副本（手工拷进来的怪名字）按"过期"处理：宁可多备份一次
        None => true,
        Some(age) => age >= interval,
    }
}

static AUTO_LAST: Mutex<Option<AutoBackupState>> = Mutex::new(None);

fn remember_auto_backup(ok: bool, detail: &str) {
    let state = AutoBackupState { ran_at: now_iso(), ok, detail: detail.to_string() };
    *AUTO_LAST.lock().unwrap_or_else(|p| p.into_inner()) = Some(state);
}

/// 页面上"自动备份最近一次检查说了什么"。None = 本次运行线程还没跑过第一轮。
pub fn auto_backup_note() -> Option<AutoBackupState> {
    AUTO_LAST.lock().unwrap_or_else(|p| p.into_inner()).clone()
}

/// 到期就补一份 `kind = auto`，没到就什么都不做。回 `Some(副本)` 表示这次真生成了文件。
///
/// 收 `&Connection` 与 [`create_backup`] 同一条理由：调用方已经持锁，这里再抢一次就死锁。
pub fn auto_backup_if_due(conn: &Connection, loc: &Locations) -> Result<Option<BackupFile>, String> {
    let backup_dir = loc.backup_dir(conn);
    if !auto_backup_needed(conn, &backup_dir) {
        return Ok(None);
    }
    Ok(Some(create_backup(conn, loc, ActorRef::system(), "auto", &stamp_now(), &[])?))
}

/// 起自动备份的守护线程：**先立刻查一轮**（新装站点当场就有第一份退路），之后每小时一次。
///
/// 用 `std::thread` 而不是事件循环里的定时器：这一轮全是同步的文件与 SQL 操作；
/// 地磅读线程已经是这个形态，两个后台线程混用两种生命周期管理只会更难归因。
/// 失败不弹错也不影响主流程——页面上那行"自动备份"因此必须是可见的（见 `auto_backup_note`）。
pub fn spawn_auto_backup(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("banghe-auto-backup".into())
        .spawn(move || {
            loop {
                auto_backup_tick(&app);
                std::thread::sleep(std::time::Duration::from_secs(AUTO_BACKUP_POLL_SECS));
            }
        });
    if let Err(e) = spawned {
        eprintln!("[banghe] 自动备份线程没起来（{e}），本次运行只能靠手动备份");
    }
}

/// 线程的一轮：取锁、判定、必要时落盘，并把结论记进 [`auto_backup_note`]。
fn auto_backup_tick(app: &AppHandle) {
    let outcome = (|| -> Result<Option<BackupFile>, String> {
        let pool = pool_of(app)?;
        let loc = locations(app)?;
        let guard = pool.lock().unwrap_or_else(|p| p.into_inner());
        auto_backup_if_due(&guard, &loc)
    })();
    match outcome {
        Ok(Some(file)) => {
            eprintln!("[banghe] 自动备份已生成 {}", file.name);
            remember_auto_backup(true, &format!("已生成 {}", file.name));
        }
        Ok(None) => remember_auto_backup(true, "未到自动备份间隔，无需新副本"),
        Err(e) => {
            eprintln!("[banghe] 自动备份失败：{e}");
            remember_auto_backup(false, &e);
        }
    }
}

/// 校验一个副本：只读打开 + `integrity_check` + `quick_check` + 校验和比对 + 行数。
/// `ok` 要求**完整性与校验和同时通过**——只改一个字节、结构照样"完整"的副本，
/// 靠校验和才拦得住（这也是备份要写旁文件的唯一理由）。
pub fn verify_backup(backup_dir: &Path, name: &str) -> Result<VerifyReport, String> {
    let path = resolve_backup(backup_dir, name)?;
    let actual = sha256_of(&path)?;
    let expected = read_sidecar(&path);
    let matches = expected
        .as_ref()
        .map(|e| e.eq_ignore_ascii_case(&actual))
        .unwrap_or(false);

    let mut orders = 0i64;
    let mut settlements = 0i64;
    let mut audit_rows = 0i64;
    let mut page_count = 0i64;
    let (integrity, integrity_ok) = match open_copy_read_only(&path) {
        Err(e) => (e, false),
        Ok(copy) => {
            let (text, ok) = copy_integrity(&copy);
            if ok {
                orders = count_in(&copy, "weigh_order").unwrap_or(0);
                settlements = count_in(&copy, "settlement").unwrap_or(0);
                audit_rows = count_in(&copy, "audit_log").unwrap_or(0);
                page_count = copy
                    .query_row("PRAGMA page_count", [], |r| r.get::<_, i64>(0))
                    .unwrap_or(0);
            }
            (text, ok)
        }
    };
    Ok(VerifyReport {
        ok: integrity_ok && matches,
        integrity,
        sha256_expected: expected,
        sha256_actual: actual,
        sha256_matches: matches,
        orders,
        settlements,
        audit_rows,
        page_count,
    })
}

/// `integrity_check` 是逐页扫（几十万页的库要真跑几秒），`quick_check` 只查结构。
/// 这里以 integrity_check 的结论为准，quick_check 只在它报错时补一句现场能贴给维护人的话。
fn copy_integrity(copy: &Connection) -> (String, bool) {
    match copy.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0)) {
        Ok(s) if s.eq_ignore_ascii_case("ok") => ("ok".to_string(), true),
        Ok(s) => {
            let quick = copy
                .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
                .unwrap_or_else(|e| format!("quick_check 也跑不动：{e}"));
            (format!("{s}（quick_check：{quick}）"), false)
        }
        // 损坏到连 pragma 都跑不动时，SQLite 的错误文本本身就是最有用的诊断
        Err(e) => (format!("完整性检查无法执行：{e}"), false),
    }
}

/// 表名不能走占位符，所以这里只接受代码里写死的常量名。
fn count_in(conn: &Connection, table: &str) -> Result<i64, String> {
    if table.is_empty() || !table.chars().all(|c| c.is_ascii_lowercase() || c == '_') {
        return Err("内部错误：非法表名".into());
    }
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get::<_, i64>(0))
        .map_err(|e| format!("统计 {table} 失败：{e}"))
}

/// 现库体检：完整性 + 悬挂外键 + 体积 + 行数 + 版本记账。
/// 这是"备份页那个体检按钮"的全部真相，不掺任何合成指标。
pub fn collect_health(conn: &Connection, loc: &Locations) -> Result<HealthReport, String> {
    let (integrity, integrity_ok) = copy_integrity(conn);

    let mut fk_violations: Vec<String> = Vec::new();
    let mut stmt = conn
        .prepare("PRAGMA foreign_key_check")
        .map_err(|e| format!("外键体检失败：{e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("外键体检失败：{e}"))?;
    for row in rows {
        let (table, rowid, parent) = row.map_err(|e| format!("外键体检失败：{e}"))?;
        if fk_violations.len() < FK_SAMPLE_MAX {
            fk_violations.push(format!("{table}(rowid {rowid}) → {parent}"));
        }
    }

    let last_backup_at = list_backups(&loc.backup_dir(conn)).first().map(|f| f.created_at.clone());
    Ok(HealthReport {
        integrity,
        integrity_ok,
        fk_violations,
        db_size_bytes: loc.data_bytes(),
        wal_size_bytes: loc.wal_bytes(),
        journal_mode: conn
            .query_row("PRAGMA journal_mode", [], |r| r.get::<_, String>(0))
            .unwrap_or_else(|_| "未知".into()),
        page_size: conn
            .query_row("PRAGMA page_size", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0),
        counts: HealthCounts {
            weigh_order: count_in(conn, "weigh_order")?,
            settlement: count_in(conn, "settlement")?,
            audit_log: count_in(conn, "audit_log")?,
            attachment: count_in(conn, "attachment")?,
        },
        last_backup_at,
        app_version: meta_value(conn, "app_version"),
        schema_version: meta_value(conn, "schema_version"),
    })
}

// ----------------------------------------------------------------- 导入外部副本

/// 外部副本路径的入参清洗。**只认绝对路径**：相对路径会按进程工作目录解释，
/// 而磅房机的工作目录不在任何人的预期里（与 [`Locations::backup_dir`] 同一条规矩）。
/// 比对身份时用 canonicalize 的结果，回给界面的仍是原样路径。
fn check_source(loc: &Locations, backup_dir: &Path, src: &Path) -> Result<PathBuf, String> {
    if src.as_os_str().is_empty() {
        return Err("请先选择要导入的备份文件".into());
    }
    if !src.is_absolute() {
        return Err(format!("只能导入绝对路径（例如 D:\\banghe\\backup 里的副本），当前「{}」不是", display(src)));
    }
    if !src.extension().is_some_and(|e| e.to_string_lossy().eq_ignore_ascii_case("db")) {
        return Err(format!("只能导入 .db 备份文件：{}", display(src)));
    }
    let canon = src
        .canonicalize()
        .map_err(|e| format!("打不开要导入的副本（{}）：{e}", display(src)))?;
    if !canon.is_file() {
        return Err(format!("{} 不是一个文件", display(src)));
    }
    if file_size(&canon) == 0 {
        return Err(format!("{} 大小为 0 字节，是个空文件", display(src)));
    }
    // 现库不能当备份导入：文件级 copy 的库不带 -wal 里已提交未合并的页，
    // 导进来一份"看着像备份、其实缺最近几笔"的副本，比没有副本更危险。
    if loc.db_path().canonicalize().ok().as_deref() == Some(canon.as_path()) {
        return Err("这是正在使用的库文件，不能当作备份导入。要给当前库做备份请用「立即备份」".into());
    }
    // 已经在备份目录里的副本本来就在页面上的列表里，再拷一份只是造出一个同名撞车的假货
    if canon.parent() == backup_dir.canonicalize().ok().as_deref() {
        return Err("这份副本已经在备份目录里了，直接在下面的列表里选中它即可".into());
    }
    Ok(src.to_path_buf())
}

/// 把备份目录之外的一份 `.db` 副本收进备份目录，之后它就与本机自己备份的副本完全同权：
/// 走同一条 [`preflight_copy`] 预检与 [`apply_restore`] 换库，本函数不另开恢复路径。
///
/// 目标名**优先沿用源文件名**：`banghe_<时间>_<kind>.db` 里带着它真正的生成时刻，
/// 排序与淘汰都读这个名字时间戳（见 [`name_stamp`]）。改成导入时刻会把一份三年前的旧库
/// 伪装成新副本，淘汰时反过来挤掉真正更新的备份。
pub fn import_backup(
    conn: &Connection,
    loc: &Locations,
    actor: &AuthProfile,
    src: &Path,
) -> Result<BackupFile, String> {
    let backup_dir = loc.backup_dir(conn);
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("创建备份目录失败（{}）：{e}", display(&backup_dir)))?;
    let src = check_source(loc, &backup_dir, src)?;
    let hex = sha256_of(&src)?;

    // 带旁文件的外部副本先验一次。U 盘上拷坏的文件在这里就被拒，比让它进到备份目录、
    // 到预检时才炸更省事——而且它还会占掉一个淘汰名额，把真副本挤出去。
    if let Some(expected) = read_sidecar(&src) {
        if !expected.eq_ignore_ascii_case(&hex) {
            return Err(format!(
                "副本的校验和对不上（旁文件记 {expected}，实算 {hex}），{} 已损坏或被改动，不能导入",
                display(&src)
            ));
        }
    }

    // 同一份内容已经在备份目录里：直接把现有那条回给界面。连点两次导入不该在磁盘上
    // 堆出第二份，也不该因为兜底名带秒数而在同一秒里报"请隔一秒再试"。
    if let Some(existing) = list_backups(&backup_dir)
        .into_iter()
        .find(|f| f.sha256.as_deref().is_some_and(|s| s.eq_ignore_ascii_case(&hex)))
    {
        return Ok(existing);
    }

    let src_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut name = if name_stamp(&src_name).is_some() { src_name.clone() } else { stamp_backup_name() };
    if backup_dir.join(&name).exists() {
        // 走到这里说明同名但内容不同（同一份内容已被上面接住）：退到导入名。
        // 绝不覆盖已有副本——那等于删掉一份别人的退路。
        name = stamp_backup_name();
        if backup_dir.join(&name).exists() {
            return Err(format!("同一秒内刚导入过同名副本（{name}），请隔一秒再试"));
        }
    }
    let dst = backup_dir.join(&name);
    std::fs::copy(&src, &dst).map_err(|e| format!("把副本拷进备份目录失败（{}）：{e}", display(&dst)))?;
    // 落盘后重算：拷贝中途断连或盘坏最常见的表现就是这一步对不上。
    // 对不上就把刚写下的这一对文件删掉，磁盘上不留半成品。
    let got = match sha256_of(&dst) {
        Ok(h) => h,
        Err(e) => {
            let _ = std::fs::remove_file(&dst);
            return Err(e);
        }
    };
    if !got.eq_ignore_ascii_case(&hex) {
        let _ = std::fs::remove_file(&dst);
        return Err(format!("副本拷进备份目录后校验和变了（{hex} → {got}），已放弃这次导入"));
    }
    // 无论源文件有没有旁文件都写一份：它证明的是"自本次导入起没被改过"，
    // 这正是后续 [`verify_backup`] 与预检要用的那件事。
    write_sidecar(&dst, &hex)?;

    let size = file_size(&dst);
    let keep = setting_int(conn, "backup_keep_count", 30);
    // 刚导进来的这份往往就是站长马上要恢复的那一份，必须进保护名单（同 [`apply_restore`]
    // 里给待换副本留位数的道理）；它名字里的时间戳可能比保留数外的那些还旧。
    let (pruned, prune_errors) = prune_backups(&backup_dir, keep, &[name.as_str()]);
    let mut reason = format!("导入外部副本 {name}，源文件 {}，{size} 字节，校验和 {hex}", display(&src));
    if !pruned.is_empty() {
        reason.push_str(&format!("；按保留 {keep} 份清理掉 {}", pruned.join("、")));
    }
    if !prune_errors.is_empty() {
        reason.push_str(&format!("；注意有旧备份删不掉，磁盘并未释放：{}", prune_errors.join("；")));
    }
    audit(conn, &ActorRef::from(actor), "backup", "app_meta", &name, &reason);

    Ok(BackupFile {
        pruned: Some(pruned),
        prune_error: if prune_errors.is_empty() { None } else { Some(prune_errors.join("；")) },
        name,
        path: display(&dst),
        size_bytes: size,
        created_at: mtime_iso(&dst).unwrap_or_else(|| "未知时间".to_string()),
        sha256: Some(hex),
        sha256_ok: Some(true),
        kind: kind_of(&src_name),
    })
}

/// 导入时的兜底名：源文件名不合本程序的命名语法（没有 `YYYYMMDD-HHMMSS` 时间戳）时用它。
fn stamp_backup_name() -> String {
    format!("banghe_{}_imported.db", stamp_now())
}

// ----------------------------------------------------------------------- 恢复

/// 一眼就不合格的副本：没有可检的内容，直接给一份判否的报告（字段留空而不是编值）。
fn rejected(name: &str, reason: String) -> Preflight {
    Preflight {
        ok: false,
        name: name.trim().to_string(),
        size_bytes: 0,
        created_at: None,
        integrity: String::new(),
        schema_version: None,
        current_schema_version: None,
        station_code: None,
        station_name: None,
        orders: 0,
        settlements: 0,
        oldest_date: None,
        newest_date: None,
        errors: vec![reason],
        warnings: Vec::new(),
    }
}

/// 恢复向导的只读预检。**一条写入都不做**：预检本身不该改变"能不能恢复"这个事实。
/// 不可恢复的问题进 `errors`（`ok = false`），能继续但站长该知道的事进 `warnings`。
///
/// "这个副本不合格"一律走 `Ok(Preflight{ ok:false, .. })` 而不是 `Err`：向导要把原因
/// 逐条摊在界面上，抛错只会被看成"系统坏了"。真正抛 `Err` 的只有系统级失败（读不了目录）。
pub fn preflight_copy(conn: &Connection, backup_dir: &Path, name: &str) -> Result<Preflight, String> {
    let path = match resolve_backup(backup_dir, name) {
        Ok(p) => p,
        Err(e) => return Ok(rejected(name, e)),
    };

    let mut errors: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    let size_bytes = file_size(&path);
    if size_bytes == 0 {
        errors.push("副本大小为 0 字节，是个空文件".into());
    }

    // 校验和：旁文件缺失只给 warning——`pre_migrate_*` 快照（迁移执行器生成的）天生
    // 没有旁文件，而它正是"装错版本"时唯一能退回去的库；缺文件不当错误、但必须说。
    let actual = match sha256_of(&path) {
        Ok(h) => h,
        Err(e) => {
            errors.push(format!("读不了这个副本：{e}"));
            String::new()
        }
    };
    let expected = read_sidecar(&path);
    match &expected {
        None if actual.is_empty() => {}
        None => warnings.push(format!(
            "副本没有校验和文件（{}），无法证明它没被改过；本程序生成的备份都会带 .sha256",
            sidecar_path(&path).display()
        )),
        Some(e) if !actual.is_empty() && !e.eq_ignore_ascii_case(&actual) => errors.push(format!(
            "校验和不一致：旁文件记 {e}，实算 {actual}。副本已损坏或被改动，不能恢复"
        )),
        Some(_) => {}
    }

    let mut integrity = String::new();
    let mut copy: Option<Connection> = None;
    if size_bytes > 0 {
        match open_copy_read_only(&path) {
            Err(e) => {
                errors.push(e.clone());
                integrity = e;
            }
            Ok(c) => {
                let (text, ok) = copy_integrity(&c);
                integrity = text;
                if ok {
                    copy = Some(c);
                } else {
                    errors.push(format!("副本完整性检查未通过：{integrity}"));
                }
            }
        }
    }

    let mut orders = 0i64;
    let mut settlements = 0i64;
    let mut oldest_date: Option<String> = None;
    let mut newest_date: Option<String> = None;
    let mut station_code: Option<String> = None;
    let mut station_name: Option<String> = None;
    let mut schema_version: Option<String> = None;

    if let Some(c) = &copy {
        orders = count_in(c, "weigh_order").unwrap_or(0);
        settlements = count_in(c, "settlement").unwrap_or(0);
        if let Ok((from, to)) = c.query_row(
            "SELECT min(business_date), max(business_date) FROM weigh_order",
            [],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
        ) {
            oldest_date = from.filter(|s| !s.is_empty());
            newest_date = to.filter(|s| !s.is_empty());
        }
        // 站点码参与取号（03 §3.5）：没有站点档案的库恢复进去，第一张单就打不出号。
        // 先挑启用中的，全被停用时退到任意一条并在 warning 里说清楚。
        let active = c.query_row(
            "SELECT code, name FROM station WHERE is_active = 1 ORDER BY id LIMIT 1",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        );
        let found = match active {
            Ok(row) => Some(row),
            // 全站都被停用是真实存在的状态（§9.2 is_active 默认 1，但档案页能停）：
            // 恢复后第一张单取不到站点码，必须让站长先启用回来
            Err(_) => c
                .query_row("SELECT code, name FROM station ORDER BY id LIMIT 1", [], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map(|row| {
                    warnings.push("副本里的站点档案处于停用状态，恢复后先到基础档案启用站点".into());
                    row
                })
                .ok(),
        };
        match found {
            Some((code, n)) => {
                station_code = Some(code);
                station_name = Some(n);
            }
            None => errors.push("副本里没有任何站点档案，恢复后无法制单取号".into()),
        }
        if orders == 0 {
            warnings.push("副本里一张磅单都没有，恢复等于把现有业务数据全部换掉".into());
        }
        schema_version = meta_value(c, "schema_version");
    }

    let current_schema_version = meta_value(conn, "schema_version");
    let app_max = db::migrate::max_version(db::MIGRATIONS);
    match &schema_version {
        None => errors.push("副本里没有 app_meta.schema_version 记账，无法确认它是本程序生成的库".into()),
        Some(v) => match v.parse::<u32>() {
            Err(_) => errors.push(format!("副本的结构版本「{v}」不是数字，无法判断能否被本程序理解")),
            Ok(n) => {
                // 高于本程序 → migrate.rs 会直接拒绝启动（Downgrade），换上去等于自锁
                if n > app_max {
                    errors.push(format!(
                        "副本结构版本 v{n} 高于本程序支持的最高版本 v{app_max}，恢复后应用会拒绝启动"
                    ));
                } else if let Some(cur) = current_schema_version.as_deref().and_then(|s| s.parse::<u32>().ok()) {
                    if n < cur {
                        errors.push(format!(
                            "副本结构版本 v{n} 低于现库 v{cur}：恢复会把数据退回旧表结构，请先核对版本"
                        ));
                    } else if n < app_max {
                        warnings.push(format!(
                            "副本结构版本 v{n} 低于本程序内置的 v{app_max}，首次启动会自动补跑迁移"
                        ));
                    }
                }
            }
        },
    }
    if current_schema_version.is_none() {
        warnings.push("现库未记录结构版本（app_meta.schema_version 缺失），版本比较只做了一半".into());
    }

    Ok(Preflight {
        ok: errors.is_empty(),
        name: name.trim().to_string(),
        size_bytes,
        created_at: mtime_iso(&path),
        integrity,
        schema_version,
        current_schema_version,
        station_code,
        station_name,
        orders,
        settlements,
        oldest_date,
        newest_date,
        errors,
        warnings,
    })
}

/// 换库的**入口**：在 [`apply_restore`] 之前加一道岗位闸门。
///
/// 命令层 `restore_apply` 走的就是这里，所以 tests/system_contract.rs 跑的是线上同一条路径，
/// 包括"确认文案不对、岗位不对、副本不存在"这三种在碰文件之前就该被拒的情形。
/// 确认文案与预检仍由 `apply_restore` 把关，这里不写第二份；反过来说，**绕开本函数直接调
/// `apply_restore` 等于没有岗位闸门**（它只认确认文案），新增调用方一律走这里。
pub fn restore_apply_guard(
    pool: &Pool,
    loc: &Locations,
    actor: &AuthProfile,
    name: &str,
    confirm: &str,
) -> Result<RestoreResult, String> {
    check_role(actor, RESTORE_ROLES, "恢复备份（请找站长）")?;
    apply_restore(pool, loc, actor, name, confirm)
}

/// 换库。**顺序即安全措施**，任何一步都不能调（见模块头）。
///
/// 收 `&Pool` 而不是 `&Connection`：中途必须把托管连接整个换掉——旧文件句柄不放掉，
/// Windows 上改不了名，新库也可能被旧句柄的后续写覆盖；换完还要在**新库**上补审计。
/// 全程持锁：半换状态不许被其它命令读到。
pub fn apply_restore(
    pool: &Pool,
    loc: &Locations,
    actor: &AuthProfile,
    name: &str,
    confirm: &str,
) -> Result<RestoreResult, String> {
    if confirm.trim() != RESTORE_CONFIRM_TEXT {
        return Err(format!(
            "恢复没有确认：请逐字输入「{RESTORE_CONFIRM_TEXT}」（当前输入「{}」）",
            confirm.trim()
        ));
    }
    let mut guard = pool.lock().unwrap_or_else(|p| p.into_inner());
    let backup_dir = loc.backup_dir(&guard);

    // ① 预检（只读）
    let pre = preflight_copy(&guard, &backup_dir, name).map_err(|e| format!("恢复预检失败：{e}"))?;
    if !pre.ok {
        return Err(format!("预检未通过，已停在换库之前：{}", pre.errors.join("；")));
    }
    let src_name = pre.name.clone();
    let src = resolve_backup(&backup_dir, &src_name)?;

    // ② 强制先给当前库做退路备份。失败必须中止——没有退路的换库不做。
    //    待恢复的那份副本一起进保护名单：它可能已经很旧，正好排在保留数之外。
    let safety = create_backup(&guard, loc, actor, "pre-restore", &stamp_now(), &[src_name.as_str()])
        .map_err(|e| format!("恢复前的当前库备份失败，已中止换库（不能没有退路）：{e}"))?;

    let db_path = loc.db_path();
    let wal = loc.side(WAL_SUFFIX);
    let shm = loc.side(SHM_SUFFIX);
    let stamp = stamp_now();
    let old_db = PathBuf::from(format!("{}.old-{stamp}", db_path.display()));
    let old_wal = PathBuf::from(format!("{}.old-{stamp}-wal", db_path.display()));
    let old_shm = PathBuf::from(format!("{}.old-{stamp}-shm", db_path.display()));

    // ③ 收敛 WAL：把已提交但还没合并进主文件的页刷回去。不刷就把数据留在了
    //    即将改名的 -wal 里，换上新主文件后那些单据凭空消失。
    if let Err(e) = guard.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);") {
        return Err(format!(
            "换库前收敛 WAL 失败，已停在换库之前（退路备份 {} 已生成）：{e}",
            safety.name
        ));
    }

    // ④ 释放主库文件句柄：把托管连接换成一个临时内存连接，旧连接在此刻被关闭。
    *guard = Connection::open_in_memory().map_err(|e| format!("释放库文件句柄失败：{e}"))?;

    // ⑤ 旧库改名保留 → 副本就位
    if let Err(e) = swap_db_files(&db_path, &wal, &shm, &old_db, &old_wal, &old_shm, &src) {
        let detail = put_old_back(&db_path, &wal, &shm, &old_db, &old_wal, &old_shm);
        *guard = open_or_placeholder(&db_path);
        return Err(format!(
            "换库失败：{e}{detail} 退路备份：{}。当前库未改动，可以重试",
            safety.path
        ));
    }

    // ⑥ 以新库重开连接。这一步失败说明副本落盘有问题，必须把旧库换回去。
    match open_pragmed(&db_path) {
        Ok(c) => *guard = c,
        Err(e) => {
            let detail = put_old_back(&db_path, &wal, &shm, &old_db, &old_wal, &old_shm);
            *guard = open_or_placeholder(&db_path);
            return Err(format!(
                "副本已就位但打不开新库（{e}）。{detail} 退路备份：{}",
                safety.path
            ));
        }
    }

    // ⑦ 留痕写在新库里：旧库已下线，而"这份数据是哪天被换上来的"本来就该记在当前库上。
    //    这一步失败必须把"库已经换了"讲明白——否则站长以为什么都没发生。
    let reason = format!(
        "恢复副本 {src_name}；恢复前已备份当前库为 {safety}；旧库改名为 {old}（未删除，可手工换回）",
        safety = safety.name,
        old = display(&old_db)
    );
    if let Err(e) = try_audit(&guard, actor, "restore", "app_meta", &src_name, &reason) {
        return Err(format!(
            "库已换成副本 {src_name}，但{e}。旧库保留在 {old}，退路备份 {safety}。\
             请立即重启应用并人工记下这次恢复，不要重复点恢复。",
            old = display(&old_db),
            safety = safety.name
        ));
    }
    RESTORE_DONE.store(true, Ordering::SeqCst);
    Ok(RestoreResult {
        ok: true,
        old_db_path: display(&old_db),
        safety_backup: safety.name,
        restart_required: true,
    })
}

/// 旧库与边文件改名 → 副本复制到位。失败时把已完成的部分原样写进错误里。
fn swap_db_files(
    db_path: &Path,
    wal: &Path,
    shm: &Path,
    old_db: &Path,
    old_wal: &Path,
    old_shm: &Path,
    src: &Path,
) -> Result<(), String> {
    std::fs::rename(db_path, old_db)
        .map_err(|e| format!("旧库改名失败（{} → {}）：{e}", display(db_path), display(old_db)))?;
    // checkpoint 之后 -wal / -shm 可能已经消失，不存在是正常情况
    for (from, to) in [(wal, old_wal), (shm, old_shm)] {
        if from.exists() {
            std::fs::rename(from, to).map_err(|e| format!("{} 改名失败：{e}", display(from)))?;
        }
    }
    std::fs::copy(src, db_path).map_err(|e| format!("把副本 {} 放到位失败：{e}", display(src)))?;
    Ok(())
}

/// 换库中途失败后的补救：把改名的旧库放回原位。**改名而不是删除**就是为这一刻留的。
/// 返回值是给界面看的话术，必须说清"数据到底在哪个文件里"。
fn put_old_back(
    db_path: &Path,
    wal: &Path,
    shm: &Path,
    old_db: &Path,
    old_wal: &Path,
    old_shm: &Path,
) -> String {
    // 半路失败时 banghe.db 可能是刚拷进去的副本：先挪开，别挡住旧库复位
    if db_path.exists() {
        let aside = PathBuf::from(format!("{}.failed-{}", db_path.display(), std::process::id()));
        let _ = std::fs::remove_file(&aside);
        let _ = std::fs::rename(db_path, &aside);
    }
    match std::fs::rename(old_db, db_path) {
        Ok(()) => {
            for (from, to) in [(old_wal, wal), (old_shm, shm)] {
                if from.exists() {
                    let _ = std::fs::rename(from, to);
                }
            }
            "已把旧库换回原位，业务数据未丢。".to_string()
        }
        Err(e) => format!(
            "旧库换回失败（{e}）：请**手工**把 {old} 改名为 {target} 再重启应用。",
            old = display(old_db),
            target = display(db_path)
        ),
    }
}

fn open_pragmed(db_path: &Path) -> Result<Connection, String> {
    let conn = Connection::open(db_path).map_err(|e| format!("打开 {} 失败：{e}", display(db_path)))?;
    db::setup_pragmas(&conn).map_err(|e| format!("恢复后设置连接参数失败：{e}"))?;
    Ok(conn)
}

/// 补救路径上"至少要有个能应答的连接"：真库打不开时用内存连接顶着，
/// 免得托管状态里留下一个已关闭的洞（后续任何命令都会以难看的方式炸）。
fn open_or_placeholder(db_path: &Path) -> Connection {
    open_pragmed(db_path).unwrap_or_else(|e| {
        eprintln!("[banghe] 恢复回退后仍打不开库文件：{e}");
        Connection::open_in_memory().expect("内存连接必然可用")
    })
}

// ------------------------------------------------------------------ Tauri 命令
// 只读命令同锁串行；备份/恢复要动文件，全程持锁但**不进事务**（VACUUM INTO 在事务里报错）。

async fn read_conn<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&Connection, &Locations) -> Result<T, String> + Send + 'static,
    what: &str,
) -> Result<T, String> {
    let pool = pool_of(app)?;
    let loc = locations(app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let guard = pool.lock().unwrap_or_else(|p| p.into_inner());
        f(&guard, &loc)
    })
    .await
    .map_err(|e| format!("{what}任务失败：{e}"))?
}

/// 审计列表。不设岗位闸门：留痕给所有登录岗位看（页面现状如此）。
#[tauri::command]
pub async fn audit_list(app: AppHandle, filters: AuditFilters) -> Result<Vec<AuditRow>, String> {
    read_conn(&app, move |conn, _| list_audit(conn, &filters), "审计读取").await
}

#[tauri::command]
pub async fn backup_status(app: AppHandle) -> Result<BackupStatus, String> {
    read_conn(&app, |conn, loc| collect_backup_status(conn, loc), "备份状态读取").await
}

#[tauri::command]
pub async fn db_health(app: AppHandle) -> Result<HealthReport, String> {
    read_conn(&app, |conn, loc| collect_health(conn, loc), "数据库体检").await
}

#[tauri::command]
pub async fn backup_verify(app: AppHandle, name: String) -> Result<VerifyReport, String> {
    read_conn(&app, move |conn, loc| verify_backup(&loc.backup_dir(conn), &name), "备份校验").await
}

#[tauri::command]
pub async fn restore_preflight(app: AppHandle, name: String) -> Result<Preflight, String> {
    read_conn(&app, move |conn, loc| {
        preflight_copy(conn, &loc.backup_dir(conn), &name)
    }, "恢复预检")
    .await
}

/// 手动备份。需要登录会话，且岗位在 [`BACKUP_ROLES`] 内。
#[tauri::command]
pub async fn backup_run(app: AppHandle, input: BackupRunInput) -> Result<BackupFile, String> {
    let pool = pool_of(&app)?;
    let actor = actor_with_roles(&app, BACKUP_ROLES, "手动备份（请找站长或出纳）")?;
    let loc = locations(&app)?;
    let kind = input.kind.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let stamp = stamp_now();
        let guard: MutexGuard<Connection> = pool.lock().unwrap_or_else(|p| p.into_inner());
        create_backup(&guard, &loc, &actor, &kind, &stamp, &[])
    })
    .await
    .map_err(|e| format!("备份任务失败：{e}"))?
}

/// 在系统文件管理器里打开备份目录（现场"拷去 U 盘"只能靠它）。
/// 目录不存在先建，建不出来才回错；成功时把路径回给页面显示。
#[tauri::command]
pub async fn backup_reveal(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = read_conn(&app, |conn, loc| {
        let dir = loc.backup_dir(conn);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("创建备份目录失败（{}）：{e}", display(&dir)))?;
        Ok(dir)
    }, "打开备份目录")
    .await?;
    let path = display(&dir);
    app.opener()
        .open_path(path.clone(), None::<&str>)
        .map_err(|e| format!("已生成备份目录 {path}，但打开文件管理器失败：{e}"))?;
    Ok(path)
}

/// 导入备份目录之外的一份 `.db` 副本（现场"拷去 U 盘又拷回来"的那一步）。
/// 岗位与手动备份同档：它只往备份目录里添文件，真正危险的换库仍然在 `restore_apply`。
#[tauri::command]
pub async fn backup_import(app: AppHandle, input: BackupImportInput) -> Result<BackupFile, String> {
    let pool = pool_of(&app)?;
    let actor = actor_with_roles(&app, BACKUP_ROLES, "导入外部副本（请找站长或出纳）")?;
    let loc = locations(&app)?;
    let path = input.path.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let guard = pool.lock().unwrap_or_else(|p| p.into_inner());
        import_backup(&guard, &loc, &actor, Path::new(&path))
    })
    .await
    .map_err(|e| format!("导入副本任务失败：{e}"))?
}

/// 换库。仅站长，且 `confirm` 必须逐字等于 [`RESTORE_CONFIRM_TEXT`]。
#[tauri::command]
pub async fn restore_apply(app: AppHandle, input: RestoreApplyInput) -> Result<RestoreResult, String> {
    let pool = pool_of(&app)?;
    // 岗位闸门交给 restore_apply_guard——契约测试跑的就是那条，命令层不再抄第二份角色表
    let actor = actor(&app)?;
    let loc = locations(&app)?;
    let name = input.name.unwrap_or_default();
    let confirm = input.confirm.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || restore_apply_guard(&pool, &loc, &actor, &name, &confirm))
        .await
        .map_err(|e| format!("恢复任务失败：{e}"))?
}

/// 重启应用。走 [`tauri::AppHandle::restart`]（Tauri v2.11 起有这个方法）：它会触发
/// `RunEvent::Exit`，`lib.rs` 里的 WAL 收尾照常跑。不用 `std::process` 自杀式重启——
/// 那条路跳过退出事件，会把 -wal 和未收敛的页留在原地。
#[tauri::command]
pub async fn app_restart(app: AppHandle) -> Result<(), String> {
    let actor = actor_with_roles(&app, RESTORE_ROLES, "重启应用")?;
    if !RESTORE_DONE.load(Ordering::SeqCst) {
        return Err("本次运行没有执行过恢复，无需重启；恢复向导走完后这个按钮才有效".into());
    }
    eprintln!("[banghe] 站长 {} 确认重启应用（恢复后换库）", actor.username);
    app.restart()
}
