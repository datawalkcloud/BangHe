//! 档案编码留空时的自动补号（少打字优先：编码大多只是站内编号，不是业务信息）。
//!
//! 两条规矩：
//!  1. **补号只在新增时发生**。编辑已有档案却把编码清空，一律沿用原编码——历史磅单、
//!     导出配置都按编码留痕，重新编号等于把历史接不上。
//!  2. **占号判断查全表，不过滤 `deleted_at`**。软删行仍占着 UNIQUE 索引
//!     （见 `masters_contract.rs` 的 `a_soft_deleted_variety_still_owns_its_code`），
//!     生成出一个撞号的编码会直接让 INSERT 失败。

use rusqlite::{params, Connection};

/// 第一个没被占用的 `前缀 + width 位序号`（序号从 1 起，超出 width 位后自然进位）。
///
/// `used_sql` 必须是返回单个数字的 COUNT 查询，候选编码作为 `?1` 传入；各张表的唯一性
/// 范围不一样（品种/仓房/员工站内唯一、设备编码全局唯一），所以查询留给调用方写。
pub(crate) fn next_code(
    conn: &Connection,
    used_sql: &str,
    prefix: &str,
    width: usize,
    what: &str,
) -> Result<String, String> {
    for n in 1..=99_999i64 {
        let code = format!("{prefix}{n:0width$}");
        let used: i64 = conn
            .query_row(used_sql, params![code], |r| r.get(0))
            .map_err(|e| format!("生成{what}编码失败：{e}"))?;
        if used == 0 {
            return Ok(code);
        }
    }
    Err(format!("{what}编码已用尽，请手动填写一个"))
}

/// 取库里现存的那行编码，供「编辑时清空编码＝沿用原编码」回填。
///
/// `sql` 必须是返回单个文本列的查询，行主键作为 `?1` 传入。
pub(crate) fn stored_code(conn: &Connection, sql: &str, id: i64, what: &str) -> Result<String, String> {
    conn.query_row(sql, params![id], |r| r.get::<_, String>(0))
        .map_err(|_| format!("{what}保存失败：没找到这条档案，请刷新后重试"))
}
