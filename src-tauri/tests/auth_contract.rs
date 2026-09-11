//! 密码登录与会话的行为守卫（docs/design/02 §11 M10）
//!
//! 这里守的是**纸面单测抓不到的那类错**：文案泄露账号是否存在、初始密码改密后还能用、
//! 授权把别人的"最后登录时间"改了、会话哈希混进返回值。不连真库，全部走内存库 +
//! 真实迁移脚本，所以 `0003_seed_superadmin.sql` 有没有生效、超管能不能登，是在这里验的。
//!
//! 结构层面的断言（列、快照、枚举三源、篡改拒启）仍归 `schema_contract.rs`，不重复。

use chrono::{Duration, Local};
use rusqlite::Connection;

use banghe_lib::auth::{
    self, authenticate, change_password, hash_password, idle_expired, iso_of, logout, reset_password,
    AuthProfile, Kind, LoginOutcome, IDLE_TTL_SECS, MAX_FAILED, NO_DETAIL, PWD_MIN_LEN, PWD_UNSET,
};
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};

fn db() -> Connection {
    in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本")
}

fn login(conn: &Connection, username: &str, password: &str) -> LoginOutcome {
    authenticate(conn, username, password, Kind::Login, None)
}

fn authorize(conn: &Connection, username: &str, password: &str) -> LoginOutcome {
    authenticate(conn, username, password, Kind::Authorize, Some("test-session"))
}

fn text_of(conn: &Connection, username: &str, column: &str) -> Option<String> {
    conn.query_row(
        &format!("SELECT {column} FROM user_account WHERE username = ?1"),
        rusqlite::params![username],
        |r| r.get::<_, Option<String>>(0),
    )
    .ok()
    .flatten()
}

fn number_of(conn: &Connection, username: &str, column: &str) -> i64 {
    conn.query_row(
        &format!("SELECT {column} FROM user_account WHERE username = ?1"),
        rusqlite::params![username],
        |r| r.get(0),
    )
    .unwrap_or(-1)
}

fn add_account(conn: &Connection, username: &str, role: &str, hash: &str, active: bool) {
    conn.execute(
        "INSERT INTO user_account (username, display_name, password_hash, role, must_change_pwd, is_active, created_at)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)",
        rusqlite::params![
            username,
            format!("测试·{username}"),
            hash,
            role,
            if active { 1 } else { 0 },
            iso_of(Local::now()),
        ],
    )
    .expect("插入测试账号");
}

fn profile(id: i64, username: &str, role: &str) -> AuthProfile {
    AuthProfile {
        id,
        username: username.into(),
        display_name: username.into(),
        role: role.into(),
        must_change_pwd: false,
    }
}

// ------------------------------------------------------------------ 种子与首启

#[test]
fn superadmin_is_seeded_and_usable_only_via_install_bootstrap() {
    let conn = db();
    assert_eq!(
        text_of(&conn, "superadmin", "password_hash").as_deref(),
        Some(PWD_UNSET),
        "0003 的超管必须仍是占位哈希，不能看起来像能用"
    );
    assert_eq!(text_of(&conn, "superadmin", "role").as_deref(), Some("station_master"));

    let outcome = login(&conn, "superadmin", auth::bootstrap_password());
    assert!(outcome.ok, "装机初始密码应能登入预留超管：{:?}", outcome.error);
    assert_eq!(outcome.needs_password_setup, Some(true), "必须把界面切到设置密码");
    let session = outcome.session.expect("登录成功应发会话");
    assert!(session.actor.must_change_pwd, "首启账号的会话必须带强改标记");
    assert_eq!(session.idle_ttl_secs, IDLE_TTL_SECS, "失效时长由后端下发，前端不抄常量");
}

#[test]
fn admin_seed_still_ships_without_a_usable_hash() {
    let conn = db();
    // schema_contract 已经在结构上钉过一次，这里钉的是行为：占位符不是密码
    assert!(text_of(&conn, "admin", "password_hash").unwrap().starts_with('!'));
    let wrong = login(&conn, "admin", "");
    assert!(!wrong.ok);
    let right = login(&conn, "admin", auth::bootstrap_password());
    assert!(right.ok, "admin 与 superadmin 共用同一条首启规则：{:?}", right.error);
}

// ---------------------------------------------------------------- 防枚举与锁定

#[test]
fn unknown_user_and_wrong_password_answer_identically() {
    let conn = db();
    let ghost = login(&conn, "nobody", "whatever");
    let wrong = login(&conn, "superadmin", "wrong-on-purpose");
    assert_eq!(ghost.error.as_deref(), Some(NO_DETAIL));
    assert_eq!(wrong.error.as_deref(), Some(NO_DETAIL), "两种失败必须逐字相同，否则能枚举登录名");
    assert_eq!(ghost.attempts_left, None, "不存在的账号不该回剩余次数");
    assert_eq!(wrong.attempts_left, Some(MAX_FAILED - 1));
}

#[test]
fn lockout_kicks_in_at_threshold_and_blocks_the_right_password() {
    let conn = db();
    for i in 1..=MAX_FAILED {
        let outcome = login(&conn, "superadmin", "nope");
        assert!(!outcome.ok);
        assert_eq!(outcome.attempts_left, Some((MAX_FAILED - i).max(0)), "第 {i} 次的剩余次数");
    }
    assert_eq!(number_of(&conn, "superadmin", "failed_count"), MAX_FAILED);
    assert!(text_of(&conn, "superadmin", "locked_until").is_some(), "到阈值必须写下解除时间");

    // 锁定期内连正确密码都不给进，且不再累加计数（否则一次锁定能被无限续期）
    let blocked = login(&conn, "superadmin", auth::bootstrap_password());
    assert!(!blocked.ok, "锁定期内正确密码也必须拒");
    assert!(blocked.locked_until.is_some(), "要回解除时间给界面倒计时");
    assert_eq!(number_of(&conn, "superadmin", "failed_count"), MAX_FAILED, "锁定期内不累加");
}

#[test]
fn disabled_account_is_refused_by_name_not_by_password() {
    let conn = db();
    add_account(&conn, "fired", "weigher", PWD_UNSET, false);
    let outcome = login(&conn, "fired", auth::bootstrap_password());
    assert!(!outcome.ok);
    assert!(outcome.error.as_deref().unwrap().contains("已停用"), "停用要给明确原因：{:?}", outcome.error);
}

// ----------------------------------------------------------- 改密与初始密码退场

#[test]
fn changing_password_retires_the_bootstrap_route() {
    let conn = db();
    let first = login(&conn, "superadmin", auth::bootstrap_password()).session.expect("首启会话");
    let made = hash_password("banghe-2026").expect("生成哈希应成功");
    assert!(made.starts_with("$argon2id$"), "必须是 argon2id 的 PHC 串，与 0001 注释一致");
    assert!(auth::verify_password("banghe-2026", &made));
    assert!(!auth::verify_password("banghe-2027", &made));

    let changed = change_password(&conn, &first.actor, auth::bootstrap_password(), "banghe-2026");
    assert!(changed.ok, "改密应成功：{:?}", changed.error);
    assert_eq!(number_of(&conn, "superadmin", "must_change_pwd"), 0, "改完即清强改标记");

    let after = login(&conn, "superadmin", auth::bootstrap_password());
    assert!(!after.ok, "装机初始密码在改密后必须永久失效");
    let reuse = login(&conn, "superadmin", "banghe-2026");
    assert!(reuse.ok);
    assert_eq!(reuse.session.expect("正常会话").actor.must_change_pwd, false);
    assert_eq!(reuse.needs_password_setup, Some(false), "已是正式密码，不该再切设置密码界面");
}

#[test]
fn password_rules_reject_short_and_bootstrap_values() {
    let conn = db();
    let actor = login(&conn, "superadmin", auth::bootstrap_password()).session.unwrap().actor;
    let short = change_password(&conn, &actor, auth::bootstrap_password(), "123");
    assert!(!short.ok);
    assert!(short.error.unwrap().contains(&PWD_MIN_LEN.to_string()), "要说出长度要求");

    let same = change_password(&conn, &actor, auth::bootstrap_password(), auth::bootstrap_password());
    assert!(!same.ok, "不许把初始密码原样再设一遍");

    let wrong_old = change_password(&conn, &actor, "not-the-old-one", "brand-new-1");
    assert!(!wrong_old.ok);
    assert_eq!(wrong_old.error.as_deref(), Some(NO_DETAIL), "原密码错也不给细节");
    assert_eq!(
        text_of(&conn, "superadmin", "password_hash").as_deref(),
        Some(PWD_UNSET),
        "改密失败不能碰掉原哈希"
    );
}

#[test]
fn only_station_master_may_reset_others() {
    let conn = db();
    let target = number_of(&conn, "admin", "id");
    let weighed = profile(999, "weigher-1", "weigher");
    let denied = reset_password(&conn, &weighed, target);
    assert!(!denied.ok);
    assert_eq!(text_of(&conn, "admin", "password_hash").as_deref(), Some(PWD_UNSET));

    let master = profile(1, "admin", "station_master");
    add_account(&conn, "worker", "registrar", "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", true);
    let worker = number_of(&conn, "worker", "id");
    let done = reset_password(&conn, &master, worker);
    assert!(done.ok, "站长重置应成功：{:?}", done.error);
    assert_eq!(text_of(&conn, "worker", "password_hash").as_deref(), Some(PWD_UNSET), "重置即打回待设密码");
    assert_eq!(number_of(&conn, "worker", "must_change_pwd"), 1, "重置后必须强制改密");
    let ghost = reset_password(&conn, &master, 999_999);
    assert!(!ghost.ok, "不存在的账号要拒绝，不能回 ok");
}

// ------------------------------------------------------------------ 授权（背书）

#[test]
fn supervisor_authorize_never_signs_in_or_touches_last_login() {
    let conn = db();
    let before = text_of(&conn, "admin", "last_login_at");
    let outcome = authorize(&conn, "admin", auth::bootstrap_password());
    assert!(outcome.ok, "站长授权应通过：{:?}", outcome.error);
    assert!(outcome.session.is_none(), "授权只背书，不发会话");
    assert_eq!(text_of(&conn, "admin", "last_login_at"), before, "替别人背书不算他上线");

    add_account(&conn, "weigh2", "weigher", PWD_UNSET, true);
    let not_master = authorize(&conn, "weigh2", auth::bootstrap_password());
    assert!(!not_master.ok);
    assert!(not_master.error.unwrap().contains("不是站长"), "授权必须落在站长身上");
}

// ---------------------------------------------------------------- 会话与空闲失效

#[test]
fn idle_boundary_uses_the_ttl_and_fails_closed_on_garbage() {
    let now = Local::now();
    assert!(!idle_expired(&iso_of(now - Duration::minutes(59)), now, IDLE_TTL_SECS), "59 分钟仍在会话内");
    assert!(idle_expired(&iso_of(now - Duration::minutes(61)), now, IDLE_TTL_SECS), "超过 1 小时无操作即失效");
    assert!(idle_expired("不是时间串", now, IDLE_TTL_SECS), "时间解析不了就当作失效，宁可重登");
}

#[test]
fn logout_and_idle_timeout_are_separate_audit_actions() {
    let conn = db();
    let actor = login(&conn, "superadmin", auth::bootstrap_password()).unwrap_actor();
    logout(&conn, &actor, "sid-1", false);
    logout(&conn, &actor, "sid-2", true);
    let actions: Vec<String> = conn
        .prepare("SELECT action FROM audit_log WHERE action IN ('logout','login.timeout') ORDER BY action")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert_eq!(actions, vec!["login.timeout".to_string(), "logout".to_string()]);
}

// ------------------------------------------------------------------ 不外泄哈希

#[test]
fn nothing_leaks_the_hash_or_the_raw_counter() {
    let conn = db();
    let outcome = login(&conn, "superadmin", auth::bootstrap_password());
    let json = serde_json::to_string(&outcome).expect("会话可序列化");
    assert!(!json.contains("argon2"), "返回值里不许出现哈希串：{json}");
    assert!(!json.contains(PWD_UNSET), "占位符本身也不许出现在响应里");
    assert!(!json.to_lowercase().contains("passwordhash"), "字段名册里不许有哈希");
    assert!(!json.contains("failedCount"), "剩余次数走 attemptsLeft，不外泄原计数");
    assert!(json.contains("idleTtlSecs"), "失效时长要下发给前端");
}

#[test]
fn every_attempt_leaves_an_audit_trail() {
    let conn = db();
    let _ = login(&conn, "superadmin", auth::bootstrap_password());
    let _ = login(&conn, "superadmin", "bad");
    let _ = login(&conn, "ghost", "bad");
    let (ok, denied): (i64, i64) = conn
        .query_row(
            "SELECT SUM(result='ok'), SUM(result='denied') FROM audit_log WHERE action='login'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(ok, 1);
    assert_eq!(denied, 2, "越权/失败尝试同样要留痕（03 §9.21）");
    let with_session: i64 = conn
        .query_row("SELECT COUNT(*) FROM audit_log WHERE action='login' AND result='ok' AND session_id IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(with_session, 1, "成功登录的审计必须带会话号，否则串不起一次作业");
}

/// 让断言写得短一点：会话里的署名
trait UnwrapActor {
    fn unwrap_actor(self) -> AuthProfile;
}

impl UnwrapActor for LoginOutcome {
    fn unwrap_actor(self) -> AuthProfile {
        assert!(self.ok, "{:?}", self.error);
        self.session.expect("应有会话").actor
    }
}
