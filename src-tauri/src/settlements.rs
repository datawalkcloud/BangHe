//! 结算台账（05 §3 `/settlements`、`/settlements/$settleNo`；01 §F5.2）
//!
//! 工作台 `orders::settle` 早已把 settlement / payment_record 写进真库，
//! 但台账页的读（详情 / 待结算池 / 挂账账龄）与补录付款仍指向 mock——
//! 桌面端出现「当场结清的钱在台账里查无此单」的裂缺，本模块把它接上。
//! 台账**列表**复用 `crate::reports::list_settlements`（命令 settlement_list），
//! 那份筛选是超集（收款人匹配 / 关键字转义 / 日期与 limit），这里不再造第二份。
//! 沿用 `orders.rs` 的规矩：DTO 与 `src/mock/types.ts` 逐字一致、
//! 业务校验回中文短句、写入走事务并落 `pay.record` 审计、
//! 岗位闸门以会话为准（入参 `operator_id` 一律忽略）。
//!
//! 与 mock 的**有意差异**（都是真库才立得住的口径）：
//!  - **补录付款不再顺手打上「售粮人已签」**（mock 付款即 `signed_by_party=1`）。
//!    签字发生在工作台结算屏（`party_signed`），出纳付款不等于农户签字。
//!  - **超额付款被拦**（mock 直接把 paid_fen 加超、状态转 paid）。台账页本来就
//!    禁着超额提交，真库把这条约束落到命令层，并发双开时不会付重。
//!  - **磅单已付数按结算明细逐单填满应付再轮到下一单**（mock 用
//!    `paid_fen / order_count` 平均分且落小数）。分摊顺序即凭证上的 `seq`。
//!  - **挂账时效读库键 `payment_due_warn_hours`（小时，72=3 天）**，与看板同源；
//!    mock 读的是 `payment_due_days`，数值等价。
//!  - 列表 / 挂账的行数在单机站点是百级，逐单复用 [`orders::load_settlement_by_id`]
//!    的 N+1 不构成手感问题，换来的是与工作台**完全同一份**的结算单形状。

use chrono::{Duration, Local, NaiveDate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::auth::AuthProfile;
use crate::orders::{
    audit, load_settlement_by_id, map_order_row, map_party_row, next_no, read_only, setting_int, write_tx, METHODS, ORDER_SELECT, PARTY_SELECT, SETTLE_ROLES,
};
use crate::orders::{Party, Settlement, WeighOrder};

fn now_iso() -> String {
    crate::db::migrate::now_iso()
}

/// 分 → 人话金额，用于校验文案（与前端 money() 同口径：两位小数）
fn yuan_text(fen: i64) -> String {
    format!("{:.2}", fen as f64 / 100.0)
}

// ------------------------------------------------------------------ 输出结构

/// §9.18 付款流水。TS 同构 `PaymentRecord`（mock/types.ts），
/// settle_no / order_no / party 都靠 JOIN 现算，流水表本身只挂外键。
#[derive(Debug, Clone, Serialize)]
pub struct PaymentRecord {
    pub id: i64,
    pub pay_no: String,
    pub settlement_id: Option<i64>,
    pub settle_no: Option<String>,
    pub order_id: Option<i64>,
    pub order_no: Option<String>,
    pub party_id: i64,
    pub party_name: String,
    pub amount_fen: i64,
    pub method: String,
    pub trade_no: Option<String>,
    pub payee_name: String,
    pub paid_at: String,
    pub operator_id: i64,
    pub voucher_no: Option<String>,
    pub reversed: i64,
    pub remark: Option<String>,
}

/// 结算单详情的三件套（05 §3 `/settlements/$settleNo`）：
/// 结算单本体 + 覆盖磅单（按结算顺序）+ 付款流水（按登记顺序）。
#[derive(Debug, Clone, Serialize)]
pub struct SettlementDetail {
    pub settlement: Settlement,
    pub orders: Vec<WeighOrder>,
    pub payments: Vec<PaymentRecord>,
}

/// 待结算池分组：一个售粮人 + 他名下压着的磅单（与 mock.pendingSettlements 同形）
#[derive(Debug, Clone, Serialize)]
pub struct PendingGroup {
    pub party: Party,
    pub rows: Vec<WeighOrder>,
}

/// 挂账行（账龄口径与 mock.creditRows 同形）：
/// due_date = 业务日 + 时效天数，overdue_days 只正不负。
#[derive(Debug, Clone, Serialize)]
pub struct CreditRow {
    pub settlement: Settlement,
    pub unpaid_fen: i64,
    pub due_date: String,
    pub overdue_days: i64,
}

// ------------------------------------------------------------------ 列表：走 reports.rs
// 台账列表复用 `crate::reports::list_settlements`（命令名 settlement_list，含
// 付款状态校验 / 关键字转义 / 日期与 limit），这里不再重复一份筛选实现——
// 两处同构查询迟早漂移，报表那份额外覆盖收款人姓名，是超集。

// ---------------------------------------------------------------------- 详情

pub fn settlement_detail(conn: &Connection, settle_no: &str) -> Result<Option<SettlementDetail>, String> {
    let id: Option<i64> = conn
        .query_row("SELECT id FROM settlement WHERE settle_no = ?1", params![settle_no], |r| r.get(0))
        .optional()
        .map_err(|e| format!("读取结算单失败：{e}"))?;
    let Some(id) = id else { return Ok(None) };
    let settlement = load_settlement_by_id(conn, id)?.ok_or_else(|| "读取结算单失败：单据在读取途中消失".to_string())?;

    // 覆盖磅单走 ORDER_SELECT 全列（详情页要品种 / 单价 / 应付 / 状态），按 seq 排
    let orders_sql = format!("{ORDER_SELECT} JOIN settlement_order so ON so.order_id = o.id WHERE so.settlement_id = ?1 ORDER BY so.seq");
    let orders: Vec<WeighOrder> = conn
        .prepare_cached(&orders_sql)
        .and_then(|mut st| st.query_map(params![id], map_order_row).and_then(|m| m.collect::<Result<Vec<_>, _>>()))
        .map_err(|e| format!("读取结算覆盖磅单失败：{e}"))?;

    let payments: Vec<PaymentRecord> = conn
        .prepare_cached(
            "SELECT pr.id, pr.pay_no, pr.settlement_id, s.settle_no, pr.order_id, o.order_no,
                    COALESCE(s.party_id, o.party_id, 0), COALESCE(p.name, ''),
                    pr.amount_fen, pr.method, pr.trade_no,
                    COALESCE(pr.payee_name, s.payee_name, p.name, ''), pr.paid_at, pr.operator_id,
                    pr.voucher_no, pr.reversed, pr.remark
             FROM payment_record pr
             LEFT JOIN settlement s ON s.id = pr.settlement_id
             LEFT JOIN weigh_order o ON o.id = pr.order_id
             LEFT JOIN party p ON p.id = COALESCE(s.party_id, o.party_id)
             WHERE pr.settlement_id = ?1 ORDER BY pr.id",
        )
        .and_then(|mut st| {
            st.query_map(params![id], |r| {
                Ok(PaymentRecord {
                    id: r.get(0)?,
                    pay_no: r.get(1)?,
                    settlement_id: r.get(2)?,
                    settle_no: r.get(3)?,
                    order_id: r.get(4)?,
                    order_no: r.get(5)?,
                    party_id: r.get(6)?,
                    party_name: r.get(7)?,
                    amount_fen: r.get(8)?,
                    method: r.get(9)?,
                    trade_no: r.get(10)?,
                    payee_name: r.get(11)?,
                    paid_at: r.get(12)?,
                    operator_id: r.get(13)?,
                    voucher_no: r.get(14)?,
                    reversed: r.get(15)?,
                    remark: r.get(16)?,
                })
            })
            .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        })
        .map_err(|e| format!("读取付款流水失败：{e}"))?;

    Ok(Some(SettlementDetail { settlement, orders, payments }))
}

// ------------------------------------------------------------------ 待结算池

/// to_settle / reweigh 的压池磅单，按售粮人分组、张数多者在前（当天不清就是悬空数）。
pub fn pending_settlements(conn: &Connection) -> Result<Vec<PendingGroup>, String> {
    let rows: Vec<WeighOrder> = conn
        .prepare_cached(&format!("{ORDER_SELECT} WHERE o.status IN ('to_settle','reweigh') ORDER BY o.registered_at ASC"))
        .and_then(|mut st| st.query_map([], map_order_row).and_then(|m| m.collect::<Result<Vec<_>, _>>()))
        .map_err(|e| format!("读取待结算池失败：{e}"))?;

    let mut groups: Vec<(i64, Vec<WeighOrder>)> = Vec::new();
    for o in rows {
        match groups.iter_mut().find(|(pid, _)| *pid == o.party_id) {
            Some((_, rows)) => rows.push(o),
            None => groups.push((o.party_id, vec![o])),
        }
    }
    let mut out = Vec::with_capacity(groups.len());
    for (pid, rows) in groups {
        let party: Party = conn
            .query_row(&format!("{PARTY_SELECT} WHERE id = ?1"), params![pid], map_party_row)
            .map_err(|e| format!("读取待结算池售粮人失败：{e}"))?;
        out.push(PendingGroup { party, rows });
    }
    out.sort_by(|a, b| b.rows.len().cmp(&a.rows.len()).then(a.party.name.cmp(&b.party.name)));
    Ok(out)
}

// -------------------------------------------------------------------- 挂账

/// 挂账 = 未付清且未撤销的结算单。时效读 `payment_due_warn_hours`（小时），
/// 换算成天向上取整（72h = 3 天，与 mock 的 payment_due_days=3 数值等价）。
pub fn credits(conn: &Connection) -> Result<Vec<CreditRow>, String> {
    let due_days = (setting_int(conn, "payment_due_warn_hours", 72) + 23) / 24;
    let ids: Vec<i64> = conn
        .prepare_cached("SELECT s.id FROM settlement s WHERE s.status = 'normal' AND s.payment_status <> 'paid' ORDER BY s.business_date ASC, s.id ASC")
        .and_then(|mut st| st.query_map([], |r| r.get(0)).and_then(|m| m.collect::<Result<Vec<_>, _>>()))
        .map_err(|e| format!("读取挂账台账失败：{e}"))?;

    let today = Local::now().date_naive();
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let Some(s) = load_settlement_by_id(conn, id)? else { continue };
        let settled_day = NaiveDate::parse_from_str(&s.business_date, "%Y-%m-%d").unwrap_or(today);
        let elapsed = today.signed_duration_since(settled_day).num_days();
        out.push(CreditRow {
            unpaid_fen: s.payable_fen - s.paid_fen,
            due_date: (settled_day + Duration::days(due_days)).format("%Y-%m-%d").to_string(),
            overdue_days: (elapsed - due_days).max(0),
            settlement: s,
        });
    }
    out.sort_by(|a, b| b.overdue_days.cmp(&a.overdue_days).then(a.due_date.cmp(&b.due_date)));
    Ok(out)
}

// ---------------------------------------------------------------- 登记付款

/// 出纳补录付款。字段沿用 mock.recordPayment 入参（snake_case 直传）；
/// `operator_id` 以会话为准，这里只为兼容前端签名而保留。
#[derive(Debug, Deserialize)]
pub struct RecordPaymentInput {
    pub settle_no: String,
    pub amount_fen: i64,
    pub method: String,
    #[serde(default)]
    pub trade_no: Option<String>,
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
}

pub fn record_payment(conn: &Connection, actor: &AuthProfile, input: RecordPaymentInput) -> Result<Option<Settlement>, String> {
    if input.amount_fen <= 0 {
        return Err("本次付款金额必须大于 0".into());
    }
    if !METHODS.contains(&input.method.as_str()) {
        return Err(format!("未知付款方式「{}」", input.method));
    }
    let trade_no = input.trade_no.clone().unwrap_or_default().trim().to_string();
    if input.method != "cash" && trade_no.is_empty() {
        return Err("非现金付款请填交易流水号，便于对账".into());
    }

    type Head = (i64, String, String, i64, i64, String);
    let head: Option<Head> = conn
        .query_row(
            "SELECT s.id, s.settle_no, COALESCE(s.payee_name, p.name), s.payable_fen, s.paid_fen, s.status
             FROM settlement s JOIN party p ON p.id = s.party_id WHERE s.settle_no = ?1",
            params![input.settle_no],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(|e| format!("读取结算单失败：{e}"))?;
    let Some((id, settle_no, payee_name, payable, paid, status)) = head else {
        return Ok(None);
    };
    if status == "revoked" {
        return Err("本结算单已撤销，不能再登记付款".into());
    }
    let unpaid = payable - paid;
    if input.amount_fen > unpaid {
        return Err(format!("本次付款 {} 元超出未付余额 {} 元", yuan_text(input.amount_fen), yuan_text(unpaid)));
    }

    let now = now_iso();
    let pay_no = next_no(conn, "FK")?;
    conn.execute(
        "INSERT INTO payment_record (pay_no, settlement_id, order_id, amount_fen, method, trade_no, payee_name, paid_at, operator_id, reversed, created_at, created_by)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?7, ?8)",
        params![
            pay_no, id, input.amount_fen, input.method,
            if trade_no.is_empty() { None } else { Some(trade_no.as_str()) },
            payee_name, now, actor.id,
        ],
    )
    .map_err(|e| format!("付款流水写入失败：{e}"))?;

    let new_paid = paid + input.amount_fen;
    let new_status = if new_paid >= payable { "paid" } else { "partial" };
    conn.execute(
        "UPDATE settlement SET paid_fen = ?2, payment_status = ?3, main_method = ?4, updated_at = ?5 WHERE id = ?1",
        params![id, new_paid, new_status, input.method, now],
    )
    .map_err(|e| format!("更新结算单付款状态失败：{e}"))?;

    // 磅单侧分摊：按结算明细 seq 逐单填满该行应付，余数轮到下一单（末单承担四舍五入差）
    let rows: Vec<(i64, i64)> = conn
        .prepare_cached(
            "SELECT so.order_id, COALESCE(o.payable_amount_fen, 0)
             FROM settlement_order so JOIN weigh_order o ON o.id = so.order_id
             WHERE so.settlement_id = ?1 ORDER BY so.seq",
        )
        .and_then(|mut st| st.query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?))).and_then(|m| m.collect::<Result<Vec<_>, _>>()))
        .map_err(|e| format!("读取结算明细失败：{e}"))?;
    let mut left = new_paid;
    for (order_id, order_payable) in rows {
        let alloc = left.min(order_payable.max(0));
        left -= alloc;
        let o_status = if order_payable > 0 && alloc >= order_payable {
            "paid"
        } else if alloc > 0 {
            "partial"
        } else {
            "unpaid"
        };
        conn.execute(
            "UPDATE weigh_order SET
                paid_amount_fen = ?2, payment_status = ?3, payment_method = ?4,
                paid_at = CASE WHEN ?3 = 'paid' THEN COALESCE(paid_at, ?5) ELSE paid_at END,
                updated_at = ?5
             WHERE id = ?1",
            params![order_id, alloc, o_status, input.method, now],
        )
        .map_err(|e| format!("回写磅单付款状态失败：{e}"))?;
    }

    audit(
        conn,
        actor,
        "pay.record",
        "settlement",
        &settle_no,
        Some(&format!("登记付款 {pay_no} {} 元（{}）", yuan_text(input.amount_fen), input.method)),
        None,
    );
    load_settlement_by_id(conn, id)
}

// ----------------------------------------------------------------- Tauri 命令
// 读不设岗（与 orders.rs 同口径）；补录付款限出纳/站长（05 §6.1 pay.record）。

#[tauri::command]
pub async fn settlement_get(app: AppHandle, no: String) -> Result<Option<SettlementDetail>, String> {
    read_only(&app, move |conn| settlement_detail(conn, &no), "结算单读取").await
}

#[tauri::command]
pub async fn settlement_pending(app: AppHandle) -> Result<Vec<PendingGroup>, String> {
    read_only(&app, pending_settlements, "待结算池读取").await
}

#[tauri::command]
pub async fn settlement_credits(app: AppHandle) -> Result<Vec<CreditRow>, String> {
    read_only(&app, credits, "挂账台账读取").await
}

#[tauri::command]
pub async fn payment_add(app: AppHandle, input: RecordPaymentInput) -> Result<Option<Settlement>, String> {
    write_tx(&app, move |conn, actor| record_payment(conn, actor, input), SETTLE_ROLES, "登记付款").await
}
