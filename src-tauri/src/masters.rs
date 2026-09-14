//! 基础档案读写（02 §7 M6；03 §9.2 station / §9.3 app_setting / §9.4 user_account /
//! §9.8 grain_variety / §9.9 warehouse+storage_slot / §9.10 price_list）
//!
//! 参数那一块有个特别处：库里只有「键 / 值 JSON / 值类型 / 说明」，界面上的中文名、
//! 分组、控件类型一律在前端 `src/lib/settings-catalog.ts`；只有 `station_name` 反过来
//! 例外——它读自 §9.2 的 `station` 行，不占 `app_setting` 一个键，免得同一个站名存两份。
//!
//! 这是「从 mock 换成真库」的第一块业务读写，顺手把后面各模块要沿用的规矩立在这里：
//!  1. **DTO 字段名与 `src/mock/types.ts` 逐字一致（保持 snake_case，不改 camelCase）**。
//!     页面里 `v.std_moisture_001pct` 这类取数已经写死，换后端时改字段名等于改页面，
//!     而 05 §8 的验收口径是"页面零改动"。[`crate::auth`] 用 camelCase 是因为那份类型
//!     本来就是随登录功能新写的，两边各自对齐自己的前端类型，不冲突。
//!  2. **库里可空、界面只认字符串的列在 SQL 里 `COALESCE` 掉**（站名、电话、货位标签）。
//!     品种的国家基准**反过来保留 NULL**：写 0 会被读成"国标规定水分是 0.00%"，
//!     而 `percent()` 遇到 null 本来就渲染成"—"，不如让它空着等站长来填。
//!  3. **业务校验回中文短句**，不往外抛 SQLite 原文。档案页点保存的是站长，
//!     `UNIQUE constraint failed: grain_variety.code` 对他没有任何意义。
//!  4. **写入一律留审计**；审计写失败不挡保存（与 [`crate::auth`] 同一取舍）。
//!  5. **权限在命令层判**，不靠前端 disabled。`can()` 只管界面显隐（05 §5），
//!     这里再判一次站长岗，前端被改也越不过去；`operator_id` 由会话给出，入参里的那个忽略。

use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::auth::{self, AuthProfile};
use crate::codes::{next_code, stored_code};
use crate::db::{locked, Db};
use crate::domain::enums::{Role, WarehouseKind};

type Pool = Arc<Mutex<Connection>>;

/// 写档案要求的岗位。与 05 §6.1 给前端的 `setting.write` / `price.edit` 同源，
/// 只是这边是最后一道闸。
const WRITE_ROLE: Role = Role::StationMaster;

fn pool_of(app: &AppHandle) -> Result<Pool, String> {
    app.try_state::<Db>()
        .map(|d| d.shared())
        .ok_or_else(|| "数据库尚未就绪（启动迁移未完成）".to_string())
}

/// 命令层的写入闸门：必须在线、且必须是站长。
fn operator(app: &AppHandle) -> Result<AuthProfile, String> {
    let actor = auth::current_actor(app)
        .ok_or_else(|| "登录已失效，请重新登录后再保存档案".to_string())?;
    if actor.role != WRITE_ROLE.to_string() {
        return Err(format!(
            "「{}」的岗位无权修改基础档案，需要站长",
            actor.username
        ));
    }
    Ok(actor)
}

fn now_iso() -> String {
    crate::db::migrate::now_iso()
}

/// `client_info` 与 [`crate::auth`] 同口径：现场排障要区分的是"哪台磅房机改的"，
/// 时间已经在 `at` 列里了，这里再拼一遍毫无意义。
fn client_info() -> String {
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "未知机器".into());
    format!("{host} / banghe {}", env!("CARGO_PKG_VERSION"))
}

/// `audit_log`（§9.21）只插入。`entity` 填表名，`entity_no` 填业务码，
/// 与 mock 层 `auditMaster` 的动作名逐字一致，审计页换真库时不用改筛选条件。
fn audit(
    conn: &Connection,
    actor: &AuthProfile,
    action: &str,
    entity: &str,
    entity_no: &str,
    reason: Option<&str>,
) {
    let result = conn.execute(
        "INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_no, reason, result, client_info)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ok', ?8)",
        params![
            now_iso(),
            actor.id,
            actor.display_name,
            action,
            entity,
            entity_no,
            reason,
            client_info(),
        ],
    );
    if let Err(e) = result {
        eprintln!("[banghe] 档案审计写入失败（{action} {entity} {entity_no}）：{e}");
    }
}

fn is_unique_conflict(e: &rusqlite::Error) -> bool {
    e.to_string().contains("UNIQUE") || e.to_string().contains("constraint failed")
}

// --------------------------------------------------------------------- 读出结构

/// §9.8 品种
#[derive(Debug, Clone, Serialize)]
pub struct Variety {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub category: String,
    pub std_moisture_001pct: Option<i64>,
    pub std_impurity_001pct: Option<i64>,
    pub std_unsound_001pct: Option<i64>,
    pub std_bulk_density: Option<i64>,
    pub reject_moisture_001pct: Option<i64>,
    pub enabled_indicators: Vec<String>,
    pub default_package_deduct_01kg: i64,
    pub sort_order: i64,
    pub is_active: i64,
}

/// §9.9 货位。库里没有 `deleted_at`，停用即 `is_active = 0`
#[derive(Debug, Clone, Serialize)]
pub struct Slot {
    pub id: i64,
    pub warehouse_id: i64,
    pub code: String,
    pub label: String,
    pub is_active: i64,
}

/// §9.9 仓房（带下属货位，档案页一屏看完，不再发第二次请求）
#[derive(Debug, Clone, Serialize)]
pub struct Warehouse {
    pub id: i64,
    pub code: String,
    pub name: String,
    /// 类型与容量保留 NULL：后端替它编 `house` / `0` 会让档案页把"没填"演成"填了"
    pub kind: Option<String>,
    pub capacity_ton: Option<i64>,
    // -------------------------------------------------- 库存那一格（§9.23 / 0022 派生）
    // 全部读自 `stock::warehouse_totals`，判据不在这里重写一遍：结存与出库可用量共用同一份，
    // 两处各算一次就是「档案页说还有 300 吨、出库说无货」这种最难归因的错账。
    /// 期初建账量（0.1kg）。NULL＝从没申报过；`Some(0)` 是一句明确的「空仓起账」
    pub opening_01kg: Option<i64>,
    /// 期初登记到哪个品种（`grain_variety.id`）。NULL＝期初没细分品种：仓房总量照计，
    /// 但按品种的出库账面看不见它（界面上要显出来，别让站长以为已经细分过）
    pub opening_variety_id: Option<i64>,
    /// 账面结存（0.1kg）＝ Σ入 − Σ出，含期初
    pub balance_01kg: i64,
    /// 已上磅但还没结算入账的部分：不计入 `balance_01kg`，但真实占容积
    pub pending_in_01kg: i64,
    /// 剩余容量（0.1kg）＝ 核定容量 − 结存 − 待入账。核定容量没填则为 NULL（不替它猜）。
    /// **负数不是错误**：那是一句「这间仓已经超容」的提示，本系统一律不因此拦单
    pub remain_01kg: Option<i64>,
    pub is_active: i64,
    pub slots: Vec<Slot>,
}

/// §9.10 价目。`made_by` 为 NULL 只可能是直接翻库留下的脏行，界面显示"—"
#[derive(Debug, Clone, Serialize)]
pub struct Price {
    pub id: i64,
    pub variety_id: i64,
    pub grade: String,
    pub price_fen_per_ton: i64,
    pub effective_from: String,
    pub effective_to: String,
    pub basis: String,
    pub made_by: Option<i64>,
    pub approved_by: Option<i64>,
    pub remark: Option<String>,
}

/// §9.4 员工。**不含 `password_hash` / `failed_count` / `locked_until`**——
/// 同 [`crate::auth::AuthProfile`] 的理由：能出 WebView 的字段就是可以被改的字段。
#[derive(Debug, Clone, Serialize)]
pub struct Staff {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: String,
    pub phone: String,
    pub is_active: i64,
    pub last_login_at: Option<String>,
}

/// §9.2 站点（v1 仅一条）
#[derive(Debug, Clone, Serialize)]
pub struct Station {
    pub id: i64,
    pub code: String,
    pub name: String,
    pub address: String,
    pub phone: String,
}

// ----------------------------------------------------------------------- 入参

/// `is_active` 缺省按"启用"处理：新增表单没有这个开关时不该静默建出一条停用的档案
fn enabled() -> i64 {
    1
}

#[derive(Debug, Deserialize)]
pub struct VarietyInput {
    pub id: Option<i64>,
    pub code: String,
    pub name: String,
    #[serde(default)]
    pub category: String,
    pub std_moisture_001pct: Option<i64>,
    pub std_impurity_001pct: Option<i64>,
    pub std_unsound_001pct: Option<i64>,
    pub std_bulk_density: Option<i64>,
    pub reject_moisture_001pct: Option<i64>,
    #[serde(default)]
    pub enabled_indicators: Vec<String>,
    #[serde(default)]
    pub default_package_deduct_01kg: i64,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "enabled")]
    pub is_active: i64,
}

#[derive(Debug, Deserialize)]
pub struct DeleteVarietyInput {
    pub id: i64,
    /// 前端透传，后端以会话为准忽略
    #[serde(default)]
    pub operator_id: i64,
}

/// 删除仓房入参。与 [`DeleteVarietyInput`] 同形：`operator_id` 前端透传、后端以会话为准忽略。
#[derive(Debug, Deserialize)]
pub struct DeleteWarehouseInput {
    pub id: i64,
    #[serde(default)]
    pub operator_id: i64,
}

/// 删除货位入参，同上。
#[derive(Debug, Deserialize)]
pub struct DeleteSlotInput {
    pub id: i64,
    #[serde(default)]
    pub operator_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct WarehouseInput {
    pub id: Option<i64>,
    pub code: String,
    pub name: String,
    pub kind: String,
    /// 空着就是没核定，落 NULL；`0` 吨是一条明确的"不允许存粮"
    #[serde(default)]
    pub capacity_ton: Option<i64>,
    /// 期初建账（0.1kg；界面按吨录入，换算只在边界发生一次）。**不落 warehouse 表的列**，
    /// 而是落成 §9.23 那笔 `is_opening = 1` 的入库流水（0022）——库存账只有一个账本。
    /// NULL＝从没申报过（不建流水行）；`Some(0)` 是一句明确的「空仓起账」。
    #[serde(default)]
    pub opening_01kg: Option<i64>,
    /// 期初登记到哪个品种（可空＝不细分：仓房总量照计，按品种的出库账面看不见它）
    #[serde(default)]
    pub opening_variety_id: Option<i64>,
    #[serde(default = "enabled")]
    pub is_active: i64,
}

#[derive(Debug, Deserialize)]
pub struct SlotInput {
    pub id: Option<i64>,
    pub warehouse_id: i64,
    pub code: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "enabled")]
    pub is_active: i64,
}

#[derive(Debug, Deserialize)]
pub struct PriceInput {
    pub id: Option<i64>,
    pub variety_id: i64,
    pub grade: String,
    pub price_fen_per_ton: i64,
    pub effective_from: String,
    pub effective_to: String,
    #[serde(default)]
    pub basis: String,
    pub remark: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct StaffInput {
    pub id: Option<i64>,
    pub username: String,
    pub display_name: String,
    pub role: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default = "enabled")]
    pub is_active: i64,
}

// ------------------------------------------------------------------ 纯库操作
// 全部收 `&Connection`，命令层只负责取锁与会话，测试因此可以不连 Tauri 直接跑。

const VARIETY_COLS: &str = "id, code, name, COALESCE(category, ''),
        std_moisture_001pct, std_impurity_001pct, std_unsound_001pct,
        std_bulk_density, reject_moisture_001pct, enabled_indicators_json,
        default_package_deduct_01kg, sort_order, is_active";

fn map_variety(r: &rusqlite::Row<'_>) -> rusqlite::Result<Variety> {
    let indicators: String = r.get(9)?;
    Ok(Variety {
        id: r.get(0)?,
        code: r.get(1)?,
        name: r.get(2)?,
        category: r.get(3)?,
        std_moisture_001pct: r.get(4)?,
        std_impurity_001pct: r.get(5)?,
        std_unsound_001pct: r.get(6)?,
        std_bulk_density: r.get(7)?,
        reject_moisture_001pct: r.get(8)?,
        // 脏 JSON 只丢掉指标勾选，不让整个档案页白屏
        enabled_indicators: serde_json::from_str(&indicators).unwrap_or_default(),
        default_package_deduct_01kg: r.get(10)?,
        sort_order: r.get(11)?,
        is_active: r.get(12)?,
    })
}

pub fn list_varieties(conn: &Connection) -> Result<Vec<Variety>, String> {
    // §3.4 档案表软删除：所有查询必须带 deleted_at IS NULL，没有例外
    let sql = format!(
        "SELECT {VARIETY_COLS} FROM grain_variety
         WHERE deleted_at IS NULL ORDER BY sort_order, code"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("读取品种失败：{e}"))?;
    let rows = stmt
        .query_map([], map_variety)
        .map_err(|e| format!("读取品种失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取品种失败：{e}"))?;
    Ok(rows)
}

fn variety_by_id(conn: &Connection, id: i64) -> Result<Variety, String> {
    conn.query_row(
        &format!("SELECT {VARIETY_COLS} FROM grain_variety WHERE id = ?1"),
        params![id],
        map_variety,
    )
    .map_err(|e| format!("品种保存后读取失败：{e}"))
}

fn ensure_variety_code_free(conn: &Connection, code: &str, self_id: Option<i64>) -> Result<(), String> {
    let taken: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM grain_variety
             WHERE code = ?1 AND deleted_at IS NULL AND (?2 IS NULL OR id <> ?2)",
            params![code, self_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("检查品种编码失败：{e}"))?;
    if taken > 0 {
        return Err(format!("品种编码「{code}」已存在，编码站内唯一，换一个"));
    }
    Ok(())
}

pub fn save_variety(conn: &Connection, actor: &AuthProfile, input: VarietyInput) -> Result<Variety, String> {
    let mut code = input.code.trim().to_uppercase();
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("品种名称必填".into());
    }
    if code.is_empty() {
        code = match input.id {
            Some(id) => stored_code(conn, "SELECT code FROM grain_variety WHERE id = ?1", id, "品种")?,
            None => next_code(conn, "SELECT COUNT(*) FROM grain_variety WHERE code = ?1", "V", 2, "品种")?,
        };
    }
    if input.enabled_indicators.is_empty() {
        return Err("至少勾选一个检测项目，否则化验面板没有可录指标".into());
    }
    let indicators = serde_json::to_string(&input.enabled_indicators)
        .map_err(|e| format!("检测项目序列化失败：{e}"))?;

    match input.id {
        Some(id) => {
            ensure_variety_code_free(conn, &code, Some(id))?;
            conn.execute(
                "UPDATE grain_variety SET
                    code = ?1, name = ?2, category = NULLIF(?3, ''),
                    std_moisture_001pct = ?4, std_impurity_001pct = ?5, std_unsound_001pct = ?6,
                    std_bulk_density = ?7, reject_moisture_001pct = ?8,
                    enabled_indicators_json = ?9, default_package_deduct_01kg = ?10,
                    sort_order = ?11, is_active = ?12, updated_at = ?13
                 WHERE id = ?14 AND deleted_at IS NULL",
                params![
                    code, name, input.category,
                    input.std_moisture_001pct, input.std_impurity_001pct, input.std_unsound_001pct,
                    input.std_bulk_density, input.reject_moisture_001pct,
                    indicators, input.default_package_deduct_01kg,
                    input.sort_order, input.is_active, now_iso(), id,
                ],
            )
            .map_err(|e| {
                if is_unique_conflict(&e) {
                    format!("品种编码「{code}」已存在，编码站内唯一，换一个")
                } else {
                    format!("品种保存失败：{e}")
                }
            })?;
            let row = variety_by_id(conn, id)?;
            audit(conn, actor, "variety.update", "grain_variety", &code, None);
            Ok(row)
        }
        None => {
            ensure_variety_code_free(conn, &code, None)?;
            conn.execute(
                "INSERT INTO grain_variety (
                    code, name, category, std_moisture_001pct, std_impurity_001pct,
                    std_unsound_001pct, std_bulk_density, reject_moisture_001pct,
                    enabled_indicators_json, default_package_deduct_01kg, sort_order,
                    is_active, created_at)
                 VALUES (?1, ?2, NULLIF(?3, ''), ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    code, name, input.category,
                    input.std_moisture_001pct, input.std_impurity_001pct, input.std_unsound_001pct,
                    input.std_bulk_density, input.reject_moisture_001pct,
                    indicators, input.default_package_deduct_01kg, input.sort_order,
                    input.is_active, now_iso(),
                ],
            )
            .map_err(|e| {
                if is_unique_conflict(&e) {
                    format!("品种编码「{code}」已存在，编码站内唯一，换一个")
                } else {
                    format!("品种保存失败：{e}")
                }
            })?;
            let row = variety_by_id(conn, conn.last_insert_rowid())?;
            audit(conn, actor, "variety.create", "grain_variety", &code, None);
            Ok(row)
        }
    }
}

/// 删除品种（§3.4 档案表软删除：置 `deleted_at`，历史单据照旧能读回品种名）。
///
/// 先查引用：品种一旦被价目表 / 磅单 / 化验单挂过，就不能删——删掉会让历史价目与
/// 台账找不到品种来源，那种只能「停用」（`is_active = 0`，留档保追溯）。这与设备删
/// 除同一套纪律：有业务历史的拒删，只允许清理错录。
pub fn delete_variety(conn: &Connection, actor: &AuthProfile, id: i64) -> Result<Variety, String> {
    let row = variety_by_id(conn, id)?;
    let refs = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, params![id], |r| r.get(0))
            .map_err(|e| format!("检查品种引用失败：{e}"))
    };
    let in_price = refs("SELECT COUNT(*) FROM price_list WHERE variety_id = ?1")?;
    let in_order = refs("SELECT COUNT(*) FROM weigh_order WHERE variety_id = ?1")?;
    let in_qc = refs("SELECT COUNT(*) FROM qc_report WHERE variety_id = ?1")?;
    if in_price > 0 || in_order > 0 || in_qc > 0 {
        let mut parts: Vec<String> = Vec::new();
        if in_price > 0 {
            parts.push(format!("价目表 {in_price} 条"));
        }
        if in_order > 0 {
            parts.push(format!("磅单 {in_order} 条"));
        }
        if in_qc > 0 {
            parts.push(format!("化验单 {in_qc} 条"));
        }
        let reason = format!(
            "品种「{}」仍被{}引用，不能删除；如不再使用请改为「停用」",
            row.name,
            parts.join("、")
        );
        audit(conn, actor, "variety.delete", "grain_variety", &row.code, Some(&reason));
        return Err(reason);
    }
    conn.execute(
        "UPDATE grain_variety SET deleted_at = ?1, is_active = 0, updated_at = ?1
         WHERE id = ?2 AND deleted_at IS NULL",
        params![now_iso(), id],
    )
    .map_err(|e| format!("品种删除失败：{e}"))?;
    audit(conn, actor, "variety.delete", "grain_variety", &row.code, None);
    Ok(row)
}

const SLOT_COLS: &str = "id, warehouse_id, code, COALESCE(label, code), is_active";

fn map_slot(r: &rusqlite::Row<'_>) -> rusqlite::Result<Slot> {
    Ok(Slot {
        id: r.get(0)?,
        warehouse_id: r.get(1)?,
        code: r.get(2)?,
        label: r.get(3)?,
        is_active: r.get(4)?,
    })
}

fn list_slots(conn: &Connection) -> Result<Vec<Slot>, String> {
    let sql = format!("SELECT {SLOT_COLS} FROM storage_slot ORDER BY warehouse_id, code");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("读取货位失败：{e}"))?;
    let rows = stmt
        .query_map([], map_slot)
        .map_err(|e| format!("读取货位失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取货位失败：{e}"))?;
    Ok(rows)
}

pub fn list_warehouses(conn: &Connection) -> Result<Vec<Warehouse>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, code, name, kind, capacity_ton, is_active
             FROM warehouse WHERE deleted_at IS NULL ORDER BY code",
        )
        .map_err(|e| format!("读取仓房失败：{e}"))?;
    let heads: Vec<(i64, String, String, Option<String>, Option<i64>, i64)> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))
        })
        .map_err(|e| format!("读取仓房失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取仓房失败：{e}"))?;
    // 货位一共几十条，一次取完再挂到各仓房下，省掉 N+1
    let slots = list_slots(conn)?;
    // 库存那一格同理一次取完。判据不在这里重写——结存与出库可用量共用 `stock.rs` 那一份，
    // 两处各算一次就是「档案页说还有 300 吨、出库说无货」这种最难归因的错账。
    let totals = crate::stock::warehouse_totals(conn)?;
    Ok(heads
        .into_iter()
        .map(|(id, code, name, kind, capacity_ton, is_active)| {
            let t = totals.iter().find(|t| t.warehouse_id == id);
            let (balance_01kg, pending_in_01kg) = (
                t.map(|t| t.balance_01kg).unwrap_or(0),
                t.map(|t| t.pending_in_01kg).unwrap_or(0),
            );
            Warehouse {
                slots: slots.iter().filter(|s| s.warehouse_id == id).cloned().collect(),
                opening_01kg: t.and_then(|t| t.opening_01kg),
                opening_variety_id: t.and_then(|t| t.opening_variety_id),
                balance_01kg,
                pending_in_01kg,
                // 1 吨 = 10000 个 0.1kg；容量没核定就留 NULL，不替站长猜一个"能装多少"
                remain_01kg: capacity_ton.map(|c| c * 10_000 - balance_01kg - pending_in_01kg),
                id,
                code,
                name,
                kind,
                capacity_ton,
                is_active,
            }
        })
        .collect())
}

fn warehouse_by_id(conn: &Connection, id: i64) -> Result<Warehouse, String> {
    list_warehouses(conn)?
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| "仓房保存后读取失败".to_string())
}

pub fn save_warehouse(conn: &Connection, actor: &AuthProfile, input: WarehouseInput) -> Result<Warehouse, String> {
    let mut code = input.code.trim().to_uppercase();
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("仓房名称必填".into());
    }
    if code.is_empty() {
        code = match input.id {
            Some(id) => stored_code(conn, "SELECT code FROM warehouse WHERE id = ?1", id, "仓房")?,
            None => next_code(conn, "SELECT COUNT(*) FROM warehouse WHERE code = ?1", "CW", 2, "仓房")?,
        };
    }
    if !WarehouseKind::VALUES.contains(&input.kind.as_str()) {
        return Err(format!(
            "仓房类型「{}」不在值域内（{}）",
            input.kind,
            WarehouseKind::VALUES.join(" / ")
        ));
    }
    let taken: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM warehouse
             WHERE code = ?1 AND deleted_at IS NULL AND (?2 IS NULL OR id <> ?2)",
            params![code, input.id],
            |r| r.get(0),
        )
        .map_err(|e| format!("检查仓房编码失败：{e}"))?;
    if taken > 0 {
        return Err(format!("仓房编码「{code}」已存在，换一个"));
    }

    // 一次保存动两张表（warehouse + stock_movement）＋审计，必须一起成或一起滚：
    // 档案存上、库存账没记上，系统就会指着一间压着 1200 吨的库房说它是空的。
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| format!("仓房保存失败：{e}"))?;

    let id = match input.id {
        Some(id) => {
            tx.execute(
                "UPDATE warehouse SET code = ?1, name = ?2, kind = ?3, capacity_ton = ?4,
                        is_active = ?5, updated_at = ?6
                 WHERE id = ?7 AND deleted_at IS NULL",
                params![code, name, input.kind, input.capacity_ton, input.is_active, now_iso(), id],
            )
            .map_err(|e| format!("仓房保存失败：{e}"))?;
            id
        }
        None => {
            tx.execute(
                "INSERT INTO warehouse (code, name, kind, capacity_ton, is_active, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![code, name, input.kind, input.capacity_ton, input.is_active, now_iso()],
            )
            .map_err(|e| format!("仓房保存失败：{e}"))?;
            tx.last_insert_rowid()
        }
    };

    // 期初：写进库存账本（§9.23 的那笔建账流水），不占 warehouse 表的列。
    if let Some(vid) = input.opening_variety_id.filter(|v| *v > 0) {
        let variety: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM grain_variety WHERE id = ?1 AND deleted_at IS NULL",
                params![vid],
                |r| r.get(0),
            )
            .map_err(|e| format!("检查品种失败：{e}"))?;
        if variety == 0 {
            return Err("所选品种不存在或已删除".into());
        }
    }
    let before = crate::stock::opening_01kg(&tx, id)?;
    let mut reason = None;
    if input.opening_01kg != before {
        crate::stock::set_opening(
            &tx,
            actor,
            id,
            input.opening_variety_id.filter(|v| *v > 0),
            input.opening_01kg,
        )?;
        // 基线被改过必须留痕：结存对不上时第一个被问的就是「期初到底填了多少」。
        // 挂在本次保存那一条审计的 reason 上，不另开一行——档案写入「一次操作一条审计」
        // 是 masters_contract 钉住的纪律，多一条就把那条断言改成了测试迁就实现。
        reason = Some(format!(
            "期初建账 {} → {}",
            opening_label(before),
            opening_label(input.opening_01kg)
        ));
    }
    // 回读排在期初之后：档案页与制单下拉拿到的结存/剩余容量必须是这次的最终值
    let row = warehouse_by_id(&tx, id)?;
    audit(
        &tx,
        actor,
        if input.id.is_some() { "warehouse.update" } else { "warehouse.create" },
        "warehouse",
        &code,
        reason.as_deref(),
    );
    tx.commit().map_err(|e| format!("仓房保存提交失败：{e}"))?;
    Ok(row)
}

/// 审计里那句人话：`None` 与 `Some(0)` 必须能区分开（一个是"从没申报过"，一个是"空仓起账"）
fn opening_label(v01kg: Option<i64>) -> String {
    match v01kg {
        None => "未申报".to_string(),
        Some(v) => format!("{:.2} 吨", v as f64 / 10_000.0),
    }
}

fn slot_by_id(conn: &Connection, id: i64) -> Result<Slot, String> {
    list_slots(conn)?
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "货位保存后读取失败".to_string())
}

pub fn save_slot(conn: &Connection, actor: &AuthProfile, input: SlotInput) -> Result<Slot, String> {
    let mut code = input.code.trim().to_uppercase();
    let warehouse_code = conn
        .query_row(
            "SELECT code FROM warehouse WHERE id = ?1 AND deleted_at IS NULL",
            params![input.warehouse_id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| "所属仓房不存在或已删除，货位无法保存".to_string())?;
    if code.is_empty() {
        code = match input.id {
            Some(id) => stored_code(conn, "SELECT code FROM storage_slot WHERE id = ?1", id, "货位")?,
            None => next_code(
                conn,
                "SELECT COUNT(*) FROM storage_slot WHERE code = ?1",
                &format!("{warehouse_code}-"),
                2,
                "货位",
            )?,
        };
    }
    let label = input.label.trim().to_string();
    let result = match input.id {
        Some(id) => conn.execute(
            "UPDATE storage_slot SET warehouse_id = ?1, code = ?2, label = NULLIF(?3, ''), is_active = ?4
             WHERE id = ?5",
            params![input.warehouse_id, code, label, input.is_active, id],
        ),
        None => conn.execute(
            "INSERT INTO storage_slot (warehouse_id, code, label, is_active) VALUES (?1, ?2, NULLIF(?3, ''), ?4)",
            params![input.warehouse_id, code, label, input.is_active],
        ),
    };
    match result {
        Ok(_) => {
            let id = match input.id {
                Some(id) => id,
                None => conn.last_insert_rowid(),
            };
            let row = slot_by_id(conn, id)?;
            audit(
                conn,
                actor,
                if input.id.is_some() { "slot.update" } else { "slot.create" },
                "storage_slot",
                &code,
                None,
            );
            Ok(row)
        }
        // uk_slot(warehouse_id, code) 就活在这一句上
        Err(e) if is_unique_conflict(&e) => Err(format!(
            "该仓房下已有货位「{code}」，同一仓房内货位编码不可重复"
        )),
        Err(e) => Err(format!("货位保存失败：{e}")),
    }
}

/// 删除仓房（§3.4 档案表软删除：置 `deleted_at`，历史磅单的去向照旧能读回仓房名）。
///
/// 先查引用：仓房一旦被磅单、出入库流水或往来单位「常用去向」挂过就不能删——删掉会让
/// 历史台账找不到去向来源，那种只能「停用」（`is_active = 0`）。引用统计把「本仓房下的
/// 货位」一并算进来（磅单可能只登记到货位、没填仓房），任一命中即拒删。全部为 0 时，
/// 连带硬删这些没有历史的货位子行（`storage_slot.warehouse_id` 非空外键，留孤儿货位既
/// 不会被档案页显示、又可能在别处冒出来），再把仓房软删。与品种、设备同一套纪律。
pub fn delete_warehouse(conn: &Connection, actor: &AuthProfile, id: i64) -> Result<Warehouse, String> {
    let row = warehouse_by_id(conn, id)?;
    let refs = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, params![id], |r| r.get(0))
            .map_err(|e| format!("检查仓房引用失败：{e}"))
    };
    // 「本仓房下的货位」子查询：仓房级与货位级引用一次算全
    const OWN_SLOTS: &str = "(SELECT id FROM storage_slot WHERE warehouse_id = ?1)";
    let in_order = refs(&format!(
        "SELECT COUNT(*) FROM weigh_order WHERE warehouse_id = ?1 OR slot_id IN {OWN_SLOTS}"
    ))?;
    // 期初行**不算**外部引用：它是这间仓房自己的建账基线，不是别人挂上来的单据。
    // 不排掉的话，站长只要填过期初就再也删不掉这间仓（只能停用），而「先清空期初再删」
    // 又是平白多绕一步——所以这里排除、下面连带撤掉。
    let in_move = refs(&format!(
        "SELECT COUNT(*) FROM stock_movement
         WHERE is_opening = 0
            AND (from_warehouse_id = ?1 OR to_warehouse_id = ?1
                 OR from_slot_id IN {OWN_SLOTS} OR to_slot_id IN {OWN_SLOTS})"
    ))?;
    let in_party = refs("SELECT COUNT(*) FROM party WHERE default_warehouse_id = ?1 AND deleted_at IS NULL")?;
    if in_order > 0 || in_move > 0 || in_party > 0 {
        let mut parts: Vec<String> = Vec::new();
        if in_order > 0 {
            parts.push(format!("磅单 {in_order} 张"));
        }
        if in_move > 0 {
            parts.push(format!("出入库流水 {in_move} 条"));
        }
        if in_party > 0 {
            parts.push(format!("往来单位常用去向 {in_party} 处"));
        }
        let reason = format!(
            "仓房「{}」仍被{}引用，不能删除；如不再使用请改为「停用」",
            row.name,
            parts.join("、")
        );
        audit(conn, actor, "warehouse.delete", "warehouse", &row.code, Some(&reason));
        return Err(reason);
    }
    conn.execute("DELETE FROM storage_slot WHERE warehouse_id = ?1", params![id])
        .map_err(|e| format!("仓房删除失败：{e}"))?;
    // 期初行随仓房一起撤掉（留着一行指向已删仓房的流水，结存矩阵里会冒出一格没有主人的货）
    conn.execute(
        "DELETE FROM stock_movement WHERE is_opening = 1 AND to_warehouse_id = ?1",
        params![id],
    )
    .map_err(|e| format!("仓房删除失败：{e}"))?;
    conn.execute(
        "UPDATE warehouse SET deleted_at = ?1, is_active = 0, updated_at = ?1
         WHERE id = ?2 AND deleted_at IS NULL",
        params![now_iso(), id],
    )
    .map_err(|e| format!("仓房删除失败：{e}"))?;
    audit(conn, actor, "warehouse.delete", "warehouse", &row.code, None);
    Ok(row)
}

/// 删除货位。`storage_slot` 没有 `deleted_at` 列（§9.9 停用即 `is_active = 0`），
/// 因此这里走硬删，与设备删除同一取舍：先查引用，被历史单据挂过的拒删、只允许「停用」，
/// 干净的错录才真删。货位是叶子、无子表，删了不留悬空引用。
pub fn delete_slot(conn: &Connection, actor: &AuthProfile, id: i64) -> Result<Slot, String> {
    let row = slot_by_id(conn, id)?;
    let refs = |sql: &str| -> Result<i64, String> {
        conn.query_row(sql, params![id], |r| r.get(0))
            .map_err(|e| format!("检查货位引用失败：{e}"))
    };
    let in_order = refs("SELECT COUNT(*) FROM weigh_order WHERE slot_id = ?1")?;
    let in_move =
        refs("SELECT COUNT(*) FROM stock_movement WHERE from_slot_id = ?1 OR to_slot_id = ?1")?;
    if in_order > 0 || in_move > 0 {
        let mut parts: Vec<String> = Vec::new();
        if in_order > 0 {
            parts.push(format!("磅单 {in_order} 张"));
        }
        if in_move > 0 {
            parts.push(format!("出入库流水 {in_move} 条"));
        }
        let reason = format!(
            "货位「{}」仍被{}引用，不能删除；如不再使用请改为「停用」",
            row.label,
            parts.join("、")
        );
        audit(conn, actor, "slot.delete", "storage_slot", &row.code, Some(&reason));
        return Err(reason);
    }
    conn.execute("DELETE FROM storage_slot WHERE id = ?1", params![id])
        .map_err(|e| format!("货位删除失败：{e}"))?;
    audit(conn, actor, "slot.delete", "storage_slot", &row.code, None);
    Ok(row)
}

const PRICE_COLS: &str = "id, variety_id, grade, price_fen_per_ton, effective_from,
        effective_to, COALESCE(basis, ''), made_by, approved_by, remark";

fn map_price(r: &rusqlite::Row<'_>) -> rusqlite::Result<Price> {
    Ok(Price {
        id: r.get(0)?,
        variety_id: r.get(1)?,
        grade: r.get(2)?,
        price_fen_per_ton: r.get(3)?,
        effective_from: r.get(4)?,
        effective_to: r.get(5)?,
        basis: r.get(6)?,
        made_by: r.get(7)?,
        approved_by: r.get(8)?,
        remark: r.get(9)?,
    })
}

pub fn list_prices(conn: &Connection) -> Result<Vec<Price>, String> {
    let sql = format!(
        "SELECT {PRICE_COLS} FROM price_list
         WHERE deleted_at IS NULL ORDER BY effective_from DESC, variety_id, grade"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("读取价目失败：{e}"))?;
    let rows = stmt
        .query_map([], map_price)
        .map_err(|e| format!("读取价目失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取价目失败：{e}"))?;
    Ok(rows)
}

fn price_by_id(conn: &Connection, id: i64) -> Result<Price, String> {
    conn.query_row(
        &format!("SELECT {PRICE_COLS} FROM price_list WHERE id = ?1"),
        params![id],
        map_price,
    )
    .map_err(|e| format!("价目保存后读取失败：{e}"))
}

pub fn save_price(conn: &Connection, actor: &AuthProfile, input: PriceInput) -> Result<Price, String> {
    if input.price_fen_per_ton <= 0 {
        return Err("单价必须大于 0".into());
    }
    if input.effective_from > input.effective_to {
        return Err("生效起始日不能晚于截止日".into());
    }
    let variety: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM grain_variety WHERE id = ?1 AND deleted_at IS NULL",
            params![input.variety_id],
            |r| r.get(0),
        )
        .map_err(|e| format!("检查品种失败：{e}"))?;
    if variety == 0 {
        return Err("所选品种不存在或已删除".into());
    }

    // §9.10：重叠校验放服务层（SQLite 的排除型约束表达力不足）。
    // 标准区间相交判据：a.from <= b.to AND b.from <= a.to，改自己那条时要按 id 排除。
    let clash: Option<(String, String)> = conn
        .query_row(
            "SELECT effective_from, effective_to FROM price_list
             WHERE deleted_at IS NULL AND variety_id = ?1 AND grade = ?2
               AND effective_from <= ?4 AND ?3 <= effective_to
               AND (?5 IS NULL OR id <> ?5)
             LIMIT 1",
            params![input.variety_id, input.grade, input.effective_from, input.effective_to, input.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    if let Some((from, to)) = clash {
        return Err(format!(
            "{} 在 {from} ~ {to} 已经有一条生效价，区间重叠。调价请先给旧价填截止日，再发新价",
            input.grade
        ));
    }

    match input.id {
        Some(id) => {
            conn.execute(
                "UPDATE price_list SET variety_id = ?1, grade = ?2, price_fen_per_ton = ?3,
                        effective_from = ?4, effective_to = ?5, basis = ?6, remark = ?7,
                        approved_by = ?8
                 WHERE id = ?9 AND deleted_at IS NULL",
                params![
                    input.variety_id, input.grade, input.price_fen_per_ton,
                    input.effective_from, input.effective_to, input.basis, input.remark,
                    actor.id, id,
                ],
            )
            .map_err(|e| format!("价目保存失败：{e}"))?;
            let row = price_by_id(conn, id)?;
            audit(
                conn,
                actor,
                "price.update",
                "price_list",
                &format!("{}/{}", input.variety_id, input.grade),
                Some(&input.basis),
            );
            Ok(row)
        }
        None => {
            conn.execute(
                "INSERT INTO price_list (variety_id, grade, price_fen_per_ton, effective_from,
                        effective_to, basis, made_by, approved_by, remark, created_at, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?7)",
                params![
                    input.variety_id, input.grade, input.price_fen_per_ton,
                    input.effective_from, input.effective_to, input.basis,
                    actor.id, input.remark, now_iso(),
                ],
            )
            .map_err(|e| format!("价目保存失败：{e}"))?;
            let row = price_by_id(conn, conn.last_insert_rowid())?;
            audit(
                conn,
                actor,
                "price.create",
                "price_list",
                &format!("{}/{}", input.variety_id, input.grade),
                Some(&input.basis),
            );
            Ok(row)
        }
    }
}

const STAFF_COLS: &str = "id, username, display_name, role, COALESCE(phone, ''), is_active, last_login_at";

fn map_staff(r: &rusqlite::Row<'_>) -> rusqlite::Result<Staff> {
    Ok(Staff {
        id: r.get(0)?,
        username: r.get(1)?,
        display_name: r.get(2)?,
        role: r.get(3)?,
        phone: r.get(4)?,
        is_active: r.get(5)?,
        last_login_at: r.get(6)?,
    })
}

pub fn list_staff(conn: &Connection) -> Result<Vec<Staff>, String> {
    let sql = format!(
        "SELECT {STAFF_COLS} FROM user_account
         WHERE deleted_at IS NULL ORDER BY is_active DESC, id"
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("读取员工失败：{e}"))?;
    let rows = stmt
        .query_map([], map_staff)
        .map_err(|e| format!("读取员工失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取员工失败：{e}"))?;
    Ok(rows)
}

fn staff_by_id(conn: &Connection, id: i64) -> Result<Staff, String> {
    conn.query_row(
        &format!("SELECT {STAFF_COLS} FROM user_account WHERE id = ?1"),
        params![id],
        map_staff,
    )
    .map_err(|e| format!("员工保存后读取失败：{e}"))
}

pub fn save_staff(conn: &Connection, actor: &AuthProfile, input: StaffInput) -> Result<Staff, String> {
    let mut username = input.username.trim().to_lowercase();
    let display_name = input.display_name.trim().to_string();
    if display_name.is_empty() {
        return Err("员工姓名必填".into());
    }
    if username.is_empty() {
        username = match input.id {
            Some(id) => stored_code(conn, "SELECT username FROM user_account WHERE id = ?1", id, "员工")?,
            None => next_code(
                conn,
                "SELECT COUNT(*) FROM user_account WHERE username = ?1",
                "u",
                2,
                "登录名",
            )?,
        };
    }
    if !Role::VALUES.contains(&input.role.as_str()) {
        return Err(format!("岗位「{}」不在值域内", input.role));
    }
    let taken: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM user_account
             WHERE username = ?1 AND deleted_at IS NULL AND (?2 IS NULL OR id <> ?2)",
            params![username, input.id],
            |r| r.get(0),
        )
        .map_err(|e| format!("检查登录名失败：{e}"))?;
    if taken > 0 {
        return Err(format!("登录名「{username}」已被占用，换一个"));
    }

    match input.id {
        Some(id) => {
            // 全站最后一名在职站长不能被停用或改岗：授权类操作（作废 / 红冲 / 补打）
            // 只认站长密码，改完就没人在磅房里能签这个字了。
            if input.is_active == 0 || input.role != WRITE_ROLE.to_string() {
                let others: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM user_account
                         WHERE deleted_at IS NULL AND is_active = 1 AND role = ?1 AND id <> ?2",
                        params![WRITE_ROLE.to_string(), id],
                        |r| r.get(0),
                    )
                    .map_err(|e| format!("检查站长在岗情况失败：{e}"))?;
                let is_master: bool = conn
                    .query_row(
                        "SELECT role = ?1 AND is_active = 1 FROM user_account WHERE id = ?2",
                        params![WRITE_ROLE.to_string(), id],
                        |r| r.get::<_, i64>(0),
                    )
                    .unwrap_or(0)
                    == 1;
                if is_master && others == 0 {
                    return Err("这是最后一名在职站长，停用或改岗后无人能授权，请先设好接班人".into());
                }
            }
            conn.execute(
                "UPDATE user_account SET display_name = ?1, role = ?2, phone = NULLIF(?3, ''),
                        is_active = ?4, updated_at = ?5
                 WHERE id = ?6 AND deleted_at IS NULL",
                params![display_name, input.role, input.phone, input.is_active, now_iso(), id],
            )
            .map_err(|e| format!("员工保存失败：{e}"))?;
            let row = staff_by_id(conn, id)?;
            audit(conn, actor, "staff.update", "user_account", &row.username, None);
            Ok(row)
        }
        None => {
            // 新员工落占位哈希：进得来（只认装机初始密码）、且首登必改
            // ——同 `0003_seed_superadmin.sql` 那条路，见 crate::auth 模块头规矩 5。
            conn.execute(
                "INSERT INTO user_account (username, display_name, password_hash, role, phone,
                        must_change_pwd, is_active, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULLIF(?5, ''), 1, ?6, ?7)",
                params![
                    username, display_name, auth::PWD_UNSET, input.role, input.phone,
                    input.is_active, now_iso()
                ],
            )
            .map_err(|e| {
                if is_unique_conflict(&e) {
                    format!("登录名「{username}」已被占用，换一个")
                } else {
                    format!("员工保存失败：{e}")
                }
            })?;
            let row = staff_by_id(conn, conn.last_insert_rowid())?;
            audit(conn, actor, "staff.create", "user_account", &row.username, None);
            Ok(row)
        }
    }
}

pub fn get_station(conn: &Connection) -> Result<Station, String> {
    conn.query_row(
        "SELECT id, code, name, COALESCE(address, ''), COALESCE(phone, '')
         FROM station WHERE is_active = 1 ORDER BY id LIMIT 1",
        [],
        |r| {
            Ok(Station {
                id: r.get(0)?,
                code: r.get(1)?,
                name: r.get(2)?,
                address: r.get(3)?,
                phone: r.get(4)?,
            })
        },
    )
    .map_err(|_| "站点档案尚未初始化，请先在系统设置里填写站名".to_string())
}

pub fn flatten_slots(conn: &Connection) -> Result<Vec<Slot>, String> {
    list_slots(conn)
}

// --------------------------------------------------------------------- 站点参数

/// §9.3 站点参数。库里只有「键 / 值 / 值类型 / 一行说明」，界面上的中文名、分组、
/// 控件类型、单位口径全在 `src/lib/settings-catalog.ts`——那是展示层的字典，
/// 入库就等于把 UI 焊死在数据里，改个文案要跑一次迁移。
#[derive(Debug, Clone, Serialize)]
pub struct Setting {
    pub key: String,
    /// `value_json` 解开后的**标量文本**：`"BD"` → `BD`、`300` → `300`、`true` → `true`。
    /// 前端 `useSetting` 只有 raw / num / bool 三种读法，不该再解一层 JSON。
    pub value: String,
    pub value_type: String,
    pub description: String,
}

/// 站点名称不在 `app_setting`，它在 §9.2 的 `station` 表里。参数页照旧列这一项，
/// 读时合成、写时回 station 行——同一个站名在库里存两份，早晚对不上。
const STATION_NAME_KEY: &str = "station_name";

fn flatten_json_value(raw: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .map(|v| match v {
            serde_json::Value::String(s) => s,
            other => other.to_string(), // bool / int / json 原样成文本给界面
        })
        .unwrap_or_else(|_| raw.to_string())
}

/// 按各键**已有的** `value_type` 把界面文本编码成 `value_json`。
/// 类型是 0001 建表时就 CHECK 死的四选一，界面不能借保存的机会偷改它。
fn encode_setting_value(value_type: &str, raw: &str) -> Result<String, String> {
    let t = raw.trim();
    match value_type {
        "int" => t
            .parse::<i64>()
            .map(|n| n.to_string())
            .map_err(|_| format!("这一项要填整数，「{raw}」读不进去")),
        "bool" => match t.to_lowercase().as_str() {
            "true" | "1" => Ok("true".into()),
            "false" | "0" => Ok("false".into()),
            _ => Err(format!("这一项只有开、关两种值，收到「{raw}」")),
        },
        "json" => serde_json::from_str::<serde_json::Value>(t)
            .map(|v| v.to_string())
            .map_err(|_| "这一项必须是一段合法 JSON".to_string()),
        _ => serde_json::to_string(t).map_err(|e| format!("参数编码失败：{e}")),
    }
}

pub fn list_settings(conn: &Connection) -> Result<Vec<Setting>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT key, value_json, value_type, COALESCE(description, '')
             FROM app_setting ORDER BY key",
        )
        .map_err(|e| format!("读取参数失败：{e}"))?;
    let mut rows: Vec<Setting> = stmt
        .query_map([], |r| {
            Ok(Setting {
                key: r.get(0)?,
                value: flatten_json_value(&r.get::<_, String>(1)?),
                value_type: r.get(2)?,
                description: r.get(3)?,
            })
        })
        .map_err(|e| format!("读取参数失败：{e}"))?
        .filter_map(|r| r.ok())
        .collect();
    // 站点档案没建全时参数页仍要能打得开：站名合成空串，让界面自己提示去补
    let name: Option<String> = conn
        .query_row(
            "SELECT name FROM station WHERE is_active = 1 ORDER BY id LIMIT 1",
            [],
            |r| r.get(0),
        )
        .ok();
    rows.insert(
        0,
        Setting {
            key: STATION_NAME_KEY.into(),
            value: name.unwrap_or_default(),
            value_type: "string".into(),
            description: "打印抬头与磅单第一行".into(),
        },
    );
    Ok(rows)
}

#[derive(Debug, Deserialize)]
pub struct SettingInput {
    pub key: String,
    pub value: String,
    /// 打印门禁的结论（"未经真机验证"之类）。只进审计原因，不参与放行判断——
    /// 测不测得到打印机是前端与设备层的事，Rust 侧只负责把话说清楚并留痕。
    pub verify_note: Option<String>,
}

/// 返回**保存后重读的整表**，与 mock 的 `saveSetting` 同签名：
/// 参数页保存后直接换数据源，不必逐键回填本地 state。
pub fn save_setting(conn: &Connection, actor: &AuthProfile, input: SettingInput) -> Result<Vec<Setting>, String> {
    let reason = |old: &str, new: &str| match input.verify_note.as_deref() {
        Some(n) if !n.is_empty() => format!("{old} → {new}（{n}）"),
        _ => format!("{old} → {new}"),
    };
    if input.key == STATION_NAME_KEY {
        let name = input.value.trim();
        if name.is_empty() {
            return Err("站点名称不能为空：打印抬头与磅单第一行都要用它".into());
        }
        let old: String = conn
            .query_row(
                "SELECT name FROM station WHERE is_active = 1 ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .map_err(|_| "站点档案尚未初始化，改不了站名".to_string())?;
        if old != name {
            conn.execute("UPDATE station SET name = ?1 WHERE is_active = 1", params![name])
                .map_err(|e| format!("站点名称保存失败：{e}"))?;
            audit(
                conn,
                actor,
                "setting.update",
                "station",
                STATION_NAME_KEY,
                Some(&reason(&old, name)),
            );
        }
        return list_settings(conn);
    }
    let (old_json, value_type): (String, String) = conn
        .query_row(
            "SELECT value_json, value_type FROM app_setting WHERE key = ?1",
            params![input.key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| format!("参数「{}」在库里没有这一项", input.key))?;
    let next_json = encode_setting_value(&value_type, &input.value)?;
    conn.execute(
        "UPDATE app_setting SET value_json = ?1, updated_at = ?2, updated_by = ?3 WHERE key = ?4",
        params![next_json, now_iso(), actor.id, input.key],
    )
    .map_err(|e| format!("参数保存失败：{e}"))?;
    audit(
        conn,
        actor,
        "setting.update",
        "app_setting",
        &input.key,
        Some(&reason(&flatten_json_value(&old_json), &flatten_json_value(&next_json))),
    );
    list_settings(conn)
}

// ----------------------------------------------------------------- Tauri 命令

/// 读取一律不校验岗位：档案里的品种/仓房/价目是看板、工作台、单据详情的公共下拉，
/// 连只读岗（viewer）都要能看见。写入才要站长，见 [`operator`]。

#[tauri::command]
pub async fn master_station(app: AppHandle) -> Result<Station, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| get_station(conn)))
        .await
        .map_err(|e| format!("站点读取任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_varieties(app: AppHandle) -> Result<Vec<Variety>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| list_varieties(conn)))
        .await
        .map_err(|e| format!("品种读取任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_warehouses(app: AppHandle) -> Result<Vec<Warehouse>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| list_warehouses(conn)))
        .await
        .map_err(|e| format!("仓房读取任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_slots(app: AppHandle) -> Result<Vec<Slot>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| flatten_slots(conn)))
        .await
        .map_err(|e| format!("货位读取任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_prices(app: AppHandle) -> Result<Vec<Price>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| list_prices(conn)))
        .await
        .map_err(|e| format!("价目读取任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_staff(app: AppHandle) -> Result<Vec<Staff>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| list_staff(conn)))
        .await
        .map_err(|e| format!("员工读取任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_save_variety(app: AppHandle, input: VarietyInput) -> Result<Variety, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| save_variety(conn, &actor, input)))
        .await
        .map_err(|e| format!("品种保存任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_delete_variety(app: AppHandle, input: DeleteVarietyInput) -> Result<Variety, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| delete_variety(conn, &actor, input.id)))
        .await
        .map_err(|e| format!("品种删除任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_save_warehouse(app: AppHandle, input: WarehouseInput) -> Result<Warehouse, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| save_warehouse(conn, &actor, input)))
        .await
        .map_err(|e| format!("仓房保存任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_save_slot(app: AppHandle, input: SlotInput) -> Result<Slot, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| save_slot(conn, &actor, input)))
        .await
        .map_err(|e| format!("货位保存任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_delete_warehouse(app: AppHandle, input: DeleteWarehouseInput) -> Result<Warehouse, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| delete_warehouse(conn, &actor, input.id)))
        .await
        .map_err(|e| format!("仓房删除任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_delete_slot(app: AppHandle, input: DeleteSlotInput) -> Result<Slot, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| delete_slot(conn, &actor, input.id)))
        .await
        .map_err(|e| format!("货位删除任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_save_price(app: AppHandle, input: PriceInput) -> Result<Price, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| save_price(conn, &actor, input)))
        .await
        .map_err(|e| format!("价目保存任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_save_staff(app: AppHandle, input: StaffInput) -> Result<Staff, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| save_staff(conn, &actor, input)))
        .await
        .map_err(|e| format!("员工保存任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_settings(app: AppHandle) -> Result<Vec<Setting>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| list_settings(conn)))
        .await
        .map_err(|e| format!("参数读取任务失败：{e}"))?
}

/// 改参数会立刻影响正在进行的过磅（皮重容差、分度值、判稳窗口），
/// 所以这道闸只在服务端把：前端的 `can("setting.write")` 是体验，不是边界。
#[tauri::command]
pub async fn master_save_setting(app: AppHandle, input: SettingInput) -> Result<Vec<Setting>, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| save_setting(conn, &actor, input)))
        .await
        .map_err(|e| format!("参数保存任务失败：{e}"))?
}


// ------------------------------------------------------- §9.27 常用语/快捷选项

/// 事由/原因/结论类文本框「点一句人话」的下拉候选（03 §9.27、05 §3）。
/// 落库仍是自由文本，本表只预备选。DTO 字段与 `src/mock/types.ts::QuickOption` 逐字一致。
#[derive(Debug, Clone, Serialize)]
pub struct QuickOption {
    pub id: i64,
    pub kind: String,
    pub label: String,
    pub value: String,
    pub sort_order: i64,
    pub is_active: i64,
}

/// 分类白名单。与前端 `QuickOptionKind`、§9.27 的 kind 值域逐字一致；库里对 `kind`
/// 不加 CHECK（扩一类只改这里 + 前端类型 + 迁移种子，不动表结构）。
pub const QUICK_OPTION_KINDS: [&str; 6] =
    ["void", "price", "reject", "card_retire", "remark", "odor"];

const QUICK_OPTION_COLS: &str = "id, kind, label, value, sort_order, is_active";

fn map_quick_option(r: &rusqlite::Row<'_>) -> rusqlite::Result<QuickOption> {
    Ok(QuickOption {
        id: r.get(0)?,
        kind: r.get(1)?,
        label: r.get(2)?,
        value: r.get(3)?,
        sort_order: r.get(4)?,
        is_active: r.get(5)?,
    })
}

/// 一次读全表（含停用行）：「基础档案 › 常用语/快捷选项」整页维护要看得到停用的，
/// 字段用侧的下拉由前端按 `is_active` 过滤。按 kind、sort_order、id 稳定排序。
pub fn list_quick_options(conn: &Connection) -> Result<Vec<QuickOption>, String> {
    let sql = format!("SELECT {QUICK_OPTION_COLS} FROM quick_option ORDER BY kind, sort_order, id");
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("读取常用语失败：{e}"))?;
    let rows = stmt
        .query_map([], map_quick_option)
        .map_err(|e| format!("读取常用语失败：{e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取常用语失败：{e}"))?;
    Ok(rows)
}

fn quick_option_by_id(conn: &Connection, id: i64) -> Result<QuickOption, String> {
    conn.query_row(
        &format!("SELECT {QUICK_OPTION_COLS} FROM quick_option WHERE id = ?1"),
        params![id],
        map_quick_option,
    )
    .map_err(|e| format!("常用语保存后读取失败：{e}"))
}

#[derive(Debug, Deserialize)]
pub struct QuickOptionInput {
    pub id: Option<i64>,
    pub kind: String,
    pub label: String,
    pub value: String,
    /// 0＝没给排序号，保存时自动排到同类末尾
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default = "enabled")]
    pub is_active: i64,
}

#[derive(Debug, Deserialize)]
pub struct DeleteQuickOptionInput {
    pub id: i64,
    /// 前端透传，后端以会话为准忽略
    #[serde(default)]
    pub operator_id: i64,
}

/// 新增 / 修改一条常用语。只保证分类合法、简称与内容不为空；落库是自由文本不做枚举锁死。
pub fn save_quick_option(
    conn: &Connection,
    actor: &AuthProfile,
    input: QuickOptionInput,
) -> Result<QuickOption, String> {
    let kind = input.kind.trim().to_string();
    let label = input.label.trim().to_string();
    let value = input.value.trim().to_string();
    if !QUICK_OPTION_KINDS.contains(&kind.as_str()) {
        return Err(format!(
            "常用语分类「{kind}」不在值域内（{}）",
            QUICK_OPTION_KINDS.join(" / ")
        ));
    }
    if label.is_empty() {
        return Err("简称必填：下拉清单上就显示这几个字".into());
    }
    if value.is_empty() {
        return Err("完整内容必填：点一下要填进文本框的就是这句话".into());
    }
    let sort_order = if input.sort_order > 0 {
        input.sort_order
    } else {
        conn.query_row(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 FROM quick_option WHERE kind = ?1",
            params![kind],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(1)
    };

    match input.id {
        Some(id) => {
            // 先确认这行在，别对不存在的 id 静默 UPDATE 影响 0 行还回「保存成功」
            quick_option_by_id(conn, id)?;
            conn.execute(
                "UPDATE quick_option SET kind = ?1, label = ?2, value = ?3, sort_order = ?4, is_active = ?5
                 WHERE id = ?6",
                params![kind, label, value, sort_order, input.is_active, id],
            )
            .map_err(|e| format!("常用语保存失败：{e}"))?;
            let row = quick_option_by_id(conn, id)?;
            audit(conn, actor, "quick_option.update", "quick_option", &kind, Some(&label));
            Ok(row)
        }
        None => {
            conn.execute(
                "INSERT INTO quick_option (kind, label, value, sort_order, is_active, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![kind, label, value, sort_order, input.is_active, now_iso()],
            )
            .map_err(|e| format!("常用语保存失败：{e}"))?;
            let row = quick_option_by_id(conn, conn.last_insert_rowid())?;
            audit(conn, actor, "quick_option.create", "quick_option", &kind, Some(&label));
            Ok(row)
        }
    }
}

/// 删除一条常用语（物理删）。单据上存的是那句文本本身，不引用本表行，删了不动历史。
pub fn delete_quick_option(conn: &Connection, actor: &AuthProfile, id: i64) -> Result<QuickOption, String> {
    let row = quick_option_by_id(conn, id)?;
    conn.execute("DELETE FROM quick_option WHERE id = ?1", params![id])
        .map_err(|e| format!("常用语删除失败：{e}"))?;
    audit(conn, actor, "quick_option.delete", "quick_option", &row.kind, Some(&row.label));
    Ok(row)
}

#[tauri::command]
pub async fn master_quick_options(app: AppHandle) -> Result<Vec<QuickOption>, String> {
    let pool = pool_of(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| list_quick_options(conn)))
        .await
        .map_err(|e| format!("常用语读取任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_save_quick_option(app: AppHandle, input: QuickOptionInput) -> Result<QuickOption, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| save_quick_option(conn, &actor, input)))
        .await
        .map_err(|e| format!("常用语保存任务失败：{e}"))?
}

#[tauri::command]
pub async fn master_delete_quick_option(
    app: AppHandle,
    input: DeleteQuickOptionInput,
) -> Result<QuickOption, String> {
    let pool = pool_of(&app)?;
    let actor = operator(&app)?;
    tauri::async_runtime::spawn_blocking(move || locked(&pool, |conn| delete_quick_option(conn, &actor, input.id)))
        .await
        .map_err(|e| format!("常用语删除任务失败：{e}"))?
}
