//! 库存账（03 §9.23 `stock_movement`、§4.3 不变式 9；02 §M11 粮食出库）
//!
//! `stock_movement` 从 0001 起就是「只建表不写入」的预留，0021 才把两条腿接上：
//! **结存 = Σ入 − Σ出**，按 仓房 × 品种 聚合。本模块是这张账的唯一读口径，
//! 写入侧的入库投影也在这里（[`sync_in_movement`]），出库流水则由
//! [`crate::outbound`] 在完成/红冲时与单据状态同事务写入。
//!
//! ## 两条腿的权威源不对称（最容易实现错的地方）
//!
//!  - `in`  的权威源是**磅单**，本表的 in 行只是投影：改派仓房就 UPDATE 那一行，
//!    清空去向就删掉那一行。真相永远在 `weigh_order` 上，删了可重放、无信息损失。
//!    所以 [`sync_in_movement`] 是**幂等同步**，不是「记一笔入库」。
//!  - `out` 的权威源是**出库单 + 本表流水**，出库单只是入口：一律 append-only，
//!    红冲补一条对称 `in` 行并用 `reversal_of_id` 指回被冲那条，原行永不删改。
//!
//! ## 「什么算已入仓」的判据
//!
//! 与 0021 回填脚本**逐字同口径**，改一处必须改另一处，否则历史账与新账对不齐：
//! 去向已定 AND **结算重量已写入** AND status ∈ (settled,paid,archived) AND 不是红冲单。
//! 刻意以结算重量为准而非「磅一过就算入库」：`settlement_weight_01kg` 全仓只有
//! `orders::settle` 那一刻才写（扣水/扣杂/包装扣量都在那一屏才逐项录入），
//! 所以 `to_settle` 阶段根本没有可信的数量，硬算进结存会虚报「还能出多少」。
//! 已称未结的部分由 [`BalanceRow::pending_in_01kg`] 单列出来看住，不静默吞掉。
//!
//! 本期所有流水都带仓房（入库来自磅单去向、出库来自出库单的出仓来源），
//! 结存按 `warehouse` 内连接聚合；将来若引入无仓房的流水，需要在这里改判据。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::AppHandle;

use crate::orders::read_only;

/// 与 0021 回填的 WHERE 同口径：这张磅单的粮算不算已经进仓。
///
/// 只认**已结算及之后**：扣水/扣杂/包装扣量是在结算那一刻才逐项录入的，
/// `to_settle` 阶段的结算重量根本还不存在，把它的净重算进结存等于虚报「还能出多少」。
const IN_QUALIFIED: &str = "warehouse_id IS NOT NULL \
     AND settlement_weight_01kg IS NOT NULL \
     AND status IN ('settled','paid','archived') \
     AND reversed_order_id IS NULL";

/// 流水记在哪个仓房的账上：入库记到货房，出库从货房扣。
const MOVE_WH: &str = "CASE WHEN m.kind = 'in' THEN m.to_warehouse_id ELSE m.from_warehouse_id END";

/// 待入账：粮已卸上磅、净重已知，但还没结算所以数量未定，**不计入结存**、只单列一栏。
const PENDING_IN_WHERE: &str = "o.warehouse_id IS NOT NULL \
     AND o.reversed_order_id IS NULL \
     AND o.net_weight_01kg IS NOT NULL \
     AND o.status IN ('gross_weighed','tare_weighed','reweigh','to_settle')";

// =========================================================================== 读

#[derive(Debug, Clone, Serialize)]
pub struct BalanceRow {
    pub warehouse_id: i64,
    pub warehouse_code: String,
    pub warehouse_name: String,
    pub variety_id: Option<i64>,
    pub variety_code: Option<String>,
    pub variety_name: Option<String>,
    /// 账面结存（0.1kg）= Σ入 − Σ出
    pub balance_01kg: i64,
    /// 两条腿分开给：只留一个结存数字的账没人敢信
    pub in_01kg: i64,
    pub out_01kg: i64,
    /// 已称完但还没结算入账、去向定到本仓房的部分（**不计入** balance_01kg）
    pub pending_in_01kg: i64,
    pub last_move_at: Option<String>,
}

/// 结存矩阵：只出「有过流水或有一笔试入账」的 仓房 × 品种 组合，不铺笛卡尔积——
/// 空组合全列出来只会把真有货的那几格挤下去。
pub fn balance(conn: &Connection) -> Result<Vec<BalanceRow>, String> {
    let mut rows: Vec<BalanceRow> = {
        let sql = format!(
            "SELECT wh.id, wh.code, wh.name, v.id, v.code, v.name,
                    COALESCE(SUM(CASE WHEN m.kind = 'in' THEN m.weight_01kg ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN m.kind = 'in' THEN 0 ELSE m.weight_01kg END), 0),
                    MAX(m.operated_at)
               FROM stock_movement m
               JOIN warehouse wh ON wh.id = ({MOVE_WH})
               LEFT JOIN grain_variety v ON v.id = m.variety_id
              GROUP BY wh.id, v.id
              ORDER BY wh.code, v.code"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取库存结存失败：{e}"))?;
        stmt.query_map([], |r| {
            let in_01kg: i64 = r.get(6)?;
            let out_01kg: i64 = r.get(7)?;
            Ok(BalanceRow {
                warehouse_id: r.get(0)?,
                warehouse_code: r.get(1)?,
                warehouse_name: r.get(2)?,
                variety_id: r.get(3)?,
                variety_code: r.get(4)?,
                variety_name: r.get(5)?,
                balance_01kg: in_01kg - out_01kg,
                in_01kg,
                out_01kg,
                pending_in_01kg: 0,
                last_move_at: r.get(8)?,
            })
        })
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取库存结存失败：{e}"))?
    };

    // 已称未结的入仓量并进来。它**不改** balance_01kg（那一列的口径是以结算重量为准），
    // 但值仓必须看得见「仓里已卸、账上还没进」的那部分，否则会被当成库存凭空少了一截。
    let sql = format!(
        "SELECT o.warehouse_id, o.variety_id,
                COALESCE(SUM(o.net_weight_01kg), 0)
           FROM weigh_order o
          WHERE {PENDING_IN_WHERE}
          GROUP BY o.warehouse_id, o.variety_id"
    );
    let pending: Vec<(i64, Option<i64>, i64)> = {
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取待入账入仓量失败：{e}"))?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .and_then(|m| m.collect::<Result<Vec<_>, _>>())
            .map_err(|e| format!("读取待入账入仓量失败：{e}"))?
    };
    for (wh, var, qty) in pending {
        if let Some(b) = rows.iter_mut().find(|b| b.warehouse_id == wh && b.variety_id == var) {
            b.pending_in_01kg = qty;
            continue;
        }
        // 这个组合只有待入账、还没有任何流水：补一行。结存 0，但那几吨粮不能凭空消失。
        let (code, name) = conn
            .query_row("SELECT code, name FROM warehouse WHERE id = ?1", params![wh], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .unwrap_or_else(|_| ("—".into(), "未知仓房".into()));
        let variety = var.and_then(|vid| {
            conn.query_row("SELECT code, name FROM grain_variety WHERE id = ?1", params![vid], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .ok()
        });
        rows.push(BalanceRow {
            warehouse_id: wh,
            warehouse_code: code,
            warehouse_name: name,
            variety_id: var,
            variety_code: variety.as_ref().map(|(c, _)| c.clone()),
            variety_name: variety.as_ref().map(|(_, n)| n.clone()),
            balance_01kg: 0,
            in_01kg: 0,
            out_01kg: 0,
            pending_in_01kg: qty,
            last_move_at: None,
        });
    }
    Ok(rows)
}

#[derive(Debug, Clone, Serialize)]
pub struct MovementRow {
    pub id: i64,
    pub kind: String,
    /// 带符号的变动量（0.1kg）：入库为正、出库为负。界面按符号上色。
    pub signed_01kg: i64,
    pub weight_01kg: i64,
    pub order_id: Option<i64>,
    pub order_no: Option<String>,
    pub outbound_id: Option<i64>,
    pub outbound_no: Option<String>,
    pub party_id: Option<i64>,
    pub party_name: Option<String>,
    pub variety_id: Option<i64>,
    pub variety_name: Option<String>,
    pub grade: Option<String>,
    pub warehouse_id: Option<i64>,
    pub warehouse_name: Option<String>,
    pub from_warehouse_id: Option<i64>,
    pub from_warehouse_name: Option<String>,
    pub to_warehouse_id: Option<i64>,
    pub to_warehouse_name: Option<String>,
    pub amount_fen: Option<i64>,
    pub business_date: String,
    pub operated_at: String,
    pub operator_name: String,
    pub reversal_of_id: Option<i64>,
    pub remark: Option<String>,
}

/// 流水行的统一读法（本模块的流水页与 `crate::outbound` 的详情页共用一份，
/// 免得两处各自 JOIN 出两个口径）。
pub(crate) const MOVE_SELECT: &str = "SELECT m.id, m.kind,
       (CASE WHEN m.kind = 'in' THEN m.weight_01kg ELSE -m.weight_01kg END),
       m.weight_01kg,
       m.order_id, o.order_no,
       m.outbound_id, ob.order_no,
       m.party_id, p.name,
       m.variety_id, v.name, m.grade,
       (CASE WHEN m.kind = 'in' THEN m.to_warehouse_id ELSE m.from_warehouse_id END), wh.name,
       m.from_warehouse_id, fw.name,
       m.to_warehouse_id, tw.name,
       m.amount_fen, m.business_date, m.operated_at,
       COALESCE(u.display_name, '—'), m.reversal_of_id, m.remark
  FROM stock_movement m
  LEFT JOIN warehouse       wh ON wh.id = (CASE WHEN m.kind = 'in' THEN m.to_warehouse_id ELSE m.from_warehouse_id END)
  LEFT JOIN weigh_order     o  ON o.id  = m.order_id
  LEFT JOIN outbound_order  ob ON ob.id = m.outbound_id
  LEFT JOIN party           p  ON p.id  = m.party_id
  LEFT JOIN grain_variety   v  ON v.id  = m.variety_id
  LEFT JOIN warehouse       fw ON fw.id = m.from_warehouse_id
  LEFT JOIN warehouse       tw ON tw.id = m.to_warehouse_id
  LEFT JOIN user_account    u  ON u.id  = m.operator_id";

pub(crate) fn map_move_row(r: &rusqlite::Row) -> rusqlite::Result<MovementRow> {
    Ok(MovementRow {
        id: r.get(0)?,
        kind: r.get(1)?,
        signed_01kg: r.get(2)?,
        weight_01kg: r.get(3)?,
        order_id: r.get(4)?,
        order_no: r.get(5)?,
        outbound_id: r.get(6)?,
        outbound_no: r.get(7)?,
        party_id: r.get(8)?,
        party_name: r.get(9)?,
        variety_id: r.get(10)?,
        variety_name: r.get(11)?,
        grade: r.get(12)?,
        warehouse_id: r.get(13)?,
        warehouse_name: r.get(14)?,
        from_warehouse_id: r.get(15)?,
        from_warehouse_name: r.get(16)?,
        to_warehouse_id: r.get(17)?,
        to_warehouse_name: r.get(18)?,
        amount_fen: r.get(19)?,
        business_date: r.get(20)?,
        operated_at: r.get(21)?,
        operator_name: r.get(22)?,
        reversal_of_id: r.get(23)?,
        remark: r.get(24)?,
    })
}

/// 流水查询条件。沿用本仓既定约定：**snake_case 直传**，字段与 `src/mock/types.ts`
/// 里的同名类型逐字一致（前端把 input 原样交给真库，浏览器预览走同一份 mock 签名）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct MovementFilters {
    #[serde(default)]
    pub warehouse_id: Option<i64>,
    #[serde(default)]
    pub variety_id: Option<i64>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub page: Option<i64>,
    #[serde(default)]
    pub page_size: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MovementPage {
    pub rows: Vec<MovementRow>,
    pub total: i64,
}

/// 流水账：倒序分页。「谁在什么时候把多少粮挪进挪出了哪个仓」的原始凭据。
pub fn movements(conn: &Connection, f: &MovementFilters) -> Result<MovementPage, String> {
    let page = f.page.unwrap_or(1).max(1);
    let size = f.page_size.unwrap_or(50).clamp(1, 2000);

    let mut where_sql = String::from(" WHERE 1 = 1");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    let mut n = 0usize;
    let mut push = |frag: &str, val: Box<dyn rusqlite::ToSql>| {
        n += 1;
        where_sql.push_str(&frag.replace('$', &n.to_string()));
        args.push(val);
    };
    if let Some(w) = f.warehouse_id {
        push(&format!(" AND ({MOVE_WH}) = $"), Box::new(w));
    }
    if let Some(v) = f.variety_id {
        push(" AND m.variety_id = $", Box::new(v));
    }
    if let Some(k) = f.kind.as_deref().filter(|s| *s != "all" && !s.is_empty()) {
        push(" AND m.kind = $", Box::new(k.to_string()));
    }
    if let Some(d) = f.date_from.clone().filter(|s| !s.is_empty()) {
        push(" AND m.business_date >= $", Box::new(d));
    }
    if let Some(d) = f.date_to.clone().filter(|s| !s.is_empty()) {
        push(" AND m.business_date <= $", Box::new(d));
    }

    let total: i64 = conn
        .query_row(
            &format!("SELECT COUNT(1) FROM stock_movement m{where_sql}"),
            rusqlite::params_from_iter(args.iter()),
            |r| r.get(0),
        )
        .map_err(|e| format!("统计库存流水失败：{e}"))?;

    n += 1;
    let limit_at = n.to_string();
    n += 1;
    let offset_at = n.to_string();
    args.push(Box::new(size));
    args.push(Box::new(offset((page, size))));
    let sql = format!("{MOVE_SELECT}{where_sql} ORDER BY m.operated_at DESC, m.id DESC LIMIT ?{limit_at} OFFSET ?{offset_at}");
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("读取库存流水失败：{e}"))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), map_move_row)
        .and_then(|m| m.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("读取库存流水失败：{e}"))?;
    Ok(MovementPage { rows, total })
}

fn offset((page, size): (i64, i64)) -> i64 {
    (page - 1) * size
}

/// 某 仓房 × 品种 的账面结存（0.1kg）。出库完成时拿它判超库存——**只警示，不拦车**。
pub fn available_01kg(conn: &Connection, warehouse_id: i64, variety_id: Option<i64>) -> Result<i64, String> {
    let sql = format!(
        "SELECT COALESCE(SUM(CASE WHEN m.kind = 'in' THEN m.weight_01kg ELSE -m.weight_01kg END), 0)
           FROM stock_movement m
          WHERE ({MOVE_WH}) = ?1
            AND (m.variety_id = ?2 OR (?2 IS NULL AND m.variety_id IS NULL))"
    );
    conn.query_row(&sql, params![warehouse_id, variety_id], |r| r.get::<_, i64>(0))
        .map_err(|e| format!("查询账面结存失败：{e}"))
}

// ==================================================================== 读·仓房粒度

/// 一个仓房的库存汇总：档案页那一行「期初 / 结存 / 待入账 / 剩余容量」与制单去向下拉
/// 读的都是这一份，所以口径必须与 [`balance`]、[`available_01kg`] 完全同源——
/// 这里只换聚合粒度（跨品种合并），判据一个字都不另写。
#[derive(Debug, Clone)]
pub struct WarehouseTotals {
    pub warehouse_id: i64,
    /// 期初建账量（0.1kg）。`None` ＝这个仓房从没申报过期初，与「申报了 0（空仓起账）」是两回事。
    pub opening_01kg: Option<i64>,
    /// 期初登记到哪个品种（`grain_variety.id`）。`None`＝期初没细分品种：仓房总量照计，
    /// 但按品种的出库账面看不见它，所以档案页与编辑弹窗都要把它显出来，别让站长以为已细分。
    pub opening_variety_id: Option<i64>,
    /// 账面结存（0.1kg），含期初（期初本身就是一条 `in` 流水）。
    pub balance_01kg: i64,
    /// 已卸完但还没结算入账的部分：不计入 `balance_01kg`，但占着真实容积，故值仓看容量时要在。
    pub pending_in_01kg: i64,
}

/// 仓房粒度的汇总（跨品种合并）。全表读一次、按 id 挂到仓房上，与货位同一套省 N+1 的做法。
pub fn warehouse_totals(conn: &Connection) -> Result<Vec<WarehouseTotals>, String> {
    // 流水侧：结存按 MOVE_WH 归仓（入库记 to_warehouse、出库从 from_warehouse 扣），
    // 期初单独用 MAX(CASE...) 取——0022 的 `uk_stock_opening` 已保证一仓一笔，取不到即 NULL。
    let sql = format!(
        "SELECT ({MOVE_WH}) AS wh,
                MAX(CASE WHEN m.is_opening = 1 THEN m.weight_01kg END),
                MAX(CASE WHEN m.is_opening = 1 THEN m.variety_id END),
                COALESCE(SUM(CASE WHEN m.kind = 'in' THEN m.weight_01kg ELSE -m.weight_01kg END), 0)
           FROM stock_movement m
          WHERE ({MOVE_WH}) IS NOT NULL
          GROUP BY wh"
    );
    let mut agg: Vec<(i64, Option<i64>, Option<i64>, i64)> = {
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("汇总仓房库存失败：{e}"))?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .and_then(|m| m.collect::<Result<Vec<_>, _>>())
            .map_err(|e| format!("汇总仓房库存失败：{e}"))?
    };

    // 待入账侧：与 [`balance`] 同一个 WHERE，只是不再按品种拆开。
    let pending: Vec<(i64, i64)> = {
        let sql = format!(
            "SELECT o.warehouse_id,
                    COALESCE(SUM(COALESCE(o.settlement_weight_01kg, o.net_weight_01kg, 0)), 0)
               FROM weigh_order o
              WHERE {PENDING_IN_WHERE}
              GROUP BY o.warehouse_id"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("汇总待入账入仓量失败：{e}"))?;
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .and_then(|m| m.collect::<Result<Vec<_>, _>>())
            .map_err(|e| format!("汇总待入账入仓量失败：{e}"))?
    };

    // 只称完没结算、仓房里连一条流水都没有的仓房不会出现在 agg 里，先按档案补齐骨架，
    // 否则档案页那一行会整个消失（下拉里也读不到它的容量），像被删了一样。
    let mut rows: Vec<WarehouseTotals> = conn
        .prepare("SELECT id FROM warehouse WHERE deleted_at IS NULL")
        .and_then(|mut s| {
            s.query_map([], |r| r.get::<_, i64>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| format!("读取仓房清单失败：{e}"))?
        .into_iter()
        .map(|id| WarehouseTotals {
            warehouse_id: id,
            opening_01kg: None,
            opening_variety_id: None,
            balance_01kg: 0,
            pending_in_01kg: 0,
        })
        .collect();
    for (wh, opening, opening_variety, balance) in agg.drain(..) {
        match rows.iter_mut().find(|t| t.warehouse_id == wh) {
            Some(t) => {
                t.opening_01kg = opening;
                t.opening_variety_id = opening_variety;
                t.balance_01kg = balance;
            }
            // 流水指向的仓房已软删：档案页不显示它，但结存数字仍要能查（历史账不骗人）
            None => rows.push(WarehouseTotals {
                warehouse_id: wh,
                opening_01kg: opening,
                opening_variety_id: opening_variety,
                balance_01kg: balance,
                pending_in_01kg: 0,
            }),
        }
    }
    for (wh, qty) in pending {
        if let Some(t) = rows.iter_mut().find(|t| t.warehouse_id == wh) {
            t.pending_in_01kg = qty;
        }
    }
    Ok(rows)
}

// =========================================================================== 写

/// 一张磅单在库侧的投影长什么样（与 0021 回填的取值口径一致）。
struct InSource {
    order_id: i64,
    warehouse_id: i64,
    variety_id: Option<i64>,
    grade: Option<String>,
    party_id: Option<i64>,
    slot_id: Option<i64>,
    weight_01kg: i64,
    price_fen_per_ton: Option<i64>,
    business_date: String,
    amount_fen: Option<i64>,
    operator_id: i64,
}

/// 把一张磅单的入仓投影同步到 `stock_movement`。
///
/// 幂等：符合条件就 UPSERT 那一行（`uk_move_in_order` 保证一张单只一条非冲销入库行），
/// 不再符合条件就删掉它。**在调用方（结算、补录去向）自己的事务里跑**——投影失败必须
/// 让整笔业务一起回滚，绝不能出现「钱结了、库存账没动」这种两条腿分家。
pub fn sync_in_movement(conn: &Connection, order_id: i64) -> Result<(), String> {
    let sql = format!(
        "SELECT id, warehouse_id, variety_id, grade, party_id, slot_id,
                settlement_weight_01kg, price_fen_per_ton,
                business_date, goods_amount_fen, COALESCE(keeper_id, created_by)
           FROM weigh_order
          WHERE id = ?1 AND {IN_QUALIFIED}"
    );
    let src: Option<InSource> = conn
        .query_row(&sql, params![order_id], |r| {
            Ok(InSource {
                order_id: r.get(0)?,
                warehouse_id: r.get(1)?,
                variety_id: r.get(2)?,
                grade: r.get(3)?,
                party_id: r.get(4)?,
                slot_id: r.get(5)?,
                weight_01kg: r.get(6)?,
                price_fen_per_ton: r.get(7)?,
                business_date: r.get(8)?,
                amount_fen: r.get(9)?,
                operator_id: r.get(10)?,
            })
        })
        .optional()
        .map_err(|e| format!("读取入仓磅单失败：{e}"))?;

    let Some(s) = src else {
        // 不再符合条件（去向被清空、或整单被红冲）：撤掉投影，真相仍在磅单上
        conn.execute(
            "DELETE FROM stock_movement WHERE kind = 'in' AND order_id = ?1 AND reversal_of_id IS NULL",
            params![order_id],
        )
        .map_err(|e| format!("撤入仓流水失败：{e}"))?;
        return Ok(());
    };

    let now = crate::db::migrate::now_iso();
    let changed = conn
        .execute(
            "UPDATE stock_movement
                SET variety_id = ?2, grade = ?3, party_id = ?4, to_warehouse_id = ?5, to_slot_id = ?6,
                    weight_01kg = ?7, price_fen_per_ton = ?8, amount_fen = ?9,
                    business_date = ?10, operated_at = ?11, operator_id = ?12
              WHERE kind = 'in' AND order_id = ?1 AND reversal_of_id IS NULL",
            params![
                s.order_id, s.variety_id, s.grade, s.party_id, s.warehouse_id, s.slot_id,
                s.weight_01kg, s.price_fen_per_ton, s.amount_fen, s.business_date, now, s.operator_id,
            ],
        )
        .map_err(|e| format!("更新入仓流水失败：{e}"))?;
    if changed == 0 {
        conn.execute(
            "INSERT INTO stock_movement (kind, order_id, party_id, variety_id, grade,
                    to_warehouse_id, to_slot_id, weight_01kg, price_fen_per_ton, amount_fen,
                    business_date, operated_at, operator_id, remark)
             VALUES ('in', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     '入仓投影（去向已定，数量以结算重量为准）')",
            params![
                s.order_id, s.party_id, s.variety_id, s.grade, s.warehouse_id, s.slot_id,
                s.weight_01kg, s.price_fen_per_ton, s.amount_fen, s.business_date, now, s.operator_id,
            ],
        )
        .map_err(|e| format!("写入仓流水失败：{e}"))?;
    }
    Ok(())
}

/// 仓房期初建账流水（03 §9.9「期初」／0022）。`remark` 与 `stock.rs` 里派生流水那句同规：
/// 流水表上看得懂这笔钱不是从磅单来的，就不必再为它加一列枚举。
const OPENING_REMARK: &str = "期初建账（仓房档案录入，不来自磅单/出库单）";

/// 写入 / 改写 / 撤销一个仓房的期初建账行。**幂等**：一个仓房永远只有一条 `is_opening = 1`
/// 的行（0022 的 `uk_stock_opening` 逼住），第二次保存走 UPDATE，不会攒出第二笔。
///
/// 与仓房本行在同一个调用方事务里提交（`masters::save_warehouse`）——档案存上了、账没记上，
/// 就是「仓里明明压着 1200 吨、系统说空仓」那种错；反过来记了账没存档案也一样糟。
///
/// `kind` 写死 `'in'`：结存与带符号流水都以 `'in'` 为正向（见 `MOVE_WH`），用 `'adjust'`
/// 会被算成从别的仓扣出去的盘亏。`variety_id` 留空＝这笔期初没细分到品种，仓房总量照计，
/// 但按品种的出库账面看不见它——所以界面上品种是可填项，填了才精准。
pub fn set_opening(
    conn: &Connection,
    actor: &crate::auth::AuthProfile,
    warehouse_id: i64,
    variety_id: Option<i64>,
    opening_01kg: Option<i64>,
) -> Result<(), String> {
    if let Some(w) = opening_01kg {
        if w < 0 {
            return Err("期初库存不能是负数；要往下修正账面请走出库单".into());
        }
    }
    let now = crate::db::migrate::now_iso();
    let business_date = now.chars().take(10).collect::<String>();

    let Some(w) = opening_01kg else {
        // 清空＝撤销建账行。留着一条 0 也算「申报过期初」，两回事，所以是删不是置零。
        conn.execute(
            "DELETE FROM stock_movement WHERE is_opening = 1 AND to_warehouse_id = ?1",
            params![warehouse_id],
        )
        .map_err(|e| format!("撤销期初建账失败：{e}"))?;
        return Ok(());
    };

    let changed = conn
        .execute(
            "UPDATE stock_movement
                SET variety_id = ?2, weight_01kg = ?3, business_date = ?4,
                    operated_at = ?5, operator_id = ?6
              WHERE is_opening = 1 AND to_warehouse_id = ?1",
            params![warehouse_id, variety_id, w, business_date, now, actor.id],
        )
        .map_err(|e| format!("更新期初建账失败：{e}"))?;
    if changed > 0 {
        return Ok(());
    }
    conn.execute(
        "INSERT INTO stock_movement (kind, variety_id, to_warehouse_id, weight_01kg,
                business_date, operated_at, operator_id, is_opening, remark)
         VALUES ('in', ?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
        params![variety_id, warehouse_id, w, business_date, now, actor.id, OPENING_REMARK],
    )
    .map_err(|e| format!("写入期初建账失败：{e}"))?;
    Ok(())
}

/// 某仓房当前的期初建账量（0.1kg）。审计里那句「从多少改成多少」读它，不重算一遍判据。
pub fn opening_01kg(conn: &Connection, warehouse_id: i64) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT weight_01kg FROM stock_movement WHERE is_opening = 1 AND to_warehouse_id = ?1",
        params![warehouse_id],
        |r| r.get::<_, i64>(0),
    )
    .optional()
    .map_err(|e| format!("读取期初建账失败：{e}"))
}

// ==================================================================== Tauri 命令

#[tauri::command]
pub async fn stock_balance(app: AppHandle) -> Result<Vec<BalanceRow>, String> {
    read_only(&app, balance, "库存结存读取").await
}

#[tauri::command]
pub async fn stock_movements(app: AppHandle, input: MovementFilters) -> Result<MovementPage, String> {
    read_only(&app, move |conn| movements(conn, &input), "库存流水读取").await
}
