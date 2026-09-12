//! 付款流水读（05 §3 `/payments`；03 §9.18 payment_record）
//!
//! `/payments` 页的挂账账龄早已走真库（`settlements::credits`），但同一屏的
//! 「付款流水」与「付款方式分布」还指着 mock——页头上的"流水合计"与"挂账余额"
//! 来自两个世界，出纳对不平也无从归因。本模块补这两个读接口，`payment_record`
//! 自此只有一份真相。只读，不设角色闸门（与 `reports.rs` / `ledger.rs` 同口径）。
//!
//! DTO 直接复用 [`crate::settlements::PaymentRecord`]：那张结构就是 `src/mock/types.ts`
//! 的 `PaymentRecord`，两处各写一份迟早漂移（`settlements.rs` 复用
//! `reports::list_settlements` 是同一个理由）。列映射也与 `settlement_detail` 里的
//! 付款流水 SELECT 逐字同构：**写侧怎么落库（`orders::settle` 当场结清、
//! `settlements::record_payment` 补录收款），读侧就怎么出来**。
//!
//! 取数口径对齐 mock（`mock/api.ts::listPayments`、`mock/analytics.ts::paymentMethodDist`）：
//!  - 日期用 `substr(pr.paid_at, 1, 10)` 与 `YYYY-MM-DD` 做**闭区间**字符串比较，与 mock 的
//!    `paid_at.slice(0, 10) >= from && <= to` 一字不差。不走 `idx_pay_date` 的范围扫描：
//!    真库的 `paid_at` 带毫秒与 `+08:00` 偏移，改成 `>= from AND < 次日` 就得再信一次格式，
//!    而单机站点的量级用不上这个索引。
//!  - 行序 = 登记顺序（`pr.id` 升序），与 mock 的数组给序同向；页面默认排序不参与排序。
//!  - 分布只统计 `reversed = 0` 并按金额倒序；**列表不滤冲销**，页面自己显示"已冲销"。
//!
//! 与 mock 的**有意差异**（都是真库才立得住的口径）：
//!  - **`tone` 按渠道恒定**（下面的 `CHANNELS`），不再是 mock 的 `tones[i % 5]` 按下标轮转——
//!    那种假随机会让同一张图换个区间就改色，图例与颜色对不上号。
//!  - **中文渠道名逐字抄 `src/lib/constants.ts` 的 `PAYMENT_METHOD`**，Rust 侧不另造叫法。
//!  - **空日期 = 这一头不限**：页面的日期输入框可以清空，mock 收到 `""` 时 `d <= ""` 恒假、
//!    整张表空掉；真库按"不设下/上界"处理。格式非法（不是 `YYYY-MM-DD`）用中文短句拒绝，
//!    不静默回空表骗人在。
//!  - **行数上限** [`MAX_PAYMENT_ROWS`]：撞上限时**中文短句拒绝**，不静默截断。返回形状必须
//!    与 mock 一致（`Vec<PaymentRecord>`），塞不进"已截断"的标记，而页头的期间付款额是页面
//!    对返回全集求和——半截清单会算出一个看起来完全正确的错数，比查不到更坏。
//!    分布图不受此限（在 SQL 里聚合，行数恒 ≤ 渠道数）。服务端合计与分页是下一轮的事，
//!    届时连同这里的拒绝分支一起换成 `total` + 分页参数。

use chrono::{Local, NaiveDate};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection, Row};
use serde::Serialize;
use tauri::AppHandle;

use crate::orders::read_only;
pub use crate::settlements::PaymentRecord;

/// 一次取回的行数上限，与 `reports.rs` 的 `MAX_SETTLEMENT_LIMIT` 同值：
/// 两页用同一把尺子，前端才不用为付款流水再记一个数。
const MAX_PAYMENT_ROWS: i64 = 2000;

/// 渠道码 →（中文渠道名，固定配色）。
/// 第二列**逐字抄** `src/lib/constants.ts` 的 `PAYMENT_METHOD`（两边不一致就是新的口径坑），
/// 第三列只允许 `Tone` 的五个合法值之一：现金是"当场收钱"（success）、银行/微信/一卡通是
/// 常规电汇（info）、支付宝是第三方渠道要盯一眼（warning）、挂账核销不是现金流入（neutral）。
const CHANNELS: [(&str, &str, &str); 6] = [
    ("cash", "现金", "success"),
    ("bank", "银行转账", "info"),
    ("wechat", "微信", "info"),
    ("alipay", "支付宝", "warning"),
    ("transfer", "社保卡/一卡通", "info"),
    ("credit_writeoff", "挂账核销", "neutral"),
];

/// 流水表本体只挂外键，单号与收款人都得 JOIN 出来（与 `settlements::settlement_detail` 同句）。
/// 挂结算单的取 `settlement.party_id`，只挂磅单的（§9.18 允许不合并直接付款）回退
/// `weigh_order.party_id → party`。
/// **`account_enc`（银行账号密文）不在列清单里**：DTO 没有这个字段，密文就不会经这条读路径出门。
const PAYMENT_SELECT: &str = "SELECT pr.id, pr.pay_no, pr.settlement_id, s.settle_no, pr.order_id, o.order_no,
       COALESCE(s.party_id, o.party_id, 0), COALESCE(p.name, ''),
       pr.amount_fen, pr.method, pr.trade_no,
       COALESCE(pr.payee_name, s.payee_name, p.name, ''), pr.paid_at, pr.operator_id,
       pr.voucher_no, pr.reversed, pr.remark
FROM payment_record pr
LEFT JOIN settlement s ON s.id = pr.settlement_id
LEFT JOIN weigh_order o ON o.id = pr.order_id
LEFT JOIN party p ON p.id = COALESCE(s.party_id, o.party_id)";

fn map_payment_row(r: &Row<'_>) -> rusqlite::Result<PaymentRecord> {
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
}

/// 一片渠道分布（与 mock.paymentMethodDist 的 `{ label, fen, tone }` 逐字同形）。
/// `tone` 用 `&'static str` 而不是 String：取值被 `CHANNELS` 关死，写不出 `Tone` 之外的配色。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MethodSlice {
    pub label: String,
    pub fen: i64,
    pub tone: &'static str,
}

// --------------------------------------------------------------------- 纯库操作
// 全部收 &Connection、不碰 Tauri 状态，tests/payments_contract.rs 直接跑这段。

/// 日期界校验：空 / 全空白 ⇒ `None`（这一头不限），否则必须是 `YYYY-MM-DD`。
/// 先卡长度再交给 chrono：`%Y-%m-%d` 认 "2026-1-5"，而不补零的串一旦进了字符串比较，
/// `"2026-1-5" > "2026-09-12"` 会把整段区间错位——mock 那边同样按字符串前缀比，两边一起错
/// 才对不上，所以宁可在入口拒绝。
fn parse_bound(raw: &str, which: &str) -> Result<Option<String>, String> {
    let v = raw.trim();
    if v.is_empty() {
        return Ok(None);
    }
    if v.len() != 10 || NaiveDate::parse_from_str(v, "%Y-%m-%d").is_err() {
        return Err(format!("{which}格式应为 YYYY-MM-DD，例如 {}", Local::now().format("%Y-%m-%d")));
    }
    Ok(Some(v.to_string()))
}

/// 两个日期界 → WHERE 片段与绑定值（占位符按加入顺序编号，拼 SQL 只在这一段发生）。
fn date_conds(from: &str, to: &str) -> Result<(Vec<String>, Vec<SqlValue>), String> {
    let mut conds: Vec<String> = Vec::new();
    let mut args: Vec<SqlValue> = Vec::new();
    for (op, raw, which) in [(">=", from, "起始日"), ("<=", to, "截止日")] {
        if let Some(v) = parse_bound(raw, which)? {
            args.push(SqlValue::Text(v));
            conds.push(format!("substr(pr.paid_at, 1, 10) {op} ?{}", args.len()));
        }
    }
    Ok((conds, args))
}

fn open_and_collect<T>(conn: &Connection, sql: &str, args: &[SqlValue], map: fn(&Row<'_>) -> rusqlite::Result<T>, what: &str) -> Result<Vec<T>, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("{what}失败：{e}"))?;
    stmt.query_map(params_from_iter(args.iter()), map)
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("{what}失败：{e}"))
}

/// 期间内的付款流水（**含已冲销**，页面自己标"已冲销"并在合计里剔掉）。
/// 登记顺序升序，与 mock 给序同向。
pub fn list_payments(conn: &Connection, from: &str, to: &str) -> Result<Vec<PaymentRecord>, String> {
    let (conds, mut args) = date_conds(from, to)?;
    // 多取一行只用来判断有没有撞上限，不做"能显示多少显示多少"
    args.push(SqlValue::Integer(MAX_PAYMENT_ROWS + 1));
    let mut sql = PAYMENT_SELECT.to_string();
    if !conds.is_empty() {
        sql.push_str(&format!(" WHERE {}", conds.join(" AND ")));
    }
    sql.push_str(&format!(" ORDER BY pr.id ASC LIMIT ?{}", args.len()));

    let rows = open_and_collect(conn, &sql, &args, map_payment_row, "读取付款流水")?;
    if (rows.len() as i64) > MAX_PAYMENT_ROWS {
        return Err(format!("该期间付款流水超过 {MAX_PAYMENT_ROWS} 笔，请缩短日期区间分批核对（合计只加返回行，半截清单会算出错的期间付款额）"));
    }
    Ok(rows)
}

/// 期间内有效流水的渠道分布，金额倒序。冲销行不进（与 mock 同口径）。
/// 聚合在服务端做，行数 ≤ 渠道数，不受 [`MAX_PAYMENT_ROWS`] 影响。
pub fn method_dist(conn: &Connection, from: &str, to: &str) -> Result<Vec<MethodSlice>, String> {
    let (mut conds, args) = date_conds(from, to)?;
    conds.insert(0, "pr.reversed = 0".to_string());
    let sql = format!(
        "SELECT pr.method, SUM(pr.amount_fen) FROM payment_record pr WHERE {} GROUP BY pr.method ORDER BY SUM(pr.amount_fen) DESC, pr.method ASC",
        conds.join(" AND ")
    );
    let rows: Vec<(String, i64)> = open_and_collect(conn, &sql, &args, |r| Ok((r.get(0)?, r.get(1)?)), "读取付款方式分布")?;
    Ok(rows
        .into_iter()
        .map(|(method, fen)| {
            // 表外的渠道码（CHECK 挡住正常写入，只防历史脏数据）：叫法照 mock 回退原码，配色回退 neutral
            match CHANNELS.iter().find(|(code, _, _)| *code == method.as_str()) {
                Some((_, label, tone)) => MethodSlice { label: (*label).to_string(), fen, tone: *tone },
                None => MethodSlice { label: method, fen, tone: "neutral" },
            }
        })
        .collect())
}

// ------------------------------------------------------------------ Tauri 命令
// 只读不设岗。`from` / `to` 收 Option：页面可以把一头留空，也可以整个不传。

#[tauri::command]
pub async fn payment_list(app: AppHandle, from: Option<String>, to: Option<String>) -> Result<Vec<PaymentRecord>, String> {
    let (from, to) = (from.unwrap_or_default(), to.unwrap_or_default());
    read_only(&app, move |conn| list_payments(conn, &from, &to), "付款流水读取").await
}

#[tauri::command]
pub async fn payment_method_dist(app: AppHandle, from: Option<String>, to: Option<String>) -> Result<Vec<MethodSlice>, String> {
    let (from, to) = (from.unwrap_or_default(), to.unwrap_or_default());
    read_only(&app, move |conn| method_dist(conn, &from, &to), "付款方式分布读取").await
}
