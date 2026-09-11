//! 首页看板聚合（05 §3；口径见 02 §7 M1 与 03 §10 报表要点）
//!
//! 这是「从 mock 换成真库」的第二块（基础档案之后），沿用 [`crate::masters`]
//! 立下的规矩：**DTO 字段名与 `src/mock/types.ts` 的 `Dashboard` 逐字一致**，
//! 页面零改动（05 §8）。`manualCount` / `rejectCount` 这类前端在用的驼峰键
//! 就照驼峰序列化，不趁机统一命名风格。
//!
//! 统计口径全部照搬 `src/mock/analytics.ts`（它本身是照 03 §10 写的）：
//!  1. 参与汇总 = `settlement_weight_01kg` 非空且状态不是 voided / rejected；
//!     **红冲单与原单都参与**（不变式 4，负值抵消），所以不能按状态白名单筛。
//!  2. 边界用 `business_date`（跨零点单归前一日），不用 created_at。
//!  3. 合计与分组来自同一 WHERE，保证"总分相符"。
//!
//! 两个阈值的来源与 mock 有一处单位差异：
//!  - 在途超时：mock 键 `open_order_alert_minutes`（30 分钟）。库里尚未种这个键
//!    （03 §9.3.1 没有它），先按同名键读 `app_setting`，读不到用默认 30——
//!    等系统参数整轮迁库时前端设置页能直接改它，这里零改动接上。
//!  - 挂账时效：库键是 `payment_due_warn_hours`（72 小时），mock 是
//!    `payment_due_days`（3 天），数值等价。告警文案按小时换算成天说。
//!
//! §9.24 视图的时长口径曾是坏的：`v_open_order.stuck_minutes` /
//! `v_payable.unpaid_hours` 用 `julianday('now','localtime')` 对比带 +08:00
//! 偏移的落库文本，恒定虚增一个时区（刚进磅的车显示"停留 8 小时"）。
//! 0005 迁移已把两侧统一到 `julianday('now')`，看板因此**直接取视图列**，
//! 口径只留一份；`tests/dashboard_contract.rs` 里"新单停留 ≈ 0"的断言
//! 就是这条回归的闸。

use chrono::{Duration, Local};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

use crate::db::{locked, Db};

type Pool = Arc<Mutex<Connection>>;

/// mock 的 HISTORY_DAYS = 14：趋势与分组窗口都取「今天往前 14 天，含今天」共 15 个点
const TREND_DAYS: i64 = 15;
/// 在途超时提醒的兜底阈值（分钟），与 mock `open_order_alert_minutes` 默认值一致
const DEFAULT_ALERT_MINUTES: i64 = 30;
/// 挂账时效兜底（小时），与 0002_seed 的 `payment_due_warn_hours` 一致
const DEFAULT_DUE_HOURS: i64 = 72;
/// 时段分布画 06:00–20:00（与 mock hourCurve 的 15 个桶一致，凌晨时段没有车可看）
const HOUR_START: i64 = 6;
const HOUR_END: i64 = 20;

/// 在途作业的状态集：与 mock 的 OPEN 集合逐字一致。
/// 注意 §9.24 的 v_open_order 用「排除终态」表达，会把 settled / paid 也算进去——
/// 看板语义是"还没结完钱的车"，所以这里显式列白名单。
const OPEN_STATUSES: &str =
    "'draft','registered','qc_done','gross_weighed','tare_weighed','reweigh','to_settle'";

/// 参与汇总统计的磅单（03 §10 / 不变式 4）
const STAT_WHERE: &str = "settlement_weight_01kg IS NOT NULL AND status NOT IN ('voided','rejected')";

fn pool_of(app: &AppHandle) -> Result<Pool, String> {
    app.try_state::<Db>()
        .map(|d| d.shared())
        .ok_or_else(|| "数据库尚未就绪（启动迁移未完成）".to_string())
}

/// 业务日期口径（本地日历日）。跨零点作业的单归前一日，由录单时写死在
/// `business_date` 上，这里只负责"今天"是哪一天。
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

/// 读一个 int 型系统参数；键不存在或值不是数字时用默认值（看板不能因为
/// 一个没迁移过来的阈值整页打不开）。`app_setting.value_json` 是 JSON 编码。
fn setting_int(conn: &Connection, key: &str, default: i64) -> i64 {
    conn.query_row(
        "SELECT value_json FROM app_setting WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .and_then(|v| v.as_i64())
    .unwrap_or(default)
}

// --------------------------------------------------------------------- 输出结构
// 字段名即前端契约（src/mock/types.ts 的 Dashboard），改名 = 改页面。

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dashboard {
    pub today: TodayStat,
    pub open_orders: Vec<OpenOrderRow>,
    pub alerts: Vec<Alert>,
    pub trend: Vec<TrendRow>,
    pub by_variety: Vec<VarietyRow>,
    pub by_party_type: Vec<PartyTypeRow>,
    pub hour_curve: Vec<HourRow>,
    /// 看板设备面板随行数据：设备中心整模块换真库前，页面不再借道 mock 的
    /// listDevices，保证"面板 + 告警"同源，不再出现两套设备说法。
    pub devices: Vec<DeviceRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TodayStat {
    pub orders: i64,
    pub net_01kg: i64,
    pub settle_01kg: i64,
    pub goods_fen: i64,
    pub payable_fen: i64,
    pub paid_fen: i64,
    pub credit_fen: i64,
    // 前端 Dashboard.today 用的是驼峰 manualCount/rejectCount（mock 时代就这样），
    // 逐字对齐，不趁机改页面。
    #[serde(rename = "manualCount")]
    pub manual_count: i64,
    #[serde(rename = "rejectCount")]
    pub reject_count: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenOrderRow {
    pub order_no: String,
    pub party_name: String,
    pub status: String,
    pub variety_name: String,
    pub since_minutes: i64,
    pub overdue: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Alert {
    /// neutral | info | success | warning | danger（前端 Tone）
    pub level: String,
    pub title: String,
    pub detail: String,
    pub action: String,
    pub href: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrendRow {
    pub date: String,
    pub net_01kg: i64,
    pub goods_fen: i64,
    pub orders: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct VarietyRow {
    pub variety_code: String,
    pub variety_name: String,
    pub net_01kg: i64,
    pub goods_fen: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PartyTypeRow {
    pub r#type: String,
    pub label: String,
    pub orders: i64,
    pub net_01kg: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct HourRow {
    pub hour: i64,
    pub orders: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceRow {
    pub code: String,
    pub name: String,
    pub kind: String,
    pub is_enabled: i64,
    pub last_status: String,
    pub last_error: Option<String>,
}

// ------------------------------------------------------------------- 文案小工具
// 与 src/lib/format.ts 逐字对齐：告警文案是字符串，两端口径不一致会打架。

/// format.ts money()：分 → "¥12,345.00"（zh-CN 千分位）
fn money(fen: i64) -> String {
    let sign = if fen < 0 { "-" } else { "" };
    let abs = fen.unsigned_abs();
    let (yuan, cents) = (abs / 100, abs % 100);
    let digits = yuan.to_string();
    let mut grouped = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(c);
    }
    format!("{sign}¥{grouped}.{cents:02}")
}

/// format.ts durationText()
fn duration_text(minutes: i64) -> String {
    if minutes < 60 {
        return format!("{minutes} 分钟");
    }
    let h = minutes / 60;
    if h < 24 {
        let m = minutes % 60;
        return if m == 0 {
            format!("{h} 小时")
        } else {
            format!("{h} 小时 {m} 分")
        };
    }
    let d = h / 24;
    let rh = h % 24;
    if rh == 0 {
        format!("{d} 天")
    } else {
        format!("{d} 天 {rh} 小时")
    }
}

/// constants.ts PARTY_TYPE：库里存的是英文枚举，label 是展示层快照，
/// 前端 `PARTY_TYPE[p.type] ?? p.label` 反正会再覆盖一次，两边各留一份不冲突。
fn party_type_label(t: &str) -> String {
    match t {
        "farmer" => "农户",
        "large_grower" => "种粮大户",
        "broker" => "经纪人",
        "cooperative" => "合作社",
        "company" => "企业",
        other => other,
    }
    .to_string()
}

// --------------------------------------------------------------------- 纯库操作
// 全部收 &Connection、不碰 Tauri 状态，tests/dashboard_contract.rs 直接跑这段。

pub fn build_dashboard(conn: &Connection) -> Result<Dashboard, String> {
    let tk = today();
    let window_from = days_before(&tk, TREND_DAYS - 1);
    let alert_minutes = setting_int(conn, "open_order_alert_minutes", DEFAULT_ALERT_MINUTES);
    let due_hours = setting_int(conn, "payment_due_warn_hours", DEFAULT_DUE_HOURS);

    // ------------------------------------------------------------- 今日汇总
    let (orders, net, settle, goods, payable, paid): (i64, i64, i64, i64, i64, i64) = conn
        .query_row(
            &format!(
                "SELECT COUNT(*), COALESCE(SUM(net_weight_01kg),0), COALESCE(SUM(settlement_weight_01kg),0),
                        COALESCE(SUM(goods_amount_fen),0), COALESCE(SUM(payable_amount_fen),0),
                        COALESCE(SUM(paid_amount_fen),0)
                 FROM weigh_order WHERE business_date = ?1 AND {STAT_WHERE}"
            ),
            params![tk],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .map_err(|e| format!("读取今日汇总失败：{e}"))?;
    let manual_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM weigh_order WHERE business_date = ?1 AND weight_source = 'manual'",
            params![tk],
            |r| r.get(0),
        )
        .map_err(|e| format!("读取手录车次失败：{e}"))?;
    let reject_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM weigh_order WHERE business_date = ?1 AND status = 'rejected'",
            params![tk],
            |r| r.get(0),
        )
        .map_err(|e| format!("读取拒收车次失败：{e}"))?;

    // --------------------------------------------------------------- 在途作业
    // 停留时点与 §9.24 同口径：COALESCE(tare_at, gross_at, registered_at)。
    // stuck_minutes 直接取视图列（0005 起基准已修正，不再本地重算第二套）。
    let mut stmt = conn
        .prepare(&format!(
            "SELECT order_no, party_name, status, variety_name, stuck_minutes
             FROM v_open_order
             WHERE status IN ({OPEN_STATUSES})
             ORDER BY stuck_minutes DESC",
        ))
        .map_err(|e| format!("读取在途作业失败：{e}"))?;
    let open_orders: Vec<OpenOrderRow> = stmt
        .query_map([], |r| {
            let since: i64 = r.get(4)?;
            Ok(OpenOrderRow {
                order_no: r.get(0)?,
                party_name: r.get(1)?,
                status: r.get(2)?,
                variety_name: r.get(3)?,
                since_minutes: since.max(0),
                overdue: since > alert_minutes,
            })
        })
        .map_err(|e| format!("读取在途作业失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取在途作业失败：{e}"))?;

    // ---------------------------------------------------------------- 设备面板
    let mut stmt = conn
        .prepare(
            "SELECT code, name, kind, is_enabled, last_status, last_error
             FROM device_config WHERE is_enabled = 1 ORDER BY kind, code",
        )
        .map_err(|e| format!("读取设备状态失败：{e}"))?;
    let devices: Vec<DeviceRow> = stmt
        .query_map([], |r| {
            Ok(DeviceRow {
                code: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                is_enabled: r.get(3)?,
                last_status: r.get(4)?,
                last_error: r.get(5)?,
            })
        })
        .map_err(|e| format!("读取设备状态失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取设备状态失败：{e}"))?;

    // ------------------------------------------------------------------- 趋势
    let mut stmt = conn
        .prepare(&format!(
            "SELECT business_date, COUNT(*), COALESCE(SUM(net_weight_01kg),0), COALESCE(SUM(goods_amount_fen),0)
             FROM weigh_order
             WHERE business_date BETWEEN ?1 AND ?2 AND {STAT_WHERE}
             GROUP BY business_date"
        ))
        .map_err(|e| format!("读取趋势失败：{e}"))?;
    let agg: Vec<(String, i64, i64, i64)> = stmt
        .query_map(params![window_from, tk], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| format!("读取趋势失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取趋势失败：{e}"))?;
    let trend: Vec<TrendRow> = (0..TREND_DAYS)
        .map(|i| {
            let date = days_before(&tk, TREND_DAYS - 1 - i);
            agg.iter()
                .find(|(d, ..)| *d == date)
                .map(|(_, orders, net, goods)| TrendRow {
                    date: date.clone(),
                    orders: *orders,
                    net_01kg: *net,
                    goods_fen: *goods,
                })
                .unwrap_or(TrendRow { date, net_01kg: 0, goods_fen: 0, orders: 0 })
        })
        .collect();

    // --------------------------------------------------------------- 品种分组
    // 品种全集来自档案（LEFT JOIN 聚合），没收粮的品种也占一行 0。与 mock 的差别：
    // mock 写死四个品种，这里跟着 grain_variety 走——档案页加了品种，看板就有柱子。
    let mut stmt = conn
        .prepare(&format!(
            "SELECT v.code, v.name, COALESCE(s.net, 0), COALESCE(s.goods, 0)
             FROM grain_variety v
             LEFT JOIN (
                 SELECT variety_id, SUM(net_weight_01kg) AS net, SUM(goods_amount_fen) AS goods
                 FROM weigh_order
                 WHERE business_date >= ?1 AND {STAT_WHERE}
                 GROUP BY variety_id
             ) s ON s.variety_id = v.id
             WHERE v.deleted_at IS NULL
             ORDER BY v.sort_order, v.code"
        ))
        .map_err(|e| format!("读取品种分组失败：{e}"))?;
    let by_variety: Vec<VarietyRow> = stmt
        .query_map(params![window_from], |r| {
            Ok(VarietyRow {
                variety_code: r.get(0)?,
                variety_name: r.get(1)?,
                net_01kg: r.get(2)?,
                goods_fen: r.get(3)?,
            })
        })
        .map_err(|e| format!("读取品种分组失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取品种分组失败：{e}"))?;

    // ------------------------------------------------------------- 售粮人构成
    let mut stmt = conn
        .prepare(
            "SELECT p.party_type, COUNT(*), COALESCE(SUM(o.net_weight_01kg),0)
             FROM weigh_order o JOIN party p ON p.id = o.party_id
             WHERE o.business_date >= ?1
               AND o.settlement_weight_01kg IS NOT NULL
               AND o.status NOT IN ('voided','rejected')
             GROUP BY p.party_type ORDER BY p.party_type",
        )
        .map_err(|e| format!("读取售粮人构成失败：{e}"))?;
    let by_party_type: Vec<PartyTypeRow> = stmt
        .query_map(params![window_from], |r| {
            let t: String = r.get(0)?;
            Ok(PartyTypeRow {
                r#type: t.clone(),
                label: party_type_label(&t),
                orders: r.get(1)?,
                net_01kg: r.get(2)?,
            })
        })
        .map_err(|e| format!("读取售粮人构成失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取售粮人构成失败：{e}"))?;

    // ----------------------------------------------------------------- 时段分布
    // registered_at 落库即本地挂钟文本（+08:00），substr 取时与 mock 的
    // getHours 等价，且不受 julianday 时区陷阱影响。统计**今日全部单**
    // （含在途/作废），口径同 mock：它画的是"什么时候来过车"。
    let mut stmt = conn
        .prepare(
            "SELECT CAST(substr(registered_at, 12, 2) AS INTEGER), COUNT(*)
             FROM weigh_order WHERE business_date = ?1 GROUP BY 1",
        )
        .map_err(|e| format!("读取时段分布失败：{e}"))?;
    let hours: Vec<(i64, i64)> = stmt
        .query_map(params![tk], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| format!("读取时段分布失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取时段分布失败：{e}"))?;
    let hour_curve: Vec<HourRow> = (HOUR_START..=HOUR_END)
        .map(|h| HourRow {
            hour: h,
            orders: hours.iter().find(|(x, _)| *x == h).map(|(_, n)| *n).unwrap_or(0),
        })
        .collect();

    // ------------------------------------------------------------------- 告警
    // 顺序即进站第一眼优先级（05 §3）：挂账 → 在途超时 → 设备 → 手录。
    let mut alerts: Vec<Alert> = Vec::new();

    // unpaid_hours 直接取 v_payable 视图列（0005 起基准已修正）。
    // 视图本身只管"还没付清"，"已超时效"由这里的阈值判定。
    let (credit_n, credit_fen): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(unpaid_fen),0)
             FROM v_payable
             WHERE unpaid_hours > ?1",
            params![due_hours],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| format!("读取挂账告警失败：{e}"))?;
    if credit_n > 0 {
        let due_text = if due_hours % 24 == 0 {
            format!("{} 天", due_hours / 24)
        } else {
            format!("{due_hours} 小时")
        };
        alerts.push(Alert {
            level: "danger".into(),
            title: format!("{credit_n} 笔挂账超过付款时效"),
            detail: format!("合计 {} 未付，已超 {due_text}时效", money(credit_fen)),
            action: "去付款登记".into(),
            href: "/payments".into(),
        });
    }

    let overdue_open: Vec<&OpenOrderRow> = open_orders.iter().filter(|o| o.overdue).collect();
    if let Some(worst) = overdue_open.first() {
        alerts.push(Alert {
            level: "warning".into(),
            title: format!("{} 车在途超时", overdue_open.len()),
            detail: format!(
                "最久 {}：{} {}",
                duration_text(worst.since_minutes),
                worst.order_no,
                worst.party_name
            ),
            action: "回工作台继续".into(),
            href: "/workstation".into(),
        });
    }

    let offline: Vec<&DeviceRow> = devices.iter().filter(|d| d.last_status != "online").collect();
    if !offline.is_empty() {
        alerts.push(Alert {
            level: "danger".into(),
            title: format!("{} 台设备离线或故障", offline.len()),
            detail: offline
                .iter()
                .map(|d| format!("{}（{}）", d.name, d.last_error.as_deref().unwrap_or("未连接")))
                .collect::<Vec<_>>()
                .join("；"),
            action: "打开设备中心".into(),
            href: "/devices".into(),
        });
    }

    if manual_count > 0 {
        alerts.push(Alert {
            level: "warning".into(),
            title: format!("今日 {manual_count} 单为手录称重"),
            detail: "手录单据迎检必查，请核对仪表日志".into(),
            action: "查看手录清单".into(),
            href: "/orders?weightSource=manual".into(),
        });
    }

    Ok(Dashboard {
        today: TodayStat {
            orders,
            net_01kg: net,
            settle_01kg: settle,
            goods_fen: goods,
            payable_fen: payable,
            paid_fen: paid,
            credit_fen: payable - paid,
            manual_count,
            reject_count,
        },
        open_orders,
        alerts,
        trend,
        by_variety,
        by_party_type,
        hour_curve,
        devices,
    })
}

// ----------------------------------------------------------------- Tauri 命令

/// 看板是只读聚合，所有岗位（含 viewer）都要能看，不设写入闸门。
#[tauri::command]
pub async fn dashboard_data(app: AppHandle) -> Result<Dashboard, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, build_dashboard))
        .await
        .map_err(|e| format!("看板聚合任务失败：{e}"))?
}
