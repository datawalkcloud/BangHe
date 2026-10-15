//! 化验单读（05 §3 `/qc/$reportNo`；02 §F3 质检；01 §F3.4 复检并排）
//!
//! 质检页的**列表**早已走 `orders::list_qc`（命令 `qc_list`），但两张读面还留在
//! mock：质检页的「待检队列」（`qcQueue`）与质检单详情（`getQc`）。后果不是"少个
//! 数据源"而是**同一页两种真相**——桌面端列表里是真库单号，点进去用真单号查 mock
//! 内存必然查不到，页面显示空白；而队列 tab 里全是演示数据，现场真实登记的待检车
//! 一辆都不出现。本模块把这两条补齐。
//!
//! 复用 `orders::load_qc` 而不是再写一份 SELECT：化验单的字段口径（证号 CAST、
//! 品种快照、指标明细按 sort_order）只该有一个出处，否则复检对比列与工作台
//! 看到的化验值会慢慢分叉。
//!
//! 与 mock 的**有意差异**（都是真库才立得住的口径）：
//!  - **待检队列含「已毛重未化验」**。mock 只认 `draft`/`registered`，而粮站实际
//!    流程是抽样→毛重→化验→皮重（`orders.rs:1539` 的 `qc_done` 迁移就是这条），
//!    毛重后还没出单的車正是质检员最该看到的那批。
//!  - **队列只认「没有有效化验单」**：`is_effective = 0` 的留档单（被复检替换）
//!    不算已检完，与 `settle` 取计价依据时只看有效单的口径同源。
//!  - 复检单详情把首检单一起带回（`first`），页面据此渲染并排对比列，
//!    与 mock 的 `{ report, first? }` 形状逐字一致。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::AppHandle;

use crate::orders::{load_qc, map_order_row, read_only, QcReport, WeighOrder, ORDER_SELECT};

/// 详情页的返回形状：`first` 缺席时整个字段不出现，与 mock 的 `{ report, first? }` 对齐
#[derive(Debug, Clone, Serialize)]
pub struct QcDetail {
    pub report: QcReport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first: Option<QcReport>,
}

/// 队列里"还没出有效化验单"的磅单状态。结算之后的单不进队列（该看台账不该看质检）。
const PENDING_STATUSES: &str = "'draft','registered','qc_done','gross_weighed','tare_weighed','reweigh'";

pub fn qc_detail(conn: &Connection, report_no: &str) -> Result<Option<QcDetail>, String> {
    let hit: Option<(i64, Option<i64>)> = conn
        .query_row("SELECT id, first_report_id FROM qc_report WHERE report_no = ?1", params![report_no], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| format!("读取化验单失败：{e}"))?;
    let Some((id, first_id)) = hit else { return Ok(None) };
    let Some(report) = load_qc(conn, id)? else { return Ok(None) };
    let first = match first_id {
        Some(fid) => load_qc(conn, fid)?,
        None => None,
    };
    Ok(Some(QcDetail { report, first }))
}

/// 待检队列：已登记但还没有有效化验单的磅单，先登先检。
pub fn qc_queue(conn: &Connection) -> Result<Vec<WeighOrder>, String> {
    let sql = format!(
        "{ORDER_SELECT} WHERE o.status IN ({PENDING_STATUSES})
           AND NOT EXISTS (SELECT 1 FROM qc_report q WHERE q.order_id = o.id AND q.is_effective = 1)
         ORDER BY o.registered_at, o.id"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取待检队列失败：{e}"))?;
    let rows = stmt
        .query_map([], map_order_row)
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取待检队列失败：{e}"))?;
    Ok(rows)
}

#[tauri::command]
pub async fn qc_get(app: AppHandle, no: String) -> Result<Option<QcDetail>, String> {
    read_only(&app, move |conn| qc_detail(conn, &no), "化验单读取").await
}

#[tauri::command]
pub async fn qc_queue_list(app: AppHandle) -> Result<Vec<WeighOrder>, String> {
    read_only(&app, qc_queue, "待检队列读取").await
}
