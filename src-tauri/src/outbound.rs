//! 粮食出库单（02 §M11、03 §9.27、§4.3 不变式 9）
//!
//! 与收购链（[`crate::orders`]）**平行且独立**的一条单据链：出库没有化验环节、
//! 没有一次/二次称重的强制顺序，最短路径就是「制单 → 完成出库」，所以另起一表、
//! 另起一条四态状态机（`draft → done`，加 `voided` / `reversed` 两个终态）。
//! 把磅单那 13 态套过来，等于把已经稳定的收粮主流程拖进回归面。
//!
//! 两档性质共用一张表：`sale` 销售出库（有领出方与单价、出仓即挂货款）、
//! `record` 登记出库（领用/自用/损耗，粮出仓但不产生钱）。差别只在要不要计价。
//!
//! ## 本期（波 1）的边界
//!
//!  - **只有手填净重**：接秤与毛/皮重复核是波 2（届时 `weight_source` 由捕获路径写
//!    `scale`，并复用 `weigh_record` 的出库侧）。`weight_source` 从建表第一天就落，
//!    因为「这个重量是人敲的还是秤取的」是迎检必查项，事后补等于编。
//!  - **不做收款**：销售出库出仓即置 `payment_status='unpaid'`，核销与收款登记是波 3。
//!    本期货款只算不收。
//!  - **不做转仓/损耗核算**：`stock_movement.kind` 那几个值保留，但不给录入口。
//!
//! ## 库存账这一腿
//!
//! 完成出库 = 单据状态推进 + `stock_movement` 一条 `out` 流水 + 超库存警示，**同一事务**。
//! 红冲 = 原单置 `reversed` + 补一条对称 `in` 流水（`reversal_of_id` 指回被冲那条），
//! 原流水永不删改。入库侧的对称逻辑在 [`crate::stock`]。
//!
//! ## 超库存不拦车
//!
//! 账面结存不够时**照常出库**，服务端把算给你看的那句话存进 `stock_warning`
//! （屏显醒目条 + 时间轴 + 票面留痕）。理由与皮重容差同一套：现场「账上没货但真出了」
//! 是常态（磅房先出、单据晚录、结存只认已结算量），硬拦只会把人逼去改数字凑闸门，
//! 那样得来的账比超库存危险得多。

use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::auth::AuthProfile;
use crate::orders::{audit, next_no, read_only, resolve_destination, write_tx, GRADES};
use crate::stock;

/// 出库作业岗：值仓是主经办，站长兜底，磅员/登记员现场代做。
/// 与 05 §6.1 前端 `can()` 同源，这里是最后一道。读不设岗。
const OUTBOUND_ROLES: &[&str] = &["station_master", "keeper", "registrar", "weigher"];
/// 作废与红冲要更重的岗：更正别人的账，不该由做这张单的人自己说了算。
const CLOSE_ROLES: &[&str] = &["station_master", "keeper"];

/// 红冲/作废原因最短字数，与磅单作废同源（迎检要看得懂为什么冲）。
const REASON_MIN: usize = 6;

fn now_iso() -> String {
    crate::db::migrate::now_iso()
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

/// 03 §3.1 规则 3 的唯一同构（与 `orders::amount_fen` 同一算法）：
/// 0.1kg × 分/吨 ÷ 10000 = 分，四舍五入只在最终金额处发生。
fn amount_fen(weight_01kg: i64, price_fen_per_ton: i64) -> i64 {
    let n = weight_01kg as i128 * price_fen_per_ton as i128;
    ((n + 5000) / 10000) as i64
}

// ----------------------------------------------------------------------- 输出结构
// 与 src/mock/types.ts 逐字对齐；沿用本仓既定 snake_case 直传约定。

#[derive(Debug, Clone, Serialize)]
pub struct OutboundOrder {
    pub id: i64,
    pub order_no: String,
    pub business_date: String,
    /// `sale` | `record`
    pub kind: String,
    /// `draft` | `done` | `voided` | `reversed`
    pub status: String,
    pub party_id: Option<i64>,
    pub party_name: Option<String>,
    /// 非档案领出方（部门/用途对象），自由文本，登记出库可只填这一栏
    pub counterparty_label: Option<String>,
    pub variety_id: Option<i64>,
    pub variety_name: Option<String>,
    pub grade: Option<String>,
    pub warehouse_id: i64,
    pub warehouse_name: String,
    pub slot_id: Option<i64>,
    pub slot_label: Option<String>,
    pub vehicle_no: Option<String>,
    pub net_weight_01kg: Option<i64>,
    /// `scale` | `manual`——本期恒 manual，接秤后由捕获路径改写
    pub weight_source: String,
    pub price_fen_per_ton: Option<i64>,
    pub goods_amount_fen: Option<i64>,
    pub payment_status: String,
    /// 超库存出库时服务端复算后自动写入的那句警示；NULL＝账面够用
    pub stock_warning: Option<String>,
    pub void_reason: Option<String>,
    pub remark: Option<String>,
    pub created_at: String,
    pub created_by: i64,
    pub created_name: String,
    pub completed_at: Option<String>,
    pub completed_by: Option<i64>,
    pub completed_name: Option<String>,
    /// 本单最后一次被改动的时间。作废没有专门的"作废时间"列（不为此加迁移），
    /// 但作废一定会写 `updated_at`，详情时间轴就取它——比不显示时间诚实，
    /// 也比拿 `created_at` 凑数诚实。
    pub updated_at: Option<String>,
}

/// 详情页带的东西：这张单在库存账上留下的流水（出库那条 + 红冲补的对称入库那条）。
#[derive(Debug, Clone, Serialize)]
pub struct OutboundDetail {
    #[serde(flatten)]
    pub order: OutboundOrder,
    pub movements: Vec<stock::MovementRow>,
}

const OUT_SELECT: &str = "SELECT o.id, o.order_no, o.business_date, o.kind, o.status,
       o.party_id, p.name, o.counterparty_label,
       o.variety_id, v.name, o.grade,
       o.warehouse_id, w.name, o.slot_id, COALESCE(s.label, s.code),
       o.vehicle_no, o.net_weight_01kg, o.weight_source,
       o.price_fen_per_ton, o.goods_amount_fen, o.payment_status,
       o.stock_warning, o.void_reason, o.remark,
       o.created_at, o.created_by, COALESCE(cu.display_name, '—'),
       o.completed_at, o.completed_by, COALESCE(bu.display_name, '—'), o.updated_at
  FROM outbound_order o
  LEFT JOIN party p ON p.id = o.party_id
  LEFT JOIN grain_variety v ON v.id = o.variety_id
  LEFT JOIN warehouse w ON w.id = o.warehouse_id
  LEFT JOIN storage_slot s ON s.id = o.slot_id
  LEFT JOIN user_account cu ON cu.id = o.created_by
  LEFT JOIN user_account bu ON bu.id = o.completed_by";

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<OutboundOrder> {
    Ok(OutboundOrder {
        id: r.get(0)?,
        order_no: r.get(1)?,
        business_date: r.get(2)?,
        kind: r.get(3)?,
        status: r.get(4)?,
        party_id: r.get(5)?,
        party_name: r.get(6)?,
        counterparty_label: r.get(7)?,
        variety_id: r.get(8)?,
        variety_name: r.get(9)?,
        grade: r.get(10)?,
        warehouse_id: r.get(11)?,
        warehouse_name: r.get(12)?,
        slot_id: r.get(13)?,
        slot_label: r.get(14)?,
        vehicle_no: r.get(15)?,
        net_weight_01kg: r.get(16)?,
        weight_source: r.get(17)?,
        price_fen_per_ton: r.get(18)?,
        goods_amount_fen: r.get(19)?,
        payment_status: r.get(20)?,
        stock_warning: r.get(21)?,
        void_reason: r.get(22)?,
        remark: r.get(23)?,
        created_at: r.get(24)?,
        created_by: r.get(25)?,
        created_name: r.get(26)?,
        completed_at: r.get(27)?,
        completed_by: r.get(28)?,
        completed_name: r.get(29)?,
        updated_at: r.get(30)?,
    })
}

fn load_order(conn: &Connection, order_no: &str) -> Result<Option<OutboundOrder>, String> {
    conn.query_row(&format!("{OUT_SELECT} WHERE o.order_no = ?1"), params![order_no], map_row)
        .optional()
        .map_err(|e| format!("读取出库单失败：{e}"))
}

// ---------------------------------------------------------------------- 入参与校验

#[derive(Debug, Deserialize)]
pub struct OutboundSaveInput {
    /// 空＝新建；带单号＝改草稿
    #[serde(default)]
    pub order_no: Option<String>,
    /// `sale` | `record`
    pub kind: String,
    #[serde(default)]
    pub business_date: Option<String>,
    #[serde(default)]
    pub party_id: Option<i64>,
    #[serde(default)]
    pub counterparty_label: Option<String>,
    #[serde(default)]
    pub variety_id: Option<i64>,
    #[serde(default)]
    pub grade: Option<String>,
    pub warehouse_id: i64,
    #[serde(default)]
    pub slot_id: Option<i64>,
    #[serde(default)]
    pub vehicle_no: Option<String>,
    #[serde(default)]
    pub net_weight_01kg: Option<i64>,
    #[serde(default)]
    pub price_fen_per_ton: Option<i64>,
    #[serde(default)]
    pub remark: Option<String>,
    /// 操作人以会话为准，此字段只为与 mock 签名对齐而存在
    #[serde(default)]
    #[allow(dead_code)]
    pub operator_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct OutboundCloseInput {
    pub order_no: String,
    /// 作废/红冲原因，≥ [`REASON_MIN`] 字
    pub reason: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub operator_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct OutboundCompleteInput {
    pub order_no: String,
    #[serde(default)]
    #[allow(dead_code)]
    pub operator_id: Option<i64>,
}

fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// 制单/改单共同的校验与归一。回 (仓房, 货位, 等级, 货款)。
///
/// 这里刻意**不**判「库存够不够」：草稿阶段数量还可能改，而且每改一次就查一次结存，
/// 会把「账面暂时不够」变成开不出单。超库存只在完成出库那一刻判一次、警示一次。
fn validate_save(conn: &Connection, i: &OutboundSaveInput) -> Result<(i64, Option<i64>, Option<String>, Option<i64>), String> {
    if !["sale", "record"].contains(&i.kind.as_str()) {
        return Err(format!(
            "出库性质「{}」不在值域内（sale 销售出库 / record 登记出库）",
            i.kind
        ));
    }
    let dest = resolve_destination(conn, Some(i.warehouse_id), i.slot_id)?;
    let warehouse_id = dest
        .warehouse_id
        .ok_or_else(|| "必须指定出仓仓房：粮从哪个仓出去，账就要从哪个仓扣".to_string())?;

    match i.variety_id {
        None => {
            return Err("必须指定品种：库存按 仓房 × 品种 记账，品种空的出库单结存对不上".into());
        }
        Some(vid) => {
            let ok: Option<String> = conn
                .query_row(
                    "SELECT name FROM grain_variety WHERE id = ?1 AND deleted_at IS NULL AND is_active = 1",
                    params![vid],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| format!("检查品种失败：{e}"))?;
            if ok.is_none() {
                return Err("所选品种不存在或已停用，请改选在用品种".into());
            }
        }
    }
    let grade = clean(&i.grade);
    if let Some(g) = grade.as_deref() {
        if !GRADES.contains(&g) {
            return Err(format!("等级「{g}」不在值域内（{}）", GRADES.join(" / ")));
        }
    }

    match i.kind.as_str() {
        "sale" => {
            let pid = i
                .party_id
                .ok_or_else(|| "销售出库必须选领出方档案：货款要挂在谁头上".to_string())?;
            let party: Option<(String, String)> = conn
                .query_row(
                    "SELECT name, status FROM party WHERE id = ?1 AND deleted_at IS NULL",
                    params![pid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| format!("检查领出方失败：{e}"))?;
            let (name, status) = party.ok_or_else(|| "领出方档案不存在，请先在往来单位建档".to_string())?;
            if status != "active" {
                return Err(format!("领出方「{name}」档案已停用，不能开新出库单；确需出货请先启用该档案"));
            }
        }
        // 登记出库不计价。宁可当场拒绝，也不悄悄把用户填的单价丢掉——
        // 「我明明填了 2600 怎么没了」是查都查不出来的那种坑。
        _ => {
            if i.price_fen_per_ton.is_some() {
                return Err("登记出库不计价，单价请留空；要收钱请把性质改成销售出库".into());
            }
            if let Some(pid) = i.party_id {
                let known: Option<i64> = conn
                    .query_row(
                        "SELECT id FROM party WHERE id = ?1 AND deleted_at IS NULL",
                        params![pid],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| format!("检查领出方失败：{e}"))?;
                if known.is_none() {
                    return Err("领出方档案不存在；不记账的出库可以直接填「领用方」那一栏".into());
                }
            }
        }
    }

    if let Some(w) = i.net_weight_01kg {
        if w <= 0 {
            return Err("出库净重必须大于 0；这一车什么都没出就直接作废本单".into());
        }
    }
    if let Some(pp) = i.price_fen_per_ton {
        if pp <= 0 {
            return Err("单价必须大于 0；不收钱的出库请把性质改成登记出库并清空单价".into());
        }
    }

    let goods = match (i.net_weight_01kg, i.price_fen_per_ton) {
        (Some(w), Some(pp)) if i.kind == "sale" => Some(amount_fen(w, pp)),
        _ => None,
    };
    Ok((warehouse_id, dest.slot_id, grade, goods))
}

// ------------------------------------------------------------------------- 写：制单/改单

/// 新建（无 `order_no`）或修改（带 `order_no`）一张草稿出库单。
///
/// 只有草稿能改：完成后单据就是库存账的凭据，要改只能走红冲再来一张。
/// 取号 CK 与插入同事务（§3.5），断电不重号；作废号占位不复用。
pub fn save(conn: &Connection, actor: &AuthProfile, input: OutboundSaveInput) -> Result<OutboundOrder, String> {
    let (warehouse_id, slot_id, grade, goods) = validate_save(conn, &input)?;
    let business_date = clean(&input.business_date).unwrap_or_else(today);
    // 结算/交班都按业务日归集，跨日补录不能把单据塞进未来
    if business_date > today() {
        return Err(format!("业务日期 {} 晚于今天，不能往未来记账", business_date));
    }
    let now = now_iso();

    match input.order_no.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => {
            let order_no = next_no(conn, "CK")?;
            conn.execute(
                "INSERT INTO outbound_order (order_no, station_id, business_date, kind, status,
                        party_id, counterparty_label, variety_id, grade, warehouse_id, slot_id,
                        vehicle_no, net_weight_01kg, weight_source, price_fen_per_ton, goods_amount_fen,
                        payment_status, remark, created_at, created_by)
                 VALUES (?1, (SELECT id FROM station WHERE is_active = 1 ORDER BY id LIMIT 1),
                        ?2, ?3, 'draft', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'manual', ?12, ?13,
                        ?14, ?15, ?16, ?17)",
                params![
                    order_no, business_date, input.kind,
                    input.party_id, clean(&input.counterparty_label), input.variety_id, grade,
                    warehouse_id, slot_id, clean(&input.vehicle_no), input.net_weight_01kg,
                    input.price_fen_per_ton, goods,
                    // 草稿期一律 not_required：销售出库「成为一笔应收」这个动作发生在
                    // 完成出库那一刻（见 [`complete`]）。提前落 unpaid，会让一张还没出仓的
                    // 草稿凭空出现在挂账口径里。
                    "not_required",
                    clean(&input.remark), now, actor.id,
                ],
            )
            .map_err(|e| format!("建出库单失败：{e}"))?;
            audit(conn, actor, "outbound.create", "outbound_order", &order_no, None, None);
            load_order(conn, &order_no)?.ok_or_else(|| "建单后读回出库单失败".to_string())
        }
        Some(order_no) => {
            let cur = load_order(conn, &order_no)?.ok_or_else(|| "出库单不存在，可能已被删除".to_string())?;
            if cur.status != "draft" {
                return Err(format!(
                    "本单已「{}」，不能再改；要更正请走红冲后另开一张",
                    status_label(&cur.status)
                ));
            }
            conn.execute(
                "UPDATE outbound_order SET business_date = ?2, kind = ?3, party_id = ?4,
                        counterparty_label = ?5, variety_id = ?6, grade = ?7, warehouse_id = ?8,
                        slot_id = ?9, vehicle_no = ?10, net_weight_01kg = ?11,
                        price_fen_per_ton = ?12, goods_amount_fen = ?13, remark = ?14,
                        updated_at = ?15, updated_by = ?16
                  WHERE order_no = ?1",
                params![
                    order_no, business_date, input.kind, input.party_id,
                    clean(&input.counterparty_label), input.variety_id, grade, warehouse_id, slot_id,
                    clean(&input.vehicle_no), input.net_weight_01kg,
                    input.price_fen_per_ton, goods, clean(&input.remark), now, actor.id,
                ],
            )
            .map_err(|e| format!("修改出库单失败：{e}"))?;
            audit(
                conn,
                actor,
                "outbound.update",
                "outbound_order",
                &order_no,
                Some(&format!("改前 {} {}kg", cur.warehouse_name, cur.net_weight_01kg.unwrap_or(0))),
                None,
            );
            load_order(conn, &order_no)?.ok_or_else(|| "改单后读回出库单失败".to_string())
        }
    }
}

fn status_label(s: &str) -> &str {
    match s {
        "draft" => "草稿",
        "done" => "已出库",
        "voided" => "已作废",
        "reversed" => "已红冲",
        other => other,
    }
}

// --------------------------------------------------------------------- 写：完成出库

/// 完成出库：算货款 → 判超库存（只警示不拦） → 写 `out` 流水 → 单据转 `done`。
/// 全部一个事务：不能出现「单出了、库存没扣」或「库存扣了、单还没完成」。
pub fn complete(conn: &Connection, actor: &AuthProfile, input: OutboundCompleteInput) -> Result<OutboundOrder, String> {
    let cur = load_order(conn, &input.order_no)?.ok_or_else(|| "出库单不存在，可能已被删除".to_string())?;
    match cur.status.as_str() {
        "draft" => {}
        "done" => return Err("本单已完成出库，库存已扣，无需重复操作".into()),
        other => return Err(format!("本单当前为「{}」，不能完成出库", status_label(other))),
    }
    let weight = cur
        .net_weight_01kg
        .filter(|w| *w > 0)
        .ok_or_else(|| "先把出库净重填上再完成出库：库存要扣多少，全看这一格".to_string())?;
    let variety_id = cur
        .variety_id
        .ok_or_else(|| "本单还没有品种，无法按 仓房 × 品种 扣库存".to_string())?;
    if cur.kind == "sale" {
        if cur.party_id.is_none() {
            return Err("销售出库必须选定出方，请先修改本单".into());
        }
        if cur.price_fen_per_ton.unwrap_or(0) <= 0 {
            return Err("销售出库必须有单价，否则货款算不出来，请先修改本单".into());
        }
    }

    let goods = if cur.kind == "sale" {
        Some(amount_fen(weight, cur.price_fen_per_ton.unwrap_or(0)))
    } else {
        None
    };

    // 超库存：算给你看，但不拦你。结存口径是「已结算入库 − 已出库」，
    // 未结算的在途入库不算数（见 `stock::IN_QUALIFIED`），所以这里偏保守是设计意图。
    let avail = stock::available_01kg(conn, cur.warehouse_id, Some(variety_id))?;
    let warning = if avail < weight {
        Some(format!(
            "{} 账面结存 {:.2} 吨，本次出库 {:.2} 吨，超出 {:.2} 吨（未结算的入仓量不计入账面，出库照常放行）",
            cur.warehouse_name,
            avail as f64 / 10000.0,
            weight as f64 / 10000.0,
            (weight - avail) as f64 / 10000.0
        ))
    } else {
        None
    };

    let now = now_iso();
    conn.execute(
        "UPDATE outbound_order SET status = 'done', goods_amount_fen = ?2,
                payment_status = ?3, stock_warning = ?4,
                completed_at = ?5, completed_by = ?6, updated_at = ?5, updated_by = ?6
          WHERE order_no = ?1",
        params![
            cur.order_no, goods,
            // 销售出库到这一刻才成为一笔应收；登记出库永不进入资金流程
            if cur.kind == "sale" { "unpaid" } else { "not_required" },
            warning, now, actor.id,
        ],
    )
    .map_err(|e| format!("完成出库失败：{e}"))?;

    let amount = goods.unwrap_or(0);
    conn.execute(
        "INSERT INTO stock_movement (kind, outbound_id, party_id, variety_id, grade,
                from_warehouse_id, from_slot_id, weight_01kg, price_fen_per_ton, amount_fen,
                business_date, operated_at, operator_id, remark)
         VALUES ('out', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            cur.id, cur.party_id, Some(variety_id), cur.grade,
            cur.warehouse_id, cur.slot_id, weight, cur.price_fen_per_ton,
            if cur.kind == "sale" { Some(amount) } else { None },
            cur.business_date, now, actor.id,
            format!("出库单 {} 完成出库", cur.order_no),
        ],
    )
    .map_err(|e| format!("写出库流水失败：{e}"))?;

    let mut detail = format!(
        "{} {} {}{:.2} 吨",
        if cur.kind == "sale" { "销售出库" } else { "登记出库" },
        cur.warehouse_name,
        cur.variety_name.as_deref().unwrap_or("未定品种"),
        weight as f64 / 10000.0
    );
    if let Some(g) = goods {
        detail.push_str(&format!("，货款 {:.2} 元", g as f64 / 100.0));
    }
    if let Some(w) = &warning {
        detail.push_str(&format!("；超库存警示：{w}"));
    }
    audit(conn, actor, "outbound.complete", "outbound_order", &cur.order_no, Some(&detail), None);
    load_order(conn, &cur.order_no)?.ok_or_else(|| "完成出库后读回失败".to_string())
}

// ----------------------------------------------------------------------- 写：作废

/// 作废只发生在过账前（草稿）——那时库存一行未动，作废干净，不需要冲销流水。
/// 已完成的单走 [`reverse`]，因为它的账已经落在库存里了。
pub fn void(conn: &Connection, actor: &AuthProfile, input: OutboundCloseInput) -> Result<Option<OutboundOrder>, String> {
    let reason = input.reason.trim().to_string();
    if reason.chars().count() < REASON_MIN {
        return Err(format!("作废原因不得少于 {REASON_MIN} 个字（迎检要看得懂为什么废）"));
    }
    let cur = match load_order(conn, &input.order_no)? {
        Some(o) => o,
        None => return Ok(None),
    };
    if cur.status != "draft" {
        return Err(if cur.status == "voided" {
            "本单已作废，无需重复操作".into()
        } else {
            format!("本单已「{}」，库存已扣，只能由站长或保管员走红冲更正", status_label(&cur.status))
        });
    }
    let now = now_iso();
    conn.execute(
        "UPDATE outbound_order SET status = 'voided', void_reason = ?2, updated_at = ?3, updated_by = ?4 WHERE order_no = ?1",
        params![cur.order_no, reason, now, actor.id],
    )
    .map_err(|e| format!("作废失败：{e}"))?;
    audit(conn, actor, "outbound.void", "outbound_order", &cur.order_no, Some(&reason), None);
    load_order(conn, &cur.order_no)
}

// ----------------------------------------------------------------------- 写：红冲

/// 红冲已完成的出库单：原单置 `reversed`，**补一条对称入库流水**把货还回原来那个仓。
///
/// 原来的 `out` 行永不删改（库存流水是账本，账本不能涂改），靠 `reversal_of_id`
/// 与被冲那条互相指认。这与磅单红冲「原单不动、另立负向单」同一条原则，
/// 只是这里不另立单据——一张出库单的更正不需要两张纸，补对称流水就够还原库存。
pub fn reverse(conn: &Connection, actor: &AuthProfile, input: OutboundCloseInput) -> Result<Option<OutboundOrder>, String> {
    let reason = input.reason.trim().to_string();
    if reason.chars().count() < REASON_MIN {
        return Err(format!("红冲原因不得少于 {REASON_MIN} 个字（这张单为什么不算了，审计要看得懂）"));
    }
    let cur = match load_order(conn, &input.order_no)? {
        Some(o) => o,
        None => return Ok(None),
    };
    if cur.status == "reversed" {
        return Err("本单已红冲，不能再次红冲".into());
    }
    if cur.status != "done" {
        return Err(format!("本单当前为「{}」，未过账的单直接作废即可，无需红冲", status_label(&cur.status)));
    }
    // 被冲的那条出库流水必须存在——它是红冲的唯一依据；没有它说明账本身是坏的，
    // 宁可报错让人来查，也不能凭空造一条入库把结存抬高。
    let out_id: i64 = conn
        .query_row(
            "SELECT id FROM stock_movement WHERE kind = 'out' AND outbound_id = ?1",
            params![cur.id],
            |r| r.get(0),
        )
        .map_err(|_| "本单在库存账里没有出库流水，不能红冲；请先让站长核查数据".to_string())?;

    let now = now_iso();
    conn.execute(
        "UPDATE outbound_order SET status = 'reversed', void_reason = ?2, updated_at = ?3, updated_by = ?4 WHERE order_no = ?1",
        params![cur.order_no, reason, now, actor.id],
    )
    .map_err(|e| format!("红冲失败：{e}"))?;
    conn.execute(
        "INSERT INTO stock_movement (kind, outbound_id, reversal_of_id, party_id, variety_id, grade,
                to_warehouse_id, to_slot_id, weight_01kg, price_fen_per_ton, amount_fen,
                business_date, operated_at, operator_id, remark)
         SELECT 'in', ?1, m.id, m.party_id, m.variety_id, m.grade,
                m.from_warehouse_id, m.from_slot_id, m.weight_01kg, m.price_fen_per_ton, m.amount_fen,
                ?2, ?3, ?4, ?5
           FROM stock_movement m WHERE m.id = ?6",
        params![cur.id, today(), now, actor.id, format!("红冲出库单 {}：{reason}", cur.order_no), out_id],
    )
    .map_err(|e| format!("写红冲流水失败：{e}"))?;

    audit(
        conn,
        actor,
        "outbound.reverse",
        "outbound_order",
        &cur.order_no,
        Some(&format!(
            "红冲 {} {}{:.2} 吨：{reason}",
            cur.warehouse_name,
            cur.variety_name.as_deref().unwrap_or("未定品种"),
            cur.net_weight_01kg.unwrap_or(0) as f64 / 10000.0
        )),
        None,
    );
    load_order(conn, &cur.order_no)
}

// ------------------------------------------------------------------------- 读：列表/详情

#[derive(Debug, Default, Deserialize)]
pub struct OutboundFilters {
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub variety_id: Option<i64>,
    #[serde(default)]
    pub keyword: Option<String>,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub page_size: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutboundSummary {
    pub count: i64,
    pub net_01kg: i64,
    pub goods_fen: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutboundPage {
    pub rows: Vec<OutboundOrder>,
    pub total: i64,
    /// 合计与行同一条 WHERE：分屏对不上数是最难发现的那种错
    pub summary: OutboundSummary,
}

pub fn list(conn: &Connection, f: &OutboundFilters) -> Result<OutboundPage, String> {
    let page = f.page.unwrap_or(1).max(1);
    let size = f.page_size.unwrap_or(50).clamp(1, 2000);
    let kw = f.keyword.as_deref().unwrap_or("").trim().to_lowercase();

    let mut where_sql = String::from(" WHERE 1 = 1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut n = 0usize;
    macro_rules! push {
        ($frag:expr, $val:expr) => {{
            n += 1;
            where_sql.push_str(&$frag.replace('#', &n.to_string()));
            args.push(Box::new($val));
        }};
    }
    if let Some(d) = f.date_from.clone().filter(|s| !s.is_empty()) {
        push!(" AND o.business_date >= ?#", d);
    }
    if let Some(d) = f.date_to.clone().filter(|s| !s.is_empty()) {
        push!(" AND o.business_date <= ?#", d);
    }
    if let Some(s) = f.status.clone().filter(|s| s != "all" && !s.is_empty()) {
        push!(" AND o.status = ?#", s);
    }
    if let Some(s) = f.kind.clone().filter(|s| s != "all" && !s.is_empty()) {
        push!(" AND o.kind = ?#", s);
    }
    if let Some(w) = f.warehouse_id {
        push!(" AND o.warehouse_id = ?#", w);
    }
    if let Some(v) = f.variety_id {
        push!(" AND o.variety_id = ?#", v);
    }
    if !kw.is_empty() {
        n += 1;
        let p = format!("%{kw}%");
        where_sql.push_str(&format!(
            " AND (lower(o.order_no) LIKE ?{n} OR lower(COALESCE(p.name, '')) LIKE ?{n} \
               OR lower(COALESCE(o.counterparty_label, '')) LIKE ?{n} OR lower(COALESCE(o.vehicle_no, '')) LIKE ?{n})"
        ));
        args.push(Box::new(p));
    }

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(1) FROM outbound_order o LEFT JOIN party p ON p.id = o.party_id{where_sql}"),
            rusqlite::params_from_iter(args.iter()),
            |r| r.get(0),
        )
        .map_err(|e| format!("统计出库单失败：{e}"))?;
    let summary: OutboundSummary = conn
        .query_row(
            &format!(
                "SELECT COUNT(1), COALESCE(SUM(o.net_weight_01kg), 0), COALESCE(SUM(o.goods_amount_fen), 0)
                   FROM outbound_order o LEFT JOIN party p ON p.id = o.party_id{where_sql}"
            ),
            rusqlite::params_from_iter(args.iter()),
            |r| {
                Ok(OutboundSummary {
                    count: r.get(0)?,
                    net_01kg: r.get(1)?,
                    goods_fen: r.get(2)?,
                })
            },
        )
        .map_err(|e| format!("汇总出库单失败：{e}"))?;

    n += 1;
    let l1 = n.to_string();
    n += 1;
    let l2 = n.to_string();
    args.push(Box::new(size));
    args.push(Box::new((page - 1) * size));
    let sql = format!("{OUT_SELECT}{where_sql} ORDER BY o.business_date DESC, o.id DESC LIMIT ?{l1} OFFSET ?{l2}");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取出库单失败：{e}"))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), map_row)
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取出库单失败：{e}"))?;
    Ok(OutboundPage { rows, total, summary })
}

pub fn detail(conn: &Connection, order_no: &str) -> Result<Option<OutboundDetail>, String> {
    let Some(order) = load_order(conn, order_no)? else { return Ok(None) };
    let sql = format!("{} WHERE m.outbound_id = ?1 ORDER BY m.operated_at, m.id", stock::MOVE_SELECT);
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("读取出库流水失败：{e}"))?;
    let movements = stmt
        .query_map(params![order.id], stock::map_move_row)
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取出库流水失败：{e}"))?;
    Ok(Some(OutboundDetail { order, movements }))
}

// ==================================================================== Tauri 命令

#[tauri::command]
pub async fn outbound_list(app: AppHandle, input: OutboundFilters) -> Result<OutboundPage, String> {
    read_only(&app, move |conn| list(conn, &input), "出库单读取").await
}

#[tauri::command]
pub async fn outbound_get(app: AppHandle, no: String) -> Result<Option<OutboundDetail>, String> {
    read_only(&app, move |conn| detail(conn, &no), "出库单读取").await
}

#[tauri::command]
pub async fn outbound_save(app: AppHandle, input: OutboundSaveInput) -> Result<OutboundOrder, String> {
    let what = if input.order_no.as_deref().is_some_and(|s| !s.trim().is_empty()) {
        "修改出库单"
    } else {
        "开出库单"
    };
    write_tx(&app, move |conn, actor| save(conn, actor, input), OUTBOUND_ROLES, what).await
}

#[tauri::command]
pub async fn outbound_complete(app: AppHandle, input: OutboundCompleteInput) -> Result<OutboundOrder, String> {
    write_tx(&app, move |conn, actor| complete(conn, actor, input), OUTBOUND_ROLES, "完成出库").await
}

#[tauri::command]
pub async fn outbound_void(app: AppHandle, input: OutboundCloseInput) -> Result<Option<OutboundOrder>, String> {
    write_tx(&app, move |conn, actor| void(conn, actor, input), CLOSE_ROLES, "作废出库单").await
}

#[tauri::command]
pub async fn outbound_reverse(app: AppHandle, input: OutboundCloseInput) -> Result<Option<OutboundOrder>, String> {
    write_tx(&app, move |conn, actor| reverse(conn, actor, input), CLOSE_ROLES, "红冲出库单").await
}
