//! 个人界面偏好（§9.25 `user_preference` / `src-tauri/src/prefs.rs`）的行为守卫。
//!
//! 这张表很薄，但薄表上的三条语义一旦破了，界面上表现为"我的布局第二天又变回默认"，
//! 现场很难自己排查出来，所以钉死在这里：
//!  1. **按账号隔离**：磅员存的布局不能被站长读到，删账号要跟着级联消失——
//!     偏好不属留痕数据，不像单据署名那样需要保留；
//!  2. **覆盖式写入**：同一 (账号, 键) 只有一行，拖一次写一次不会把表撑成流水账；
//!  3. **闸门在库外**：键名字符集/长度、值必须合法 JSON 且有上限，都由 `check_*` 拦住，
//!     不给这张表留出"塞进任意文本"的口子。
//!
//! 命令层（`prefs_read` / `prefs_write`）与这里的差别只有"取会话 + 切阻塞线程池"，
//! 那两层由 `auth_contract.rs` 与桌面端实机覆盖，不在此重复。

use rusqlite::{params, Connection};

use banghe_lib::db;
use banghe_lib::prefs::{check_key, check_value, read, write};

const KEY: &str = "workstation.layout";

fn db_conn() -> Connection {
    db::in_memory_migrated("0.1.0", db::MIGRATIONS).expect("内存库应能跑完全部迁移脚本")
}

/// 0002/0003 种子给了 admin（id=1）；第二个账号自己插一条，用来验隔离。
fn second_user(conn: &Connection, username: &str) -> i64 {
    conn.execute(
        "INSERT INTO user_account (username, display_name, password_hash, role, is_active, created_at)
         VALUES (?1, ?1, 'x', 'weigher', 1, '2026-01-01T00:00:00.000+08:00')",
        params![username],
    )
    .expect("插入测试账号");
    conn.last_insert_rowid()
}

#[test]
fn absent_key_reads_none_so_frontend_falls_back_to_default() {
    let conn = db_conn();
    assert_eq!(read(&conn, 1, KEY).unwrap(), None, "没存过应当回 None，前端才有依据回落默认三栏");
}

#[test]
fn write_is_upsert_one_row_per_key() {
    let conn = db_conn();
    write(&conn, 1, KEY, r#"{"version":1,"items":[{"i":"weigh","x":0,"y":0,"w":6,"h":12}]}"#).unwrap();
    write(&conn, 1, KEY, r#"{"version":1,"items":[{"i":"weigh","x":6,"y":0,"w":6,"h":20}]}"#).unwrap();

    let got = read(&conn, 1, KEY).unwrap().expect("刚写的应当读得到");
    assert!(got.contains("\"x\":6"), "第二次写必须覆盖第一次：{got}");

    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM user_preference WHERE user_id = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 1, "同一 (账号,键) 只能有一行，否则拖一次布局就多存一行");
}

#[test]
fn accounts_are_isolated_and_follow_the_account_when_it_goes() {
    let conn = db_conn();
    let other = second_user(&conn, "lb");
    write(&conn, 1, KEY, r#"{"version":1,"items":[]}"#).unwrap();
    assert_eq!(read(&conn, other, KEY).unwrap(), None, "站长排的版不该出现在磅员的界面上");

    write(&conn, other, "theme.accent", r#""moss""#).unwrap();
    conn.execute("DELETE FROM user_account WHERE id = ?1", params![other])
        .expect("删账号");
    assert_eq!(
        read(&conn, other, "theme.accent").unwrap(),
        None,
        "偏好不是留痕数据：账号删了就该跟着级联消失"
    );
}

#[test]
fn key_gate_rejects_junk_names() {
    let long = "k".repeat(65);
    for bad in ["", "Workstation.Layout", "带中文", "a b", ".lead", "trail-", &long] {
        assert!(check_key(bad).is_err(), "键名 {bad:?} 不该放行");
    }
    for ok in ["workstation.layout", "theme", "a1", "qc-panel"] {
        assert!(check_key(ok).is_ok(), "键名 {ok:?} 应当放行");
    }
}

#[test]
fn value_gate_rejects_non_json_and_oversize() {
    assert!(check_value("").is_err(), "空串不是合法 JSON");
    assert!(check_value("{version:1").is_err(), "缺引号的伪 JSON 应当被拒");
    assert!(check_value(r#"{"version":1,"items":[]}"#).is_ok());

    let big = format!(r#"{{"pad":"{}"}}"#, "x".repeat(64 * 1024));
    assert!(check_value(&big).is_err(), "超过 64 KB 的偏好一定不是界面排布");
}
