//! 台账报表其余三视图 + 收购明细台账（05 §3 `/reports/$kind`；口径 03 §10、02 §F6/F7）
//!
//! ------------------------------------------------------------------ 为什么单独成文件
//! 日报（`report_daily`）与挂账清单在 [`crate::reports`] 里，本模块补同一页面的另外四个
//! tab：`report_ledger` / `report_quality` / `report_parties` / `report_staff`。
//! 两份实现口径同源（下面的 `STAT_ON` 与 `crate::dashboard::STAT_WHERE` 是同一条），
//! 收口时并成一个 `reports.rs` 即可，命令名与 DTO 字段都不用改。
//!
//! ------------------------------------------------------------------ 与 mock 的等价关系
//! 逐条照搬 `src/mock/analytics.ts`（它本身按 03 §10 写），页面因此零改动：
//!  - [`build_ledger`] ← `buildLedger`：区间内**除作废与拒收**的全部单，按
//!    `business_date, registered_at` 升序，`seq` 由这里连续编号（报送台账要的是行号）。
//!  - [`build_quality`] ← `buildQuality`：分母两套（`orders` 含拒收、`samples` 只算
//!    有效化验单），故超基准率与拒收率**不可相加**，页面 toolbar 里已写明。
//!  - [`build_party_rank`] ← `buildPartyRank`：`last_date` 与是否出行用的是
//!    「非作废」全集，四个金额列用的是 `STAT_ON` 子集——照抄，不顺手统一。
//!  - [`build_staff_load`] ← `buildStaffLoad`：经手单数按「磅员或登记员」归人，
//!    同一单两个人各计一次，合计必大于实际单数。
//!
//! ------------------------------------------------------------------ 三条硬约定
//!  1. 红冲单以负值参与（不变式 4）：只剔 `voided` / `rejected`，**不能**按状态白名单筛。
//!  2. 统计边界一律 `business_date`（不变式 2），不用 `created_at` / `registered_at`。
//!  3. 合计与明细同一条 WHERE（03 §10 守则 2）。台账页在前端对**接口返回的全集**求合计，
//!     所以 `build_ledger` 不分页；单站一个季度的量级在千行以内，一次取回比"屏显合计
//!     只等于当前页"要诚实。区间若真放大到跨年，改的是这一处：接口补 `total` 与分页参数，
//!     页面把合计改读接口值。
//!
//! ------------------------------------------------------------------ 两处与 mock 的刻意差异
//!  - 品种/售粮人/员工的名单跟着档案与库里的实际数据走，不再用 mock 写死的四品种、
//!    五个岗位名单（`buildQuality` 的品种全集取 `grain_variety WHERE deleted_at IS NULL`，
//!    与看板 `by_variety` 同源：档案加品种，报表就有行）。
//!  - **超基准样本数读 `qc_indicator.over_std` 快照**，不在这里重算 `value > 标准值`。
//!    理由：`over_std` 就是化验员当时在界面对照标准看到的那个红点（`QcPanel` 写入），
//!    报表与屏幕必须同源；`grain_variety.std_*` 后补或后改都不该让历史台账变脸。
//!    副作用如实说明：品种基准没填的站，超基准率恒为 0（工作台同样不标红），
//!    水分分布图不受影响，所以页面仍然有东西可看。

use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

use crate::db::{locked, Db};

/// 参与汇总的磅单（03 §10 / 不变式 4）：与 `dashboard.rs` 的 `STAT_WHERE` 同一条，
/// 这里带 `o.` 前缀，因为本模块每条 SQL 都 JOIN 了别的表。
/// 台账与排行另用其中一半（`o.status NOT IN ('voided','rejected')`），照 mock 的
/// `buildLedger` / `buildPartyRank` 逐字保留，不合并成一个常量。
const STAT_ON: &str = "o.settlement_weight_01kg IS NOT NULL AND o.status NOT IN ('voided','rejected')";

/// 等级枚举（constants.ts GRADES 的顺序，图例色条也按这个顺序排）
const GRADES: [&str; 5] = ["一等", "二等", "三等", "四等", "等外"];

/// 水分分箱（02 §F7.3 的展示区间）。边界与 mock 一致：左开右闭 `(min, max]`。
const MOISTURE_BUCKETS: [(&str, i64, i64); 5] = [
    ("≤ 12.5%", 0, 1250),
    ("12.5 – 14%", 1250, 1400),
    ("14 – 15.5%", 1400, 1550),
    ("15.5 – 18%", 1550, 1800),
    ("> 18%", 1800, i64::MAX),
];

type Pool = Arc<Mutex<Connection>>;

fn pool_of(app: &AppHandle) -> Result<Pool, String> {
    app.try_state::<Db>()
        .map(|d| d.shared())
        .ok_or_else(|| "数据库尚未就绪（启动迁移未完成）".to_string())
}

/// 整数域的四舍五入（对齐 JS `Math.round`：正数 .5 上进）。
/// 报表里所有均值都要落到 `_001pct` 定点整数，不能让浮点串进 JSON 被前端 `percent()` 二次取整。
fn round_div(sum: i64, n: i64) -> Option<i64> {
    if n == 0 {
        return None;
    }
    Some((sum * 2 + n).div_euclid(2 * n))
}

// ===================================================================== 收购明细台账

#[derive(Debug, Clone, Serialize)]
pub struct LedgerRow {
    pub seq: i64,
    pub business_date: String,
    pub order_no: String,
    pub party_name: String,
    pub party_type: String,
    /// 过渡态明文（`id_card_no_enc` 目前存明文 UTF-8，同 `orders.rs`）。
    /// 界面与导出都走 `maskIdCard`，全号只作为现场人工勾选的报送动作输出。
    pub id_card_no: String,
    pub address: String,
    pub variety_name: String,
    pub grade: Option<String>,
    pub vehicle_no: Option<String>,
    pub warehouse_name: Option<String>,
    pub gross_weight_01kg: Option<i64>,
    pub tare_weight_01kg: Option<i64>,
    pub net_weight_01kg: Option<i64>,
    pub deduct_total_01kg: i64,
    pub settlement_weight_01kg: Option<i64>,
    pub moisture_001pct: Option<i64>,
    pub impurity_001pct: Option<i64>,
    pub price_fen_per_ton: Option<i64>,
    pub goods_amount_fen: Option<i64>,
    pub deduction_fee_fen: i64,
    pub payable_amount_fen: Option<i64>,
    pub paid_amount_fen: i64,
    pub credit_amount_fen: i64,
    pub payment_method: Option<String>,
    pub weight_source: String,
    pub weigher_name: String,
    pub inspector_name: String,
    pub settled: bool,
}

pub fn build_ledger(conn: &Connection, from: &str, to: &str) -> Result<Vec<LedgerRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT o.business_date, o.order_no, p.name, p.party_type,
                    COALESCE(CAST(p.id_card_no_enc AS TEXT), ''), COALESCE(p.address, ''),
                    v.name, o.grade, o.vehicle_no, w.name,
                    o.gross_weight_01kg, o.tare_weight_01kg, o.net_weight_01kg,
                    o.deduct_total_01kg, o.settlement_weight_01kg,
                    mi.value_num, ii.value_num,
                    o.price_fen_per_ton, o.goods_amount_fen, o.deduction_fee_fen,
                    o.payable_amount_fen, o.paid_amount_fen,
                    o.payment_method, o.weight_source,
                    COALESCE(wu.display_name, '—'), COALESCE(iu.display_name, '—'),
                    o.settled_at IS NOT NULL
             FROM weigh_order o
             JOIN party p ON p.id = o.party_id
             JOIN grain_variety v ON v.id = o.variety_id
             LEFT JOIN warehouse w ON w.id = o.warehouse_id
             LEFT JOIN qc_report q ON q.id = o.qc_report_id
             LEFT JOIN qc_indicator mi ON mi.report_id = q.id AND mi.code = 'moisture'
             LEFT JOIN qc_indicator ii ON ii.report_id = q.id AND ii.code = 'impurity'
             LEFT JOIN user_account wu ON wu.id = o.weigher_id
             LEFT JOIN user_account iu ON iu.id = o.inspector_id
             WHERE o.business_date BETWEEN ?1 AND ?2
               AND o.status NOT IN ('voided','rejected')
             ORDER BY o.business_date, o.registered_at, o.order_no",
        )
        .map_err(|e| format!("读取收购台账失败：{e}"))?;
    let rows = stmt
        .query_map(params![from, to], |r| {
            let payable: Option<i64> = r.get(20)?;
            let paid: i64 = r.get(21)?;
            Ok(LedgerRow {
                seq: 0,
                business_date: r.get(0)?,
                order_no: r.get(1)?,
                party_name: r.get(2)?,
                party_type: r.get(3)?,
                id_card_no: r.get(4)?,
                address: r.get(5)?,
                variety_name: r.get(6)?,
                grade: r.get(7)?,
                vehicle_no: r.get(8)?,
                warehouse_name: r.get(9)?,
                gross_weight_01kg: r.get(10)?,
                tare_weight_01kg: r.get(11)?,
                net_weight_01kg: r.get(12)?,
                deduct_total_01kg: r.get(13)?,
                settlement_weight_01kg: r.get(14)?,
                moisture_001pct: r.get(15)?,
                impurity_001pct: r.get(16)?,
                price_fen_per_ton: r.get(17)?,
                goods_amount_fen: r.get(18)?,
                deduction_fee_fen: r.get(19)?,
                payable_amount_fen: payable,
                paid_amount_fen: paid,
                credit_amount_fen: payable.unwrap_or(0) - paid,
                payment_method: r.get(22)?,
                weight_source: r.get(23)?,
                weigher_name: r.get(24)?,
                inspector_name: r.get(25)?,
                settled: r.get(26)?,
            })
        })
        .map_err(|e| format!("读取收购台账失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取收购台账失败：{e}"))?;
    // seq 在取完再编号：SQL 里用 ROW_NUMBER() 也能做，但排序键一旦调整，
    // 窗口函数与 ORDER BY 分两处维护更容易出错。
    Ok(rows
        .into_iter()
        .enumerate()
        .map(|(i, mut row)| {
            row.seq = i as i64 + 1;
            row
        })
        .collect())
}

// ===================================================================== 质量分析

/// 外层键走 camelCase（`dateFrom` / `byVariety` / `gradeDist` / `moistureBuckets`，
/// 与 mock 类型的驼峰写法逐字一致），行内字段保持库的 snake 命名。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityReport {
    pub date_from: String,
    pub date_to: String,
    pub by_variety: Vec<QualityVarietyRow>,
    pub grade_dist: Vec<GradeDistRow>,
    pub moisture_buckets: Vec<BucketRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct QualityVarietyRow {
    pub variety_name: String,
    pub variety_code: String,
    /// 期间内有化验单的磅单数（含拒收）——拒收率的分母
    pub orders: i64,
    /// 其中化验单生效的样本数——超基准率的分母
    pub samples: i64,
    pub avg_moisture: Option<i64>,
    pub avg_impurity: Option<i64>,
    pub avg_unsound: Option<i64>,
    pub over_moisture: i64,
    pub over_impurity: i64,
    /// 三项指标任一超标准的样本数（同一单既超水又超杂只计一次）
    pub over_any: i64,
    pub reject: i64,
    pub net_01kg: i64,
    pub deduct_01kg: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GradeDistRow {
    pub variety_name: String,
    pub grades: Vec<GradeCount>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GradeCount {
    pub grade: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BucketRow {
    pub label: String,
    pub count: i64,
}

/// 品种基础信息（档案顺序）。三个视图共用一份，保证 byVariety 与 gradeDist 行序一致。
fn varieties(conn: &Connection) -> Result<Vec<(i64, String, String)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, code, name FROM grain_variety WHERE deleted_at IS NULL ORDER BY sort_order, code")
        .map_err(|e| format!("读取品种档案失败：{e}"))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| format!("读取品种档案失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取品种档案失败：{e}"))?;
    Ok(rows)
}

/// 期间内该品种一单没有时的全零聚合（列序与上面 SQL 的 14 个累加列一一对应，不含 `v.id`）。
/// 写成显式常量而不是 `unwrap_or_default()`：标准库没给这个元数字段数的元组实现 `Default`。
const ZERO_AGG: (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64) =
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

pub fn build_quality(conn: &Connection, from: &str, to: &str) -> Result<QualityReport, String> {
    let vars = varieties(conn)?;

    // 品种聚合。LEFT JOIN 从品种档案出发，所以期间内一单没有的品种也占一行 0
    // （mock 写死四品种同理）；uk_qc_effective + uk_ind 保证三张指标左连接不会放大行数。
    let mut stmt = conn
        .prepare(&format!(
            "SELECT v.id,
                    COUNT(o.id),
                    SUM(CASE WHEN q.is_effective = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN q.is_effective = 1 THEN COALESCE(mi.value_num, 0) ELSE 0 END),
                    SUM(CASE WHEN q.is_effective = 1 AND mi.value_num IS NOT NULL THEN 1 ELSE 0 END),
                    SUM(CASE WHEN q.is_effective = 1 THEN COALESCE(im.value_num, 0) ELSE 0 END),
                    SUM(CASE WHEN q.is_effective = 1 AND im.value_num IS NOT NULL THEN 1 ELSE 0 END),
                    SUM(CASE WHEN q.is_effective = 1 THEN COALESCE(un.value_num, 0) ELSE 0 END),
                    SUM(CASE WHEN q.is_effective = 1 AND un.value_num IS NOT NULL THEN 1 ELSE 0 END),
                    SUM(CASE WHEN q.is_effective = 1 AND mi.over_std = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN q.is_effective = 1 AND im.over_std = 1 THEN 1 ELSE 0 END),
                    SUM(CASE WHEN q.is_effective = 1 AND (mi.over_std = 1 OR im.over_std = 1 OR un.over_std = 1) THEN 1 ELSE 0 END),
                    SUM(CASE WHEN o.status = 'rejected' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN {STAT_ON} THEN COALESCE(o.net_weight_01kg, 0) ELSE 0 END),
                    SUM(CASE WHEN {STAT_ON} THEN o.deduct_total_01kg ELSE 0 END)
             FROM grain_variety v
             LEFT JOIN weigh_order o
                    ON o.variety_id = v.id AND o.business_date BETWEEN ?1 AND ?2
                   AND o.qc_report_id IS NOT NULL
             LEFT JOIN qc_report q ON q.id = o.qc_report_id
             LEFT JOIN qc_indicator mi ON mi.report_id = q.id AND mi.code = 'moisture'
             LEFT JOIN qc_indicator im ON im.report_id = q.id AND im.code = 'impurity'
             LEFT JOIN qc_indicator un ON un.report_id = q.id AND un.code = 'unsound'
             WHERE v.deleted_at IS NULL
             GROUP BY v.id",
        ))
        .map_err(|e| format!("读取质量分析失败：{e}"))?;
    let agg: Vec<(i64, (i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64, i64))> = stmt
        .query_map(params![from, to], |r| {
            Ok((
                r.get(0)?,
                (
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                    r.get(11)?,
                    r.get(12)?,
                    r.get(13)?,
                    r.get(14)?,
                ),
            ))
        })
        .map_err(|e| format!("读取质量分析失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取质量分析失败：{e}"))?;

    let by_variety = vars
        .iter()
        .map(|(id, code, name)| {
            let a = agg.iter().find(|(vid, _)| vid == id).map(|(_, a)| *a).unwrap_or(ZERO_AGG);
            QualityVarietyRow {
                variety_name: name.clone(),
                variety_code: code.clone(),
                orders: a.0,
                samples: a.1,
                avg_moisture: round_div(a.2, a.3),
                avg_impurity: round_div(a.4, a.5),
                avg_unsound: round_div(a.6, a.7),
                over_moisture: a.8,
                over_impurity: a.9,
                over_any: a.10,
                reject: a.11,
                net_01kg: a.12,
                deduct_01kg: a.13,
            }
        })
        .collect();

    // 等级分布：分母同样是"期间内有化验单的单"，与 orders 一致
    let mut stmt = conn
        .prepare(
            "SELECT o.variety_id, o.grade, COUNT(*)
             FROM weigh_order o
             WHERE o.business_date BETWEEN ?1 AND ?2 AND o.qc_report_id IS NOT NULL
               AND o.grade IS NOT NULL
             GROUP BY o.variety_id, o.grade",
        )
        .map_err(|e| format!("读取等级分布失败：{e}"))?;
    let grade_counts: Vec<(i64, String, i64)> = stmt
        .query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| format!("读取等级分布失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取等级分布失败：{e}"))?;
    let grade_dist = vars
        .iter()
        .map(|(id, _, name)| GradeDistRow {
            variety_name: name.clone(),
            grades: GRADES
                .iter()
                .map(|g| GradeCount {
                    grade: (*g).to_string(),
                    count: grade_counts
                        .iter()
                        .filter(|(vid, grade, _)| vid == id && grade == g)
                        .map(|(_, _, n)| *n)
                        .sum(),
                })
                .collect(),
        })
        .collect();

    // 水分分箱：用单据挂的那张化验单（复检降级后仍按当前结算依据看），与 mock 的
    // qcOf(o.qc_report_id) 同一取法，不套 is_effective。
    let mut stmt = conn
        .prepare(
            "SELECT i.value_num
             FROM weigh_order o JOIN qc_indicator i ON i.report_id = o.qc_report_id AND i.code = 'moisture'
             WHERE o.business_date BETWEEN ?1 AND ?2 AND o.qc_report_id IS NOT NULL
               AND i.value_num IS NOT NULL",
        )
        .map_err(|e| format!("读取水分分布失败：{e}"))?;
    let moistures: Vec<i64> = stmt
        .query_map(params![from, to], |r| r.get::<_, i64>(0))
        .map_err(|e| format!("读取水分分布失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取水分分布失败：{e}"))?;
    let moisture_buckets = MOISTURE_BUCKETS
        .iter()
        .map(|(label, min, max)| BucketRow {
            label: (*label).to_string(),
            count: moistures.iter().filter(|m| **m > *min && **m <= *max).count() as i64,
        })
        .collect();

    Ok(QualityReport {
        date_from: from.to_string(),
        date_to: to.to_string(),
        by_variety,
        grade_dist,
        moisture_buckets,
    })
}

// =================================================================== 售粮人排行

#[derive(Debug, Clone, Serialize)]
pub struct PartyRankRow {
    pub party_id: i64,
    pub name: String,
    pub party_type: String,
    pub orders: i64,
    pub net_01kg: i64,
    pub goods_fen: i64,
    pub paid_fen: i64,
    pub credit_fen: i64,
    pub last_date: String,
    /// 全历史皮重均值（不受区间影响）：下次卸货时判断偏差用，页面列名已写明口径
    pub avg_tare_01kg: Option<i64>,
}

pub fn build_party_rank(conn: &Connection, from: &str, to: &str) -> Result<Vec<PartyRankRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT p.id, p.name, p.party_type,
                    SUM(CASE WHEN {STAT_ON} THEN 1 ELSE 0 END),
                    SUM(CASE WHEN {STAT_ON} THEN COALESCE(o.net_weight_01kg, 0) ELSE 0 END),
                    SUM(CASE WHEN {STAT_ON} THEN COALESCE(o.goods_amount_fen, 0) ELSE 0 END),
                    SUM(CASE WHEN {STAT_ON} THEN o.paid_amount_fen ELSE 0 END),
                    SUM(CASE WHEN {STAT_ON} THEN COALESCE(o.payable_amount_fen, 0) - o.paid_amount_fen ELSE 0 END),
                    MAX(o.business_date),
                    (SELECT ROUND(AVG(x.tare_weight_01kg)) FROM weigh_order x
                      WHERE x.party_id = p.id AND x.tare_weight_01kg IS NOT NULL)
             FROM weigh_order o JOIN party p ON p.id = o.party_id
             WHERE o.business_date BETWEEN ?1 AND ?2 AND o.status <> 'voided'
             GROUP BY p.id, p.name, p.party_type
             ORDER BY 5 DESC, 4 DESC, p.id",
        ))
        .map_err(|e| format!("读取售粮人排行失败：{e}"))?;
    let rows = stmt
        .query_map(params![from, to], |r| {
            let avg: Option<f64> = r.get(9)?;
            Ok(PartyRankRow {
                party_id: r.get(0)?,
                name: r.get(1)?,
                party_type: r.get(2)?,
                orders: r.get(3)?,
                net_01kg: r.get(4)?,
                goods_fen: r.get(5)?,
                paid_fen: r.get(6)?,
                credit_fen: r.get(7)?,
                last_date: r.get(8)?,
                avg_tare_01kg: avg.map(|v| v as i64),
            })
        })
        .map_err(|e| format!("读取售粮人排行失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取售粮人排行失败：{e}"))?;
    Ok(rows)
}

// ============================================================== 作业量与异常统计

#[derive(Debug, Clone, Serialize)]
pub struct StaffLoadRow {
    pub user_id: i64,
    pub name: String,
    /// 库里的角色枚举原样输出，前端 `ROLE[role]` 再映射中文
    pub role: String,
    pub orders: i64,
    pub manual_count: i64,
    pub manual_ratio: f64,
    pub void_count: i64,
    pub override_count: i64,
    pub reprint_count: i64,
}

pub fn build_staff_load(conn: &Connection, from: &str, to: &str) -> Result<Vec<StaffLoadRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT * FROM (
                SELECT u.id, u.display_name, u.role,
                       (SELECT COUNT(*) FROM weigh_order o
                         WHERE o.business_date BETWEEN ?1 AND ?2
                           AND (o.weigher_id = u.id OR o.registered_by = u.id)) AS handled,
                       (SELECT COUNT(*) FROM weigh_order o
                         WHERE o.business_date BETWEEN ?1 AND ?2
                           AND (o.weigher_id = u.id OR o.registered_by = u.id)
                           AND o.weight_source = 'manual') AS manual,
                       (SELECT COUNT(*) FROM weigh_order o
                         WHERE o.business_date BETWEEN ?1 AND ?2
                           AND o.registered_by = u.id AND o.status = 'voided'
                           AND o.voided_at IS NOT NULL) AS voids,
                       (SELECT COUNT(*) FROM weigh_order o
                         WHERE o.business_date BETWEEN ?1 AND ?2
                           AND o.tare_override_by = u.id) AS overrides,
                       (SELECT COUNT(*) FROM print_log pl
                         WHERE pl.operator_id = u.id AND pl.is_reprint = 1
                           AND substr(pl.printed_at, 1, 10) BETWEEN ?1 AND ?2) AS reprints
                FROM user_account u
                WHERE u.deleted_at IS NULL
             ) WHERE handled > 0
             ORDER BY handled DESC, manual DESC, id",
        )
        .map_err(|e| format!("读取作业量统计失败：{e}"))?;
    let rows = stmt
        .query_map(params![from, to], |r| {
            let orders: i64 = r.get(3)?;
            let manual: i64 = r.get(4)?;
            Ok(StaffLoadRow {
                user_id: r.get(0)?,
                name: r.get(1)?,
                role: r.get(2)?,
                orders,
                manual_count: manual,
                manual_ratio: if orders > 0 { manual as f64 / orders as f64 } else { 0.0 },
                void_count: r.get(5)?,
                override_count: r.get(6)?,
                reprint_count: r.get(7)?,
            })
        })
        .map_err(|e| format!("读取作业量统计失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取作业量统计失败：{e}"))?;
    Ok(rows)
}

// ==================================================================== Tauri 命令
// 四张报表全部只读聚合，岗位不限（含 viewer），闸门在前端导出按钮上（data.export）。

#[tauri::command]
pub async fn report_ledger(app: AppHandle, from: String, to: String) -> Result<Vec<LedgerRow>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, move |conn| build_ledger(conn, &from, &to)))
        .await
        .map_err(|e| format!("收购台账查询任务失败：{e}"))?
}

#[tauri::command]
pub async fn report_quality(app: AppHandle, from: String, to: String) -> Result<QualityReport, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, move |conn| build_quality(conn, &from, &to)))
        .await
        .map_err(|e| format!("质量分析任务失败：{e}"))?
}

#[tauri::command]
pub async fn report_parties(app: AppHandle, from: String, to: String) -> Result<Vec<PartyRankRow>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, move |conn| build_party_rank(conn, &from, &to)))
        .await
        .map_err(|e| format!("售粮人排行任务失败：{e}"))?
}

#[tauri::command]
pub async fn report_staff(app: AppHandle, from: String, to: String) -> Result<Vec<StaffLoadRow>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, move |conn| build_staff_load(conn, &from, &to)))
        .await
        .map_err(|e| format!("作业量统计任务失败：{e}"))?
}
