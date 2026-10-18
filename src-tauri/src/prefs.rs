//! 个人界面偏好（§9.25 `user_preference`）。
//!
//! 目前只有一个消费者：磅房工作台的自定义布局（05 §4）。它和 `app_setting`（§9.3）
//! 的区别是**归属**——站点参数全站一份、由站长改、改了要留审计；布局是每个操作员
//! 自己的事，磅员把称重区拉大不影响化验员。所以另起一张按 `(user_id, key)` 主键的表，
//! 也不套 `setting.write` 那道站长闸：登录态即可读写自己那一行。
//!
//! 服务端**不解释值的结构**。布局是前端的概念（`src/components/workstation/layout.ts`
//! 才有面板注册表与默认排布），这里只守三条对任何偏好都成立的底线：
//!  1. 键名限长限字符集，防止这张表变成谁都能塞的杂物间；
//!  2. 值必须是合法 JSON，且不超过 64 KB——一次布局撑死 2 KB，超了就是前端出 bug
//!     或有人在拿它传别的东西，拒掉比存下来好收拾；
//!  3. 只写当前会话本人那一行，`user_id` 由 [`auth::current_actor`] 给出，入参里没有它。

use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};

use crate::auth;
use crate::db::{locked, Db};

type Pool = Arc<Mutex<Connection>>;

/// 单次偏好的上限。一份 6 面板的 12 列布局约 500 B，留足冗余也是道护栏。
const MAX_VALUE_BYTES: usize = 64 * 1024;

fn pool_of(app: &AppHandle) -> Result<Pool, String> {
    app.try_state::<Db>()
        .map(|d| d.shared())
        .ok_or_else(|| "数据库尚未就绪（启动迁移未完成）".to_string())
}

/// 当前登录者。偏好是"他自己的那一行"，没有会话就无从归属，直接拒。
fn actor_id(app: &AppHandle) -> Result<i64, String> {
    auth::current_actor(app)
        .map(|a| a.id)
        .ok_or_else(|| "登录已失效，请重新登录后再保存界面设置".to_string())
}

/// 键名口径：小写字母/数字起始，后接小写字母、数字、`.`、`_`、`-`，总长 ≤ 64。
/// 与前端 `src/components/workstation/layout.ts` 里的 `LAYOUT_KEY` 同源。
pub fn check_key(key: &str) -> Result<(), String> {
    let ok = !key.is_empty()
        && key.len() <= 64
        && key.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && key.ends_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
        && key
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'));
    if ok {
        Ok(())
    } else {
        Err(format!("偏好键名不合法：{key}"))
    }
}

/// 值的两道闸：合法 JSON + 长度上限。都不看内容结构——布局长什么样是前端的事。
pub fn check_value(value_json: &str) -> Result<(), String> {
    if value_json.len() > MAX_VALUE_BYTES {
        return Err(format!(
            "偏好内容过大（{} KB，上限 {} KB），已拒绝保存",
            value_json.len() / 1024,
            MAX_VALUE_BYTES / 1024
        ));
    }
    serde_json::from_str::<serde_json::Value>(value_json)
        .map_err(|e| format!("偏好内容不是合法 JSON：{e}"))?;
    Ok(())
}

/// 以下三条 `pub` 只是给 `tests/prefs_contract.rs` 的口子：命令层与它们只差
/// "取会话 + 切阻塞线程池"，SQL 与闸门本身要能脱离 Tauri 运行时被验证。
pub fn read(conn: &Connection, user_id: i64, key: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT value_json FROM user_preference WHERE user_id = ?1 AND key = ?2",
        params![user_id, key],
        |r| r.get::<_, String>(0),
    )
    .map(Some)
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(None),
        other => Err(format!("偏好读取失败：{other}")),
    })
}

/// 覆盖式写入。返回值是落库时间，前端用它提示"已保存"，不必再读一次。
pub fn write(conn: &Connection, user_id: i64, key: &str, value_json: &str) -> Result<String, String> {
    let at = crate::db::migrate::now_iso();
    conn.execute(
        "INSERT INTO user_preference (user_id, key, value_json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json,
                                                 updated_at = excluded.updated_at",
        params![user_id, key, value_json, at],
    )
    .map_err(|e| format!("偏好保存失败：{e}"))?;
    Ok(at)
}

/// 取本人某键的偏好值（JSON 文本）。没存过回 `null`，由前端回落默认布局。
#[tauri::command]
pub async fn prefs_read(app: AppHandle, key: String) -> Result<Option<String>, String> {
    let pool = pool_of(&app)?;
    let user_id = actor_id(&app)?;
    check_key(&key)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| read(conn, user_id, &key)))
        .await
        .map_err(|e| format!("偏好读取任务失败：{e}"))?
}

/// 存本人某键的偏好值。幂等：同一份内容重复写只是刷新 `updated_at`。
#[tauri::command]
pub async fn prefs_write(
    app: AppHandle,
    key: String,
    value_json: String,
) -> Result<String, String> {
    let pool = pool_of(&app)?;
    let user_id = actor_id(&app)?;
    check_key(&key)?;
    check_value(&value_json)?;
    tauri::async_runtime::spawn_blocking(move || {
        locked(&pool, |conn| write(conn, user_id, &key, &value_json))
    })
    .await
    .map_err(|e| format!("偏好保存任务失败：{e}"))?
}
