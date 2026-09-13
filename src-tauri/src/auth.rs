//! 密码登录与会话（docs/design/02 §11 M10、05 §3 末尾、03 §9.4）
//!
//! 四条硬规矩，写在这里以免散到别处：
//!  1. **密码校验只发生在 Rust 侧**。`password_hash` 永不进任何命令返回值——
//!     WebView 能按 F12 改前端状态，改不了这里。
//!  2. **业务失败不抛异常**（照 [`printer`] 的约定）：回 `ok=false` + 一句人话原因。
//!     登录失败在磅房是高频事件，弹栈没有意义，操作员也看不懂。
//!  3. **耗时活在 [`spawn_blocking`](tauri::async_runtime::spawn_blocking) 里跑**，
//!     并且一次校验分三段：锁内取数 → **锁外**算 argon2 → 锁内落结论。
//!     argon2 单次 50–100 ms，持锁计算会让后面的业务命令在单连接上排队（03 §1.2）。
//!  4. **文案不区分"用户不存在"与"密码错"**，且账号不存在时也照跑一次假哈希，
//!     否则响应时间的快慢本身就能把在职登录名枚举出来。
//!
//! 会话寿命（2026-09-13 改）：**登录后不设总时长上限、永不自动登出**；空闲满
//! [`IDLE_TTL_SECS`] 只是把会话**锁屏**（`Session::locked`），业务命令在锁定期一律拒绝，
//! 输入本人密码经 [`auth_unlock`] 解锁后原地继续。主动登出仍是立刻结束会话；
//! 会话只存内存，所以重启程序必须重登——
//! 这是"单据署名等于当时坐在磅房里的人"这条链路的唯一支点。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock, RwLockWriteGuard};

use argon2::password_hash::generate_salt;
use argon2::{Algorithm, Argon2, PasswordHash, PasswordHasher, PasswordVerifier, Version};
use chrono::{DateTime, Local};
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::migrate::now_iso;
use crate::db::{locked, Db};

/// 无操作多久后锁屏（不登出，输密码解锁）。业务上要"不退出就一直用"，但挡不住人离开磅房机后被接手，
/// 折中成 1 小时空闲锁屏。做成设置项要新增 `app_setting` 键（牵动 03 §9.3.1 与 seed
/// 契约测试，且 0002 已发布不可改、只能补 0003），本轮先按常量交付。
pub const IDLE_TTL_SECS: i64 = 3600;
/// 连错几次锁多久（02 §11"连续失败锁定"；`failed_count`/`locked_until` 两列 0001 已备）
pub const MAX_FAILED: i64 = 5;
pub const LOCK_MINUTES: i64 = 15;

/// 调试构建是否放行"连错锁定"。默认 `false`（锁定照常生效）：单元测试直接调
/// [`authenticate`]、不跑 App 启动，所以 §11 的连错锁定契约仍被 `tests/auth_contract.rs` 守着。
/// 只有 `lib.rs` 在 `cfg(debug_assertions)` 下把它置真，让 `tauri dev` 反复试错不被锁死、
/// 也能把此前已锁的账号直接登进去（成功登录会顺手把 `failed_count`/`locked_until` 归零）。
static LOCKOUT_DISABLED: AtomicBool = AtomicBool::new(false);

/// 由 App 启动流程调用（仅 debug 构建传 `true`）。
pub fn set_lockout_disabled(disabled: bool) {
    LOCKOUT_DISABLED.store(disabled, Ordering::Relaxed);
}

/// 锁定逻辑当前是否生效。关掉时：既不因连错而设锁，也无视已有的 `locked_until`。
fn lockout_active() -> bool {
    !LOCKOUT_DISABLED.load(Ordering::Relaxed)
}

/// 最短密码。磅房全键盘作业、操作员以年龄偏大的站长为主，不叠复杂度规则——
/// 强行大写加符号只会换来贴在显示器边框上的便利贴。
pub const PWD_MIN_LEN: usize = 6;

/// 未设密码的标记值，与 `0002_seed.sql` 里 admin 的占位符逐字一致。
/// 它**不是**合法的 argon2 串，所以直接翻库也看不出哪个账号能登进去。
pub const PWD_UNSET: &str = "!set_on_first_run";

/// 装机初始密码：**仅**对 `password_hash` 仍是 [`PWD_UNSET`] 的账号有效，
/// 且登录后强制改密（见 [`conclude`] 里的 `must_change_pwd`），改完这条路即永久关闭。
/// 于是"预留超管"与"新员工首次登录"共用一条规则，库里永远不需要写死哈希
/// （`tests/schema_contract.rs` 断言种子哈希以 `!` 开头，正是为守住这点）。
///
/// 风险要说清楚：初始密码在二进制里，`strings` 翻得出来，属于"保密即安全"。
/// 收紧办法是把装机密码改成安装时随机生成、抄在装机单上的一次性值——
/// 改动只落在 [`bootstrap_password`] 这一处。
pub fn bootstrap_password() -> &'static str {
    "banghe@2026"
}

/// 密码错与"用户不存在"逐字相同（规矩 4）。测试也引用这一份，避免文案分叉。
pub const NO_DETAIL: &str = "用户名或密码不正确";

/// `audit_log.entity`，03 §9.21：只插入，不暴露任何删改接口
const AUDIT_ENTITY: &str = "user_account";

/// `client_info` 目前只有机器名与应用版本——现场排障真正要的是"哪台磅房机"
fn client_info() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "未知机器".into());
    format!("{host} / banghe {}", env!("CARGO_PKG_VERSION"))
}

// --------------------------------------------------------------------- 数据结构

/// 能出 Rust 的账号信息。**没有 `password_hash`，也没有 `failed_count` 原值**——
/// 防哈希外泄与防枚举靠这个结构保证，不靠"记得删字段"。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AuthProfile {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    /// 线上值与 `src/lib/constants.ts` 的 `ROLE` 键一致（03 §9.4）
    pub role: String,
    pub must_change_pwd: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub actor: AuthProfile,
    /// 随机不透明串，写进 `audit_log.session_id` 串联同一次作业
    pub session_id: String,
    pub issued_at: String,
    pub last_seen_at: String,
    /// 下发给前端，"还有多久掉登录"这类提示因此不必抄常量
    pub idle_ttl_secs: i64,
    /// 空闲超时锁屏中：会话还在，但业务命令一律拒绝，直到 [`auth_unlock`] 验密解锁
    pub locked: bool,
}

/// `auth_login` 的回执。字段全部可缺省，前端按 `ok` 分支。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginOutcome {
    pub ok: bool,
    pub error: Option<String>,
    pub session: Option<Session>,
    /// 该账号还是占位哈希 ⇒ 前端把界面切成"设置密码"
    pub needs_password_setup: Option<bool>,
    /// 剩余可试次数，作为独立数值下发，不拼进文案
    pub attempts_left: Option<i64>,
    /// 已锁定时给出解除时间（ISO 8601），界面按它倒计时
    pub locked_until: Option<String>,
}

impl LoginOutcome {
    fn denied(error: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(error.into()),
            session: None,
            needs_password_setup: None,
            attempts_left: None,
            locked_until: None,
        }
    }

    fn denied_locked(error: impl Into<String>, until: Option<String>) -> Self {
        Self { locked_until: until, ..Self::denied(error) }
    }
}

/// 改密、重置、授权统一用它，免得前端要为三种命令写三套分支
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionOutcome {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug)]
struct Account {
    id: i64,
    username: String,
    display_name: String,
    password_hash: String,
    role: String,
    must_change_pwd: bool,
    failed_count: i64,
    locked_until: Option<String>,
    is_active: bool,
    deleted: bool,
}

/// 托管在 Tauri 的会话。`Arc` 出来才能进 `spawn_blocking`。
#[derive(Debug, Default)]
pub struct AuthState {
    inner: Arc<RwLock<Option<Session>>>,
}

impl AuthState {
    pub fn store(&self) -> Arc<RwLock<Option<Session>>> {
        self.inner.clone()
    }
}

type Store = Arc<RwLock<Option<Session>>>;

fn guard(store: &Store) -> RwLockWriteGuard<'_, Option<Session>> {
    store.write().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 当前会话（供命令与测试复用）；空闲超时**就地转入锁屏**而不清掉——
/// 登录态本身永久有效，锁屏只是要一次密码确认"人还是刚才那个人"。
fn live(store: &Store) -> Option<Session> {
    let mut current = guard(store);
    if let Some(session) = current.as_mut() {
        if !session.locked && idle_expired(&session.last_seen_at, Local::now(), session.idle_ttl_secs) {
            session.locked = true;
        }
    }
    current.clone()
}

/// 未锁定的当前会话：业务命令与权限判定用它，锁屏期间一律当作"没登录"。
fn unlocked(store: &Store) -> Option<Session> {
    live(store).filter(|session| !session.locked)
}

// ------------------------------------------------------------------- 哈希与会话

/// argon2id，参数用 argon2 crate 默认（OWASP 推荐 m=19 MiB / t=2 / p=1）。
/// 输出 PHC 串 `$argon2id$v=19$m=…$salt$hash`，与 `0001_init.sql` 的注释一致。
pub fn hash_password(plain: &str) -> Result<String, String> {
    Argon2::new(Algorithm::Argon2id, Version::V0x13, argon2::Params::default())
        // 随机盐由 password-hash 自己生成（getrandom 特征），不必手传
        .hash_password(plain.as_bytes())
        .map(|h| h.to_string())
        .map_err(|e| format!("生成密码哈希失败：{e}"))
}

/// 校验。存储值不是合法 PHC 串（例如仍是占位符）时回 `false` 而不是报错——
/// 占位符走 [`bootstrap_password`] 那条分支，不该被当成"哈希损坏"。
pub fn verify_password(plain: &str, stored: &str) -> bool {
    match PasswordHash::new(stored) {
        Ok(parsed) => Argon2::new(Algorithm::Argon2id, Version::V0x13, argon2::Params::default())
            .verify_password(plain.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// 随机不透明会话号：password-hash 在 `getrandom` 特征下给的 16 字节 OS 随机数，
/// 转 32 位十六进制。不新增直接依赖，字符集纯 [0-9a-f]，当 TEXT 存取都安全。
fn new_session_id() -> String {
    generate_salt().iter().map(|b| format!("{b:02x}")).collect()
}

/// 解析库里的 ISO 8601 时间。
///
/// 两处的失败方向**故意不同，别"统一"掉**：
/// - 锁定时间解析失败 ⇒ 视为未锁定（放行到密码校验，后面还有 argon2 兜底）；
/// - 会话时间解析失败 ⇒ 视为已失效（宁可让磅员重登一次，也不发一个来源不明的会话）。
fn parse_iso(value: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.with_timezone(&Local))
}

/// 纯函数，便于单测：空闲是否已超时
pub fn idle_expired(last_seen_at: &str, now: DateTime<Local>, ttl_secs: i64) -> bool {
    match parse_iso(last_seen_at) {
        Some(seen) => (now - seen) > chrono::Duration::seconds(ttl_secs),
        None => true,
    }
}

/// 库里那套 ISO 8601 本地时间 + 偏移的写法（03 §3.2）。测试也用它，避免第二份格式化器。
pub fn iso_of(now: DateTime<Local>) -> String {
    now.to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

// ------------------------------------------------------------------ 纯库操作

fn load_account(conn: &Connection, username: &str) -> Result<Option<Account>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT id, username, display_name, password_hash, role, must_change_pwd,
                failed_count, locked_until, is_active, deleted_at
         FROM user_account
         WHERE username = ?1 AND deleted_at IS NULL",
    )?;
    let found = stmt
        .query_map(params![username], |r| {
            Ok(Account {
                id: r.get(0)?,
                username: r.get(1)?,
                display_name: r.get(2)?,
                password_hash: r.get(3)?,
                role: r.get(4)?,
                must_change_pwd: r.get::<_, i64>(5)? == 1,
                failed_count: r.get(6)?,
                locked_until: r.get(7)?,
                is_active: r.get::<_, i64>(8)? == 1,
                deleted: r.get::<_, Option<String>>(9)?.is_some(),
            })
        })?
        .next()
        .transpose()?;
    Ok(found)
}

/// 写一条审计。审计写失败**不挡住登录**（磅房先能收粮，事后再补查），
/// 但也不能静默：落 stderr，打包版看 `startup_error.log` 同级的控制台输出渠道。
fn audit(
    conn: &Connection,
    actor_id: Option<i64>,
    actor_name: &str,
    action: &str,
    entity_id: Option<i64>,
    reason: Option<&str>,
    ok: bool,
    session_id: Option<&str>,
) {
    let result = conn.execute(
        "INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_id, reason, result, session_id, client_info)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            now_iso(),
            actor_id,
            actor_name,
            action,
            AUDIT_ENTITY,
            entity_id,
            reason,
            if ok { "ok" } else { "denied" },
            session_id,
            client_info(),
        ],
    );
    if let Err(e) = result {
        eprintln!("[banghe] 审计写入失败（{action}）：{e}");
    }
}

/// 一次校验的三种入口。登录不限岗位；授权必须是站长；解锁只验密、不签发新会话。
/// 三者共用同一套失败计数与锁定阈值，区别只在是否签发会话、是否写 `last_login_at`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Login,
    Authorize,
    /// 锁屏后输回本人密码：走同一套 argon2 校验与连错锁定，但不动 `issued_at`/`session_id`
    Unlock,
}

impl Kind {
    fn action(self) -> &'static str {
        match self {
            Kind::Login => "login",
            Kind::Authorize => "authorize",
            Kind::Unlock => "login.unlock",
        }
    }
}

/// 三段式的中间态（见模块头规矩 3）
enum Pending {
    /// 账号不存在（或授权时不是站长）：仍要在锁外烧一次假哈希拉平时序
    Burn,
    /// 已取到账号，等待锁外校验
    Await { account: Account, is_unset: bool },
    /// 不必校验就能定结论（停用、锁定有效期内、读库失败）
    Done(LoginOutcome),
}

/// 第一段：锁内取数与前置判定
fn precheck(conn: &Connection, username: &str, kind: Kind, session_id: Option<&str>, now: DateTime<Local>) -> Pending {
    let account = match load_account(conn, username) {
        Ok(Some(a)) => a,
        Ok(None) => {
            audit(conn, None, username, kind.action(), None, Some("账号不存在或已删除"), false, session_id);
            return Pending::Burn;
        }
        Err(e) => return Pending::Done(LoginOutcome::denied(format!("读取账号失败：{e}"))),
    };

    if !account.is_active || account.deleted {
        audit(conn, Some(account.id), &account.display_name, kind.action(), Some(account.id), Some("账号已停用"), false, session_id);
        return Pending::Done(LoginOutcome::denied(format!("「{}」已停用，请联系站长", account.username)));
    }
    if kind == Kind::Authorize && account.role != "station_master" {
        audit(conn, Some(account.id), &account.display_name, kind.action(), Some(account.id), Some("该账号不是站长，无权授权"), false, session_id);
        return Pending::Done(LoginOutcome::denied(format!("「{}」不是站长，不能授权", account.username)));
    }
    if lockout_active() {
        if let Some(raw) = &account.locked_until {
            if parse_iso(raw).map(|until| until > now).unwrap_or(false) {
                // 锁定有效期内不再校验、也不再累加计数——否则一次锁定能被无限续期
                return Pending::Done(LoginOutcome::denied_locked(
                    format!("密码连错 {MAX_FAILED} 次，账号已锁定，请稍后再试"),
                    Some(raw.clone()),
                ));
            }
            // 锁已过期（或时间串解析失败，按未锁定处理）：计数从头开始
        }
    }

    let is_unset = account.password_hash == PWD_UNSET;
    Pending::Await { account, is_unset }
}

/// 第二段：锁外校验。`false` 一律回 [`NO_DETAIL`]，不细分原因
fn verify_for(pending: &Pending, password: &str) -> bool {
    match pending {
        Pending::Burn => {
            let _ = dummy_verify(password);
            false
        }
        Pending::Await { account, is_unset } => {
            if *is_unset {
                password == bootstrap_password()
            } else {
                verify_password(password, &account.password_hash)
            }
        }
        Pending::Done(_) => false,
    }
}

/// 第三段：锁内落结论
fn conclude(
    conn: &Connection,
    pending: Pending,
    verified: bool,
    kind: Kind,
    session_id: Option<&str>,
    now: DateTime<Local>,
) -> LoginOutcome {
    let (account, is_unset) = match pending {
        Pending::Done(outcome) => return outcome,
        // 账号不存在：结论与"密码错"逐字相同
        Pending::Burn => return LoginOutcome::denied(NO_DETAIL),
        Pending::Await { account, is_unset } => (account, is_unset),
    };

    if !verified {
        let failed = account.failed_count + 1;
        let locking = lockout_active() && failed >= MAX_FAILED;
        let locked_until = if locking {
            Some(iso_of(now + chrono::Duration::minutes(LOCK_MINUTES)))
        } else {
            account
                .locked_until
                .clone()
                .filter(|raw| parse_iso(raw).map(|u| u > now).unwrap_or(false))
        };
        if let Err(e) = conn.execute(
            "UPDATE user_account SET failed_count = ?1, locked_until = ?2, updated_at = ?3 WHERE id = ?4",
            params![failed, locked_until, now_iso(), account.id],
        ) {
            return LoginOutcome::denied(format!("记录失败次数时出错：{e}"));
        }
        audit(conn, Some(account.id), &account.display_name, kind.action(), Some(account.id), Some("密码不正确"), false, session_id);
        return LoginOutcome {
            error: Some(if locking {
                format!("密码连错 {MAX_FAILED} 次，账号锁定 {LOCK_MINUTES} 分钟")
            } else {
                NO_DETAIL.to_string()
            }),
            // 占位符账号即使密码错，也要让界面停在"设置密码"那一步
            needs_password_setup: if is_unset { Some(true) } else { None },
            attempts_left: Some((MAX_FAILED - failed).max(0)),
            locked_until: if locking { locked_until } else { None },
            ..LoginOutcome::denied("")
        };
    }

    // 校验通过：清失败计数与锁定。登录才记 `last_login_at`——授权是替别人背书，不算他上线
    let stamp = now_iso();
    if kind == Kind::Login {
        conn.execute(
            "UPDATE user_account SET failed_count = 0, locked_until = NULL, last_login_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![stamp, account.id],
        )
        .ok();
    } else {
        conn.execute(
            "UPDATE user_account SET failed_count = 0, locked_until = NULL, updated_at = ?1 WHERE id = ?2",
            params![stamp, account.id],
        )
        .ok();
    }

    let actor = AuthProfile {
        id: account.id,
        username: account.username,
        display_name: account.display_name.clone(),
        role: account.role,
        must_change_pwd: account.must_change_pwd || is_unset,
    };
    let session = (kind == Kind::Login).then(|| Session {
        actor: actor.clone(),
        session_id: new_session_id(),
        issued_at: stamp.clone(),
        last_seen_at: stamp,
        idle_ttl_secs: IDLE_TTL_SECS,
        locked: false,
    });
    audit(
        conn,
        Some(actor.id),
        &actor.display_name,
        kind.action(),
        Some(actor.id),
        if is_unset { Some("使用装机初始密码") } else { None },
        true,
        session.as_ref().map(|s| s.session_id.as_str()).or(session_id),
    );

    LoginOutcome {
        ok: true,
        error: if is_unset { Some("该账号尚未设置密码，请先设置登录密码".to_string()) } else { None },
        session,
        needs_password_setup: Some(is_unset),
        attempts_left: Some(MAX_FAILED),
        locked_until: None,
    }
}

/// 账号不存在时也跑一次真实规模的 argon2，把响应时间拉平。
/// 假哈希串解析必然失败，[`verify_password`] 回 `false`——要紧的是计算量已经花出去了。
fn dummy_verify(plain: &str) -> bool {
    const STUB: &str = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$0000000000000000000000000000000000000000";
    verify_password(plain, STUB)
}

/// 一次完整校验：三段流程的现成包装。
///
/// 命令侧**不用**它——那会在持锁状态下算 argon2（见模块头规矩 3），所以命令里手拆三段、
/// 中间放掉锁。留给测试和不碰单连接的调用方，保证两侧走的是同一套判定逻辑。
#[allow(dead_code)]
pub fn authenticate(conn: &Connection, username: &str, password: &str, kind: Kind, session_id: Option<&str>) -> LoginOutcome {
    let now = Local::now();
    let pending = precheck(conn, username, kind, session_id, now);
    let verified = verify_for(&pending, password);
    conclude(conn, pending, verified, kind, session_id, now)
}

pub fn change_password(conn: &Connection, actor: &AuthProfile, old: &str, new: &str) -> ActionOutcome {
    if new.chars().count() < PWD_MIN_LEN {
        return ActionOutcome { ok: false, error: Some(format!("密码至少 {PWD_MIN_LEN} 位")) };
    }
    if new == PWD_UNSET || new == bootstrap_password() {
        return ActionOutcome { ok: false, error: Some("不能沿用装机初始密码，请另设一个".into()) };
    }
    let stored: String = match conn.query_row(
        "SELECT password_hash FROM user_account WHERE id = ?1 AND deleted_at IS NULL",
        params![actor.id],
        |r| r.get(0),
    ) {
        Ok(v) => v,
        Err(e) => return ActionOutcome { ok: false, error: Some(format!("读取账号失败：{e}")) },
    };
    let old_ok = if stored == PWD_UNSET {
        old == bootstrap_password()
    } else {
        verify_password(old, &stored)
    };
    if !old_ok {
        audit(conn, Some(actor.id), &actor.display_name, "password.change", Some(actor.id), Some("改密时原密码不正确"), false, None);
        return ActionOutcome { ok: false, error: Some(NO_DETAIL.to_string()) };
    }
    let hashed = match hash_password(new) {
        Ok(h) => h,
        Err(e) => return ActionOutcome { ok: false, error: Some(e) },
    };
    match conn.execute(
        "UPDATE user_account SET password_hash = ?1, must_change_pwd = 0, failed_count = 0, locked_until = NULL, updated_at = ?2 WHERE id = ?3",
        params![hashed, now_iso(), actor.id],
    ) {
        Ok(_) => {
            audit(conn, Some(actor.id), &actor.display_name, "password.change", Some(actor.id), None, true, None);
            ActionOutcome { ok: true, error: None }
        }
        Err(e) => ActionOutcome { ok: false, error: Some(format!("写入密码失败：{e}")) },
    }
}

/// 站长把某账号打回"待设密码"（现场两件事：员工忘密码、新账号首登）。
/// 打回后该账号只能用装机初始密码进一次，且必须改密。
pub fn reset_password(conn: &Connection, actor: &AuthProfile, target: i64) -> ActionOutcome {
    if actor.role != "station_master" {
        audit(conn, Some(actor.id), &actor.display_name, "password.reset", Some(target), Some("非站长尝试重置密码"), false, None);
        return ActionOutcome { ok: false, error: Some("只有站长可以重置他人密码".into()) };
    }
    let denied = |e: String| ActionOutcome { ok: false, error: Some(e) };
    let name: Option<String> = conn
        .query_row(
            "SELECT display_name FROM user_account WHERE id = ?1 AND deleted_at IS NULL",
            params![target],
            |r| r.get(0),
        )
        .ok();
    let Some(name) = name else {
        return denied("没有这个账号".into());
    };
    match conn.execute(
        "UPDATE user_account SET password_hash = ?1, must_change_pwd = 1, failed_count = 0, locked_until = NULL, updated_at = ?2 WHERE id = ?3",
        params![PWD_UNSET, now_iso(), target],
    ) {
        Ok(0) => denied("账号未发生改动".into()),
        Ok(_) => {
            audit(conn, Some(actor.id), &actor.display_name, "password.reset", Some(target), Some(&format!("重置「{name}」密码为待设置")), true, None);
            ActionOutcome { ok: true, error: None }
        }
        Err(e) => denied(format!("重置失败：{e}")),
    }
}

/// 留痕：`idle=true` 是空闲锁屏前的记一笔（会话并没被清掉），`idle=false` 是主动登出。
pub fn logout(conn: &Connection, actor: &AuthProfile, session_id: &str, idle: bool) -> ActionOutcome {
    audit(
        conn,
        Some(actor.id),
        &actor.display_name,
        if idle { "login.timeout" } else { "logout" },
        Some(actor.id),
        if idle { Some("超过 1 小时无操作，已锁屏") } else { None },
        true,
        Some(session_id),
    );
    ActionOutcome { ok: true, error: None }
}

// ------------------------------------------------------------------ Tauri 命令

/// 从 `AppHandle` 取出「连接 + 会话存储」。库没打开成功时程序不会进事件循环
/// （迁移失败在 `lib.rs` 里直接中止启动），所以这里的错误只可能是异常场景。
fn handles(app: &AppHandle) -> Result<(Arc<Mutex<Connection>>, Store), String> {
    let database = app
        .try_state::<Db>()
        .ok_or_else(|| "数据库尚未就绪（启动迁移未完成）".to_string())?;
    let auth = app
        .try_state::<AuthState>()
        .ok_or_else(|| "登录状态尚未就绪".to_string())?;
    Ok((database.shared(), auth.store()))
}

/// 当前登录人，供其它命令模块在 Rust 侧判岗位（`masters` 的档案写入就用它）。
/// 会话是**权限的最后一道闸**：前端的 `can()` 只管按钮显隐（05 §5），改不动这里。
/// 锁屏期间同样在这里就地拒绝——界面浮层可以被绕过，这里不能。
pub fn current_actor(app: &AppHandle) -> Option<AuthProfile> {
    let store = app.try_state::<AuthState>()?.store();
    unlocked(&store).map(|session| session.actor)
}

#[tauri::command]
pub async fn auth_login(app: AppHandle, username: String, password: String) -> Result<LoginOutcome, String> {
    let (pool, store) = handles(&app)?;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let name = username.trim().to_string();
        // 第一段 + 结论在锁内，第二段（argon2）在两次取锁之间跑
        let pending = locked(&pool, |conn| precheck(conn, &name, Kind::Login, None, Local::now()));
        let verified = verify_for(&pending, &password);
        locked(&pool, |conn| conclude(conn, pending, verified, Kind::Login, None, Local::now()))
    })
    .await
    .map_err(|e| format!("登录任务失败：{e}"))?;

    if let Some(session) = outcome.session.clone() {
        *guard(&store) = Some(session);
    }
    Ok(outcome)
}

/// 取回当前会话：WebView 刷新/HMR 后 JS 状态全丢，靠这条恢复，不必重打密码。
/// 已过空闲时限的会话在这里就地转入锁屏，`locked` 一并下发给前端弹锁屏浮层。
#[tauri::command]
pub async fn auth_session(app: AppHandle) -> Result<Option<Session>, String> {
    let (_, store) = handles(&app)?;
    Ok(live(&store))
}

/// 活动心跳：界面上的键盘/鼠标事件节流后打这里。回 `false` = 已锁屏，
/// 前端弹锁屏浮层（会话还在，不登出、不跳登录页，与 05 §6"离线不拦路"一致）。
#[tauri::command]
pub async fn auth_touch(app: AppHandle) -> Result<bool, String> {
    let (pool, store) = handles(&app)?;
    let just_locked = {
        let mut current = guard(&store);
        match current.as_mut() {
            None => None,
            Some(session) if session.locked => None,
            Some(session) => {
                if idle_expired(&session.last_seen_at, Local::now(), session.idle_ttl_secs) {
                    let stamp = (session.actor.clone(), session.session_id.clone());
                    session.locked = true;
                    Some(stamp)
                } else {
                    session.last_seen_at = now_iso();
                    None
                }
            }
        }
    };
    match just_locked {
        // 锁屏也留痕，否则"这单到底是谁打的"会断在无人值守的那段时间
        Some((actor, sid)) => {
            tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| logout(conn, &actor, &sid, true)))
                .await
                .map_err(|e| format!("锁屏处理任务失败：{e}"))?;
            Ok(false)
        }
        None => Ok(guard(&store).as_ref().map(|s| !s.locked).unwrap_or(true)),
    }
}

/// 锁屏解锁：只验**当前登录人本人**的密码，会话本身（session_id/issued_at）不变，
/// 锁屏前后仍是同一条审计链。连错同样走登录那套 5 次锁 15 分钟（Kind::Unlock 复用三段式）。
#[tauri::command]
pub async fn auth_unlock(app: AppHandle, password: String) -> Result<LoginOutcome, String> {
    let (pool, store) = handles(&app)?;
    let Some(session) = guard(&store).clone() else {
        return Ok(LoginOutcome::denied("没有可解锁的登录会话，请重新登录"));
    };
    let username = session.actor.username.clone();
    let sid = session.session_id.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let pending = locked(&pool, |conn| precheck(conn, &username, Kind::Unlock, Some(&sid), Local::now()));
        let verified = verify_for(&pending, &password);
        locked(&pool, |conn| conclude(conn, pending, verified, Kind::Unlock, Some(&sid), Local::now()))
    })
    .await
    .map_err(|e| format!("解锁任务失败：{e}"))?;
    if outcome.ok {
        let mut current = guard(&store);
        if let Some(s) = current.as_mut() {
            s.locked = false;
            s.last_seen_at = now_iso();
        }
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn auth_logout(app: AppHandle) -> Result<ActionOutcome, String> {
    let (pool, store) = handles(&app)?;
    let Some(session) = guard(&store).take() else {
        return Ok(ActionOutcome { ok: true, error: None });
    };
    let actor = session.actor.clone();
    let sid = session.session_id.clone();
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| logout(conn, &actor, &sid, false)))
        .await
        .map_err(|e| format!("登出任务失败：{e}"))
}

/// 设置 / 修改自己的密码。`mustChangePwd` 的账号在改完之前拿不到业务权限（前端守卫负责挡）。
#[tauri::command]
pub async fn auth_change_password(app: AppHandle, old: String, new: String) -> Result<ActionOutcome, String> {
    let (pool, store) = handles(&app)?;
    let Some(session) = unlocked(&store) else {
        return Ok(ActionOutcome { ok: false, error: Some("登录已失效或处于锁屏，请先处理后再试".into()) });
    };
    let actor = session.actor.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| change_password(&conn, &actor, &old, &new)))
        .await
        .map_err(|e| format!("改密任务失败：{e}"))?;
    if outcome.ok {
        // 会话里的标记就地改掉，免得前端还要再走一次 auth_session 才知道自己改完了
        if let Some(s) = guard(&store).as_mut() {
            s.actor.must_change_pwd = false;
        }
    }
    Ok(outcome)
}

#[tauri::command]
pub async fn auth_reset_password(app: AppHandle, target: i64) -> Result<ActionOutcome, String> {
    let (pool, store) = handles(&app)?;
    let Some(session) = unlocked(&store) else {
        return Ok(ActionOutcome { ok: false, error: Some("登录已失效或处于锁屏，请先处理后再试".into()) });
    };
    let actor = session.actor.clone();
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| reset_password(&conn, &actor, target)))
        .await
        .map_err(|e| format!("重置任务失败：{e}"))
}

/// 破坏性操作的站长授权（作废 / 红冲 / 补打，05 §10-7）。
/// 只回答"这个密码是不是某个在职站长的"，**不发会话**，也不动最后登录时间。
#[tauri::command]
pub async fn auth_verify_supervisor(app: AppHandle, username: String, password: String) -> Result<ActionOutcome, String> {
    let (pool, store) = handles(&app)?;
    let sid = guard(&store).as_ref().map(|s| s.session_id.clone()).unwrap_or_default();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let name = username.trim().to_string();
        let pending = locked(&pool, |conn| precheck(conn, &name, Kind::Authorize, Some(&sid), Local::now()));
        let verified = verify_for(&pending, &password);
        locked(&pool, |conn| conclude(conn, pending, verified, Kind::Authorize, Some(&sid), Local::now()))
    })
    .await
    .map_err(|e| format!("授权校验任务失败：{e}"))?;
    Ok(ActionOutcome { ok: outcome.ok, error: outcome.error })
}
