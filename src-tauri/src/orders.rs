//! 工作台录单全链路（02 §7 M2–M5；03 §3.5 编号、§4.3 不变式、§9.6/§9.11–§9.19）
//!
//! 这是「从 mock 换成真库」的第三块：制单 → 称重 → 化验 → 结算 → 打印留痕，
//! 外加工作台离不开的售粮人档案（查/建/改）。沿用 [`crate::masters`] 立的规矩：
//! DTO 与 `src/mock/types.ts` 逐字一致、业务校验回中文短句、写入留审计、
//! 权限在命令层按会话岗位判（`operator_id`/`registered_by` 等入参一律忽略，以会话为准）。
//!
//! 与 mock 的**有意差异**（都是真库才暴露得出的正确性问题）：
//!  - **取号**按 §3.5 走 `seq_counter`（站点+前缀+**年月**，`BD01202609…`），与磅单
//!    插入同事务——mock 用数组长度拼号，ZJ/JS 甚至按天不归零，并发必重号。
//!  - **已结算/已作废的单不再允许称重、补录化验**（mock 全放行）；重复结算被
//!    `uk_so_order`（不变式 6）拦住并回人话。
//!  - **复检链**：同单再录化验时旧报告 `is_effective=0`（不变式 7 的
//!    `uk_qc_effective` 也逼着必须这么做），新报告 `is_recheck=1` 并指回首检。
//!  - **拒收单复检接收后恢复流转**（mock 会把单永久卡在 rejected）。
//!  - **皮重超容差不拦车**：服务端复算偏差，超出即自动在磅单上记一条警示文案（屏显醒目条 +
//!    时间轴 + 审计 + 票面「皮重警示」栏），捕获照常完成；旧的「站长授权放行」路径已移除。
//!  - `party.last_tare_01kg` 在每次皮重捕获后刷新——皮重异常参考从此用真历史。
//!
//! **PII 过渡态**：`id_card_no_enc` / `phone_enc` / `bank_account_enc` 现以明文 UTF-8
//! 存入 BLOB。AES-GCM + keyring 的加密基建还没写（`pii_encrypt_enabled` 参数目前
//! 只是占位），单独一轮补；但**证号 SHA-256 fp 从第一天就落**——读卡反查
//! （`idx_party_fp`）与建档去重靠它，密文化时只需换编解码列，索引与流程不动。
//! 电话的唯一性（`uk_party_phone`，0013）则**确实吃明文**：密文化时要与证号同路子
//! 换成确定性哈希列 `phone_fp`，[`phone_key`] 的归一口径跟着搬到那一列。
//! 界面照旧全程走 `maskIdCard`，明文不出 WebView（invoke 返回值除外——和档案页
//! 现行为一致，密文基建落地前不假装更安全）。
//!
//! 抓拍照片本轮仍不落 `attachment`：过磅画面的取帧通道还没接（前端传的
//! `has_photo` 只是"当时摄像头在线"的自我声明）。DTO 的 has_photo/抓拍墙一律按
//! `photo_attachment_id IS NOT NULL` 现算——没存图就诚实显示"无抓拍"。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{Duration, Local};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::auth::{self, AuthProfile};
use crate::camera;
use crate::db::{locked, Db};

type Pool = Arc<Mutex<Connection>>;

fn pool_of(app: &AppHandle) -> Result<Pool, String> {
    app.try_state::<Db>()
        .map(|d| d.shared())
        .ok_or_else(|| "数据库尚未就绪（启动迁移未完成）".to_string())
}

fn now_iso() -> String {
    crate::db::migrate::now_iso()
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

// ----------------------------------------------------------------------- 权限闸门
// 与 05 §6.1 前端 can() 同源，这里是最后一道。读不设岗（viewer 也要能看队列与档案）。

fn actor_with_roles(app: &AppHandle, roles: &[&str], what: &str) -> Result<AuthProfile, String> {
    let actor = auth::current_actor(app).ok_or_else(|| "登录已失效或已锁屏，请先解锁再继续作业".to_string())?;
    if actor.must_change_pwd {
        return Err("当前账号尚未完成首登改密，不能进行业务写入".into());
    }
    if !roles.contains(&actor.role.as_str()) {
        return Err(format!(
            "岗位「{}」无权{what}，需要：{}",
            actor.role,
            roles.join(" / ")
        ));
    }
    Ok(actor)
}

/// 制单 / 称重 / 建档：磅房现场岗三件套（05 §6.1 order.create、party.manage）
const FLOOR_ROLES: &[&str] = &["station_master", "registrar", "weigher"];
/// 化验录入（05 §6.1 qc.save）
const QC_ROLES: &[&str] = &["station_master", "inspector"];
/// 结算与当场付款（05 §6.1 settle.create）：能生成结算单，也能当场收钱
pub(crate) const SETTLE_ROLES: &[&str] = &["station_master", "cashier"];
/// 挂账结算（05 §6.1 settle.credit）：磅员也在这条上，**只能把单挂上账、不动现金**。
///
/// 两把钥匙分开的理由见 `src/store/session.ts` 里同名能力的注释：皮重刚捕完那一刻不让磅员
/// 挂账，整条"两刷一条流"就得卡在窗口等人取钱；而把 `weigher` 并进 `SETTLE_ROLES`，
/// 同一把钥匙也开得了"当场付款"那扇门。所以命令层按 `pay_now` 选角色集，**不取并集**。
pub(crate) const SETTLE_CREDIT_ROLES: &[&str] = &["station_master", "cashier", "weigher"];
/// 补录入仓去向：值仓的活，站长兜底（02 §11 保管员 = 指定仓房货位）
const KEEPER_ROLES: &[&str] = &["station_master", "keeper"];
/// 调整等级：化验员定级、出纳结算时改判、站长兜底（02 §11；结算常按实际议价改判）
const GRADE_ROLES: &[&str] = &["station_master", "inspector", "cashier"];
/// 定价 / 改价：磅房现场议价由磅员谈定即落，站长兜底（02 §F1.4）。
///
/// 为什么定价权要下到磅房：农户是**先问价、谈成才卸货**的，价必须在过磅出票之前就定下来，
/// 否则票面没有价、事后无从对账。价目表只是"挂牌"起点，议价偏离可留一句事由（见 `set_price`）。
/// 这把钥匙不含"收钱"——定价与收付款是两件事，出纳那把钥匙在 `SETTLE_ROLES` 上。
///
/// 名沿用既有的 `price.override`：前端 `store/session.ts` 的能力点、审计动作码、
/// `SystemPage` 的「改单价」话术三处本来就是同一个词（`tare.override` 也是这么用的），
/// 不要另造一个 `order.price`。
const PRICE_OVERRIDE_ROLES: &[&str] = &["station_master", "weigher"];
/// 调整收购品种：三个入口都改了同一列——磅员/登记员在制单格里定、化验员在化验区选（选完才有指标集）、
/// 出纳在结算框改（改完单价重带），站长兜底。闸门取并集，细的收口靠各自的界面。
const VARIETY_ROLES: &[&str] = &["station_master", "registrar", "weigher", "inspector", "cashier"];

/// 等级值域。与 `src/lib/constants.ts::GRADES` 逐字同源（`ledger.rs` 里那份是给报表图例排的）。
/// 出库单（`crate::outbound`）复用同一份，两边不许各写一套字面量。
pub(crate) const GRADES: &[&str] = &["一等", "二等", "三等", "四等", "等外"];

// ------------------------------------------------------------------------- 审计
// audit_log（§9.21）动作名与 mock 层逐字一致（order.create / order.destination /
// tare.override / settle.create / pay.record / party.create|update），审计页换真库不用改筛选。

pub(crate) fn audit(
    conn: &Connection,
    actor: &AuthProfile,
    action: &str,
    entity: &str,
    entity_no: &str,
    reason: Option<&str>,
    authorized_by: Option<i64>,
) {
    let client_info = {
        let host = std::env::var("COMPUTERNAME")
            .or_else(|_| std::env::var("HOSTNAME"))
            .unwrap_or_else(|_| "未知机器".into());
        format!("{host} / banghe {}", env!("CARGO_PKG_VERSION"))
    };
    let result = conn.execute(
        "INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_no, reason, result, client_info, authorized_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ok', ?8, ?9)",
        params![
            now_iso(), actor.id, actor.display_name, action, entity, entity_no, reason, client_info, authorized_by,
        ],
    );
    if let Err(e) = result {
        eprintln!("[banghe] 业务审计写入失败（{action} {entity} {entity_no}）：{e}");
    }
}

// --------------------------------------------------------------------------- 取号
// §3.5：<前缀><站点码2><年4><月2><流水 seq_len>；seq_counter 按 站点+前缀+年月 归零，
// UPSERT...RETURNING 与业务插入同事务，断电不重号、不跳号（作废号占位不复用）。

fn setting_str(conn: &Connection, key: &str, default: &str) -> String {
    conn.query_row("SELECT value_json FROM app_setting WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .and_then(|v| v.as_str().map(str::to_string))
    .unwrap_or_else(|| default.to_string())
}

pub(crate) fn setting_int(conn: &Connection, key: &str, default: i64) -> i64 {
    conn.query_row("SELECT value_json FROM app_setting WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .and_then(|v| v.as_i64())
    .unwrap_or(default)
}

/// 站点参数里的开关。值以 JSON 存，`true`/`false` 之外的形态（没这条键、被人写成字符串）
/// 一律按默认值走——开关类的东西不能因为格式坏了就停掉作业。
pub(crate) fn setting_bool(conn: &Connection, key: &str, default: bool) -> bool {
    conn.query_row("SELECT value_json FROM app_setting WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
    .and_then(|v| v.as_bool().or_else(|| v.as_i64().map(|n| n != 0)))
    .unwrap_or(default)
}

fn station_code(conn: &Connection) -> Result<String, String> {
    conn.query_row("SELECT code FROM station WHERE is_active = 1 ORDER BY id LIMIT 1", [], |r| {
        r.get::<_, String>(0)
    })
    .map_err(|_| "站点档案尚未初始化，无法取号（先到系统设置维护站点）".to_string())
}

/// 取一个业务单号。doc_type 用 app_setting 前缀键的后缀（BD/ZJ/JS/FK），无键时回退同名常量。
pub(crate) fn next_no(conn: &Connection, doc: &str) -> Result<String, String> {
    let prefix = setting_str(conn, &format!("doc_no_prefix_{doc}"), doc);
    let code = station_code(conn)?;
    let len = setting_int(conn, "doc_no_seq_len", 6).clamp(1, 12) as usize;
    let ym = Local::now().format("%Y%m").to_string();
    let cur: i64 = conn
        .query_row(
            "INSERT INTO seq_counter (prefix_key, current, step, updated_at)
             VALUES (?1, 1, 1, ?2)
             ON CONFLICT(prefix_key) DO UPDATE SET current = current + 1, updated_at = excluded.updated_at
             RETURNING current",
            params![format!("{doc}:{code}:{ym}"), now_iso()],
            |r| r.get(0),
        )
        .map_err(|e| format!("取号失败（{doc}）：{e}"))?;
    Ok(format!("{prefix}{code}{ym}{:0len$}", cur, len = len))
}

fn user_name(conn: &Connection, id: Option<i64>) -> String {
    id.and_then(|id| {
        conn.query_row("SELECT display_name FROM user_account WHERE id = ?1", params![id], |r| {
            r.get::<_, String>(0)
        })
        .ok()
    })
    .unwrap_or_else(|| "—".into())
}

// ----------------------------------------------------------------------- 输出结构
// 与 src/mock/types.ts 逐字对齐；records/photos/prints/timeline 是"详情才带"的
// 聚合（mock 注释同口径），列表接口输出时整字段缺席（skip_serializing_if none）。

#[derive(Debug, Clone, Serialize)]
pub struct WeighOrder {
    pub id: i64,
    pub order_no: String,
    pub business_date: String,
    pub status: String,
    pub party_id: i64,
    pub party_name: String,
    pub party_type: String,
    pub id_card_no: String,
    /// 收购品种：制单可空（06 §4.0 两刷一条流），结算与录化验前必填（0017）
    pub variety_id: Option<i64>,
    pub variety_code: Option<String>,
    pub variety_name: Option<String>,
    pub grade: Option<String>,
    pub warehouse_id: Option<i64>,
    pub warehouse_name: Option<String>,
    pub slot_id: Option<i64>,
    pub slot_label: Option<String>,
    pub card_no: Option<String>,
    pub vehicle_no: Option<String>,
    pub driver_name: Option<String>,
    pub gross_weight_01kg: Option<i64>,
    pub tare_weight_01kg: Option<i64>,
    pub net_weight_01kg: Option<i64>,
    pub package_deduct_01kg: i64,
    pub package_count: i64,
    pub moisture_deduct_01kg: i64,
    pub impurity_deduct_01kg: i64,
    pub other_deduct_01kg: i64,
    pub deduct_total_01kg: i64,
    pub settlement_weight_01kg: Option<i64>,
    pub price_fen_per_ton: Option<i64>,
    pub price_list_id: Option<i64>,
    pub price_override_reason: Option<String>,
    pub goods_amount_fen: Option<i64>,
    pub deduction_fee_fen: i64,
    pub advance_fee_fen: i64,
    pub payable_amount_fen: Option<i64>,
    pub paid_amount_fen: i64,
    pub payment_status: String,
    pub payment_method: Option<String>,
    pub weight_source: String,
    /// 旧「授权放行」遗留列：授权路径移除后恒为 NULL，列留着只为兼容既有库
    pub tare_override_by: Option<i64>,
    /// 皮重偏差超容差的警示文案（服务端自动生成）；null = 未超差
    pub tare_override_reason: Option<String>,
    pub is_manual_pricing: i64,
    pub reversed_order_id: Option<i64>,
    pub reverse_of_id: Option<i64>,
    pub qc_report_id: Option<i64>,
    pub registered_by: i64,
    pub registered_at: String,
    pub gross_at: Option<String>,
    pub tare_at: Option<String>,
    pub qc_at: Option<String>,
    pub settled_at: Option<String>,
    pub paid_at: Option<String>,
    pub voided_at: Option<String>,
    pub void_reason: Option<String>,
    pub weigher_id: Option<i64>,
    pub inspector_id: Option<i64>,
    pub keeper_id: Option<i64>,
    pub remark: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub records: Option<Vec<WeighRecord>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub photos: Option<Vec<CapturePhoto>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prints: Option<Vec<PrintLog>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline: Option<Vec<TimelineEvent>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeighRecord {
    pub id: i64,
    pub seq: i64,
    pub weigh_type: String,
    pub weight_01kg: i64,
    pub aligned_weight_01kg: i64,
    pub is_adopted: i64,
    pub adopt_reason: Option<String>,
    pub source: String,
    pub device_code: String,
    pub raw_frame: Option<String>,
    pub stable: i64,
    pub captured_at: String,
    pub operator_id: i64,
    pub has_photo: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct CapturePhoto {
    /// 有图时是 `attachment.id`（读原图按它取）；缺图占位格用 `-称重记录 id`（负数，与
    /// 真实附件 id 永不撞号，前端 `missing` 为真时也不会拿它去读图）。
    pub id: i64,
    pub biz_type: String,
    pub label: String,
    /// 这张是谁拍的（相机台账名）；缺图占位格没有来源相机，为 `None`
    pub device_label: Option<String>,
    pub tone: String,
    pub captured_at: String,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrintLog {
    pub id: i64,
    pub doc_type: String,
    pub doc_no: String,
    pub copies: i64,
    pub paper: String,
    pub printer_name: String,
    pub channel: String,
    pub is_reprint: i64,
    pub authorized_by: Option<i64>,
    pub result: String,
    pub error_msg: Option<String>,
    pub printed_at: String,
    pub operator_id: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TimelineEvent {
    pub at: String,
    pub action: String,
    pub label: String,
    pub actor: String,
    pub tone: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Party {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub party_type: String,
    pub id_card_no: String,
    pub id_card_verified: i64,
    pub phone: String,
    pub address: String,
    pub bank_name: Option<String>,
    pub bank_account: Option<String>,
    pub credit_limit_fen: i64,
    pub default_warehouse_id: Option<i64>,
    pub default_slot_id: Option<i64>,
    pub default_vehicle_no: Option<String>,
    pub last_tare_01kg: Option<i64>,
    pub remark: Option<String>,
    pub status: String,
    pub created_at: String,
    /// 人像照片（§9.6 `photo_attachment_id`）。**选填**：手工上传与读卡自动带入都落这一列，
    /// `NULL` 就是"这张档案没有照片"，界面按"无照片"显示，不当成缺数据。
    pub photo_attachment_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PartyDetail {
    #[serde(flatten)]
    pub party: Party,
    pub recent: Vec<WeighOrder>,
    #[serde(rename = "tareHistory")]
    pub tare_history: Vec<TareRow>,
    pub credit_fen: i64,
    pub total_net_01kg: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TareRow {
    pub date: String,
    pub tare_01kg: i64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct QcIndicatorRow {
    pub code: String,
    pub name: String,
    pub value_num: Option<i64>,
    pub value_text: Option<String>,
    pub unit: String,
    pub std_value: Option<i64>,
    pub over_std: i64,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct QcReport {
    pub id: i64,
    pub report_no: String,
    pub order_id: i64,
    pub order_no: String,
    pub party_name: String,
    pub sample_no: String,
    pub variety_id: i64,
    pub grade: Option<String>,
    pub decision: String,
    pub reject_reason: Option<String>,
    pub moisture_deduct_01kg: i64,
    pub impurity_deduct_01kg: i64,
    pub test_method: String,
    pub is_recheck: i64,
    pub first_report_id: Option<i64>,
    pub is_effective: i64,
    pub inspector_id: i64,
    pub inspected_at: String,
    pub retention_no: Option<String>,
    pub retention_until: Option<String>,
    pub indicators: Vec<QcIndicatorRow>,
    pub remark: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettlementOrderRow {
    pub order_id: i64,
    pub order_no: String,
    pub goods_amount_fen: i64,
    pub price_fen_per_ton: i64,
    pub settlement_weight_01kg: i64,
    pub seq: i64,
}

#[derive(Debug, Clone, Serialize)]
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
    pub payment_status: String,
    pub main_method: Option<String>,
    pub payee_name: String,
    pub signed_by_party: i64,
    pub status: String,
    pub settled_at: String,
    pub settler_id: i64,
    pub orders: Vec<SettlementOrderRow>,
    pub remark: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SettleResult {
    pub order: WeighOrder,
    pub settlement: Settlement,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageResult {
    pub rows: Vec<WeighOrder>,
    pub total: i64,
    pub summary: Summary,
}

#[derive(Debug, Clone, Serialize)]
pub struct Summary {
    pub count: i64,
    pub net_01kg: i64,
    pub settle_01kg: i64,
    pub goods_fen: i64,
    pub payable_fen: i64,
}

// ------------------------------------------------------------------ 磅单行读取

/// 列表/详情的公共列。party 走 INNER JOIN（外键保证恒在），variety 走 LEFT JOIN——
/// 品种自 0017 起可空（制单时还没定也成立一张单），用 INNER JOIN 会让没品种的磅单
/// 从列表、详情、在途看板与全局搜索里整条凭空消失。仓房货位 LEFT JOIN；
/// 证号从过渡明文 BLOB 里 CAST 出来。
/// 此常量同时喂 order_get / order_list / open_orders / search / settlements，改一处全线生效。
pub(crate) const ORDER_SELECT: &str = "SELECT o.id, o.order_no, o.business_date, o.status,
         o.party_id, p.name, p.party_type, COALESCE(CAST(p.id_card_no_enc AS TEXT), ''),
         o.variety_id, v.code, v.name, o.grade, o.warehouse_id, w.name, o.slot_id, COALESCE(sl.label, sl.code),
         o.vehicle_no, o.driver_name,
         o.gross_weight_01kg, o.tare_weight_01kg, o.net_weight_01kg, o.package_deduct_01kg, o.package_count,
         o.moisture_deduct_01kg, o.impurity_deduct_01kg, o.other_deduct_01kg, o.deduct_total_01kg, o.settlement_weight_01kg,
         o.price_fen_per_ton, o.price_list_id, o.price_override_reason, o.goods_amount_fen, o.deduction_fee_fen, o.advance_fee_fen,
         o.payable_amount_fen, o.paid_amount_fen, o.payment_status, o.payment_method,
         o.weight_source, o.tare_override_by, o.tare_override_reason, o.is_manual_pricing, o.reversed_order_id, o.reverse_of_id, o.qc_report_id,
         o.registered_by, o.registered_at, o.gross_at, o.tare_at, o.qc_at, o.settled_at, o.paid_at, o.voided_at, o.void_reason,
         o.weigher_id, o.inspector_id, o.keeper_id, o.remark, o.created_at, o.updated_at,
         o.card_no
  FROM weigh_order o
  JOIN party p ON p.id = o.party_id
  LEFT JOIN grain_variety v ON v.id = o.variety_id
  LEFT JOIN warehouse w ON w.id = o.warehouse_id
  LEFT JOIN storage_slot sl ON sl.id = o.slot_id";

pub(crate) fn map_order_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WeighOrder> {
    Ok(WeighOrder {
        id: r.get(0)?,
        order_no: r.get(1)?,
        business_date: r.get(2)?,
        status: r.get(3)?,
        party_id: r.get(4)?,
        party_name: r.get(5)?,
        party_type: r.get(6)?,
        id_card_no: r.get(7)?,
        variety_id: r.get(8)?,
        variety_code: r.get(9)?,
        variety_name: r.get(10)?,
        grade: r.get(11)?,
        warehouse_id: r.get(12)?,
        warehouse_name: r.get(13)?,
        slot_id: r.get(14)?,
        slot_label: r.get(15)?,
        vehicle_no: r.get(16)?,
        driver_name: r.get(17)?,
        gross_weight_01kg: r.get(18)?,
        tare_weight_01kg: r.get(19)?,
        net_weight_01kg: r.get(20)?,
        package_deduct_01kg: r.get(21)?,
        package_count: r.get(22)?,
        moisture_deduct_01kg: r.get(23)?,
        impurity_deduct_01kg: r.get(24)?,
        other_deduct_01kg: r.get(25)?,
        deduct_total_01kg: r.get(26)?,
        settlement_weight_01kg: r.get(27)?,
        price_fen_per_ton: r.get(28)?,
        price_list_id: r.get(29)?,
        price_override_reason: r.get(30)?,
        goods_amount_fen: r.get(31)?,
        deduction_fee_fen: r.get(32)?,
        advance_fee_fen: r.get(33)?,
        payable_amount_fen: r.get(34)?,
        paid_amount_fen: r.get(35)?,
        payment_status: r.get(36)?,
        payment_method: r.get(37)?,
        weight_source: r.get(38)?,
        tare_override_by: r.get(39)?,
        tare_override_reason: r.get(40)?,
        is_manual_pricing: r.get(41)?,
        reversed_order_id: r.get(42)?,
        reverse_of_id: r.get(43)?,
        qc_report_id: r.get(44)?,
        registered_by: r.get(45)?,
        registered_at: r.get(46)?,
        gross_at: r.get(47)?,
        tare_at: r.get(48)?,
        qc_at: r.get(49)?,
        settled_at: r.get(50)?,
        paid_at: r.get(51)?,
        voided_at: r.get(52)?,
        void_reason: r.get(53)?,
        weigher_id: r.get(54)?,
        inspector_id: r.get(55)?,
        keeper_id: r.get(56)?,
        remark: r.get(57)?,
        created_at: r.get(58)?,
        updated_at: r.get(59)?,
        // 末列追加：ORDER_SELECT 的新列一律排在最后，不重排上面这串下标
        card_no: r.get(60)?,
        records: None,
        photos: None,
        prints: None,
        timeline: None,
    })
}

const RECORD_COLS: &str = "wr.id, wr.seq, wr.weigh_type, wr.weight_01kg, wr.aligned_weight_01kg,
         wr.is_adopted, wr.adopt_reason, wr.source, COALESCE(d.code, '—'), wr.raw_frame,
         wr.stable, wr.captured_at, wr.operator_id, (wr.photo_attachment_id IS NOT NULL)";

fn map_record_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<WeighRecord> {
    Ok(WeighRecord {
        id: r.get(0)?,
        seq: r.get(1)?,
        weigh_type: r.get(2)?,
        weight_01kg: r.get(3)?,
        aligned_weight_01kg: r.get(4)?,
        is_adopted: r.get(5)?,
        adopt_reason: r.get(6)?,
        source: r.get(7)?,
        device_code: r.get(8)?,
        raw_frame: r.get(9)?,
        stable: r.get(10)?,
        captured_at: r.get(11)?,
        operator_id: r.get(12)?,
        has_photo: r.get(13)?,
    })
}

fn load_records(conn: &Connection, order_id: i64) -> Result<Vec<WeighRecord>, String> {
    let mut stmt = match conn.prepare(&format!(
        "SELECT {RECORD_COLS} FROM weigh_record wr LEFT JOIN device_config d ON d.id = wr.device_id
         WHERE wr.order_id = ?1 ORDER BY wr.seq"
    )) {
        Ok(s) => s,
        Err(e) => return Err(format!("读取称重轨迹失败：{e}")),
    };
    stmt.query_map(params![order_id], map_record_row)
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取称重轨迹失败：{e}"))
}

const PRINT_COLS: &str = "id, doc_type, doc_no, copies, paper, printer_name, channel, is_reprint,
         authorized_by, result, error_msg, printed_at, operator_id";

fn load_prints(conn: &Connection, order_no: &str) -> Result<Vec<PrintLog>, String> {
    let mut stmt = match conn.prepare(&format!(
        "SELECT {PRINT_COLS} FROM print_log WHERE doc_no = ?1 ORDER BY printed_at"
    )) {
        Ok(s) => s,
        Err(e) => return Err(format!("读取打印记录失败：{e}")),
    };
    stmt.query_map(params![order_no], |r| {
        Ok(PrintLog {
            id: r.get(0)?,
            doc_type: r.get(1)?,
            doc_no: r.get(2)?,
            copies: r.get(3)?,
            paper: r.get(4)?,
            printer_name: r.get(5)?,
            channel: r.get(6)?,
            is_reprint: r.get(7)?,
            authorized_by: r.get(8)?,
            result: r.get(9)?,
            error_msg: r.get(10)?,
            printed_at: r.get(11)?,
            operator_id: r.get(12)?,
        })
    })
    .and_then(|m| m.collect::<Result<Vec<_>, _>>())
    .map_err(|e| format!("读取打印记录失败：{e}"))
}

pub(crate) fn load_qc(conn: &Connection, report_id: i64) -> Result<Option<QcReport>, String> {
    type QcHead = (i64, String, i64, String, String, String, i64, Option<String>, String, Option<String>, i64, i64, String, i64, Option<i64>, i64, i64, String, Option<String>, Option<String>, Option<String>);
    let head: Option<QcHead> = conn
        .query_row(
            "SELECT q.id, q.report_no, q.order_id, o.order_no, p.name, COALESCE(q.sample_no, ''),
                    q.variety_id, q.grade, q.decision, q.reject_reason,
                    q.moisture_deduct_01kg, q.impurity_deduct_01kg, q.test_method,
                    q.is_recheck, q.first_report_id, q.is_effective,
                    q.inspector_id, q.inspected_at, q.retention_no, q.retention_until, q.remark
             FROM qc_report q
             JOIN weigh_order o ON o.id = q.order_id
             JOIN party p ON p.id = o.party_id
             WHERE q.id = ?1",
            params![report_id],
            |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?,
                    r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?,
                    r.get(10)?, r.get(11)?, r.get(12)?,
                    r.get(13)?, r.get(14)?, r.get(15)?,
                    r.get(16)?, r.get(17)?, r.get(18)?, r.get(19)?, r.get(20)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("读取化验单失败：{e}"))?;
    let Some(head) = head else { return Ok(None) };
    let indicators = load_indicators(conn, head.0)?;
    Ok(Some(QcReport {
        id: head.0,
        report_no: head.1,
        order_id: head.2,
        order_no: head.3,
        party_name: head.4,
        sample_no: head.5,
        variety_id: head.6,
        grade: head.7,
        decision: head.8,
        reject_reason: head.9,
        moisture_deduct_01kg: head.10,
        impurity_deduct_01kg: head.11,
        test_method: head.12,
        is_recheck: head.13,
        first_report_id: head.14,
        is_effective: head.15,
        inspector_id: head.16,
        inspected_at: head.17,
        retention_no: head.18,
        retention_until: head.19,
        remark: head.20,
        indicators,
    }))
}

fn load_indicators(conn: &Connection, report_id: i64) -> Result<Vec<QcIndicatorRow>, String> {
    let mut stmt = match conn.prepare(
        "SELECT code, name, value_num, value_text, unit, std_value, over_std, sort_order
         FROM qc_indicator WHERE report_id = ?1 ORDER BY sort_order, code",
    ) {
        Ok(s) => s,
        Err(e) => return Err(format!("读取化验指标失败：{e}")),
    };
    stmt.query_map(params![report_id], |r| {
        Ok(QcIndicatorRow {
            code: r.get(0)?,
            name: r.get(1)?,
            value_num: r.get(2)?,
            value_text: r.get(3)?,
            unit: r.get(4)?,
            std_value: r.get(5)?,
            over_std: r.get(6)?,
            sort_order: r.get(7)?,
        })
    })
    .and_then(|m| m.collect::<Result<Vec<_>, _>>())
    .map_err(|e| format!("读取化验指标失败：{e}"))
}

fn load_settlement_of(conn: &Connection, order_id: i64) -> Result<Option<Settlement>, String> {
    let id: Option<i64> = conn
        .query_row(
            "SELECT so.settlement_id FROM settlement_order so WHERE so.order_id = ?1 LIMIT 1",
            params![order_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("读取结算单失败：{e}"))?;
    match id {
        Some(id) => load_settlement_by_id(conn, id),
        None => Ok(None),
    }
}

pub(crate) fn load_settlement_by_id(conn: &Connection, id: i64) -> Result<Option<Settlement>, String> {
    type SettleHead = (i64, String, i64, String, String, String, String, i64, i64, i64, i64, i64, i64, i64, i64, i64, String, Option<String>, String, i64, String, String, i64, Option<String>);
    let head: Option<SettleHead> = conn
        .query_row(
            "SELECT s.id, s.settle_no, s.party_id, p.name, s.business_date, s.period_from, s.period_to,
                    s.order_count, s.total_net_01kg, s.total_deduct_01kg, s.total_settle_01kg,
                    s.total_goods_fen, s.total_deduction_fen, s.total_advance_fen,
                    s.payable_fen, s.paid_fen, s.payment_status, s.main_method,
                    COALESCE(s.payee_name, p.name), s.signed_by_party, s.status, s.settled_at, s.settler_id, s.remark
             FROM settlement s JOIN party p ON p.id = s.party_id WHERE s.id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?,
                    r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?,
                    r.get(11)?, r.get(12)?, r.get(13)?,
                    r.get(14)?, r.get(15)?, r.get(16)?, r.get(17)?,
                    r.get(18)?, r.get(19)?, r.get(20)?, r.get(21)?, r.get(22)?, r.get(23)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("读取结算单失败：{e}"))?;
    let Some(head) = head else { return Ok(None) };
    let mut stmt = match conn.prepare(
        "SELECT so.order_id, o.order_no, so.goods_amount_fen, so.price_fen_per_ton, so.settlement_weight_01kg, so.seq
         FROM settlement_order so JOIN weigh_order o ON o.id = so.order_id
         WHERE so.settlement_id = ?1 ORDER BY so.seq",
    ) {
        Ok(s) => s,
        Err(e) => return Err(format!("读取结算明细失败：{e}")),
    };
    let orders = stmt
        .query_map(params![head.0], |r| {
            Ok(SettlementOrderRow {
                order_id: r.get(0)?,
                order_no: r.get(1)?,
                goods_amount_fen: r.get(2)?,
                price_fen_per_ton: r.get(3)?,
                settlement_weight_01kg: r.get(4)?,
                seq: r.get(5)?,
            })
        })
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取结算明细失败：{e}"))?;
    Ok(Some(Settlement {
        id: head.0,
        settle_no: head.1,
        party_id: head.2,
        party_name: head.3,
        business_date: head.4,
        period_from: head.5,
        period_to: head.6,
        order_count: head.7,
        total_net_01kg: head.8,
        total_deduct_01kg: head.9,
        total_settle_01kg: head.10,
        total_goods_fen: head.11,
        total_deduction_fen: head.12,
        total_advance_fen: head.13,
        payable_fen: head.14,
        paid_fen: head.15,
        payment_status: head.16,
        main_method: head.17,
        payee_name: head.18,
        signed_by_party: head.19,
        status: head.20,
        settled_at: head.21,
        settler_id: head.22,
        orders,
        remark: head.23,
    }))
}

/// mock buildTimeline 的 Rust 同构。两处按真库信息更准：
/// 付款事件的署名取付款流水的经办人（mock 偷懒记成登记人），作废取 voided_by。
fn build_timeline(
    conn: &Connection,
    o: &WeighOrder,
    records: &[WeighRecord],
    qc: Option<&QcReport>,
    settlement: Option<&Settlement>,
) -> Vec<TimelineEvent> {
    let mut ev: Vec<TimelineEvent> = Vec::new();
    let mut add = |at: Option<&String>, action: &str, label: String, actor: String, tone: &str, detail: Option<String>| {
        if let Some(at) = at {
            ev.push(TimelineEvent { at: at.clone(), action: action.into(), label, actor, tone: tone.into(), detail });
        }
    };
    add(Some(&o.registered_at), "order.create", "取号登记".into(), user_name(conn, Some(o.registered_by)), "neutral", Some(format!("{} · {}", o.party_name, o.variety_name.as_deref().unwrap_or("未定品种"))));
    if let Some(q) = qc {
        add(
            Some(&q.inspected_at),
            "qc.save",
            format!("化验 {}{}", q.report_no, if q.is_recheck == 1 { "（复检）" } else { "" }),
            user_name(conn, Some(q.inspector_id)),
            if q.decision == "reject" { "danger" } else if q.decision == "conditional" { "warning" } else { "info" },
            Some(format!(
                "{} · {}",
                q.grade.clone().unwrap_or_else(|| "—".into()),
                match q.decision.as_str() {
                    "accept" => "接收",
                    "conditional" => "条件接收",
                    _ => "拒收",
                }
            )),
        );
    }
    for r in records {
        add(
            Some(&r.captured_at),
            "weigh.capture",
            if r.weigh_type == "gross" { "捕获毛重" } else { "捕获皮重" }.into(),
            user_name(conn, Some(r.operator_id)),
            if r.source == "manual" { "warning" } else { "info" },
            if r.source == "manual" {
                Some("手录".into())
            } else if r.adopt_reason.is_some() {
                r.adopt_reason.clone()
            } else if r.is_adopted == 1 {
                None
            } else {
                Some("已被复称替换".into())
            },
        );
    }
    if o.tare_override_reason.is_some() {
        // 超容差警示：不再要求授权，捕获人即经手人；旧数据里记过授权人的仍显示授权人
        let who = o.tare_override_by.or(o.weigher_id);
        add(o.tare_at.as_ref(), "tare.override", "皮重偏差超容差".into(), user_name(conn, who), "warning", o.tare_override_reason.clone());
    }
    if o.settled_at.is_some() {
        add(o.settled_at.as_ref(), "settle.create", "生成结算单".into(), user_name(conn, settlement.map(|s| s.settler_id)), "info", settlement.map(|s| s.settle_no.clone()));
    }
    if o.paid_at.is_some() {
        let payer: Option<i64> = conn
            .query_row(
                "SELECT operator_id FROM payment_record
                 WHERE order_id = ?1 OR settlement_id = ?2 ORDER BY id DESC LIMIT 1",
                params![o.id, settlement.map(|s| s.id)],
                |r| r.get(0),
            )
            .ok();
        add(o.paid_at.as_ref(), "pay.record", "付款登记".into(), user_name(conn, payer.or(Some(o.registered_by))), "success", o.payment_method.clone());
    }
    if o.voided_at.is_some() {
        let voided_by: Option<i64> = conn
            .query_row("SELECT voided_by FROM weigh_order WHERE id = ?1", params![o.id], |r| r.get(0))
            .ok()
            .flatten();
        add(o.voided_at.as_ref(), "order.void", "作废".into(), user_name(conn, voided_by.or(Some(o.registered_by))), "danger", o.void_reason.clone());
    }
    let order_no_of = |id: i64| -> Option<String> {
        conn.query_row("SELECT order_no FROM weigh_order WHERE id = ?1", params![id], |r| r.get(0)).ok()
    };
    if let Some(src) = o.reversed_order_id {
        add(o.updated_at.as_ref(), "order.reverse", "红冲单".into(), user_name(conn, Some(o.registered_by)), "danger", order_no_of(src));
    }
    if let Some(src) = o.reverse_of_id {
        add(o.updated_at.as_ref(), "order.reverse", "被红冲".into(), user_name(conn, Some(o.registered_by)), "danger", order_no_of(src));
    }
    ev.sort_by(|a, b| a.at.cmp(&b.at));
    ev
}

/// 详情口径：磅单 + 轨迹 + 抓拍墙 + 打印记录 + 时间轴一次给齐（页面零改动对齐 mock getOrder）。
/// 对外暴露给 tests/orders_contract.rs：详情口径的完整读取
pub fn load_order_full(conn: &Connection, by_no: &str) -> Result<Option<WeighOrder>, String> {
    let mut o: WeighOrder = match conn
        .query_row(&format!("{ORDER_SELECT} WHERE o.order_no = ?1"), params![by_no], map_order_row)
        .optional()
    {
        Ok(Some(o)) => o,
        Ok(None) => return Ok(None),
        Err(e) => return Err(format!("读取磅单失败：{e}")),
    };
    let records = load_records(conn, o.id)?;
    let qc = o.qc_report_id.and_then(|id| load_qc(conn, id).ok().flatten());
    let settlement = load_settlement_of(conn, o.id)?;
    o.photos = Some(build_capture_wall(conn, &records)?);
    o.timeline = Some(build_timeline(conn, &o, &records, qc.as_ref(), settlement.as_ref()));
    o.prints = Some(load_prints(conn, &o.order_no)?);
    o.records = Some(records);
    Ok(Some(o))
}

/// 抓拍墙：一次称重（毛重一捕 / 皮重一捕）最多 3 台相机各一张，逐张列，附上是哪台拍的。
/// 判据是 `attachment`（`biz_type='scale_capture'`、`biz_id=称重记录 id`）——一条记录挂了几张
/// 就出几格；一条被采纳的记录一张都没有，才补一格「无抓拍」占位（`missing`）。已被复称替换的
/// 轨迹（`is_adopted=0`）不进墙。
fn build_capture_wall(conn: &Connection, records: &[WeighRecord]) -> Result<Vec<CapturePhoto>, String> {
    let adopted: Vec<&WeighRecord> = records.iter().filter(|r| r.is_adopted == 1).collect();
    if adopted.is_empty() {
        return Ok(Vec::new());
    }
    // 一次把本单所有抓拍附件按记录归堆（带来源相机名），再逐条 adopted 记录铺格
    let mut by_record: std::collections::HashMap<i64, Vec<(i64, Option<String>, String)>> =
        std::collections::HashMap::new();
    let ids: Vec<i64> = adopted.iter().map(|r| r.id).collect();
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT a.biz_id, a.id, COALESCE(d.name, NULLIF(d.code, ''), ''), a.captured_at
         FROM attachment a LEFT JOIN device_config d ON d.id = a.source_device_id
         WHERE a.biz_type = 'scale_capture' AND a.biz_id IN ({placeholders})
         ORDER BY a.biz_id, a.id"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("读取抓拍墙失败：{e}"))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            let biz_id: i64 = r.get(0)?;
            let att_id: i64 = r.get(1)?;
            let dev: String = r.get(2)?;
            let at: String = r.get(3)?;
            Ok((biz_id, att_id, Some(dev).filter(|s| !s.is_empty()), at))
        })
        .map_err(|e| format!("读取抓拍墙失败：{e}"))?;
    for row in rows {
        let (biz_id, att_id, dev, at) = row.map_err(|e| format!("读取抓拍墙失败：{e}"))?;
        by_record.entry(biz_id).or_default().push((att_id, dev, at));
    }
    let mut out = Vec::new();
    for rec in &adopted {
        let head = if rec.weigh_type == "gross" { "毛重抓拍" } else { "皮重抓拍" };
        match by_record.get(&rec.id) {
            Some(atts) if !atts.is_empty() => {
                for (att_id, dev, at) in atts {
                    out.push(CapturePhoto {
                        id: *att_id,
                        biz_type: "scale_capture".into(),
                        label: head.into(),
                        device_label: dev.clone(),
                        tone: "info".into(),
                        captured_at: at.clone(),
                        missing: false,
                    });
                }
            }
            // 被采纳却一张没落上：设备离线/手工跳过的诚实留痕（05 §6.5 只标文字）
            _ => {
                out.push(CapturePhoto {
                    id: -rec.id,
                    biz_type: "scale_capture".into(),
                    label: head.into(),
                    device_label: None,
                    tone: "danger".into(),
                    captured_at: rec.captured_at.clone(),
                    missing: true,
                });
            }
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------- 售粮人档案

pub(crate) const PARTY_SELECT: &str = "SELECT id, COALESCE(code, ''), name, party_type,
         COALESCE(CAST(id_card_no_enc AS TEXT), ''), id_card_verified,
         COALESCE(CAST(phone_enc AS TEXT), ''), COALESCE(address, ''),
         bank_name, CAST(bank_account_enc AS TEXT), credit_limit_fen,
         default_warehouse_id, NULL, default_vehicle_no, last_tare_01kg, remark, status, created_at,
         photo_attachment_id
  FROM party";

pub(crate) fn map_party_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Party> {
    Ok(Party {
        id: r.get(0)?,
        code: r.get(1)?,
        name: r.get(2)?,
        party_type: r.get(3)?,
        id_card_no: r.get(4)?,
        id_card_verified: r.get(5)?,
        phone: r.get(6)?,
        address: r.get(7)?,
        bank_name: r.get(8)?,
        bank_account: r.get(9)?,
        credit_limit_fen: r.get(10)?,
        default_warehouse_id: r.get(11)?,
        default_slot_id: r.get(12)?,
        default_vehicle_no: r.get(13)?,
        last_tare_01kg: r.get(14)?,
        remark: r.get(15)?,
        status: r.get(16)?,
        created_at: r.get(17)?,
        photo_attachment_id: r.get(18)?,
    })
}

pub fn list_parties(conn: &Connection, keyword: &str, ptype: Option<&str>) -> Result<Vec<Party>, String> {
    let kw = keyword.trim().to_lowercase();
    // "all" 与空串一律当「不限类型」：界面上的类型筛选下拉常用 all 兜底，真拿它去比对
    // party_type 只会一条都查不出来（出库单的领出方就栽在这一句上）。
    // 口径与 outbound.rs 的状态筛选一致：`Some("all")` 不是一种类型。
    let ptype = ptype.filter(|t| !t.is_empty() && *t != "all");
    let mut sql = format!("{PARTY_SELECT} WHERE deleted_at IS NULL");
    if ptype.is_some() {
        sql.push_str(" AND party_type = ?1");
    }
    sql.push_str(" ORDER BY id");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取售粮人档案失败：{e}"))?;
    let rows: Vec<Party> = match ptype {
        Some(t) => stmt
            .query_map(params![t], map_party_row)
            .and_then(|m| m.collect::<Result<Vec<_>, _>>()),
        None => stmt
            .query_map([], map_party_row)
            .and_then(|m| m.collect::<Result<Vec<_>, _>>()),
    }
    .map_err(|e| format!("读取售粮人档案失败：{e}"))?;
    // 关键字检索在 Rust 侧做：证号存 BLOB（密文化后更是如此），SQL LIKE 只能覆盖明文阶段，
    // 档案量级（百级）下内存过滤不影响手感，口径与 mock 的海堆一致。
    let rows = if kw.is_empty() {
        rows
    } else {
        rows.into_iter()
            .filter(|p| {
                format!(
                    "{} {} {} {} {}",
                    p.name,
                    p.code,
                    p.id_card_no,
                    p.phone,
                    p.default_vehicle_no.clone().unwrap_or_default()
                )
                .to_lowercase()
                .contains(&kw)
            })
            .collect()
    };
    Ok(rows)
}

pub fn get_party(conn: &Connection, id: i64) -> Result<Option<PartyDetail>, String> {
    let party = conn
        .query_row(&format!("{PARTY_SELECT} WHERE id = ?1 AND deleted_at IS NULL"), params![id], map_party_row)
        .optional()
        .map_err(|e| format!("读取售粮人档案失败：{e}"))?;
    let Some(party) = party else { return Ok(None) };

    let mut stmt = conn
        .prepare(&format!("{ORDER_SELECT} WHERE o.party_id = ?1 ORDER BY o.registered_at DESC LIMIT 8"))
        .map_err(|e| format!("读取历史磅单失败：{e}"))?;
    let recent = stmt
        .query_map(params![id], map_order_row)
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取历史磅单失败：{e}"))?;

    let mut stmt = conn
        .prepare(
            "SELECT business_date, tare_weight_01kg, weight_source FROM weigh_order
             WHERE party_id = ?1 AND tare_weight_01kg IS NOT NULL
             ORDER BY registered_at DESC LIMIT 12",
        )
        .map_err(|e| format!("读取皮重历史失败：{e}"))?;
    let tare_history = stmt
        .query_map(params![id], |r| {
            Ok(TareRow { date: r.get(0)?, tare_01kg: r.get(1)?, source: r.get(2)? })
        })
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取皮重历史失败：{e}"))?;

    let credit_fen: i64 = conn
        .query_row("SELECT COALESCE(SUM(unpaid_fen),0) FROM v_payable WHERE party_id = ?1", params![id], |r| r.get(0))
        .map_err(|e| format!("读取挂账余额失败：{e}"))?;
    let total_net_01kg: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(net_weight_01kg),0) FROM weigh_order
             WHERE party_id = ?1 AND settlement_weight_01kg IS NOT NULL AND status NOT IN ('voided','rejected')",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| format!("读取交售总量失败：{e}"))?;

    Ok(Some(PartyDetail { party, recent, tare_history, credit_fen, total_net_01kg }))
}

#[derive(Debug, Deserialize)]
pub struct PartySaveInput {
    pub id: Option<i64>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub party_type: Option<String>,
    #[serde(default)]
    pub id_card_no: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub address: Option<String>,
    pub bank_name: Option<String>,
    pub bank_account: Option<String>,
    #[serde(default)]
    pub credit_limit_fen: Option<i64>,
    pub default_warehouse_id: Option<i64>,
    pub default_vehicle_no: Option<String>,
    pub last_tare_01kg: Option<i64>,
    pub remark: Option<String>,
    #[serde(default)]
    pub id_card_verified: Option<i64>,
    #[serde(default)]
    pub status: Option<String>,
    /// 前端仍会带 operator_id / operator 等字段，全部忽略，以会话为准
    #[serde(default)]
    #[allow(dead_code)]
    pub operator_id: Option<i64>,
}

const PARTY_TYPES: &[&str] = &["farmer", "large_grower", "broker", "cooperative", "company"];

fn id_card_fp(no: &str) -> Option<String> {
    let no = no.trim();
    if no.is_empty() {
        return None;
    }
    let mut h = Sha256::new();
    h.update(no.as_bytes());
    Some(h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// 电话归一：存进去的形状就是比对的形状，与 0013 迁移里的
/// `upper(replace(replace(trim(...), '-',''),' ',''))` 同口径。
/// 空白与 `-` 都不算号码的一部分；归一后为空一律 `None`（存 NULL），
/// 因为 NULL 不占 `uk_party_phone` 的唯一位——「没填电话」不该互相顶掉。
fn phone_key(raw: Option<&String>) -> Option<String> {
    let s: String = raw?
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .collect::<String>()
        .to_uppercase();
    (!s.is_empty()).then_some(s)
}

/// 该号码是否已被别的档案占用，返回占用方姓名。`except_id` = 编辑时排除自己。
fn phone_holder(conn: &Connection, phone: &str, except_id: Option<i64>) -> Result<Option<String>, String> {
    let taken = match except_id {
        Some(id) => conn
            .query_row(
                "SELECT name FROM party WHERE phone_enc = ?1 AND id <> ?2 AND deleted_at IS NULL",
                params![phone, id],
                |r| r.get::<_, String>(0),
            )
            .optional(),
        None => conn
            .query_row(
                "SELECT name FROM party WHERE phone_enc = ?1 AND deleted_at IS NULL",
                params![phone],
                |r| r.get::<_, String>(0),
            )
            .optional(),
    }
    .map_err(|e| format!("检查手机号占用失败：{e}"))?;
    Ok(taken)
}

pub fn save_party(conn: &Connection, actor: &AuthProfile, input: PartySaveInput) -> Result<Party, String> {
    let ptype = input.party_type.clone();
    if let Some(t) = &ptype {
        if !PARTY_TYPES.contains(&t.as_str()) {
            return Err(format!("售粮人类型「{t}」不在值域内"));
        }
    }
    if let Some(s) = &input.status {
        if s != "active" && s != "disabled" {
            return Err(format!("档案状态「{s}」不在值域内"));
        }
    }
    let fp = input.id_card_no.as_deref().and_then(id_card_fp);
    let phone = phone_key(input.phone.as_ref());

    match input.id {
        Some(id) => {
            let exists: i64 = conn
                .query_row("SELECT COUNT(*) FROM party WHERE id = ?1 AND deleted_at IS NULL", params![id], |r| r.get(0))
                .map_err(|e| format!("检查档案失败：{e}"))?;
            if exists == 0 {
                return Err("该售粮人档案不存在或已删除，无法保存".into());
            }
            if let Some(fp) = &fp {
                let taken: Option<String> = conn
                    .query_row(
                        "SELECT name FROM party WHERE id_card_no_fp = ?1 AND id <> ?2 AND deleted_at IS NULL",
                        params![fp, id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| format!("检查证号占用失败：{e}"))?;
                if let Some(name) = taken {
                    return Err(format!("该身份证号已是档案「{name}」，一人一档，请搜索后编辑原档案"));
                }
            }
            if let Some(ph) = &phone {
                if let Some(name) = phone_holder(conn, ph, Some(id))? {
                    return Err(format!("该手机号已是档案「{name}」的号码，一人一号，请搜索后编辑原档案"));
                }
            }
            if let Some(v) = &input.credit_limit_fen {
                if *v < 0 {
                    return Err("挂账额度不能为负数".into());
                }
            }
            let mut sets: Vec<String> = Vec::new();
            let mut vals: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            macro_rules! push {
                ($col:expr, $val:expr) => {{
                    sets.push(format!("{} = ?{}", $col, vals.len() + 1));
                    vals.push(Box::new($val));
                }};
            }
            if let Some(v) = input.name.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                push!("name", v.to_string())
            }
            if let Some(v) = ptype.clone() {
                push!("party_type", v)
            }
            if let Some(v) = input.id_card_no.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                push!("id_card_no_enc", v.to_uppercase());
                push!("id_card_no_fp", input.id_card_no.as_deref().and_then(id_card_fp))
            }
            if input.phone.is_some() {
                push!("phone_enc", phone.clone())
            }
            if let Some(v) = input.address.as_deref() {
                push!("address", v.trim().to_string())
            }
            if let Some(v) = input.bank_name.as_deref() {
                push!("bank_name", if v.trim().is_empty() { None } else { Some(v.trim().to_string()) })
            }
            if let Some(v) = input.bank_account.as_deref() {
                push!("bank_account_enc", if v.trim().is_empty() { None } else { Some(v.trim().to_string()) })
            }
            if let Some(v) = input.credit_limit_fen {
                push!("credit_limit_fen", v)
            }
            if let Some(v) = input.default_warehouse_id {
                push!("default_warehouse_id", v)
            }
            if let Some(v) = input.default_vehicle_no.as_deref() {
                push!("default_vehicle_no", if v.trim().is_empty() { None } else { Some(v.trim().to_uppercase().to_string()) })
            }
            if let Some(v) = input.remark.as_deref() {
                push!("remark", if v.trim().is_empty() { None } else { Some(v.trim().to_string()) })
            }
            if let Some(v) = input.id_card_verified {
                push!("id_card_verified", if v == 1 { 1 } else { 0 })
            }
            if let Some(v) = input.status.clone() {
                push!("status", v)
            }
            if sets.is_empty() {
                return get_party(conn, id)?.map(|d| d.party).ok_or_else(|| "档案不存在".to_string());
            }
            push!("updated_at", now_iso());
            let id_idx = vals.len() + 1;
            vals.push(Box::new(id));
            let sql = format!(
                "UPDATE party SET {} WHERE id = ?{id_idx} AND deleted_at IS NULL",
                sets.join(", ")
            );
            conn.execute(&sql, rusqlite::params_from_iter(vals.iter().map(|b| b.as_ref())))
                .map_err(|e| format!("档案保存失败：{e}"))?;
            let row = get_party(conn, id)?.map(|d| d.party).ok_or_else(|| "档案保存后读取失败".to_string())?;
            audit(conn, actor, "party.update", "party", &row.code, None, None);
            Ok(row)
        }
        None => {
            let name = input.name.clone().unwrap_or_default().trim().to_string();
            let idc = input.id_card_no.clone().unwrap_or_default().trim().to_uppercase();
            let ptype = ptype.unwrap_or_else(|| "farmer".into());
            if name.is_empty() {
                return Err("售粮人姓名必填".into());
            }
            // 证号与电话至少给一个（02 §F3.1）：只有电话的档案照样能搜到人、能回访，
            // 两样都空的档案事后认不出是谁，一律拦。
            if idc.is_empty() && phone.is_none() {
                return Err("身份证号与手机号至少填一个：证号读卡带入或手工录入，只留电话也可以建档".into());
            }
            if let Some(fp) = &fp {
                let taken: Option<String> = conn
                    .query_row("SELECT name FROM party WHERE id_card_no_fp = ?1 AND deleted_at IS NULL", params![fp], |r| r.get(0))
                    .optional()
                    .map_err(|e| format!("检查证号占用失败：{e}"))?;
                if let Some(prev) = taken {
                    return Err(format!("证号 {idc} 已建档（{prev}），请直接搜索该档案编辑"));
                }
            }
            if let Some(ph) = &phone {
                if let Some(prev) = phone_holder(conn, ph, None)? {
                    return Err(format!("手机号 {ph} 已建档（{prev}），请直接搜索该档案编辑"));
                }
            }
            conn.execute(
                "INSERT INTO party (name, party_type, id_card_no_enc, id_card_no_fp, id_card_verified,
                        phone_enc, address, bank_name, bank_account_enc, credit_limit_fen,
                        default_warehouse_id, default_vehicle_no, last_tare_01kg, remark,
                        status, created_at, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 'active', ?15, ?16)",
                // 只填电话的档案：证号列存 NULL，别落一个空串——那会让「没证号」与「证号是空」
                // 在库里长得一样，检索与反查都分不清；没证号也谈不上核验，标记一律 0。
                params![
                    name, ptype,
                    if idc.is_empty() { None } else { Some(idc.as_str()) },
                    fp,
                    if idc.is_empty() { 0 } else { input.id_card_verified.unwrap_or(0).clamp(0, 1) },
                    phone, input.address.unwrap_or_default(),
                    input.bank_name, input.bank_account, input.credit_limit_fen.unwrap_or(0),
                    input.default_warehouse_id, input.default_vehicle_no, input.last_tare_01kg, input.remark,
                    now_iso(), actor.id,
                ],
            )
            .map_err(|e| format!("建档失败：{e}"))?;
            let id = conn.last_insert_rowid();
            // 户号 = P + id 补零。code 可空（自编），没有自编号时给系统号，保证检索与打印有抓手。
            conn.execute(
                "UPDATE party SET code = 'P' || printf('%04d', ?1) WHERE id = ?1 AND code IS NULL",
                params![id],
            )
            .map_err(|e| format!("户号生成失败：{e}"))?;
            let row = get_party(conn, id)?.map(|d| d.party).ok_or_else(|| "建档后读取失败".to_string())?;
            audit(conn, actor, "party.create", "party", &row.code, None, None);
            Ok(row)
        }
    }
}

// ------------------------------------------------------------------ 档案人像照片
//
// 一条命令吃两种来源（读卡带入 / 手工选文件）：到落库这一步它们是同一样东西——本机上的
// 一个图片文件。归属只有一处：`party.photo_attachment_id`（§9.6）指附件，附件那行的
// `biz_id` 反指 party，两边一起写才不会留下没人认领的农户人像。
//
// **为什么不塞进 `party_save`**：照片写不进去（文件被占用、超大、格式不认识）绝不该把一次
// 已经成立的建档/修改回滚掉——与过磅抓拍「一张照片不把称重拖回滚」是同一条判断（04 §4）。
// 所以档案是档案、照片是照片，界面上保存成功后紧接着调这一条，失败了原表单还在、重存即可。

#[derive(Debug, Deserialize)]
pub struct PartyPhotoInput {
    pub party_id: i64,
    /// 本机图片文件的绝对路径：系统文件框选中的，或身份证读卡器**本次**落出来的暂存文件。
    /// **空串＝清除照片**。不给这个字段（`None`）与给空串是两件事：前者不碰，后者删。
    pub source_path: String,
    /// 前端仍会带 operator_id，一律忽略，以会话为准
    #[serde(default)]
    #[allow(dead_code)]
    pub operator_id: Option<i64>,
    /// 来源说明（"读卡带入" / "手工上传"），只进审计，不参与任何判定
    #[serde(default)]
    pub source_label: Option<String>,
}

/// 写入/替换/清除档案人像，回保存后的档案行。
///
/// 顺序钉死为「**先落新、再改引用、最后删旧**」：中途任何一步失败，最坏是盘上多一个
/// 没人引用的新文件（事务回滚把库恢复干净）；反过来先删旧再写新，一旦写失败就是
/// 「档案显示有照片、点开却说文件丢失」那种最难归因的脏状态。
pub fn set_party_photo(
    conn: &Connection,
    app_dir: &Path,
    actor: &AuthProfile,
    input: PartyPhotoInput,
) -> Result<Party, String> {
    let party = conn
        .query_row(
            &format!("{PARTY_SELECT} WHERE id = ?1 AND deleted_at IS NULL"),
            params![input.party_id],
            map_party_row,
        )
        .optional()
        .map_err(|e| format!("检查档案失败：{e}"))?
        .ok_or_else(|| "该售粮人档案不存在或已删除，无法保存照片".to_string())?;

    let source = input.source_path.trim().to_string();
    if source.is_empty() {
        let Some(old) = party.photo_attachment_id else {
            // 本来就没照片，"清除"就是个空操作：不动 updated_at，免得审计里多出一条没发生的修改
            return Ok(party);
        };
        // 先解引用、再删附件：档案这一行还指着它的时候删，SQLite 的外键约束直接就拦了
        conn.execute(
            "UPDATE party SET photo_attachment_id = NULL, updated_at = ?1 WHERE id = ?2",
            params![now_iso(), party.id],
        )
        .map_err(|e| format!("清除照片失败：{e}"))?;
        crate::attachment::delete_image(conn, app_dir, old)?;
        audit(conn, actor, "party.photo.clear", "party", &party.code, None, None);
        return get_party(conn, party.id)?.map(|d| d.party).ok_or_else(|| "档案不存在".to_string());
    }

    let (bytes, kind) = crate::attachment::load_image_file(&source)?;
    let sha = crate::camera::sha256_hex(&bytes);
    // 同一张图重复保存不该换附件：id 变了会让界面缓存与留痕都对不上，还白留一份文件
    if let Some(old) = party.photo_attachment_id {
        let same: Option<String> = conn
            .query_row("SELECT sha256 FROM attachment WHERE id = ?1", params![old], |r| r.get(0))
            .optional()
            .map_err(|e| format!("读取原附件失败：{e}"))?;
        if same.as_deref() == Some(sha.as_str()) {
            return Ok(party);
        }
    }
    let biz_type = crate::domain::enums::AttachmentBizType::IdCardPhoto.to_string();
    let tag = format!("party{}", party.id);
    let att = crate::camera::store_image(
        conn,
        app_dir,
        &bytes,
        &crate::camera::ImageMeta {
            biz_type: &biz_type,
            biz_id: Some(party.id),
            order_id: None,
            kind,
            tag: &tag,
            source_device_id: None,
            operator_id: actor.id,
        },
    )?;
    conn.execute(
        "UPDATE party SET photo_attachment_id = ?1, updated_at = ?2 WHERE id = ?3",
        params![att, now_iso(), party.id],
    )
    .map_err(|e| format!("照片挂到档案失败：{e}"))?;
    if let Some(old) = party.photo_attachment_id {
        crate::attachment::delete_image(conn, app_dir, old)?;
    }
    let reason = input
        .source_label
        .as_deref()
        .map(|s| s.chars().take(60).collect::<String>());
    audit(conn, actor, "party.photo.update", "party", &party.code, reason.as_deref(), None);
    get_party(conn, party.id)?.map(|d| d.party).ok_or_else(|| "档案不存在".to_string())
}

/// 把档案人像读回给界面，并留一次访问痕迹（04 §4.3）。
///
/// 读不设岗位（与本文件「权限闸门」那条一致：viewer 也要能看档案），管住它的不是岗位而是
/// **每一次查看都在 `audit_log` 与 `attachment.accessed_*` 里留痕**。没有照片回 `Ok(None)`，
/// 那是正常状态不是错误——照片本来就是选填项。
pub fn party_photo_view(
    conn: &Connection,
    app_dir: &Path,
    actor: &AuthProfile,
    party_id: i64,
) -> Result<Option<crate::attachment::ImageForDisplay>, String> {
    let row = conn
        .query_row(
            "SELECT photo_attachment_id, COALESCE(code, '') FROM party WHERE id = ?1 AND deleted_at IS NULL",
            params![party_id],
            |r| Ok((r.get::<_, Option<i64>>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取档案照片失败：{e}"))?;
    let Some((att, code)) = row else { return Ok(None) };
    let Some(att) = att else { return Ok(None) };
    let img = crate::attachment::read_for_display(conn, app_dir, att, actor.id)?;
    audit(conn, actor, "pii.read", "party", &code, Some("查看档案人像照片"), None);
    Ok(Some(img))
}

/// 过磅抓拍图的读通道（04 §4.3 欠的"原图查看那半边"，本轮接上）。
///
/// 键用**称重记录 id**而非附件 id：与档案人像吃业务 id 同一口径，前端拿不到也不必拿
/// `attachment.id` 和本机路径；顺带挡住"枚举附件 id 去拖别人的单证"——记录不挂在磅单上就读不到。
/// 没抓拍（设备离线降级）回 `Ok(None)`，那是"无抓拍"的正常状态不是错误。
/// 与档案人像一样不设岗位闸门：viewer 也要能在详情页核对现场，管住它的是每次查看都留痕。
/// 过磅抓拍图的读通道：按**附件 id** 取一张（一次称重最多 3 台相机各一张，墙上是逐张列的，
/// 点哪张就按哪张的 attachment.id 读）。仍回查它挂在哪条称重记录、哪张磅单，只为把
/// `pii.read` 审计记到对的单号上。附件不存在（多半是到期清理掉了）回 `Ok(None)`，界面按
/// 「无画面」处理，不炸页面。
pub fn capture_photo_view(
    conn: &Connection,
    app_dir: &Path,
    actor: &AuthProfile,
    attachment_id: i64,
) -> Result<Option<crate::attachment::ImageForDisplay>, String> {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT wr.order_id, wo.order_no
             FROM attachment a
             JOIN weigh_record wr ON wr.id = a.biz_id
             JOIN weigh_order wo ON wo.id = wr.order_id
             WHERE a.id = ?1 AND a.biz_type = 'scale_capture'",
            params![attachment_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取抓拍记录失败：{e}"))?;
    let Some((_order_id, order_no)) = row else { return Ok(None) };
    let img = crate::attachment::read_for_display(conn, app_dir, attachment_id, actor.id)?;
    audit(conn, actor, "pii.read", "weigh_order", &order_no, Some("查看过磅抓拍画面"), None);
    Ok(Some(img))
}

// --------------------------------------------------------------------- 入仓去向
// 去向在磅单上是选填项（03 §9.9：多数站点制单时不登记），但一旦填了就必须自洽：
// 只记货位不记仓房的"半截去向"会让按仓房汇总的那批粮在报表里凭空消失。

/// 校验并归一后的一组去向。`None`/`None` 就是"本单不登记去向"，合法。
#[derive(Debug, Clone, Default)]
pub struct Destination {
    pub warehouse_id: Option<i64>,
    pub warehouse_name: Option<String>,
    pub slot_id: Option<i64>,
    pub slot_label: Option<String>,
}

impl Destination {
    /// 审计与提示用的一行字（"1号平房仓 / C01-03"）
    pub(crate) fn text(&self) -> String {
        let parts = [self.warehouse_name.as_deref(), self.slot_label.as_deref()];
        let joined = parts.into_iter().flatten().collect::<Vec<_>>().join(" / ");
        if joined.is_empty() {
            "未指定".into()
        } else {
            joined
        }
    }
}

/// 校验并归一一组仓房/货位。出库侧（`crate::outbound`）复用同一份，
/// 两边对「停用仓房不能选、货位必须属于所选仓房」的判据必须一模一样。
pub(crate) fn resolve_destination(conn: &Connection, warehouse_id: Option<i64>, slot_id: Option<i64>) -> Result<Destination, String> {
    let mut out = Destination::default();
    if let Some(id) = warehouse_id {
        let name: Option<String> = conn
            .query_row(
                "SELECT name FROM warehouse WHERE id = ?1 AND deleted_at IS NULL AND is_active = 1",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("检查仓房失败：{e}"))?;
        out.warehouse_name = Some(name.ok_or_else(|| "入库仓房不存在或已停用".to_string())?);
        out.warehouse_id = Some(id);
    }
    if let Some(id) = slot_id {
        // 货位所属仓房一并 JOIN 校验：只停仓房不停货位时，这个货位同样不能再选
        let hit: Option<(i64, String, String)> = conn
            .query_row(
                "SELECT sl.warehouse_id, COALESCE(sl.label, sl.code), w.name
                   FROM storage_slot sl JOIN warehouse w ON w.id = sl.warehouse_id
                  WHERE sl.id = ?1 AND sl.is_active = 1 AND w.deleted_at IS NULL AND w.is_active = 1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| format!("检查货位失败：{e}"))?;
        let (slot_wh, label, wh_name) =
            hit.ok_or_else(|| "货位不存在或已停用（也可能是它所属的仓房已停用）".to_string())?;
        if let Some(w) = out.warehouse_id {
            if w != slot_wh {
                return Err(format!("货位「{label}」不在该仓房下，请重选仓房或货位"));
            }
        } else {
            // 只选了货位 ⇒ 反查补上仓房，界面与报表说的是同一处
            out.warehouse_id = Some(slot_wh);
            out.warehouse_name = Some(wh_name);
        }
        out.slot_id = Some(id);
        out.slot_label = Some(label);
    }
    Ok(out)
}

// ------------------------------------------------------------------------ 制单

#[derive(Debug, Deserialize)]
pub struct CreateOrderInput {
    pub party_id: i64,
    /// 收购品种：**制单必填**。品种是这一单往后一切的锚——结算的单价要对回价目表、
    /// 化验的指标集与扣量基准全来自品种档案，空着取号等于把这两件事都往后拖，
    /// 拖到结算那一刻才发现没品种，车已经卸完、价格也错过了一次对照。
    /// 所以闸门就设在取号这一刻，必须是启用中且未删除的品种。
    pub variety_id: Option<i64>,
    pub vehicle_no: Option<String>,
    pub warehouse_id: Option<i64>,
    pub slot_id: Option<i64>,
    pub remark: Option<String>,
    /// 制单时刷到的流转卡号（前端 `ic_read` 的结果，服务端不猜）。
    /// `card_required_on_create` 开着时它是必填项，关掉才允许留空走"事后靠监听发卡"。
    #[serde(default)]
    pub card_no: Option<String>,
    #[allow(dead_code)]
    pub registered_by: Option<i64>,
    pub weight_source: String,
}

/// 本站制单是否必须先刷到流转卡（06 §4.0）。`card_flow_mode=off` 的站点压根不用卡，
/// 参数默认值一律按"强制"走——新库装上就有这道闸，站长要放开得显式关掉。
pub(crate) fn card_required_on_create(conn: &Connection) -> bool {
    setting_str(conn, "card_flow_mode", "auto") != "off"
        && setting_bool(conn, "card_required_on_create", true)
}

/// 单价的人话串（分/吨 → 元/公斤，三位小数）：只用在审计与报错话术里。
/// 展示层那份唯一口径在 `src/lib/format.ts::price`，这里不参与任何计算。
fn price_label(fen_per_ton: i64) -> String {
    format!("{:.3} 元/公斤", fen_per_ton as f64 / 100_000.0)
}

/// 价目表现行价：品种 + 日期两个锚，**等级可缺**（制单那一刻还没化验，等级未定）。
///
/// 规则与前端 `src/lib/settle-defaults.ts::lookupPrice` 逐条同构——命中等级优先，命不中退回
/// 同品种最近生效的一条。两处必须是同一套：制单带出来的价与结算框铺出来的价若不同，
/// 同一张单就会出现两个价，而钱是照结算框那个走的。
///
/// 返回 `(price_list_id, price_fen_per_ton)`：id 要一起落库，它是"这一车按哪一版价目执行"的锚，
/// 事后翻开能查到当时的挂牌价（价目表只追加、不改历史，所以那一行永远读得回来）。
fn lookup_price(conn: &Connection, variety_id: i64, grade: Option<&str>, date: &str) -> Result<Option<(i64, i64)>, String> {
    if let Some(g) = grade.map(str::trim).filter(|s| !s.is_empty()) {
        let exact = conn
            .query_row(
                "SELECT id, price_fen_per_ton FROM price_list
                 WHERE variety_id = ?1 AND grade = ?2 AND deleted_at IS NULL
                   AND effective_from <= ?3 AND effective_to >= ?3
                 ORDER BY effective_from DESC, id DESC LIMIT 1",
                params![variety_id, g, date],
                |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
            )
            .optional()
            .map_err(|e| format!("查询价目表失败：{e}"))?;
        if exact.is_some() {
            return Ok(exact);
        }
    }
    conn.query_row(
        "SELECT id, price_fen_per_ton FROM price_list
         WHERE variety_id = ?1 AND deleted_at IS NULL
           AND effective_from <= ?2 AND effective_to >= ?2
         ORDER BY effective_from DESC, id DESC LIMIT 1",
        params![variety_id, date],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)),
    )
    .optional()
    .map_err(|e| format!("查询价目表失败：{e}"))
}

pub fn create_order(conn: &Connection, actor: &AuthProfile, input: CreateOrderInput) -> Result<WeighOrder, String> {
    if input.weight_source != "scale" && input.weight_source != "manual" {
        return Err(format!("称重来源「{}」不在值域内", input.weight_source));
    }
    let party = conn
        .query_row(
            "SELECT id, name, party_type, COALESCE(CAST(id_card_no_enc AS TEXT), ''), default_vehicle_no
             FROM party WHERE id = ?1 AND deleted_at IS NULL",
            params![input.party_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, Option<String>>(4)?)),
        )
        .optional()
        .map_err(|e| format!("检查售粮人失败：{e}"))?
        .ok_or_else(|| "该售粮人档案不存在或已删除，请先建档".to_string())?;
    if party.2 != "farmer" && party.3.is_empty() {
        // 合作社/企业要税号或证号才允许挂账出票——首版一律用证号占位检查
        return Err("企业/合作社档案尚未登记身份证号，请到农户档案补齐后再制单".into());
    }
    // 品种是必填项（不是"填了就查"）：闸门与售粮人同级，都排在取号之前。
    // 注意 weigh_order.variety_id 这一列在库里仍然是可空的——存量单（以及事后
    // `order_set_variety` 清空的那类）照旧要读得出来，所以读路径的 LEFT JOIN 不动，
    // 只是新单一律不给空着成立。
    let variety_id = input
        .variety_id
        .ok_or_else(|| "还没定收购品种：制单必须选定品种，请先选好再取号制单".to_string())?;
    let variety: (String, String) = conn
        .query_row(
            "SELECT code, name FROM grain_variety WHERE id = ?1 AND deleted_at IS NULL AND is_active = 1",
            params![variety_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("检查品种失败：{e}"))?
        .ok_or_else(|| "所选品种不存在或已停用，请重新选择".to_string())?;
    let dest = resolve_destination(conn, input.warehouse_id, input.slot_id)?;

    // 制单必须先刷到一张流转卡（06 §4.0）：判定全部放在取号之前——闸不过时既不该吃掉流水号，
    // 也不该在库里落下没绑卡的半张单（命令层的 write_tx 回滚只是第二道保险）
    let card_no = input
        .card_no
        .as_deref()
        .map(crate::cards::normalize_card_no)
        .filter(|s| !s.is_empty());
    if card_no.is_none() && card_required_on_create(conn) {
        return Err("没刷到流转卡：请把 IC 卡贴紧读卡器再取号制单。本站要求「制单必须绑卡」，需要放开请到设置里关掉该参数".into());
    }
    if let Some(card) = card_no.as_deref() {
        crate::cards::check_card_for_create(conn, card)?;
    }

    let order_no = next_no(conn, "BD")?;
    let now = now_iso();
    // 挂牌价：取号那一刻就把该品种的现行价落到磅单上（02 §F1.4）。
    //
    // 为什么不等结算再定价：农户到站是先问价、谈成才卸货的，票面没有价、库里也没有价，
    // 事后就是一笔只能靠嘴说的糊涂账。制单这一刻等级还没定（化验才有），所以先按品种取
    // "最近生效的一条"当挂牌价；化验定级之后由磅员/站长用 `order_set_price` 按实际等级修正。
    //
    // 该品种在价目表里没有现行价时**不拦制单**：价是后头补得上的，号取不出来才是真卡住现场。
    let business_date = today();
    let listed = lookup_price(conn, variety_id, None, &business_date)?;
    conn.execute(
        "INSERT INTO weigh_order (
            order_no, station_id, business_date, status, party_id, variety_id,
            warehouse_id, slot_id, vehicle_no, driver_name, remark,
            weight_source, registered_by, registered_at, created_at, created_by,
            price_fen_per_ton, price_list_id)
         VALUES (?1, (SELECT id FROM station WHERE is_active = 1 ORDER BY id LIMIT 1), ?2, 'registered',
            ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?11, ?13, ?14)",
        params![
            order_no, business_date, input.party_id, variety_id,
            dest.warehouse_id, dest.slot_id,
            input.vehicle_no.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(|s| s.to_uppercase()),
            party.1, // driver_name 沿用 mock：默认同售粮人
            input.remark.as_deref().map(str::trim).filter(|s| !s.is_empty()),
            input.weight_source, actor.id, now,
            listed.map(|(_, p)| p), listed.map(|(id, _)| id),
        ],
    )
    .map_err(|e| format!("制单失败：{e}"))?;
    // 必须紧跟 INSERT：下面的 audit 自己插一行，last_insert_rowid() 就被改写走了
    let order_id = conn.last_insert_rowid();
    let price_note = match listed {
        Some((_, p)) => format!(" · 挂牌价 {}", price_label(p)),
        None => " · 品种无现行价目，待定价".to_string(),
    };
    audit(
        conn,
        actor,
        "order.create",
        "weigh_order",
        &order_no,
        Some(&format!("{} · {}{}", party.1, variety.1, price_note)),
        None,
    );
    // 绑卡与制单同一事务：卡未登记、已注销、还挂着别的未完成单，整笔回滚，不留已取号的孤单
    if let Some(card) = card_no.as_deref() {
        crate::cards::bind_on_create(conn, actor, order_id, &order_no, card)?;
    }
    load_order_full(conn, &order_no)?.ok_or_else(|| "制单后读取磅单失败".to_string())
}

// ------------------------------------------------------------------------ 称重

#[derive(Debug, Deserialize)]
pub struct CaptureInput {
    pub order_no: String,
    pub weigh_type: String,
    pub weight_01kg: i64,
    pub source: String,
    #[allow(dead_code)]
    pub operator_id: Option<i64>,
    pub raw_frame: Option<String>,
    /// 前端"当时摄像头在线"的声明；抓拍未真落库前不参与判定（见模块头）
    #[serde(default)]
    #[allow(dead_code)]
    pub has_photo: Option<bool>,
    /// 旧「站长授权放行」入参：闸门已改为警示提醒，此字段仅作兼容读取，服务端一律忽略
    #[serde(default)]
    #[allow(dead_code)]
    pub tare_override: Option<serde_json::Value>,
    /// 客户端（称重面板 / IC 刷皮重）判出偏差超容差时附上的人话文案；是否记录以服务端复算为准
    #[serde(default)]
    pub tare_warning: Option<String>,
    /// 本机 USB 摄像头的抓拍帧（04 §4 方案 A 前端半边）：面板从 WebView2 实时画面就地取帧、
    /// base64(JPEG) 回传。一次过磅最多 3 台相机，故这是一个**数组**，每台一条、按 `device_id`
    /// 对号入座；内网 IP 相机不在此列（服务端自己 HTTP 抓图）。空数组/缺省按没带处理。
    #[serde(default)]
    pub frames: Vec<CaptureFrame>,
}

/// 一台本机摄像头在捕获瞬间回传的一帧。`device_id` 指 `device_config.id`，服务端据此把帧
/// 对到勾了「过磅抓拍」的那台相机上；对不上（那台没勾/已停用）就丢弃这帧，绝不张冠李戴。
#[derive(Debug, Clone, Deserialize)]
pub struct CaptureFrame {
    pub device_id: i64,
    pub b64: String,
}

/// 警示文案入库前的长度上限（票面一栏、日志一行，够写清偏差就够了）
const TARE_WARNING_MAX_CHARS: usize = 200;

/// 允许继续称重的状态（其余为终态/结算后，必须拒绝——mock 全放行是纸面 review 看不出来的洞）
const WEIGHABLE: &[&str] = &["draft", "registered", "qc_done", "gross_weighed", "tare_weighed", "reweigh", "to_settle"];

pub fn capture(conn: &Connection, actor: &AuthProfile, input: CaptureInput) -> Result<Option<WeighOrder>, String> {
    if input.weigh_type != "gross" && input.weigh_type != "tare" {
        return Err(format!("称重类型「{}」不在值域内", input.weigh_type));
    }
    if input.source != "scale" && input.source != "manual" {
        return Err(format!("称重来源「{}」不在值域内", input.source));
    }
    if input.weight_01kg <= 0 {
        return Err("重量必须大于 0".into());
    }
    type OrderHead = (i64, String, Option<i64>, Option<i64>, i64, i64, Option<i64>);
    let head: Option<OrderHead> = conn
        .query_row(
            "SELECT id, status, gross_weight_01kg, tare_weight_01kg, COALESCE((SELECT COUNT(*) FROM weigh_record WHERE order_id = wo.id), 0), party_id, price_fen_per_ton
             FROM weigh_order wo WHERE order_no = ?1",
            params![input.order_no],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()
        .map_err(|e| format!("读取磅单失败：{e}"))?;
    let Some((order_id, status, gross, tare, seq, party_id, price_fen_per_ton)) = head else {
        return Ok(None);
    };
    if !WEIGHABLE.contains(&status.as_str()) {
        return Err(format!("本单当前为「{status}」，不能再称重；如需更正请走红冲后重录"));
    }
    // 价闸（02 §F1.4）：毛重是"这车粮上磅"的那一刻，价必须在这之前谈定并落到单上——制单按
    // 价目表带出的挂牌价、或磅房现场用 `order_set_price` 定的价。没有价就收粮，事后只能靠嘴对账。
    //
    // 为什么只拦毛重：皮重是空车多重，与这车粮值多少钱无关；而一次/二次称重顺序自由（02 §F1.2），
    // 先捕皮重后捕毛重的车，毛重那一捕照样会撞在这道闸上。复称毛重同样算——重车再上磅，价更该定了。
    //
    // 前端 `lib/weigh-gate.ts`（手点 / 手录 / 刷卡三条入口共用）与 mock `api.capture` 说的是
    // 同一句话，这里才是硬的那一道：那两处只是让人当场知道该干什么，不是唯一一道。
    if input.weigh_type == "gross" && price_fen_per_ton.is_none() {
        return Err("本单还没有单价：请先在称重区把单价填好（定价 / 改价），再刷卡或录入毛重".into());
    }

    // 皮重容差：服务端按站点参数独立复算（不信任前端有没有弹过提示）。
    // 超容差不再拦下捕获——数据照常有效，只自动在磅单上记一条警示，
    // 屏显醒目条、时间轴、审计与票面「皮重警示」栏都从这里出。
    let tare_warning_text = if input.weigh_type == "tare" {
        let mean: Option<i64> = conn
            .query_row("SELECT last_tare_01kg FROM party WHERE id = ?1", params![party_id], |r| r.get(0))
            .ok()
            .flatten();
        let pct = setting_int(conn, "tare_tolerance_pct", 0); // 单位 0.01%（300 = 3.00%）
        match mean {
            Some(m) if m > 0 && pct > 0 => {
                if (input.weight_01kg - m).abs() <= (m * pct + 5000) / 10000 {
                    None
                } else {
                    let client = input
                        .tare_warning
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("");
                    let client = if client.is_empty() {
                        String::new()
                    } else {
                        client.chars().take(TARE_WARNING_MAX_CHARS).collect()
                    };
                    let auto = format!(
                        "实测皮重 {:.1}kg，较最近历史皮重 {:.1}kg 偏差 {}{:.1}%，超出容差 {:.2}%",
                        input.weight_01kg as f64 / 10.0,
                        m as f64 / 10.0,
                        if input.weight_01kg >= m { "+" } else { "-" },
                        ((input.weight_01kg - m).abs() as f64) * 100.0 / (m as f64),
                        pct as f64 / 100.0,
                    );
                    Some(if client.is_empty() { auto } else { format!("{auto}（{client}）") })
                }
            }
            _ => None,
        }
    } else {
        None
    };
    let within_tare_tolerance = tare_warning_text.is_none();

    // 毛/皮齐备时净重必须为正：去掉旧的 abs()，避免把颠倒的重量洗成"合法"净重照常结算。
    let (new_gross, new_tare) =
        if input.weigh_type == "gross" { (Some(input.weight_01kg), tare) } else { (gross, Some(input.weight_01kg)) };
    if let (Some(g), Some(t)) = (new_gross, new_tare) {
        if g <= t {
            return Err(format!(
                "毛重（{:.1}kg）不高于皮重（{:.1}kg），净重不为正，请核对称重类型或更正",
                g as f64 / 10.0,
                t as f64 / 10.0,
            ));
        }
    }
    let net = match (new_gross, new_tare) {
        (Some(g), Some(t)) => Some(g - t),
        _ => None,
    };

    let device_id: Option<i64> = if input.source == "scale" {
        conn.query_row(
            "SELECT id FROM device_config WHERE kind = 'scale' AND is_enabled = 1 ORDER BY is_default DESC, id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok()
    } else {
        None
    };
    let now = now_iso();
    // 复称：先把同类型旧轨迹取消"已采用"，保证每类只有一个采用值（时间轴/证据墙按 is_adopted=1 取）。
    conn.execute(
        "UPDATE weigh_record SET is_adopted = 0 WHERE order_id = ?1 AND weigh_type = ?2 AND is_adopted = 1",
        params![order_id, input.weigh_type],
    )
    .map_err(|e| format!("归并称重轨迹失败：{e}"))?;
    conn.execute(
        "INSERT INTO weigh_record (order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg, is_adopted, source, device_id, raw_frame, stable, captured_at, operator_id)
         VALUES (?1, ?2, ?3, ?4, ?4, 1, ?5, ?6, ?7, 1, ?8, ?9)",
        params![order_id, seq + 1, input.weigh_type, input.weight_01kg, input.source, device_id, input.raw_frame, now, actor.id],
    )
    .map_err(|e| format!("写称重轨迹失败：{e}"))?;

    let new_status = if net.is_some() { "to_settle" } else if input.weigh_type == "gross" { "gross_weighed" } else { "tare_weighed" };
    let mut manual = input.source == "manual";
    if !manual {
        let prev: String = conn
            .query_row("SELECT weight_source FROM weigh_order WHERE id = ?1", params![order_id], |r| r.get(0))
            .unwrap_or_else(|_| "scale".into());
        manual = prev == "manual";
    }
    conn.execute(
        "UPDATE weigh_order SET
            gross_weight_01kg = ?1, tare_weight_01kg = ?2, net_weight_01kg = ?3,
            gross_at = CASE WHEN ?1 IS NOT NULL THEN ?4 ELSE gross_at END,
            tare_at  = CASE WHEN ?2 IS NOT NULL THEN ?4 ELSE tare_at  END,
            status = ?5, weight_source = ?6, weigher_id = ?7,
            tare_override_by = NULL,
            tare_override_reason = COALESCE(?8, tare_override_reason),
            updated_at = ?4, updated_by = ?7
         WHERE id = ?9",
        params![
            new_gross, new_tare, net, now, new_status,
            if manual { "manual" } else { "scale" }, actor.id,
            tare_warning_text,
            order_id,
        ],
    )
    .map_err(|e| format!("更新磅单失败：{e}"))?;
    if input.weigh_type == "tare" && within_tare_tolerance {
        // 皮重异常判定要用"最近皮重"；仅在容差内刷新，超容差的皮重不得污染基准（§9.6）
        conn.execute(
            "UPDATE party SET last_tare_01kg = ?1, updated_at = ?2, updated_by = ?3 WHERE id = ?4",
            params![input.weight_01kg, now, actor.id, party_id],
        )
        .map_err(|e| format!("刷新最近皮重失败：{e}"))?;
    }
    if let Some(text) = &tare_warning_text {
        // 不要求任何人授权：捕获人自己就是审计主体，警示文案随单留痕
        audit(conn, actor, "tare.override", "weigh_order", &input.order_no, Some(text.as_str()), None);
    }
    load_order_full(conn, &input.order_no)
}

// ------------------------------------------------------------------------ 化验

#[derive(Debug, Deserialize)]
pub struct QcIndicatorInput {
    pub code: String,
    pub name: String,
    pub value_num: Option<i64>,
    pub value_text: Option<String>,
    pub unit: String,
    pub std_value: Option<i64>,
    pub over_std: i64,
}

#[derive(Debug, Deserialize)]
pub struct SaveQcInput {
    pub order_no: String,
    pub grade: Option<String>,
    pub decision: String,
    pub test_method: String,
    pub indicators: Vec<QcIndicatorInput>,
    pub moisture_deduct_01kg: i64,
    pub impurity_deduct_01kg: i64,
    #[allow(dead_code)]
    pub inspector_id: Option<i64>,
    #[serde(default)]
    pub reject_reason: Option<String>,
}

const DECISIONS: &[&str] = &["accept", "conditional", "reject"];
const TEST_METHODS: &[&str] = &["nir", "lab", "visual"];
const UNITS: &[&str] = &["0.01pct", "gL", "text"];

pub fn save_qc(conn: &Connection, actor: &AuthProfile, input: SaveQcInput) -> Result<Option<QcReport>, String> {
    if !DECISIONS.contains(&input.decision.as_str()) {
        return Err(format!("判定「{}」不在值域内", input.decision));
    }
    if !TEST_METHODS.contains(&input.test_method.as_str()) {
        return Err(format!("检测方式「{}」不在值域内", input.test_method));
    }
    if input.decision == "reject" && input.reject_reason.clone().unwrap_or_default().trim().is_empty() {
        return Err("拒收必须填写理由（单据必印，迎检必查）".into());
    }
    if input.indicators.is_empty() {
        return Err("至少录入一项化验指标".into());
    }
    for x in &input.indicators {
        if !UNITS.contains(&x.unit.as_str()) {
            return Err(format!("指标「{}」单位「{}」不在值域内", x.name, x.unit));
        }
    }
    let head: Option<(i64, String, Option<i64>, String, Option<i64>)> = conn
        .query_row(
            "SELECT id, status, variety_id, party_name_from, qc_report_id FROM (
                SELECT o.id, o.status, o.variety_id, p.name AS party_name_from, o.qc_report_id
                FROM weigh_order o JOIN party p ON p.id = o.party_id WHERE o.order_no = ?1)",
            params![input.order_no],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| format!("读取磅单失败：{e}"))?;
    let Some((order_id, status, variety_id, _pn, prev_qc)) = head else { return Ok(None) };
    if matches!(status.as_str(), "voided" | "settled" | "paid" | "archived" | "reversed") {
        return Err(format!("本单当前为「{status}」，不能再录入化验"));
    }
    // 化验的指标集、限值与扣量基准全部来自品种档案，`qc_report.variety_id` 因此保持 NOT NULL：
    // 没有品种的化验单，它的 grade/decision 根本无从判定（0017 只放开了磅单那一列）。
    // 现场不必换屏——工作台化验区就有品种下拉，选完直接录。
    let variety_id = variety_id.ok_or_else(|| "本单还没有定收购品种，请先在化验区选定品种再录化验".to_string())?;
    let variety_active: i64 = conn
        .query_row("SELECT COUNT(*) FROM grain_variety WHERE id = ?1 AND deleted_at IS NULL", params![variety_id], |r| r.get(0))
        .map_err(|e| format!("检查品种失败：{e}"))?;
    if variety_active == 0 {
        return Err("磅单挂的品种已被删除，无法保存化验".into());
    }

    // 复检链（不变式 7）：旧的唯一有效报告先降级，新的挂回首检
    let mut is_recheck = 0i64;
    let mut first_report_id: Option<i64> = None;
    if let Some(prev_id) = prev_qc {
        let prev: Option<(i64, Option<i64>)> = conn
            .query_row("SELECT is_recheck, first_report_id FROM qc_report WHERE id = ?1 AND is_effective = 1", params![prev_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| format!("读取原化验单失败：{e}"))?;
        if let Some((_prev_recheck, prev_first)) = prev {
            is_recheck = 1;
            first_report_id = Some(prev_first.unwrap_or(prev_id));
            conn.execute("UPDATE qc_report SET is_effective = 0 WHERE order_id = ?1 AND is_effective = 1", params![order_id])
                .map_err(|e| format!("降级原化验单失败：{e}"))?;
        }
    }

    let now = now_iso();
    let ymd_compact = Local::now().format("%Y%m%d").to_string();
    let report_no = next_no(conn, "ZJ")?;
    let sample_no = format!("YP{}{}", Local::now().format("%y%m%d"), order_id % 1000);
    let retention_no = format!("LY{}M", &ymd_compact[2..]);
    let retention_until = (Local::now() + Duration::days(30)).format("%Y-%m-%d").to_string();
    conn.execute(
        "INSERT INTO qc_report (report_no, order_id, sample_no, variety_id, grade, decision, reject_reason,
                moisture_deduct_01kg, impurity_deduct_01kg, test_method, is_recheck, first_report_id,
                is_effective, inspector_id, inspected_at, retention_no, retention_until, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?14, ?15, ?16, ?14, ?13)",
        params![
            report_no, order_id, sample_no, variety_id, input.grade, input.decision,
            input.reject_reason.filter(|s| !s.trim().is_empty()),
            input.moisture_deduct_01kg.max(0), input.impurity_deduct_01kg.max(0),
            input.test_method, is_recheck, first_report_id,
            actor.id, now, retention_no, retention_until,
        ],
    )
    .map_err(|e| format!("保存化验单失败：{e}"))?;
    let report_id = conn.last_insert_rowid();
    for (i, x) in input.indicators.iter().enumerate() {
        conn.execute(
            "INSERT INTO qc_indicator (report_id, code, name, value_num, value_text, unit, std_value, over_std, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![report_id, x.code, x.name, x.value_num, x.value_text, x.unit, x.std_value, if x.over_std == 1 { 1 } else { 0 }, i as i64],
        )
        .map_err(|e| format!("写入化验指标失败：{e}"))?;
    }
    // 状态流转：拒收压过一切；接收/条件接收时若此前被拒收，要恢复流转而不是卡死
    let new_status = if input.decision == "reject" {
        Some("rejected")
    } else if matches!(status.as_str(), "rejected" | "registered" | "draft") {
        // 拒收后复检接收要恢复流转（不能永久卡在 rejected）；新登记单有了化验即 qc_done
        Some("qc_done")
    } else {
        None
    };
    match new_status {
        Some(st) => conn.execute(
            "UPDATE weigh_order SET qc_report_id = ?1, qc_at = ?2, grade = ?3, inspector_id = ?4,
                    status = ?5, updated_at = ?2, updated_by = ?4
             WHERE id = ?6",
            params![report_id, now, input.grade.clone(), actor.id, st, order_id],
        ),
        None => conn.execute(
            "UPDATE weigh_order SET qc_report_id = ?1, qc_at = ?2, grade = ?3, inspector_id = ?4,
                    updated_at = ?2, updated_by = ?4
             WHERE id = ?5",
            params![report_id, now, input.grade.clone(), actor.id, order_id],
        ),
    }
    .map_err(|e| format!("回写化验信息失败：{e}"))?;
    Ok(Some(load_qc(conn, report_id)?.ok_or_else(|| "化验单保存后读取失败".to_string())?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QcListOpts {
    #[serde(default)]
    pub keyword: Option<String>,
}

pub fn list_qc(conn: &Connection, opts: &QcListOpts) -> Result<Vec<QcReport>, String> {
    let kw = opts.keyword.clone().unwrap_or_default().trim().to_lowercase();
    let mut stmt = conn
        .prepare(
            "SELECT q.id, q.report_no, q.order_id, o.order_no, p.name, COALESCE(q.sample_no, ''),
                    q.variety_id, q.grade, q.decision, q.reject_reason,
                    q.moisture_deduct_01kg, q.impurity_deduct_01kg, q.test_method,
                    q.is_recheck, q.first_report_id, q.is_effective,
                    q.inspector_id, q.inspected_at, q.retention_no, q.retention_until, q.remark
             FROM qc_report q
             JOIN weigh_order o ON o.id = q.order_id
             JOIN party p ON p.id = o.party_id
             ORDER BY q.id",
        )
        .map_err(|e| format!("读取化验列表失败：{e}"))?;
    let heads = stmt
        .query_map([], |r| {
            Ok(QcReport {
                id: r.get(0)?,
                report_no: r.get(1)?,
                order_id: r.get(2)?,
                order_no: r.get(3)?,
                party_name: r.get(4)?,
                sample_no: r.get(5)?,
                variety_id: r.get(6)?,
                grade: r.get(7)?,
                decision: r.get(8)?,
                reject_reason: r.get(9)?,
                moisture_deduct_01kg: r.get(10)?,
                impurity_deduct_01kg: r.get(11)?,
                test_method: r.get(12)?,
                is_recheck: r.get(13)?,
                first_report_id: r.get(14)?,
                is_effective: r.get(15)?,
                inspector_id: r.get(16)?,
                inspected_at: r.get(17)?,
                retention_no: r.get(18)?,
                retention_until: r.get(19)?,
                remark: r.get(20)?,
                indicators: Vec::new(),
            })
        })
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取化验列表失败：{e}"))?;
    let mut out = Vec::new();
    for mut q in heads {
        if !kw.is_empty()
            && !format!("{} {} {} {}", q.report_no, q.order_no, q.party_name, q.sample_no)
                .to_lowercase()
                .contains(&kw)
        {
            continue;
        }
        q.indicators = load_indicators(conn, q.id)?;
        out.push(q);
    }
    Ok(out)
}

// ------------------------------------------------------------------------ 结算

#[derive(Debug, Default, Deserialize)]
pub struct SettleInput {
    pub order_no: String,
    pub price_fen_per_ton: i64,
    pub package_deduct_01kg: i64,
    pub moisture_deduct_01kg: i64,
    pub impurity_deduct_01kg: i64,
    pub other_deduct_01kg: i64,
    pub deduction_fee_fen: i64,
    pub pay_now: bool,
    /// 当场付款方式（`METHODS` 之一）。**只在 `pay_now = true` 时有意义**：结算框里这一栏
    /// 不预选，不勾「当场已付」时那个下拉是禁用的、传上来是空串，下面两处 INSERT 也都写 NULL，
    /// 所以值域校验只在 `pay_now` 时执行（见 `settle` 开头那道闸）。
    pub payment_method: String,
    /// 当场实付金额（分）。只在 `pay_now = true` 时生效：
    /// `None`＝按应付**全额**付清（老 payload 一字不改，行为完全不变）；
    /// `Some(v)` 且 `0 < v < 应付`＝部分付款，差额自动进挂账台账（`payment_status = 'partial'`）。
    /// 站点关掉「允许挂账（部分付款）」时前端不给填小，命令层不重复设闸（与 `pay_now` 同口径）。
    #[serde(default)]
    pub paid_amount_fen: Option<i64>,
    #[allow(dead_code)]
    pub settler_id: Option<i64>,
    #[serde(default)]
    pub price_list_id: Option<i64>,
    #[serde(default)]
    pub price_override_reason: Option<String>,
    #[serde(default)]
    pub party_signed: Option<bool>,
    /// 结算时确认的业务等级。`None`（或空串）＝沿用磅单现值；有值即以结算为准改写，
    /// 与化验定级不同时写进审计备注——"这一车按几等结的钱"必须事后能查。
    #[serde(default)]
    pub grade: Option<String>,
}

pub(crate) const METHODS: &[&str] = &["cash", "bank", "wechat", "alipay", "transfer", "credit_writeoff"];

/// 03 §3.1 规则 3 的唯一同构：0.1kg × 分/吨 ÷ 10000 = 分，四舍五入只在最终金额处发生。
fn amount_fen(settle_01kg: i64, price_fen_per_ton: i64) -> i64 {
    let n = settle_01kg as i128 * price_fen_per_ton as i128;
    ((n + 5000) / 10000) as i64
}

pub fn settle(conn: &Connection, actor: &AuthProfile, input: SettleInput) -> Result<Option<SettleResult>, String> {
    // 值域跟着 `pay_now` 卡：挂账那一支根本没掏钱，前端传上来的就是空串（那个下拉是禁用的），
    // 而这一列在挂账时写的是 NULL——拿一个不会落库的空串把整单挡回去，是把界面的"没选"
    // 当成了数据的"填错"。真掏钱那一刻的空串仍然照旧拒绝（前端也另有一道同样的闸）。
    if input.pay_now && !METHODS.contains(&input.payment_method.as_str()) {
        return Err(format!("付款方式「{}」不在值域内", input.payment_method));
    }
    if input.price_fen_per_ton <= 0 {
        return Err("结算单价必须大于 0".into());
    }
    for (name, v) in [
        ("袋重扣量", input.package_deduct_01kg),
        ("扣水", input.moisture_deduct_01kg),
        ("扣杂", input.impurity_deduct_01kg),
        ("其他扣量", input.other_deduct_01kg),
        ("扣款", input.deduction_fee_fen),
    ] {
        if v < 0 {
            return Err(format!("{name}不能为负数"));
        }
    }
    let grade = input.grade.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(g) = grade {
        if !GRADES.contains(&g) {
            return Err(format!("等级「{g}」不在值域内（{}）", GRADES.join(" / ")));
        }
    }
    // 改价事由的留痕口径（02 §F1.4）：**选填**。偏离价目表现行价时写了就留，不写也放行。
    //
    // 为什么不拿"磅单上已落的价"当锚：制单带的是按品种取的挂牌价（那一刻等级还没定），
    // 化验定级后价本该跟着等级走——出纳在结算框把等级一改、价自动跟到等级价，那是正常流程
    // 而不是改价；拿磅单价当锚会让每一次定级都逼人写一句事由。真正的改价只有一种：
    // 人写了一个价目表上没有的数。判据与前端 `SettleForm` 的 `matchesList` 同一套。
    type SettleTarget = (i64, String, i64, String, String, Option<i64>, Option<i64>, Option<i64>, String, i64, Option<String>, Option<i64>, Option<i64>);
    let head: Option<SettleTarget> = conn
        .query_row(
            "SELECT o.id, o.order_no, o.party_id, p.name, o.business_date, o.net_weight_01kg, o.gross_weight_01kg, o.tare_weight_01kg, o.status,
                    COALESCE((SELECT COUNT(*) FROM settlement_order WHERE order_id = o.id), 0), o.grade, o.variety_id,
                    o.price_list_id
             FROM weigh_order o JOIN party p ON p.id = o.party_id WHERE o.order_no = ?1",
            params![input.order_no],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?, r.get(11)?, r.get(12)?)),
        )
        .optional()
        .map_err(|e| format!("读取磅单失败：{e}"))?;
    let Some((order_id, order_no, party_id, party_name, business_date, net, gross, tare, status, settled_cnt, old_grade, old_variety, booked_list_id)) = head else {
        return Ok(None);
    };
    if settled_cnt > 0 {
        return Err(format!("磅单 {order_no} 已生成过结算单，不能重复结算（不变式 6）"));
    }
    if matches!(status.as_str(), "voided" | "rejected" | "settled" | "paid" | "archived" | "reversed") {
        return Err(format!("本单当前为「{status}」，不能结算"));
    }
    // 品种是这一单唯一能对回价目表的锚：单价由前端送上来、服务端只判它大于 0，
    // 没有品种，价格偏离了价目表这件事在库里没有任何一处能发现。所以这道闸必须在服务端。
    let Some(variety_id) = old_variety else {
        return Err("本单还没有定收购品种，请先选定品种再结算".into());
    };
    // 改价事由（02 §F1.4）：**选填**。偏离价目表现行价时写下来就是留痕——票面要把这个价印给客户，
    // 事后翻得到"凭什么"；不写也不拦，收粮这一刻不该因为少敲一句话就结不了账。
    let reason = input.price_override_reason.as_deref().map(str::trim).filter(|s| !s.is_empty());
    // 本单结算后生效的等级＝送来的等级，没送就沿用磅单现值（与下面 `COALESCE(?20, grade)` 同一口径）。
    // 价跟着等级走是正常流程，所以拿"这个等级对应的现行价"当基准，而不是拿磅单上那个挂牌价当基准。
    let live_fen = lookup_price(conn, variety_id, grade.or(old_grade.as_deref()), &business_date)?.map(|(_, p)| p);
    // 是否真改价：结算价与"这个等级对应的现行价"不一致。只有真改价才留事由——
    // 照价目执行的那一遍即便前端把事由带了上来也落 NULL（0001_init.sql:217「改价后置 NULL 并填 reason」）
    let deviates = live_fen != Some(input.price_fen_per_ton);
    let override_reason = if deviates { reason } else { None };
    let Some(net) = net else { return Ok(None) };
    let deduct = input
        .package_deduct_01kg
        .checked_add(input.moisture_deduct_01kg)
        .and_then(|v| v.checked_add(input.impurity_deduct_01kg))
        .and_then(|v| v.checked_add(input.other_deduct_01kg))
        .ok_or_else(|| "各项扣量之和溢出，请核对录入".to_string())?;
    if deduct > net {
        return Err(format!(
            "各项扣量合计（{:.1}kg）大于净重（{:.1}kg），结算重量不为正",
            deduct as f64 / 10.0,
            net as f64 / 10.0,
        ));
    }
    let settle_weight = net - deduct;
    if settle_weight <= 0 {
        return Err("扣量后结算重量必须大于 0".into());
    }
    let goods = amount_fen(settle_weight, input.price_fen_per_ton);
    let payable = goods
        .checked_sub(input.deduction_fee_fen)
        .ok_or_else(|| "货款减去扣款溢出，请核对录入".to_string())?;
    if payable < 0 {
        return Err(format!(
            "扣款（{:.2}元）大于货款（{:.2}元），应付金额不得为负",
            input.deduction_fee_fen as f64 / 100.0,
            goods as f64 / 100.0,
        ));
    }
    let now = now_iso();

    // 当场实付：不带 `paid_amount_fen` 的老 payload ＝按应付全额付清，行为一字不变；
    // 填小了即部分付款，差额留在结算单上进挂账台账。零元单（扣款把货款抵完）没钱可付，当场即清。
    let paid = if !input.pay_now || payable == 0 {
        0
    } else {
        match input.paid_amount_fen {
            None => payable,
            Some(v) if v <= 0 => {
                return Err("当场实付金额必须大于 0；一分钱都不付就取消「当场已付」改走挂账".into());
            }
            Some(v) if v > payable => {
                return Err(format!(
                    "当场实付（{:.2}元）大于应付（{:.2}元），付款不得超过应付",
                    v as f64 / 100.0,
                    payable as f64 / 100.0
                ));
            }
            Some(v) => v,
        }
    };
    // 三档口径与 `settlements::record_payment` 完全一致：没勾当场＝unpaid，勾了没付够＝partial，付够＝paid。
    // 部分付款时磅单 `paid_at` 仍留 NULL——那一列记的是"钱付清的时刻"，没付清就不许落时间。
    let pay_status = if !input.pay_now {
        "unpaid"
    } else if paid >= payable {
        "paid"
    } else {
        "partial"
    };

    // 取价来源：照价目执行就保住那一行（制单的挂牌价来自哪一版价目，是事后对账的锚，
    // 不该因为结算框没把它带上来就被抹成 NULL）；改价则用前端带上来的行，没带即 NULL
    // —— 0001_init.sql:217「取价来源，改价后置 NULL 并填 reason」。
    let list_id = if live_fen == Some(input.price_fen_per_ton) {
        input.price_list_id.or(booked_list_id)
    } else {
        input.price_list_id
    };

    conn.execute(
        "UPDATE weigh_order SET
            package_deduct_01kg = ?1, moisture_deduct_01kg = ?2, impurity_deduct_01kg = ?3, other_deduct_01kg = ?4,
            deduct_total_01kg = ?5, settlement_weight_01kg = ?6,
            price_fen_per_ton = ?7, price_list_id = ?8, price_override_reason = ?9,
            goods_amount_fen = ?10, deduction_fee_fen = ?11, payable_amount_fen = ?12,
            paid_amount_fen = ?13, payment_status = ?14, payment_method = ?15,
            grade = COALESCE(?20, grade),
            status = 'settled', settled_at = ?16, paid_at = ?17, updated_at = ?16, updated_by = ?18
         WHERE id = ?19",
        params![
            input.package_deduct_01kg, input.moisture_deduct_01kg, input.impurity_deduct_01kg, input.other_deduct_01kg,
            deduct, settle_weight,
            input.price_fen_per_ton, list_id,
            override_reason,
            goods, input.deduction_fee_fen, payable,
            paid,
            pay_status,
            if input.pay_now { Some(input.payment_method.as_str()) } else { None },
            now,
            if pay_status == "paid" { Some(now.as_str()) } else { None },
            actor.id, order_id, grade,
        ],
    )
    .map_err(|e| format!("结算写单失败：{e}"))?;

    let settle_no = next_no(conn, "JS")?;
    conn.execute(
        "INSERT INTO settlement (settle_no, station_id, party_id, business_date, period_from, period_to,
                order_count, total_net_01kg, total_deduct_01kg, total_settle_01kg, total_goods_fen,
                total_deduction_fen, total_advance_fen, payable_fen, paid_fen, payment_status, main_method,
                payee_name, signed_by_party, status, settled_at, settler_id, remark, created_at, created_by)
         VALUES (?1, (SELECT id FROM station WHERE is_active = 1 ORDER BY id LIMIT 1), ?2, ?3, ?3, ?3,
                1, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?10, ?11, ?12, ?13, ?14, 'normal', ?15, ?16, '工作台当场结算', ?15, ?16)",
        params![
            settle_no, party_id, business_date,
            net, deduct, settle_weight, goods, input.deduction_fee_fen,
            payable, paid,
            pay_status,
            if input.pay_now { Some(input.payment_method.as_str()) } else { None },
            party_name,
            if input.party_signed.unwrap_or(false) { 1 } else { 0 },
            now, actor.id,
        ],
    )
    .map_err(|e| format!("生成结算单失败：{e}"))?;
    let settlement_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO settlement_order (settlement_id, order_id, goods_amount_fen, price_fen_per_ton, settlement_weight_01kg, seq)
         VALUES (?1, ?2, ?3, ?4, ?5, 1)",
        params![settlement_id, order_id, goods, input.price_fen_per_ton, settle_weight],
    )
    .map_err(|e| format!("写结算明细失败：{e}"))?;
    let mut detail = format!("{order_no} 结算 {party_name}");
    // 结算时改过等级要单独记一笔：化验单上写的几等和最后按几等结的钱不是一回事，
    // 迎检与纠纷翻的就是这条备注（化验单 itself 永不改写，见 [`set_grade`]）。
    if let Some(g) = grade {
        if old_grade.as_deref() != Some(g) {
            detail.push_str(&format!("；等级 {} → {}", old_grade.as_deref().unwrap_or("未定级"), g));
        }
    }
    // 挂账的单不会产生付款流水，"为什么这张单子压在台账里"就只能靠这条审计说清
    if pay_status != "paid" {
        detail.push_str(&format!(
            "；{} {:.2} 元挂账，凭结算凭证核销",
            if pay_status == "unpaid" { "全额" } else { "尚欠" },
            (payable - paid) as f64 / 100.0
        ));
    }
    audit(conn, actor, "settle.create", "settlement", &settle_no, Some(&detail), None);

    // 流水跟着"实际付了多少"走：挂账（paid=0）一笔流水都不该有，部分付款只登记实付那一段，
    // 剩下的差额由挂账台账 + 之后的补录付款接手（settlements::record_payment）。
    if paid > 0 {
        let pay_no = next_no(conn, "FK")?;
        let pay_remark = if pay_status == "paid" { "当场结清" } else { "当场部分付款" };
        conn.execute(
            "INSERT INTO payment_record (pay_no, settlement_id, order_id, amount_fen, method, payee_name, paid_at, operator_id, reversed, remark, created_at, created_by)
             VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?6, ?7)",
            params![pay_no, settlement_id, paid, input.payment_method, party_name, now, actor.id, pay_remark],
        )
        .map_err(|e| format!("付款流水写入失败：{e}"))?;
        audit(
            conn,
            actor,
            "pay.record",
            "settlement",
            &settle_no,
            Some(&match pay_status {
                "paid" => format!("当场结清 {pay_no}"),
                _ => format!("当场部分付款 {pay_no}，尚欠 {:.2} 元待核销", (payable - paid) as f64 / 100.0),
            }),
            None,
        );
    }
    // 库存账入库侧的另一条腿：结算重量到这一刻才存在（`stock::IN_QUALIFIED` 只认结算量），
    // 所以「已登记去向 → 此刻入仓」和「先结算 → 事后补录去向」两条先后顺序都由
    // 这同一个同步负责，谁后到谁把那一行落进 stock_movement。同事务，不可分开提交。
    crate::stock::sync_in_movement(conn, order_id)?;
    // 结算即终态：同事务释放该单绑的流转卡（受 card_release_on_terminal 控制，06 §6.3）
    crate::cards::release_for_order(conn, order_id);
    let order = load_order_full(conn, &order_no)?.ok_or_else(|| "结算后读取磅单失败".to_string())?;
    let settlement = load_settlement_by_id(conn, settlement_id)?.ok_or_else(|| "结算后读取结算单失败".to_string())?;
    // gross/tare 未用，silence 编译器；结算不动毛皮重原值
    let _ = (gross, tare);
    Ok(Some(SettleResult { order, settlement }))
}

// ------------------------------------------------------------------ 在途 / 列表

const OPEN_WHERE: &str = "o.status IN ('draft','registered','qc_done','gross_weighed','tare_weighed','reweigh','to_settle')";

pub fn open_orders(conn: &Connection) -> Result<Vec<WeighOrder>, String> {
    let mut stmt = conn
        .prepare(&format!("{ORDER_SELECT} WHERE {OPEN_WHERE} ORDER BY o.registered_at DESC"))
        .map_err(|e| format!("读取在途作业失败：{e}"))?;
    stmt.query_map([], map_order_row)
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取在途作业失败：{e}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderFilters {
    #[serde(default)] pub date_from: Option<String>,
    #[serde(default)] pub date_to: Option<String>,
    #[serde(default)] pub status: Option<String>,
    #[serde(default)] pub variety_id: Option<serde_json::Value>,
    #[serde(default)] pub payment_status: Option<String>,
    #[serde(default)] pub weight_source: Option<String>,
    #[serde(default)] pub party_id: Option<serde_json::Value>,
    #[serde(default)] pub keyword: Option<String>,
    #[serde(default)] pub page: Option<i64>,
    #[serde(default)] pub page_size: Option<i64>,
    #[serde(default)] pub sort: Option<String>,
    #[serde(default)] pub order: Option<String>,
}

fn pick_id(v: &Option<serde_json::Value>) -> Option<i64> {
    v.as_ref().and_then(|x| x.as_i64())
}

fn pick_str(v: &Option<String>) -> Option<String> {
    v.clone().filter(|s| s != "all" && !s.is_empty())
}

pub fn list_orders(conn: &Connection, f: &OrderFilters) -> Result<PageResult, String> {
    let page = f.page.unwrap_or(1).max(1);
    // 上限 2000：磅单中心一次取回整周单据（列表合计与行同源，见 03 §9 索引说明），
    // 钳在 500 会静默少行——合计对得上、数不对得上，是最难发现的那种错。
    let size = f.page_size.unwrap_or(50).clamp(1, 2000);
    let kw = f.keyword.clone().unwrap_or_default().trim().to_lowercase();

    let mut where_sql = String::from(" WHERE 1 = 1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut n = 0usize;
    if let Some(d) = pick_str(&f.date_from) {
        n += 1;
        where_sql.push_str(&format!(" AND o.business_date >= ?{n}"));
        args.push(Box::new(d));
    }
    if let Some(d) = pick_str(&f.date_to) {
        n += 1;
        where_sql.push_str(&format!(" AND o.business_date <= ?{n}"));
        args.push(Box::new(d));
    }
    if let Some(s) = pick_str(&f.status) {
        n += 1;
        where_sql.push_str(&format!(" AND o.status = ?{n}"));
        args.push(Box::new(s));
    }
    if let Some(v) = pick_id(&f.variety_id) {
        n += 1;
        where_sql.push_str(&format!(" AND o.variety_id = ?{n}"));
        args.push(Box::new(v));
    }
    if let Some(v) = pick_str(&f.payment_status) {
        n += 1;
        where_sql.push_str(&format!(" AND o.payment_status = ?{n}"));
        args.push(Box::new(v));
    }
    if let Some(v) = pick_str(&f.weight_source) {
        n += 1;
        where_sql.push_str(&format!(" AND o.weight_source = ?{n}"));
        args.push(Box::new(v));
    }
    if let Some(v) = pick_id(&f.party_id) {
        n += 1;
        where_sql.push_str(&format!(" AND o.party_id = ?{n}"));
        args.push(Box::new(v));
    }
    if !kw.is_empty() {
        // 关键字海堆与 mock 一致：单号 / 姓名 / 证号后 4 位 / 车牌。
        // 参数是**一个带通配的完整 pattern**，避免同一 ?n 绑两次的歧义写法。
        n += 1;
        where_sql.push_str(&format!(
            " AND (lower(o.order_no) LIKE ?{n} OR lower(p.name) LIKE ?{n} OR lower(COALESCE(o.vehicle_no, '')) LIKE ?{n} OR substr(COALESCE(CAST(p.id_card_no_enc AS TEXT), ''), -4) LIKE ?{n})"
        ));
        let pat = format!("%{}%", kw.replace('%', "").to_lowercase());
        args.push(Box::new(pat));
    }

    let sort_col = match f.sort.as_deref() {
        Some("payable_amount_fen") => "o.payable_amount_fen",
        Some("settlement_weight_01kg") => "o.settlement_weight_01kg",
        Some("order_no") => "o.order_no",
        _ => "o.registered_at",
    };
    let dir = if f.order.as_deref() == Some("asc") { "ASC" } else { "DESC" };

    let (total, sum_count, sum_net, sum_settle, sum_goods, sum_payable): (i64, i64, i64, i64, i64, i64) = conn
        .query_row(
            &format!(
                "SELECT COUNT(*),
                        COALESCE(SUM(CASE WHEN o.settlement_weight_01kg IS NOT NULL AND o.status NOT IN ('voided','rejected') THEN 1 ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN o.settlement_weight_01kg IS NOT NULL AND o.status NOT IN ('voided','rejected') THEN o.net_weight_01kg ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN o.settlement_weight_01kg IS NOT NULL AND o.status NOT IN ('voided','rejected') THEN o.settlement_weight_01kg ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN o.settlement_weight_01kg IS NOT NULL AND o.status NOT IN ('voided','rejected') THEN o.goods_amount_fen ELSE 0 END), 0),
                        COALESCE(SUM(CASE WHEN o.settlement_weight_01kg IS NOT NULL AND o.status NOT IN ('voided','rejected') THEN o.payable_amount_fen ELSE 0 END), 0)
                 FROM weigh_order o JOIN party p ON p.id = o.party_id{where_sql}"
            ),
            rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())),
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
        )
        .map_err(|e| format!("读取磅单汇总失败：{e}"))?;

    let sql = format!(
        "{ORDER_SELECT}{where_sql} ORDER BY {sort_col} IS NULL, {sort_col} {dir} LIMIT ?{} OFFSET ?{}",
        args.len() + 1,
        args.len() + 2,
    );
    args.push(Box::new(size));
    args.push(Box::new((page - 1) * size));
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取磅单列表失败：{e}"))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter().map(|b| b.as_ref())), map_order_row)
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取磅单列表失败：{e}"))?;
    Ok(PageResult {
        rows,
        total,
        summary: Summary { count: sum_count, net_01kg: sum_net, settle_01kg: sum_settle, goods_fen: sum_goods, payable_fen: sum_payable },
    })
}

// -------------------------------------------------------------------- 打印留痕

#[derive(Debug, Deserialize)]
pub struct PrintLogInput {
    pub doc_type: String,
    pub doc_no: String,
    pub paper: String,
    pub printer_name: String,
    pub channel: String,
    pub is_reprint: bool,
    #[allow(dead_code)]
    pub operator_id: Option<i64>,
}

pub fn log_print(conn: &Connection, actor: &AuthProfile, input: PrintLogInput) -> Result<(), String> {
    if !matches!(input.channel.as_str(), "preview" | "pdf_silent" | "raw") {
        return Err(format!("打印通道「{}」不在值域内", input.channel));
    }
    let doc_id: i64 = match input.doc_type.as_str() {
        "weigh_order" => conn
            .query_row("SELECT id FROM weigh_order WHERE order_no = ?1", params![input.doc_no], |r| r.get(0))
            .unwrap_or(0),
        "quality_report" => conn
            .query_row("SELECT id FROM qc_report WHERE report_no = ?1", params![input.doc_no], |r| r.get(0))
            .unwrap_or(0),
        "settlement_voucher" => conn
            .query_row("SELECT id FROM settlement WHERE settle_no = ?1", params![input.doc_no], |r| r.get(0))
            .unwrap_or(0),
        _ => 0, // ledger / daily_report / internal_flow：无单级主键，doc_no 即快照
    };
    conn.execute(
        "INSERT INTO print_log (doc_type, doc_id, doc_no, copies, paper, printer_name, channel, is_reprint, result, printed_at, operator_id)
         VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6, ?7, 'success', ?8, ?9)",
        params![
            input.doc_type, doc_id, input.doc_no, input.paper, input.printer_name, input.channel,
            if input.is_reprint { 1 } else { 0 },
            now_iso(), actor.id,
        ],
    )
    .map_err(|e| format!("打印留痕失败：{e}"))?;
    if doc_id == 0 && matches!(input.doc_type.as_str(), "weigh_order" | "quality_report" | "settlement_voucher") {
        eprintln!("[banghe] 打印留痕挂了个查无此单：{} {}", input.doc_type, input.doc_no);
    }
    Ok(())
}

// ----------------------------------------------------------------- Tauri 命令
// 写命令在事务里跑（spawn_blocking 内取一次锁），读命令同锁串行。
// 单连接挂 Mutex，事务对象借用锁内 Connection，见 rusqlite::Connection::unchecked_transaction。

pub(crate) async fn write_tx<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce(&Connection, &AuthProfile) -> Result<T, String> + Send + 'static,
    roles: &[&str],
    what: &str,
) -> Result<T, String> {
    let pool = pool_of(app)?;
    let actor = actor_with_roles(app, roles, what)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn_guard = pool.lock().unwrap_or_else(|p| p.into_inner());
        let tx = conn_guard.unchecked_transaction().map_err(|e| format!("开启事务失败：{e}"))?;
        let out = f(&tx, &actor)?;
        tx.commit().map_err(|e| format!("提交事务失败：{e}"))?;
        Ok(out)
    })
    .await
    .map_err(|e| format!("业务写入任务失败：{e}"))?
}

pub(crate) async fn read_only<T: Send + 'static>(app: &AppHandle, f: impl FnOnce(&Connection) -> Result<T, String> + Send + 'static, what: &str) -> Result<T, String> {
    let pool = pool_of(app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, f))
        .await
        .map_err(|e| format!("{what}任务失败：{e}"))?
}

#[tauri::command]
pub async fn party_list(app: AppHandle, keyword: String, party_type: Option<String>) -> Result<Vec<Party>, String> {
    read_only(&app, move |conn| list_parties(conn, &keyword, party_type.as_deref()), "档案读取").await
}

#[tauri::command]
pub async fn party_get(app: AppHandle, id: i64) -> Result<Option<PartyDetail>, String> {
    read_only(&app, move |conn| get_party(conn, id), "档案读取").await
}

#[tauri::command]
pub async fn party_save(app: AppHandle, input: PartySaveInput) -> Result<Party, String> {
    write_tx(&app, move |conn, actor| save_party(conn, actor, input), FLOOR_ROLES, "维护售粮人档案").await
}

/// 数据目录：附件落盘与读回都以它为根（03 §9.15 的 `file_path` 就是相对它的路径）。
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("无法定位本机数据目录：{e}"))
}

#[tauri::command]
pub async fn party_photo_set(app: AppHandle, input: PartyPhotoInput) -> Result<Party, String> {
    let dir = app_data_dir(&app)?;
    write_tx(
        &app,
        move |conn, actor| set_party_photo(conn, &dir, actor, input),
        FLOOR_ROLES,
        "维护售粮人照片",
    )
    .await
}

/// 档案人像的读通道。写命令用 `write_tx` 顺手拿到会话身份，读这条按同一口径先取 actor
/// （访问痕迹要记到人），再进锁里读文件。
#[tauri::command]
pub async fn party_photo(app: AppHandle, party_id: i64) -> Result<Option<crate::attachment::ImageForDisplay>, String> {
    let actor = auth::current_actor(&app).ok_or_else(|| "登录已失效或已锁屏，请先解锁再继续作业".to_string())?;
    let pool = pool_of(&app)?;
    let dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, move |conn| party_photo_view(conn, &dir, &actor, party_id)))
        .await
        .map_err(|e| format!("档案照片读取任务失败：{e}"))?
}

/// 过磅抓拍图的读通道命令。与 `party_photo` 同一口径：先取会话身份（访问痕迹要记到人），
/// 再进锁按**附件 id** 读那张图（一次过磅最多 3 张，墙上逐张列，点哪张读哪张）；
/// `read_for_display` 内部已刷 `attachment.accessed_*`，这里再落一条 `pii.read`。
#[tauri::command]
pub async fn capture_photo(app: AppHandle, attachment_id: i64) -> Result<Option<crate::attachment::ImageForDisplay>, String> {
    let actor = auth::current_actor(&app).ok_or_else(|| "登录已失效或已锁屏，请先解锁再继续作业".to_string())?;
    let pool = pool_of(&app)?;
    let dir = app_data_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, move |conn| capture_photo_view(conn, &dir, &actor, attachment_id)))
        .await
        .map_err(|e| format!("抓拍读取任务失败：{e}"))?
}

#[tauri::command]
pub async fn order_get(app: AppHandle, no: String) -> Result<Option<WeighOrder>, String> {
    read_only(&app, move |conn| load_order_full(conn, &no), "磅单读取").await
}

#[tauri::command]
pub async fn order_open(app: AppHandle) -> Result<Vec<WeighOrder>, String> {
    read_only(&app, open_orders, "在途读取").await
}

#[tauri::command]
pub async fn order_list(app: AppHandle, filters: OrderFilters) -> Result<PageResult, String> {
    read_only(&app, move |conn| list_orders(conn, &filters), "磅单列表读取").await
}

#[tauri::command]
pub async fn order_create(app: AppHandle, input: CreateOrderInput) -> Result<WeighOrder, String> {
    // 取号与绑卡（06 §4.0）就在这一笔事务里：卡那道闸不过，号与单一起回滚
    write_tx(&app, move |conn, actor| create_order(conn, actor, input), FLOOR_ROLES, "制单").await
}

#[tauri::command]
pub async fn order_capture(app: AppHandle, mut input: CaptureInput) -> Result<Option<WeighOrder>, String> {
    // 前端的 has_photo 只是"当时摄像头在线"的自我声明，拿来当门闩：离线时连这三秒的网络都不去堵。
    let want_photo = input.has_photo.unwrap_or(false);
    // 本机摄像头的帧是前端就地取的：带了帧就想落，不必再等 has_photo 那声自我声明（空串逐条丢弃）
    let frames: Vec<CaptureFrame> = std::mem::take(&mut input.frames)
        .into_iter()
        .filter(|f| !f.b64.trim().is_empty())
        .collect();
    let order = write_tx(&app, move |conn, actor| capture(conn, actor, input), FLOOR_ROLES, "称重").await?;
    if want_photo || !frames.is_empty() {
        if let Some(weighed) = order.as_ref() {
            attach_weigh_photos(&app, weighed, frames).await;
        }
    }
    Ok(order)
}

/// 过磅抓拍（04 §2.4）：磅单已经提交，这里只往那条称重轨迹上挂图。
///
/// **一次最多 3 台相机各拍一张**（04 §4）：遍历 [`camera::list_capture_cameras`] 拿到勾了
/// 「过磅抓拍」的相机，逐台分叉取图——本机 USB 摄像头用前端回传的那帧
/// （[`camera::store_frame_for`]，按 `device_id` 对号，没有对应帧就跳过该台），
/// 内网 IP 摄像机由服务端 HTTP 抓图（[`camera::snapshot_for`]）。每张落一行 `attachment`
/// （`biz_id`=本称重记录 id），并把**第一张**回填进 `weigh_record.photo_attachment_id`
/// 作主图（读图与「无抓拍」判据的锚点），其余靠 attachment 表按 biz_id 枚举取回。
///
/// 取图要等摄像机应答（连接与收图各 3 秒），所以放在称重事务**之外**——让一张照片
/// 把已经成立的过磅拖回滚、或者把单连接的写事务开足三秒，都是把主次颠倒了（04 §4）。
/// 于是这里的所有失败都就地降级成"无抓拍"，含"配置非法"那类：原因由 `camera` 写进
/// `device_config.last_error`，站长在设备中心看得到，不该由一次称重去替它报警。
async fn attach_weigh_photos(app: &AppHandle, weighed: &WeighOrder, frames: Vec<CaptureFrame>) {
    // capture() 成功即新增一条轨迹，`records` 按 seq 升序，最后一条就是刚称的那个头
    let Some(record) = weighed.records.as_ref().and_then(|rs| rs.last()) else {
        return;
    };
    let (Ok(app_dir), Ok(pool)) = (app.path().app_data_dir(), pool_of(app)) else { return };
    let (order_id, record_id, operator_id) = (weighed.id, record.id, record.operator_id);
    let weigh_type = record.weigh_type.clone();
    let attached = tauri::async_runtime::spawn_blocking(move || -> Result<usize, String> {
        let conn = pool.lock().unwrap_or_else(|p| p.into_inner());
        let key = if weigh_type == "tare" { "capture_on_tare" } else { "capture_on_gross" };
        if !setting_bool(&conn, key, true) {
            return Ok(0);
        }
        let cams = camera::list_capture_cameras(&conn)?;
        let ctx = crate::camera::CaptureContext { order_id, weigh_record_id: record_id, operator_id };
        let mut stored: Vec<i64> = Vec::new();
        for cam in &cams {
            let photo = if camera::is_local_camera(&cam.config_json) {
                // 本机相机：只认前端为这台设备回传的那帧；没带到就跳过（不拿别的机器的帧冒充）
                match frames.iter().find(|f| f.device_id == cam.id) {
                    Some(f) => crate::camera::store_frame_for(&conn, &app_dir, &ctx, cam, &f.b64)?,
                    None => None,
                }
            } else {
                crate::camera::snapshot_for(&conn, &app_dir, &ctx, cam)?
            };
            if let Some(att) = photo {
                stored.push(att);
            }
        }
        // 主图锚点：第一张挂到 photo_attachment_id（has_photo 与单图读通道都认它），
        // 多出来的靠 attachment 表按 biz_id 枚举。一张没落上就保持 NULL → 「无抓拍」。
        if let Some(&first) = stored.first() {
            conn.execute(
                "UPDATE weigh_record SET photo_attachment_id = ?1 WHERE id = ?2",
                params![first, record_id],
            )
            .map_err(|e| format!("回填抓拍引用失败：{e}"))?;
        }
        Ok(stored.len())
    })
    .await;
    // 取不到图就是"无抓拍"：Ok(0) 的原因 camera 已写进台账并打到 stderr；
    // Err 是配置非法，同样不回头否定这次已经成立的过磅，只留一行现场可查的痕迹。
    if let Err(e) = attached {
        eprintln!("[抓拍] 本轮按无抓拍处理：{e}");
    }
}

#[tauri::command]
pub async fn qc_save(app: AppHandle, input: SaveQcInput) -> Result<Option<QcReport>, String> {
    write_tx(&app, move |conn, actor| save_qc(conn, actor, input), QC_ROLES, "录入化验").await
}

#[tauri::command]
pub async fn qc_list(app: AppHandle, opts: QcListOpts) -> Result<Vec<QcReport>, String> {
    read_only(&app, move |conn| list_qc(conn, &opts), "化验读取").await
}

#[tauri::command]
pub async fn order_settle(app: AppHandle, input: SettleInput) -> Result<Option<SettleResult>, String> {
    // 角色集按"这一单要不要动现金"选，不取并集：挂账（未付款）磅员也做得，当场付款仍限出纳/站长。
    // 判据只看 `pay_now`——`paid_amount_fen` 只在 pay_now 为真时才有意义（见 SettleInput 注释），
    // 拿它当判据会给"pay_now=false 却带了个数"的 payload 留一条缝。
    let roles: &[&str] = if input.pay_now { SETTLE_ROLES } else { SETTLE_CREDIT_ROLES };
    write_tx(&app, move |conn, actor| settle(conn, actor, input), roles, "结算").await
}

#[tauri::command]
pub async fn print_log_add(app: AppHandle, input: PrintLogInput) -> Result<(), String> {
    write_tx(&app, move |conn, actor| log_print(conn, actor, input), FLOOR_ROLES, "打印").await
}

// --------------------------------------------------------------- 作废与结算归属
// 磅单中心（/orders、/orders/$no）换真库要补的两个动作。列表与详情走 order_list /
// order_get，这里补「作废」和「本单所属结算单」——前者 mock 谁点都放行，后者 mock 有、
// 真库此前只在结算命令的返回值里给过一次，页面刷新一下就再也拿不到。

/// 可直接作废的状态（02 §F2.3：只有未到 settled 的单能作废，已结算必须走红冲）。
/// 与 WEIGHABLE 同集合不是巧合——两者都表达"单据还在流转"，但语义各自独立，分开写。
const VOIDABLE: &[&str] = &["draft", "registered", "qc_done", "gross_weighed", "tare_weighed", "reweigh", "to_settle"];

#[derive(Debug, Deserialize)]
pub struct VoidOrderInput {
    pub order_no: String,
    pub reason: String,
    /// 操作人以会话为准，此字段只为与 mock 签名对齐而存在
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
    /// 作废**不再要求站长授权**（磅员自己填事由即可废单），此字段只为兼容仍在
    /// 传它的旧调用方而保留并忽略——与皮重超容差那次同口径（见 [`capture`]）。
    #[allow(dead_code)]
    #[serde(default)]
    pub authorized_by: Option<i64>,
}

pub fn void_order(conn: &Connection, actor: &AuthProfile, input: VoidOrderInput) -> Result<Option<WeighOrder>, String> {
    let reason = input.reason.trim().to_string();
    if reason.chars().count() < 6 {
        return Err("作废原因不得少于 6 个字（迎检要看得懂为什么废）".into());
    }
    let order: Option<WeighOrder> = conn
        .query_row(&format!("{ORDER_SELECT} WHERE o.order_no = ?1"), params![input.order_no], map_order_row)
        .optional()
        .map_err(|e| format!("读取磅单失败：{e}"))?;
    let Some(order) = order else { return Ok(None) };
    if !VOIDABLE.contains(&order.status.as_str()) {
        return Err(if order.status == "voided" {
            "本单已作废，无需重复操作".into()
        } else {
            format!("本单当前为「{}」，已完成的单据不能作废，只能由站长走红冲更正", order.status)
        });
    }
    // 状态没到 settled 却已被结算单引用（并发结算或历史脏数据）同样要拦住，
    // 否则作废会把一张已进入资金流程的单悄悄移出汇总。
    if load_settlement_of(conn, order.id)?.is_some() {
        return Err("本单已挂在结算单下，作废前请先撤销结算".into());
    }

    let now = now_iso();
    conn.execute(
        "UPDATE weigh_order SET status = 'voided', voided_at = ?2, void_reason = ?3, voided_by = ?4, updated_at = ?2 WHERE id = ?1",
        params![order.id, now, reason, actor.id],
    )
    .map_err(|e| format!("作废失败：{e}"))?;
    // authorized_by 恒为空：作废不走授权，留痕靠经办人（actor）+ 事由 + 时间
    audit(conn, actor, "order.void", "weigh_order", &order.order_no, Some(&reason), None);
    // 作废同样是终态：同事务释放该单绑的流转卡（06 §6.3）
    crate::cards::release_for_order(conn, order.id);
    load_order_full(conn, &order.order_no)
}

/// 本单所属结算单（详情页的跳转与付款归属）。未结算回 None。
pub fn settlement_of(conn: &Connection, order_no: &str) -> Result<Option<Settlement>, String> {
    let id: Option<i64> = conn
        .query_row("SELECT id FROM weigh_order WHERE order_no = ?1", params![order_no], |r| r.get(0))
        .optional()
        .map_err(|e| format!("读取磅单失败：{e}"))?;
    match id {
        Some(id) => load_settlement_of(conn, id),
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn order_void(app: AppHandle, input: VoidOrderInput) -> Result<Option<WeighOrder>, String> {
    write_tx(&app, move |conn, actor| void_order(conn, actor, input), FLOOR_ROLES, "作废磅单").await
}

#[tauri::command]
pub async fn settlement_of_order(app: AppHandle, no: String) -> Result<Option<Settlement>, String> {
    read_only(&app, move |conn| settlement_of(conn, &no), "结算单读取").await
}

// ----------------------------------------------------------------- 补录入仓去向
// 制单时去向选填（03 §9.9），所以粮真进了仓往往是保管员事后到详情页补一笔。
// 这条命令就是那个写入口：谁指定的写进 keeper_id（03 §9.11 三环节署名之一），
// 改派留审计，作废/拒收的单不再接受登记。

#[derive(Debug, Deserialize)]
pub struct AssignDestinationInput {
    pub order_no: String,
    pub warehouse_id: Option<i64>,
    pub slot_id: Option<i64>,
    /// 操作人以会话为准，此字段只为与 mock 签名对齐而存在
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
}

/// 不再接受去向登记的状态：作废单不参与汇总，拒收单粮已随车离场。
const DESTINATION_LOCKED: &[&str] = &["voided", "rejected"];

pub fn assign_destination(conn: &Connection, actor: &AuthProfile, input: AssignDestinationInput) -> Result<Option<WeighOrder>, String> {
    let order: Option<WeighOrder> = conn
        .query_row(&format!("{ORDER_SELECT} WHERE o.order_no = ?1"), params![input.order_no], map_order_row)
        .optional()
        .map_err(|e| format!("读取磅单失败：{e}"))?;
    let Some(order) = order else { return Ok(None) };
    if DESTINATION_LOCKED.contains(&order.status.as_str()) {
        let label = match order.status.as_str() {
            "voided" => "已作废",
            "rejected" => "拒收退粮",
            other => other,
        };
        return Err(format!("本单{label}，不再登记入仓去向"));
    }
    let dest = resolve_destination(conn, input.warehouse_id, input.slot_id)?;
    let now = now_iso();
    // 清空去向时署名一并抹掉，免得详情里挂着"保管员张三"却查不到他指定了哪里
    let keeper_id: Option<i64> = if dest.warehouse_id.is_none() && dest.slot_id.is_none() {
        None
    } else {
        Some(actor.id)
    };
    conn.execute(
        "UPDATE weigh_order SET warehouse_id = ?2, slot_id = ?3, keeper_id = ?4, updated_at = ?5 WHERE id = ?1",
        params![order.id, dest.warehouse_id, dest.slot_id, keeper_id, now],
    )
    .map_err(|e| format!("登记去向失败：{e}"))?;
    // 库存账入库侧的一条腿：去向就是「粮进了哪个仓」的真相，本单在 stock_movement
    // 里的 in 投影跟着这里同步（改派 → UPDATE 那一行，清空 → 撤掉那一行）。
    // 与磅单更新同事务——不能出现「去向改了、结存还是老仓房的」这种两条腿分家。
    // 未结算的单本来就不在结存里（判据见 `stock::IN_QUALIFIED`），这里同步是空操作。
    crate::stock::sync_in_movement(conn, order.id)?;
    let before = Destination {
        warehouse_id: order.warehouse_id,
        warehouse_name: order.warehouse_name.clone(),
        slot_id: order.slot_id,
        slot_label: order.slot_label.clone(),
    };
    audit(
        conn,
        actor,
        "order.destination",
        "weigh_order",
        &order.order_no,
        Some(&format!("{} → {}", before.text(), dest.text())),
        None,
    );
    load_order_full(conn, &order.order_no)
}

#[tauri::command]
pub async fn order_assign_destination(app: AppHandle, input: AssignDestinationInput) -> Result<Option<WeighOrder>, String> {
    write_tx(&app, move |conn, actor| assign_destination(conn, actor, input), KEEPER_ROLES, "登记入仓去向").await
}

// ------------------------------------------------------------------- 调整等级
// 化验报告上的 `qc_report.grade` 是化验员按国标的判定，**永不改写**（复检另立新单，
// 见不变式 7）；磅单上的 `weigh_order.grade` 是**结算用的业务等级**，从过磅完成到
// 结算这一段允许改判——现场最常见的是"化验定二等、结算按实际议价改三等"。
//
// 所以改判只动磅单（事由可选，留空时审计里显式记为「未填写」），状态闸门沿用 VOIDABLE：
// 单据一旦进了结算/作废终态，等级就是钱的一部分，要改请站长走红冲，不许在这里悄悄改掉已结过的账。

#[derive(Debug, Deserialize)]
pub struct GradeAdjustInput {
    pub order_no: String,
    /// 目标等级。空串 / null ＝ 清除定级（回到"未定级"）
    pub grade: Option<String>,
    /// 改判事由，可选：现场改判频繁，不强制填写；留空时审计写「未填写」
    #[serde(default)]
    pub reason: String,
    /// 操作人以会话为准，此字段只为与 mock 签名对齐而存在
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
}

pub fn set_grade(conn: &Connection, actor: &AuthProfile, input: GradeAdjustInput) -> Result<Option<WeighOrder>, String> {
    let target = input.grade.as_deref().map(str::trim).filter(|s| !s.is_empty());
    if let Some(g) = target {
        if !GRADES.contains(&g) {
            return Err(format!("等级「{g}」不在值域内（{}）", GRADES.join(" / ")));
        }
    }
    let reason = input.reason.trim();
    let reason_label = if reason.is_empty() { "未填写" } else { reason };
    let order: Option<WeighOrder> = conn
        .query_row(&format!("{ORDER_SELECT} WHERE o.order_no = ?1"), params![input.order_no], map_order_row)
        .optional()
        .map_err(|e| format!("读取磅单失败：{e}"))?;
    let Some(order) = order else { return Ok(None) };
    if !VOIDABLE.contains(&order.status.as_str()) {
        return Err(match order.status.as_str() {
            "voided" => "本单已作废，不能再调整等级".into(),
            "rejected" => "本单化验拒收，不能再调整等级".into(),
            other => format!("本单当前为「{other}」，已结算的单改等级请先由站长红冲（02 §F6.3）"),
        });
    }
    if order.grade.as_deref() == target {
        // 没变就是没变：既不写库也不留痕，审计表里不该有"改了个寂寞"的噪音
        return Ok(Some(order));
    }
    let now = now_iso();
    conn.execute(
        "UPDATE weigh_order SET grade = ?2, updated_at = ?3, updated_by = ?4 WHERE id = ?1",
        params![order.id, target, now, actor.id],
    )
    .map_err(|e| format!("调整等级失败：{e}"))?;
    audit(
        conn,
        actor,
        "order.grade",
        "weigh_order",
        &order.order_no,
        Some(&format!(
            "等级 {} → {}：{}",
            order.grade.as_deref().unwrap_or("未定级"),
            target.unwrap_or("未定级"),
            reason_label
        )),
        None,
    );
    load_order_full(conn, &order.order_no)
}

#[tauri::command]
pub async fn order_set_grade(app: AppHandle, input: GradeAdjustInput) -> Result<Option<WeighOrder>, String> {
    write_tx(&app, move |conn, actor| set_grade(conn, actor, input), GRADE_ROLES, "调整等级").await
}

// --------------------------------------------------------------- 调整收购品种
// 0017 之后品种不再挡制单：农户报不出品种时先把单取出来，等卸完货看清粮食再定。
// 于是「定品种」从制单那一下变成了事后一次改写，入口有三处（制单格、化验区、结算框），
// 改的都是 `weigh_order.variety_id` 同一列，所以只留这一条命令，别各写一份 UPDATE。
//
// 与等级同理，闸门沿用 VOIDABLE：一旦结算，品种连同单价就是货款的一部分，
// 要改请站长走红冲（02 §F6.3），不许在这里改掉已结过的账。
// 化验单上的 `qc_report.variety_id` 是当时判定所用的品种快照，改磅单不动它。

#[derive(Debug, Deserialize)]
pub struct VarietyAdjustInput {
    pub order_no: String,
    /// 目标品种。null / 省略 ＝ 清除定种（回到「未定品种」，只允许在还没化验、还没结算时清）
    #[serde(default)]
    pub variety_id: Option<i64>,
    /// 改判事由，可选：留空时审计写「未填写」
    #[serde(default)]
    pub reason: String,
    /// 操作人以会话为准，此字段只为与 mock 签名对齐而存在
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
}

pub fn set_variety(conn: &Connection, actor: &AuthProfile, input: VarietyAdjustInput) -> Result<Option<WeighOrder>, String> {
    // 填了品种就得是个能计价的品种；不填即清除，无需校验
    let target_name: Option<String> = match input.variety_id {
        None => None,
        Some(vid) => Some(
            conn.query_row(
                "SELECT name FROM grain_variety WHERE id = ?1 AND deleted_at IS NULL AND is_active = 1",
                params![vid],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| format!("检查品种失败：{e}"))?
            .ok_or_else(|| "所选品种不存在或已停用，请重新选择".to_string())?,
        ),
    };
    let reason = input.reason.trim();
    let reason_label = if reason.is_empty() { "未填写" } else { reason };
    let order: Option<WeighOrder> = conn
        .query_row(&format!("{ORDER_SELECT} WHERE o.order_no = ?1"), params![input.order_no], map_order_row)
        .optional()
        .map_err(|e| format!("读取磅单失败：{e}"))?;
    let Some(order) = order else { return Ok(None) };
    if !VOIDABLE.contains(&order.status.as_str()) {
        return Err(match order.status.as_str() {
            "voided" => "本单已作废，不能再调整品种".into(),
            "rejected" => "本单化验拒收，不能再调整品种".into(),
            other => format!("本单当前为「{other}」，已结算的单改品种请先由站长红冲（02 §F6.3）"),
        });
    }
    if order.variety_id == input.variety_id {
        // 没变就是没变：既不写库也不留痕，审计表里不该有"改了个寂寞"的噪音
        return Ok(Some(order));
    }
    let now = now_iso();
    conn.execute(
        "UPDATE weigh_order SET variety_id = ?2, updated_at = ?3, updated_by = ?4 WHERE id = ?1",
        params![order.id, input.variety_id, now, actor.id],
    )
    .map_err(|e| format!("调整品种失败：{e}"))?;
    audit(
        conn,
        actor,
        "order.variety",
        "weigh_order",
        &order.order_no,
        Some(&format!(
            "品种 {} → {}：{}",
            order.variety_name.as_deref().unwrap_or("未定品种"),
            target_name.as_deref().unwrap_or("未定品种"),
            reason_label
        )),
        None,
    );
    load_order_full(conn, &order.order_no)
}

#[tauri::command]
pub async fn order_set_variety(app: AppHandle, input: VarietyAdjustInput) -> Result<Option<WeighOrder>, String> {
    write_tx(&app, move |conn, actor| set_variety(conn, actor, input), VARIETY_ROLES, "调整品种").await
}

// ---------------------------------------------------------------------- 定价 / 改价
// 价**不是结算的产物，是成交的前提**：农户到站先问价、谈成才卸货。所以定价从结算里拆出来，
// 变成磅单上的一个独立动作，分两步落地：
//   ① 制单那一刻按价目表带一次挂牌价（`create_order` 里的 `lookup_price`，不用人操作）；
//   ② 化验定级之后按实际等级修正，或现场议价 —— 都走本命令。
// 结算那一步只把磅单上的价**带出来**，改了才留事由、也不强求（见 `settle`）。
//
// 为什么磅房也要有落价权：议价就发生在磅房窗口上——车停在磅上、农户站在窗口、价谈定了才卸货。
// 让磅员跑去叫出纳来落价，等于把成交那一刻的时间轴拉长，而票面是当场要打给客户的：
// 价没落，票上就没价。这把钥匙不含收钱，与 `settle.credit`（只挂账、不碰现金）同一种切法。

#[derive(Debug, Deserialize)]
pub struct PriceAdjustInput {
    pub order_no: String,
    /// 本单定价（分/吨），必须大于 0
    pub price_fen_per_ton: i64,
    /// 这个价取自价目表的哪一行。手工议价时传 null；传了就必须真的是该品种现行有效的那一行
    #[serde(default)]
    pub price_list_id: Option<i64>,
    /// 改价事由：**选填**。偏离价目表现行价时写了就随价落库（票面要印给客户，事后得能对账），
    /// 不写也放行；照价目执行的那一遍一律清成 NULL。
    #[serde(default)]
    pub reason: String,
    /// 操作人以会话为准，此字段只为与 mock 签名对齐而存在
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
}

pub fn set_price(conn: &Connection, actor: &AuthProfile, input: PriceAdjustInput) -> Result<Option<WeighOrder>, String> {
    if input.price_fen_per_ton <= 0 {
        return Err("单价必须大于 0".into());
    }
    let order: Option<WeighOrder> = conn
        .query_row(&format!("{ORDER_SELECT} WHERE o.order_no = ?1"), params![input.order_no], map_order_row)
        .optional()
        .map_err(|e| format!("读取磅单失败：{e}"))?;
    let Some(order) = order else { return Ok(None) };
    // 闸门沿用 VOIDABLE：一旦结算，价就是货款的一部分，要改请站长走红冲（02 §F6.3），
    // 不许在这里把已经收过的钱改掉。与 set_grade / set_variety 同一条纪律。
    if !VOIDABLE.contains(&order.status.as_str()) {
        return Err(match order.status.as_str() {
            "voided" => "本单已作废，不能再定价".into(),
            "rejected" => "本单化验拒收，不能再定价".into(),
            other => format!("本单当前为「{other}」，已结算的单改价请先由站长红冲（02 §F6.3）"),
        });
    }
    let Some(variety_id) = order.variety_id else {
        return Err("本单还没有定收购品种：价对不回价目表，请先定品种再定价".into());
    };
    let reason = input.reason.trim();
    // 判据与 `settle`、前端 `SettleForm` 的 `matchesList` 是同一套：偏离（或该品种压根没有现行价目）
    // 就是一次真实议价——**可以**留一句能对账的话，但不留也放行（02 §F1.4：改价事由选填）。
    let live = lookup_price(conn, variety_id, order.grade.as_deref(), &order.business_date)?;
    let live_fen = live.map(|(_, p)| p);
    // 是否真改价：只有真改价才留事由；照价目执行的那一遍把事由清掉（0001_init.sql:217）
    let deviates = live_fen != Some(input.price_fen_per_ton);
    // 送了价目行就得真的是现行那一行：否则 `price_list_id` 变成一句随便填的备注，
    // 事后翻开还以为"当时就是照那版价执行的"。
    if let Some(id) = input.price_list_id {
        if live.map(|(lid, _)| lid) != Some(id) {
            return Err("所选取价行与这个品种的现行价目对不上，请重新从价目表取价".into());
        }
    }
    // 取价来源与价一起落清：照价目执行就记那一行，议价即 NULL 并留事由
    // —— 0001_init.sql:217「取价来源，改价后置 NULL 并填 reason」。
    let list_id = if deviates { input.price_list_id } else { input.price_list_id.or(live.map(|(lid, _)| lid)) };
    let stored_reason = if deviates && !reason.is_empty() { Some(reason) } else { None };
    if order.price_fen_per_ton == Some(input.price_fen_per_ton)
        && order.price_list_id == list_id
        && order.price_override_reason.as_deref() == stored_reason
    {
        // 值没变就是没变：既不写库也不留痕，审计表里不该有"改了个寂寞"的噪音（同 set_grade）
        return Ok(Some(order));
    }
    let now = now_iso();
    conn.execute(
        "UPDATE weigh_order SET price_fen_per_ton = ?2, price_list_id = ?3, price_override_reason = ?4,
                updated_at = ?5, updated_by = ?6
         WHERE id = ?1",
        params![order.id, input.price_fen_per_ton, list_id, stored_reason, now, actor.id],
    )
    .map_err(|e| format!("定价失败：{e}"))?;
    audit(
        conn,
        actor,
        "price.override",
        "weigh_order",
        &order.order_no,
        Some(&format!(
            "单价 {} → {}：{}",
            order.price_fen_per_ton.map(price_label).unwrap_or_else(|| "未定价".to_string()),
            price_label(input.price_fen_per_ton),
            if deviates {
                if reason.is_empty() { "未填写改价事由" } else { reason }
            } else {
                "照价目表执行"
            },
        )),
        None,
    );
    load_order_full(conn, &order.order_no)
}

#[tauri::command]
pub async fn order_set_price(app: AppHandle, input: PriceAdjustInput) -> Result<Option<WeighOrder>, String> {
    write_tx(&app, move |conn, actor| set_price(conn, actor, input), PRICE_OVERRIDE_ROLES, "定价").await
}

// --------------------------------------------------------------- 修改基本信息（车牌 / 备注）
// 制单只录了一次车牌/备注，现场常有"先把单取出来、车开上磅才想起没填车牌"或"备注要随过磅补充"。
// 这两个字段不碰钱、不碰状态机（不同于 grade——grade 一旦结算就是货款的一部分，故另设 VOIDABLE 闸），
// 因此过磅与结算期间都允许就地改；闸门只留会话岗位一道（与制单同一 FLOOR_ROLES：磅员/登记员/站长）。
// 与 set_grade 一样，值没变就直接回读、既不写库也不在审计表里留"改了个寂寞"的噪音。

#[derive(Debug, Deserialize)]
pub struct UpdateOrderInput {
    pub order_no: String,
    /// 车牌号，空串 / null ＝ 清除
    #[serde(default)]
    pub vehicle_no: Option<String>,
    /// 备注，空串 / null ＝ 清除
    #[serde(default)]
    pub remark: Option<String>,
    /// 操作人以会话为准，此字段只为与 mock 签名对齐而存在
    #[allow(dead_code)]
    #[serde(default)]
    pub operator_id: Option<i64>,
}

pub fn update_meta(conn: &Connection, actor: &AuthProfile, input: UpdateOrderInput) -> Result<Option<WeighOrder>, String> {
    let order: Option<WeighOrder> = conn
        .query_row(&format!("{ORDER_SELECT} WHERE o.order_no = ?1"), params![input.order_no], map_order_row)
        .optional()
        .map_err(|e| format!("读取磅单失败：{e}"))?;
    let Some(order) = order else { return Ok(None) };
    let vehicle_no = input
        .vehicle_no
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let remark = input
        .remark
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if order.vehicle_no == vehicle_no && order.remark == remark {
        return Ok(Some(order));
    }
    let dash = |s: Option<&String>| s.cloned().unwrap_or_else(|| "—".into());
    let mut changes: Vec<String> = Vec::new();
    if order.vehicle_no != vehicle_no {
        changes.push(format!("车牌 {} → {}", dash(order.vehicle_no.as_ref()), dash(vehicle_no.as_ref())));
    }
    if order.remark != remark {
        changes.push(format!("备注 {} → {}", dash(order.remark.as_ref()), dash(remark.as_ref())));
    }
    let now = now_iso();
    conn.execute(
        "UPDATE weigh_order SET vehicle_no = ?2, remark = ?3, updated_at = ?4, updated_by = ?5 WHERE id = ?1",
        params![order.id, vehicle_no, remark, now, actor.id],
    )
    .map_err(|e| format!("修改磅单信息失败：{e}"))?;
    audit(
        conn,
        actor,
        "order.update",
        "weigh_order",
        &order.order_no,
        Some(&changes.join("；")),
        None,
    );
    load_order_full(conn, &order.order_no)
}

#[tauri::command]
pub async fn order_update(app: AppHandle, input: UpdateOrderInput) -> Result<Option<WeighOrder>, String> {
    write_tx(&app, move |conn, actor| update_meta(conn, actor, input), FLOOR_ROLES, "修改磅单信息").await
}
