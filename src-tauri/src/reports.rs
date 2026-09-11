//! 「系统与审计 → 日结交班」读命令（05 §3；口径见 03 §10、02 §7 M4）
//!
//! 沿用 [`crate::dashboard`] 立下的两条规矩：
//!  - **DTO 字段名与 `src/mock/types.ts` 逐字一致**（05 §8），页面零改动即可换真库；
//!    mock 类型里残留的驼峰键（`prevDayNet_01kg` / `lastWeekNet_01kg`）原样输出，
//!    一个字母都不统一——改了页面就静默显示 0。
//!  - **一次取锁、纯函数收 `&Connection`**：`build_daily` / `list_settlements` 不碰
//!    Tauri 状态，`tests/reports_contract.rs` 直接对内存库跑这两段。
//! 看板怎么做会话，这里就怎么做：只读聚合、所有岗位可见、不加角色闸门，
//! 也不在命令层查 `auth_session`（`crate::auth` 的会话校验在写命令一侧）。
//!
//! ---------------------------------------------------------------- 口径等价关系
//! 与 `src/mock/analytics.ts` 的 `buildDaily` 逐条对齐：
//!  1. **哪些单计入汇总** = mock 的 `stat2(o)`：
//!     `o.settlement_weight_01kg != null && o.status !== 'voided' && o.status !== 'rejected'`
//!     → 下方 `STAT_WHERE`（与 `dashboard.rs` 同一句，红冲单以负值参与，见不变式 4）。
//!  2. **行 = 品种**：mock 遍历四个写死品种、`if (!list.length) continue` 跳过空行，
//!     等价于「今日有参与汇总单据的品种才出行」，所以这里按 `variety_id` 分组即可。
//!     差异（刻意）：品种全集跟着 `grain_variety` 档案走，品种名是档案当前值——
//!     mock 的 `varietySpec(code).name` 同源；单据上的品种走 `variety_id` 外键，
//!     不再读 mock 那种 `variety_code` 反规范快照。
//!  3. **`avg_moisture_001pct`** = mock 先 `qcOf(o.qc_report_id)` 再
//!     `filter(q => q.is_effective === 1)`、取 `indicators.find(code==='moisture').value_num`、
//!     `Math.round(平均)`，无样本为 `null`。→ 本表的 `moisture` 子查询：
//!     `qc_report.id = o.qc_report_id AND is_effective = 1` + `qc_indicator.code='moisture'`
//!     + `round_div(sum, n)`（该函数在整数域精确复现 `Math.round`，含 .5 上取整）。
//!  4. **`reject_count`** = mock 写的是 `orders.filter(同日 且 同品种 且 status==='rejected')`
//!     ——**不套 `stat2`**（拒收单本来就被 `stat2` 排除，套了就恒为 0），
//!     且只在「该品种今天有出行」时才被展示。→ 同行右侧标量子查询。
//!  5. **`manual_count`** 套 `stat2`（是 `list.filter(weight_source==='manual')`，
//!     与看板的 `manualCount`「同日全部单」口径**不同**，别抄错）。
//!  6. **排序** = `rows.sort((a,b) => b.net_01kg - a.net_01kg)`：按净重倒序，
//!     补 `variety_code` 升序兜底，让净重相同的两个品种顺序稳定。
//!  7. **`total`** 与行来自**同一条 WHERE**（03 §10「总分相符」），只是不分组的另一趟扫描。
//!  8. **`prevDayNet_01kg` / `lastWeekNet_01kg` 的日期** = mock 的
//!     `dateKey(addDays(new Date(`${date}T00:00:00`), -1 | -7))`：以**所查日期**为基准的
//!     本地日历日（不是「今天」），减 1 天与减 7 天，各自再套 `stat2` 求净重合计。
//!     → [`days_before`]，与 `dashboard.rs` 同一实现。
//!
//! 与 `src/mock/api.ts` 的 `listSettlements` 逐条对齐：
//!  - `paymentStatus` 缺省 / `'all'` ⇒ 不筛；否则 `s.payment_status = ?`
//!    （库 CHECK 只允许 unpaid/partial/paid，与 mock 的 `Exclude<PaymentStatus,'not_required'>` 同）。
//!  - `keyword` ⇒ mock 是 `` `${s.settle_no} ${s.party_name}`.toLowerCase().includes(kw) ``
//!    且先 `trim()`。这里同口径，并**刻意多搜一列** `s.payee_name`：交接页显示的是收款人
//!    （`代领` 时与售粮人不同），只按售粮人搜会出现"看得见却搜不到"。
//!    SQLite 的 `LIKE` 对 ASCII 本就大小写不敏感，与 JS `toLowerCase()` 等价。
//!  - mock **不过滤 `status`**（含 `revoked`）：这里同样不删行，把 `status` 原样返回，
//!    要排除红冲结算单由页面按 `status === 'normal'` 自己筛（`SettlementsPage` 现在就这么做），
//!    与 [`crate::dashboard`] 读 `v_payable`（已排除 revoked）是两条不同链路，别混。
//!  - `date_from` / `date_to` / `limit` 是 mock 没有的能力：边界一律走 `business_date`
//!    （不变式 2），`limit` 默认 200、上限 2000（钳太小会"合计对得上、数对不上"，
//!    见 `orders.rs` 同一教训）。
//!  - `orders` 明细 = mock 的 `SettlementOrderRow` 六列，顺序按 `settlement_order.seq`；
//!    `payee_name` 为空时回落售粮人姓名，与 `orders.rs::load_settlement_by_id` 同一句 SQL 口径，
//!    两处口径必须一起改。

use chrono::{Duration, Local};
use rusqlite::types::Value as SqlValue;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

use crate::db::{locked, Db};

type Pool = Arc<Mutex<Connection>>;

/// 参与汇总统计的磅单（03 §10 / 不变式 4）——与 `dashboard.rs::STAT_WHERE` 同句。
/// 两处各留一份是刻意的：抄错一次就是"日报与看板今日合计不相等"这种最难归因的 bug，
/// `tests/reports_contract.rs` 与 `tests/dashboard_contract.rs` 分别钉住自己那一侧。
const STAT_WHERE: &str = "settlement_weight_01kg IS NOT NULL AND status NOT IN ('voided','rejected')";

/// 未指定日期时日报的默认基准日（本地日历日）
const DEFAULT_SETTLEMENT_LIMIT: i64 = 200;
/// 与 `orders.rs` 一致的硬上限：一次取回整月挂账也够，且不会把内存拉爆
const MAX_SETTLEMENT_LIMIT: i64 = 2000;

/// `settlement` 列表行的列清单（`Settlement` 的 24 个头字段，`orders` 明细另取一趟）
const SETTLE_HEAD_SQL: &str = "SELECT s.id, s.settle_no, s.party_id, p.name, s.business_date, s.period_from, s.period_to,
       s.order_count, s.total_net_01kg, s.total_deduct_01kg, s.total_settle_01kg,
       s.total_goods_fen, s.total_deduction_fen, s.total_advance_fen,
       s.payable_fen, s.paid_fen, s.payment_status, s.main_method,
       COALESCE(s.payee_name, p.name), s.signed_by_party, s.status, s.settled_at, s.settler_id, s.remark
FROM settlement s JOIN party p ON p.id = s.party_id";

fn pool_of(app: &AppHandle) -> Result<Pool, String> {
    app.try_state::<Db>()
        .map(|d| d.shared())
        .ok_or_else(|| "数据库尚未就绪（启动迁移未完成）".to_string())
}

// ------------------------------------------------------------------ 日期小工具
// 与 dashboard.rs 同一实现。三处以上用到时再抽到公共模块，现在先各留一份：
// 抽出去要动 dashboard.rs，而它正被看板那轮的测试守着，不值得为此扩面。

/// 本地当天（业务日期口径）。跨零点作业的单归前一日由录单时写死在 `business_date`，
/// 这里只负责"今天"是哪一天。
fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn days_before(base: &str, n: i64) -> String {
    let d = chrono::NaiveDate::parse_from_str(base, "%Y-%m-%d")
        .unwrap_or_else(|_| Local::now().date_naive())
        .checked_sub_signed(Duration::days(n))
        .unwrap_or_else(|| Local::now().date_naive());
    d.format("%Y-%m-%d").to_string()
}

fn valid_date(s: &str) -> bool {
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

fn bad_date(v: &str) -> String {
    format!("日期格式不正确：{v}（要 YYYY-MM-DD，例如 {}）", today())
}

/// `Math.round(sum / n)` 的整数版：`floor(x + 0.5)` ≡ `⌊(2·sum + n) / (2n)⌋`，
/// n 为 0 时返回 `None`（mock 的 `mo.length ? ... : null`）。
/// 用整数而不是 f64，是为了让"平均水分"这种要印在交接表上的数在任何平台都同结果。
fn round_div(sum: i64, n: i64) -> Option<i64> {
    if n == 0 {
        return None;
    }
    Some((2 * sum + n).div_euclid(2 * n))
}

/// LIKE 模式转义：`%` 与 `_` 是通配符，用户在关键词里敲它们时要按字面理解
/// （否则"100%"这类单号会把整表捞出来）。
fn like_pattern(kw: &str) -> String {
    let escaped = kw
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

// --------------------------------------------------------------------- 输出结构
// 字段名即前端契约（src/mock/types.ts 的 DailyReport / Settlement），改名 = 改页面。
// 显式写 snake_case 是为了"结构体字段名 = JSON 键名"这件事写在纸上而不是靠 serde 默认。

/// `DailyReport`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DailyReport {
    pub date: String,
    pub rows: Vec<DailyVarietyRow>,
    pub total: DailyTotal,
    /// mock 的驼峰残留，逐字输出（`prevDayNet_01kg`），改成 prev_day 前端就静默 0
    #[serde(rename = "prevDayNet_01kg")]
    pub prev_day_net_01kg: i64,
    #[serde(rename = "lastWeekNet_01kg")]
    pub last_week_net_01kg: i64,
}

/// `DailyReport["rows"][number]`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DailyVarietyRow {
    pub variety_name: String,
    pub variety_code: String,
    pub orders: i64,
    pub parties: i64,
    pub gross_01kg: i64,
    pub tare_01kg: i64,
    pub net_01kg: i64,
    pub deduct_01kg: i64,
    pub settle_01kg: i64,
    pub goods_fen: i64,
    pub deduction_fee_fen: i64,
    pub payable_fen: i64,
    pub paid_fen: i64,
    /// = payable_fen − paid_fen（与行内另两列同源，页面直接取用）
    pub credit_fen: i64,
    /// 无有效化验样本时为 null（mock 的 `mo.length ? … : null`）
    pub avg_moisture_001pct: Option<i64>,
    pub manual_count: i64,
    pub reject_count: i64,
}

/// `DailyReport["total"]`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DailyTotal {
    pub orders: i64,
    pub parties: i64,
    pub net_01kg: i64,
    pub settle_01kg: i64,
    pub goods_fen: i64,
    pub payable_fen: i64,
    pub paid_fen: i64,
    pub credit_fen: i64,
}

/// `SettlementOrderRow`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SettlementOrderRow {
    pub order_id: i64,
    pub order_no: String,
    pub goods_amount_fen: i64,
    pub price_fen_per_ton: i64,
    pub settlement_weight_01kg: i64,
    pub seq: i64,
}

/// `Settlement`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Settlement {
    pub id: i64,
    pub settle_no: String,
    pub party_id: i64,
    pub party_name: String,
    pub business_date: String,
    pub period_from: String,
    pub period_to: String,
    pub order_count: i64,
    pub total_net_01kg: i64,
    pub total_deduct_01kg: i64,
    pub total_settle_01kg: i64,
    pub total_goods_fen: i64,
    pub total_deduction_fen: i64,
    pub total_advance_fen: i64,
    pub payable_fen: i64,
    pub paid_fen: i64,
    /// unpaid | partial | paid
    pub payment_status: String,
    pub main_method: Option<String>,
    pub payee_name: String,
    pub signed_by_party: i64,
    /// normal | revoked
    pub status: String,
    pub settled_at: String,
    pub settler_id: i64,
    pub orders: Vec<SettlementOrderRow>,
    pub remark: Option<String>,
}

/// `settlement_list` 的入参。Tauri 恒把命令参数名转驼峰，所以命令侧只能有一个
/// 多单词参数名（`filters`）——细节都塞进这个结构体，靠 `rename_all` 对上前端。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettlementFilters {
    /// 前端传 `paymentStatus`；`all` / 空 / 缺省 = 不筛
    #[serde(default)]
    pub payment_status: Option<String>,
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

// --------------------------------------------------------------------- 纯库操作
// 全部收 &Connection、不碰 Tauri 状态，tests/reports_contract.rs 直接跑这段。

/// 日结交班的日报。`date` 为 `None` / 空 ⇒ 本地当天。
/// 空库返回**零值结构**（`rows` 为空数组）而不是 Err：交接表要能打印"今日无业务"。
pub fn build_daily(conn: &Connection, date: Option<&str>) -> Result<DailyReport, String> {
    let date = match date.map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) if valid_date(d) => d.to_string(),
        Some(d) => return Err(bad_date(d)),
        None => today(),
    };

    // ------------------------------------------------------------ 品种分组（行）
    // 一趟扫描出 13 个累加列 + 水分样本数与合计，再回 Rust 侧做 Math.round 等价取整：
    // 把 round 放进 SQL 会踩 INTEGER 除法与 ROUND 的半偶舍入两套差异。
    let mut stmt = conn
        .prepare(&format!(
            "SELECT v.code, v.name,
                    g.orders, g.parties, g.gross, g.tare, g.net, g.deduct, g.settle,
                    g.goods, g.fee, g.payable, g.paid, g.manual,
                    COALESCE(m.samples, 0), COALESCE(m.moist_sum, 0),
                    (SELECT COUNT(*) FROM weigh_order r
                      WHERE r.business_date = g.business_date
                        AND r.variety_id = g.variety_id
                        AND r.status = 'rejected') AS rejects
             FROM (
                 SELECT variety_id, business_date,
                        COUNT(*) AS orders,
                        COUNT(DISTINCT party_id) AS parties,
                        COALESCE(SUM(gross_weight_01kg), 0) AS gross,
                        COALESCE(SUM(tare_weight_01kg), 0) AS tare,
                        COALESCE(SUM(net_weight_01kg), 0) AS net,
                        COALESCE(SUM(deduct_total_01kg), 0) AS deduct,
                        COALESCE(SUM(settlement_weight_01kg), 0) AS settle,
                        COALESCE(SUM(goods_amount_fen), 0) AS goods,
                        COALESCE(SUM(deduction_fee_fen), 0) AS fee,
                        COALESCE(SUM(payable_amount_fen), 0) AS payable,
                        COALESCE(SUM(paid_amount_fen), 0) AS paid,
                        COALESCE(SUM(weight_source = 'manual'), 0) AS manual
                 FROM weigh_order
                 WHERE business_date = ?1 AND {STAT_WHERE}
                 GROUP BY variety_id
             ) g
             JOIN grain_variety v ON v.id = g.variety_id
             LEFT JOIN (
                 SELECT o.variety_id,
                        COUNT(*) AS samples,
                        COALESCE(SUM(i.value_num), 0) AS moist_sum
                 FROM weigh_order o
                 JOIN qc_report q ON q.id = o.qc_report_id AND q.is_effective = 1
                 JOIN qc_indicator i ON i.report_id = q.id
                      AND i.code = 'moisture' AND i.value_num IS NOT NULL
                 WHERE o.business_date = ?1 AND {STAT_WHERE}
                 GROUP BY o.variety_id
             ) m ON m.variety_id = g.variety_id
             ORDER BY g.net DESC, v.code"
        ))
        .map_err(|e| format!("读取日报分组失败：{e}"))?;
    let rows: Vec<DailyVarietyRow> = stmt
        .query_map(params![date], |r| {
            let (samples, moist_sum): (i64, i64) = (r.get(14)?, r.get(15)?);
            let payable: i64 = r.get(11)?;
            Ok(DailyVarietyRow {
                variety_code: r.get(0)?,
                variety_name: r.get(1)?,
                orders: r.get(2)?,
                parties: r.get(3)?,
                gross_01kg: r.get(4)?,
                tare_01kg: r.get(5)?,
                net_01kg: r.get(6)?,
                deduct_01kg: r.get(7)?,
                settle_01kg: r.get(8)?,
                goods_fen: r.get(9)?,
                deduction_fee_fen: r.get(10)?,
                payable_fen: payable,
                paid_fen: r.get(12)?,
                credit_fen: payable - r.get::<_, i64>(12)?,
                avg_moisture_001pct: round_div(moist_sum, samples),
                manual_count: r.get(13)?,
                reject_count: r.get(16)?,
            })
        })
        .map_err(|e| format!("读取日报分组失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取日报分组失败：{e}"))?;

    // --------------------------------------------------------------- 合计（同一 WHERE）
    let total = daily_total(conn, &date)?;

    Ok(DailyReport {
        prev_day_net_01kg: net_on(conn, &days_before(&date, 1))?,
        last_week_net_01kg: net_on(conn, &days_before(&date, 7))?,
        date,
        rows,
        total,
    })
}

fn daily_total(conn: &Connection, date: &str) -> Result<DailyTotal, String> {
    let (orders, parties, net, settle, goods, payable, paid): (i64, i64, i64, i64, i64, i64, i64) = conn
        .query_row(
            &format!(
                "SELECT COUNT(*), COUNT(DISTINCT party_id),
                        COALESCE(SUM(net_weight_01kg), 0), COALESCE(SUM(settlement_weight_01kg), 0),
                        COALESCE(SUM(goods_amount_fen), 0), COALESCE(SUM(payable_amount_fen), 0),
                        COALESCE(SUM(paid_amount_fen), 0)
                 FROM weigh_order WHERE business_date = ?1 AND {STAT_WHERE}"
            ),
            params![date],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .map_err(|e| format!("读取日报合计失败：{e}"))?;
    Ok(DailyTotal {
        orders,
        parties,
        net_01kg: net,
        settle_01kg: settle,
        goods_fen: goods,
        payable_fen: payable,
        paid_fen: paid,
        // 与 mock 的 Σ(payable − paid) 等价（整数求和可交换），且保证页面
        // 「应付 − 已付 = 挂账」在合计行上恒成立。
        credit_fen: payable - paid,
    })
}

/// 某一天的参与汇总净重合计（环比 / 同比基数）
fn net_on(conn: &Connection, date: &str) -> Result<i64, String> {
    conn.query_row(
        &format!("SELECT COALESCE(SUM(net_weight_01kg), 0) FROM weigh_order WHERE business_date = ?1 AND {STAT_WHERE}"),
        params![date],
        |r| r.get(0),
    )
    .map_err(|e| format!("读取日环比基数失败：{e}"))
}

/// 结算单列表（交接页的"未付清结算单"与结算中心共用）。空库返回空数组，不是 Err。
pub fn list_settlements(conn: &Connection, f: &SettlementFilters) -> Result<Vec<Settlement>, String> {
    let payment_status = f
        .payment_status
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "all");
    if let Some(ps) = payment_status {
        if !matches!(ps, "unpaid" | "partial" | "paid") {
            return Err(format!("付款状态不正确：{ps}（只能是未付、部分付款或已付）"));
        }
    }
    // 条件与占位符按加入顺序编号（?1、?2…），拼 SQL 这件事只在这一段发生一次。
    let mut conds: Vec<String> = Vec::new();
    let mut args: Vec<SqlValue> = Vec::new();
    let bind = |frag: &str, val: SqlValue, conds: &mut Vec<String>, args: &mut Vec<SqlValue>| {
        args.push(val);
        conds.push(format!("{frag}?{}", args.len()));
    };
    if let Some(ps) = payment_status {
        bind("s.payment_status = ", SqlValue::Text(ps.to_string()), &mut conds, &mut args);
    }
    let kw = f.keyword.clone().unwrap_or_default().trim().to_string();
    if !kw.is_empty() {
        bind(
            "(s.settle_no || ' ' || p.name || ' ' || COALESCE(s.payee_name, '')) LIKE ",
            SqlValue::Text(like_pattern(&kw)),
            &mut conds,
            &mut args,
        );
        conds.last_mut().unwrap().push_str(" ESCAPE '\\'");
    }
    for (frag, raw) in [
        ("s.business_date >= ", f.date_from.as_deref()),
        ("s.business_date <= ", f.date_to.as_deref()),
    ] {
        if let Some(v) = raw.map(str::trim).filter(|s| !s.is_empty()) {
            if !valid_date(v) {
                return Err(bad_date(v));
            }
            bind(frag, SqlValue::Text(v.to_string()), &mut conds, &mut args);
        }
    }
    let mut sql = SETTLE_HEAD_SQL.to_string();
    if !conds.is_empty() {
        sql.push_str(&format!(" WHERE {}", conds.join(" AND ")));
    }
    // 最近的结算单在前；同一天内按单号倒序（单号由 docNo('JS', 日期) 生成，日内单调）
    sql.push_str(" ORDER BY s.business_date DESC, s.settle_no DESC");
    let limit = f.limit.unwrap_or(DEFAULT_SETTLEMENT_LIMIT).clamp(1, MAX_SETTLEMENT_LIMIT);
    args.push(SqlValue::Integer(limit));
    sql.push_str(&format!(" LIMIT ?{}", args.len()));

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取结算单列表失败：{e}"))?;
    let mut list: Vec<Settlement> = stmt
        .query_map(params_from_iter(args.iter()), |r| {
            Ok(Settlement {
                id: r.get(0)?,
                settle_no: r.get(1)?,
                party_id: r.get(2)?,
                party_name: r.get(3)?,
                business_date: r.get(4)?,
                period_from: r.get(5)?,
                period_to: r.get(6)?,
                order_count: r.get(7)?,
                total_net_01kg: r.get(8)?,
                total_deduct_01kg: r.get(9)?,
                total_settle_01kg: r.get(10)?,
                total_goods_fen: r.get(11)?,
                total_deduction_fen: r.get(12)?,
                total_advance_fen: r.get(13)?,
                payable_fen: r.get(14)?,
                paid_fen: r.get(15)?,
                payment_status: r.get(16)?,
                main_method: r.get(17)?,
                payee_name: r.get(18)?,
                signed_by_party: r.get(19)?,
                status: r.get(20)?,
                settled_at: r.get(21)?,
                settler_id: r.get(22)?,
                remark: r.get(23)?,
                orders: Vec::new(),
            })
        })
        .map_err(|e| format!("读取结算单列表失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取结算单列表失败：{e}"))?;

    // 明细一次取回（避免每单一趟查询），按 (settlement_id, seq) 排好后在 Rust 侧归组。
    if !list.is_empty() {
        let ids: Vec<i64> = list.iter().map(|s| s.id).collect();
        let marks = vec!["?"; ids.len()].join(",");
        let detail_sql = format!(
            "SELECT so.settlement_id, so.order_id, o.order_no, so.goods_amount_fen,
                    so.price_fen_per_ton, so.settlement_weight_01kg, so.seq
             FROM settlement_order so JOIN weigh_order o ON o.id = so.order_id
             WHERE so.settlement_id IN ({marks})
             ORDER BY so.settlement_id, so.seq"
        );
        let mut stmt = conn
            .prepare(&detail_sql)
            .map_err(|e| format!("读取结算明细失败：{e}"))?;
        let mut grouped: HashMap<i64, Vec<SettlementOrderRow>> = stmt
            .query_map(params_from_iter(ids.iter()), |r| {
                let sid: i64 = r.get(0)?;
                Ok((
                    sid,
                    SettlementOrderRow {
                        order_id: r.get(1)?,
                        order_no: r.get(2)?,
                        goods_amount_fen: r.get(3)?,
                        price_fen_per_ton: r.get(4)?,
                        settlement_weight_01kg: r.get(5)?,
                        seq: r.get(6)?,
                    },
                ))
            })
            .map_err(|e| format!("读取结算明细失败：{e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取结算明细失败：{e}"))?
            .into_iter()
            .fold(HashMap::new(), |mut acc, (sid, row)| {
                acc.entry(sid).or_insert_with(Vec::new).push(row);
                acc
            });
        for s in list.iter_mut() {
            s.orders = grouped.remove(&s.id).unwrap_or_default();
        }
    }
    Ok(list)
}

// ----------------------------------------------------------------- Tauri 命令

/// 日报（日结交班顶部四张卡 + 品种明细表）。只读，所有岗位可看，不设写入闸门。
#[tauri::command]
pub async fn report_daily(app: AppHandle, date: Option<String>) -> Result<DailyReport, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, move |conn| build_daily(conn, date.as_deref())))
        .await
        .map_err(|e| format!("日报聚合任务失败：{e}"))?
}

/// 结算单列表（交接页"未付清结算单"）。只读，同上。
#[tauri::command]
pub async fn settlement_list(app: AppHandle, filters: SettlementFilters) -> Result<Vec<Settlement>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, move |conn| list_settlements(conn, &filters)))
        .await
        .map_err(|e| format!("结算单列表读取任务失败：{e}"))?
}
