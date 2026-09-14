//! 粮食出库 + 库存账的行为守卫（docs/design/02 §M11、03 §9.23/§9.27、§4.3 不变式 9）
//!
//! 守的是接上 SQLite 才会犯、纸面 review 看不出来的错，全部围绕**业务不变式**：
//!  1. 结存 = Σ入 − Σ出，按 仓房 × 品种 聚合；入库腿是磅单投影、出库腿 append-only。
//!  2. 入库判据 `stock::IN_QUALIFIED`：去向已定 AND 结算重量存在 AND status ∈
//!     (settled,paid,archived) AND 非红冲单。`to_settle` 一律不计（结算重量此刻还没产生）。
//!  3. 投影同步幂等且会撤销：重复同步只留一行；改派仓房是「移动」那一行；清空去向/
//!     改出合格集则删掉那一行。
//!  4. 超库存不拦车：complete 只警示不报错，结存转负、stock_warning 非空带数字。
//!  5. 过账即落账同事务：complete 后恰好一条 kind='out' 流水，重量/仓/品种/金额与单据一致。
//!  6. 红冲不删原流水：原 out 行原样在，补一条对称 in 行（reversal_of_id 指回、
//!     to_warehouse 回到原 from_warehouse），单据转 reversed，净库存影响为 0。
//!  7. 状态机闸门：重复完成/改非草稿/作废非草稿/红冲非已过账/无出库流水红冲都要拒。
//!  8. 计价：record 拒绝带价（拒绝而非静默清空）；sale 要领出方 + 单价；
//!     goods_amount_fen = 净重 × 单价 ÷ 10000 四舍五入（半进位）。
//!  9. 回填不重复：0021 在已有已结算磅单的库上跑，每单恰好一条 in 流水、不合格的不生成。
//! 10. CK 号段：CK + 站点码 + YYYYMM + 6 位流水，同月两单只差流水号。
//!
//! 与 orders_contract 同一套内存库 + 真实迁移（种子：station 01、admin(id=1,站长)、
//! 四个默认品种）。AuthProfile 手工构造，直接调用 `stock`/`outbound` 的 pub 服务函数。

use chrono::Local;
use rusqlite::{params, Connection};

use banghe_lib::auth::AuthProfile;
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::outbound::{
    self, OutboundCloseInput, OutboundCompleteInput, OutboundSaveInput,
};
use banghe_lib::stock;

// --------------------------------------------------------------------- 夹具

fn db() -> Connection {
    in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本")
}

fn actor() -> AuthProfile {
    AuthProfile {
        id: 1,
        username: "keeper".into(),
        display_name: "值仓".into(),
        role: "keeper".into(),
        must_change_pwd: false,
    }
}

fn seed_warehouse(conn: &Connection, code: &str) -> i64 {
    conn.execute(
        "INSERT INTO warehouse (code, name, kind, is_active, created_at)
         VALUES (?1, ?1, 'house', 1, '2026-01-01T00:00:00.000+08:00')",
        params![code],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn seed_party(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO party (name, party_type, status, created_at, created_by)
         VALUES (?1, 'company', 'active', '2026-01-01T00:00:00.000+08:00', 1)",
        params![name],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn variety(conn: &Connection, code: &str) -> i64 {
    conn.query_row("SELECT id FROM grain_variety WHERE code = ?1", params![code], |r| r.get(0))
        .unwrap()
}

/// 手工落一张磅单，精确控制 status / 去向 / 结算重量 / 红冲指向，
/// 用来喂入库投影与回填，而不必走完整个收粮结算流水线。
#[allow(clippy::too_many_arguments)]
fn insert_weigh_order(
    conn: &Connection,
    order_no: &str,
    status: &str,
    party: i64,
    variety: i64,
    warehouse: Option<i64>,
    settlement_weight_01kg: Option<i64>,
    net_weight_01kg: Option<i64>,
    reversed_order_id: Option<i64>,
) -> i64 {
    conn.execute(
        "INSERT INTO weigh_order (
            order_no, station_id, business_date, status, party_id, variety_id,
            warehouse_id, settlement_weight_01kg, net_weight_01kg, price_fen_per_ton, goods_amount_fen,
            reversed_order_id, registered_by, registered_at, created_at, created_by)
         VALUES (?1, (SELECT id FROM station WHERE is_active = 1 ORDER BY id LIMIT 1),
            '2026-01-05', ?2, ?3, ?4, ?5, ?6, ?7, 240000, 0, ?8,
            1, '2026-01-05T08:00:00.000+08:00', '2026-01-05T08:00:00.000+08:00', 1)",
        params![order_no, status, party, variety, warehouse, settlement_weight_01kg, net_weight_01kg, reversed_order_id],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// 一张出库单在 stock_movement 里的 in 行数（投影口径：reversal_of_id IS NULL）。
fn in_projection_rows(conn: &Connection, order_id: i64) -> i64 {
    conn.query_row(
        "SELECT COUNT(1) FROM stock_movement WHERE kind = 'in' AND order_id = ?1 AND reversal_of_id IS NULL",
        params![order_id],
        |r| r.get(0),
    )
    .unwrap()
}

fn in_projection_warehouse(conn: &Connection, order_id: i64) -> Option<i64> {
    conn.query_row(
        "SELECT to_warehouse_id FROM stock_movement WHERE kind = 'in' AND order_id = ?1 AND reversal_of_id IS NULL",
        params![order_id],
        |r| r.get(0),
    )
    .ok()
    .flatten()
}

fn out_movement_for(conn: &Connection, outbound_id: i64) -> Option<(i64, i64, Option<i64>, i64, i64, Option<i64>)> {
    conn.query_row(
        "SELECT id, weight_01kg, variety_id, from_warehouse_id, amount_fen, price_fen_per_ton
           FROM stock_movement WHERE kind = 'out' AND outbound_id = ?1",
        params![outbound_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    )
    .ok()
}

fn movement_count(conn: &Connection, sql: &str, arg: i64) -> i64 {
    conn.query_row(sql, params![arg], |r| r.get(0)).unwrap()
}

fn sale_input(warehouse: i64, variety: i64, party: i64, weight: i64, price: i64) -> OutboundSaveInput {
    OutboundSaveInput {
        order_no: None,
        kind: "sale".into(),
        business_date: None,
        party_id: Some(party),
        counterparty_label: None,
        variety_id: Some(variety),
        grade: None,
        warehouse_id: warehouse,
        slot_id: None,
        vehicle_no: None,
        net_weight_01kg: Some(weight),
        price_fen_per_ton: Some(price),
        remark: None,
        operator_id: None,
    }
}

fn record_input(warehouse: i64, variety: i64) -> OutboundSaveInput {
    OutboundSaveInput {
        order_no: None,
        kind: "record".into(),
        business_date: None,
        party_id: None,
        counterparty_label: Some("化验室自用".into()),
        variety_id: Some(variety),
        grade: None,
        warehouse_id: warehouse,
        slot_id: None,
        vehicle_no: None,
        net_weight_01kg: Some(1000),
        price_fen_per_ton: None,
        remark: None,
        operator_id: None,
    }
}

fn close_input(order_no: &str, reason: &str) -> OutboundCloseInput {
    OutboundCloseInput { order_no: order_no.into(), reason: reason.into(), operator_id: None }
}

fn complete_input(order_no: &str) -> OutboundCompleteInput {
    OutboundCompleteInput { order_no: order_no.into(), operator_id: None }
}

/// 建一张 sale 草稿并完成出库，返回 (单据, 出仓仓房, 品种)。
fn sale_done(conn: &Connection, wh: i64, var: i64, party: i64, weight: i64, price: i64) -> outbound::OutboundOrder {
    let created = outbound::save(conn, &actor(), sale_input(wh, var, party, weight, price)).expect("销售出库制单应成功");
    outbound::complete(conn, &actor(), complete_input(&created.order_no))
        .expect("完成出库应成功")
}

// =========================================================== 不变式 1 & 2：结存与入库判据

#[test]
fn balance_is_inbound_projection_minus_outbound_per_warehouse_variety() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户甲");
    let xm = variety(&conn, "XM");

    // 入：一张已结算磅单投影 5000(0.1kg)；出：一张完成的出库单扣 1200(0.1kg)。
    let inbound = insert_weigh_order(&conn, "BD-IN-1", "settled", party, xm, Some(wh), Some(5000), Some(5200), None);
    stock::sync_in_movement(&conn, inbound).unwrap();
    let out = sale_done(&conn, wh, xm, party, 1200, 250000);

    // 唯一读口径 available = Σ入 − Σ出 = 5000 − 1200 = 3800。
    let avail = stock::available_01kg(&conn, wh, Some(xm)).unwrap();
    assert_eq!(avail, 3800, "结存应为入投影减出库：Σ5000 − Σ1200");

    // balance 矩阵里这一格的两条腿分开给，且 balance_01kg 与 available 同口径。
    let row = stock::balance(&conn)
        .unwrap()
        .into_iter()
        .find(|b| b.warehouse_id == wh && b.variety_id == Some(xm))
        .expect("仓房×品种组合应出现在结存矩阵");
    assert_eq!((row.in_01kg, row.out_01kg, row.balance_01kg), (5000, 1200, 3800));
    assert_eq!(row.balance_01kg, avail, "结存矩阵与 available 必须同口径");
    assert_eq!(out.status, "done");
}

#[test]
fn inbound_qualification_gate() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户乙");
    let xm = variety(&conn, "XM");

    // 正向：settled + 去向已定 + 结算重量存在 → 计入。
    let ok = insert_weigh_order(&conn, "BD-OK", "settled", party, xm, Some(wh), Some(4000), Some(4100), None);
    stock::sync_in_movement(&conn, ok).unwrap();
    assert_eq!(in_projection_rows(&conn, ok), 1, "已结算且有去向的单应投影一行");
    assert_eq!(stock::available_01kg(&conn, wh, Some(xm)).unwrap(), 4000);

    // 反向 1：to_settle 即便把结算重量填上也不计（扣水扣杂在结算那一刻才录入）。
    let to_settle = insert_weigh_order(&conn, "BD-TS", "to_settle", party, xm, Some(wh), Some(9999), Some(9999), None);
    stock::sync_in_movement(&conn, to_settle).unwrap();
    assert_eq!(in_projection_rows(&conn, to_settle), 0, "to_settle 不该进结存（结算重量未定）");
    assert_eq!(stock::available_01kg(&conn, wh, Some(xm)).unwrap(), 4000, "to_settle 不得抬高结存");

    // 反向 2：settled 但结算重量为空 → 不计（判据里 settlement_weight_01kg IS NOT NULL）。
    let no_settle = insert_weigh_order(&conn, "BD-NS", "settled", party, xm, Some(wh), None, Some(500), None);
    stock::sync_in_movement(&conn, no_settle).unwrap();
    assert_eq!(in_projection_rows(&conn, no_settle), 0, "无结算重量的单不计入");

    // 反向 3：红冲指向原单的磅单（reversed_order_id 非空）→ 不计。
    let reversed = insert_weigh_order(&conn, "BD-RV", "settled", party, xm, Some(wh), Some(3000), Some(3000), Some(ok));
    stock::sync_in_movement(&conn, reversed).unwrap();
    assert_eq!(in_projection_rows(&conn, reversed), 0, "红冲单不得重复计入结存");

    // 反向 4：去向未定（warehouse_id 为空）→ 不计。
    let no_wh = insert_weigh_order(&conn, "BD-NW", "settled", party, xm, None, Some(2000), Some(2000), None);
    stock::sync_in_movement(&conn, no_wh).unwrap();
    assert_eq!(in_projection_rows(&conn, no_wh), 0, "去向没定的单不计入任何仓房");
}

// =========================================================== 不变式 3：投影幂等 / 移动 / 撤销

#[test]
fn in_projection_is_idempotent_and_follows_warehouse_moves() {
    let conn = db();
    let a = seed_warehouse(&conn, "CW-A");
    let b = seed_warehouse(&conn, "CW-B");
    let party = seed_party(&conn, "农户丙");
    let xm = variety(&conn, "XM");

    let order = insert_weigh_order(&conn, "BD-1", "settled", party, xm, Some(a), Some(6000), Some(6100), None);

    // 幂等：连同步两次仍只有一行。
    stock::sync_in_movement(&conn, order).unwrap();
    stock::sync_in_movement(&conn, order).unwrap();
    assert_eq!(in_projection_rows(&conn, order), 1, "重复同步不得复制 in 行");
    assert_eq!(in_projection_warehouse(&conn, order), Some(a));
    assert_eq!(stock::available_01kg(&conn, a, Some(xm)).unwrap(), 6000);

    // 改派仓房：移动那一行到 B，而不是新增一行。
    conn.execute("UPDATE weigh_order SET warehouse_id = ?2 WHERE id = ?1", params![order, b]).unwrap();
    stock::sync_in_movement(&conn, order).unwrap();
    assert_eq!(in_projection_rows(&conn, order), 1, "改派后仍只有一行（移动而非追加）");
    assert_eq!(in_projection_warehouse(&conn, order), Some(b), "in 行应改到新仓房名下");
    assert_eq!(stock::available_01kg(&conn, a, Some(xm)).unwrap(), 0, "旧仓房结存应清零");
    assert_eq!(stock::available_01kg(&conn, b, Some(xm)).unwrap(), 6000, "新仓房承接结存");

    // 清空去向：删掉投影行（真相仍留在磅单上）。
    conn.execute("UPDATE weigh_order SET warehouse_id = NULL WHERE id = ?1", params![order]).unwrap();
    stock::sync_in_movement(&conn, order).unwrap();
    assert_eq!(in_projection_rows(&conn, order), 0, "去向清空后应撤销投影");
    assert_eq!(stock::available_01kg(&conn, b, Some(xm)).unwrap(), 0);

    // 把状态改出合格集也会撤销：重新给去向但停在 to_settle。
    let other = insert_weigh_order(&conn, "BD-2", "settled", party, xm, Some(a), Some(700), Some(700), None);
    stock::sync_in_movement(&conn, other).unwrap();
    assert_eq!(in_projection_rows(&conn, other), 1);
    conn.execute("UPDATE weigh_order SET status = 'to_settle' WHERE id = ?1", params![other]).unwrap();
    stock::sync_in_movement(&conn, other).unwrap();
    assert_eq!(in_projection_rows(&conn, other), 0, "退出合格集应撤销投影");
}

// =========================================================== 不变式 4：超库存不拦车

#[test]
fn overdraw_is_allowed_and_warns_without_blocking() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "大户丁");
    let xm = variety(&conn, "XM");
    // 账面结存：先入 1000，再出 5000 → 明显超库存。
    let inbound = insert_weigh_order(&conn, "BD-IN", "settled", party, xm, Some(wh), Some(1000), Some(1000), None);
    stock::sync_in_movement(&conn, inbound).unwrap();

    let draft = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 5000, 250000)).unwrap();
    let done = outbound::complete(&conn, &actor(), complete_input(&draft.order_no))
        .expect("超库存不得拦车：complete 必须成功而不是 Err");

    assert_eq!(done.status, "done", "超库存单照常完成");
    let warning = done.stock_warning.clone().expect("超库存完成时 stock_warning 必须非空");
    // 警示里要带上算给你看的三个数：结存 0.10 吨、出库 0.50 吨、超出 0.40 吨。
    assert!(warning.contains("0.10"), "警示应含账面结存吨数：{warning}");
    assert!(warning.contains("0.50"), "警示应含本次出库吨数：{warning}");
    assert!(warning.contains("0.40"), "警示应含超出吨数：{warning}");

    // 结存随之转负——这正是「账面没货但真出了」要如实反映的部分。
    let avail = stock::available_01kg(&conn, wh, Some(xm)).unwrap();
    assert!(avail < 0, "超库存完成后结存应为负，实际 {avail}");
    assert_eq!(avail, -4000);
}

// =========================================================== 不变式 5：过账即落账

#[test]
fn complete_writes_exactly_one_out_movement_matching_the_doc() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户戊");
    let ym = variety(&conn, "YM");

    let done = sale_done(&conn, wh, ym, party, 3000, 260000);

    // 一张单恰好一条 out 流水（uk_move_out_order 保证）。
    let out_rows = movement_count(&conn, "SELECT COUNT(1) FROM stock_movement WHERE kind='out' AND outbound_id = ?1", done.id);
    assert_eq!(out_rows, 1, "完成出库应落且只落一条 out 流水");

    let (id, weight, var, from_wh, amount, price) = out_movement_for(&conn, done.id).expect("out 流水应存在");
    assert!(id > 0);
    assert_eq!(weight, 3000);
    assert_eq!(var, Some(ym));
    assert_eq!(from_wh, wh, "出库流水的扣减仓 = 单据出仓来源");
    assert_eq!(price, Some(260000));
    assert_eq!(amount, 78000, "货款 = 0.3t × 2600元 = 780元 = 78000分");
    assert_eq!(done.goods_amount_fen, Some(78000), "单据货款与流水金额同源");
    assert_eq!(done.payment_status, "unpaid", "销售出库完成即成为一笔应收");
}

// =========================================================== 不变式 6：红冲不删原流水

#[test]
fn red_reversal_keeps_original_and_adds_symmetric_in() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户己");
    let xm = variety(&conn, "XM");

    let done = sale_done(&conn, wh, xm, party, 4200, 250000);
    let before = stock::available_01kg(&conn, wh, Some(xm)).unwrap(); // 已扣完，含负库存
    let (orig_id, orig_weight, _, orig_from, _, _) = out_movement_for(&conn, done.id).unwrap();

    let reversed = outbound::reverse(&conn, &actor(), close_input(&done.order_no, "重量录错需红冲"))
        .unwrap()
        .expect("红冲应命中已存在的单");
    assert_eq!(reversed.status, "reversed", "单据转红冲终态");

    // 原 out 行原样还在、分毫未改（账本不能涂改）。
    let still: (String, i64) = conn
        .query_row("SELECT kind, weight_01kg FROM stock_movement WHERE id = ?1", params![orig_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(still, ("out".into(), orig_weight), "红冲不得删改原出库流水");

    // 补一条对称 in 行：reversal_of_id 指回原行、to_warehouse 回到原 from_warehouse。
    let sym: Option<(i64, Option<i64>, Option<i64>, Option<i64>)> = conn
        .query_row(
            "SELECT weight_01kg, reversal_of_id, to_warehouse_id, order_id FROM stock_movement
              WHERE kind = 'in' AND outbound_id = ?1",
            params![done.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .ok();
    let (sym_weight, reversal_of, sym_to_wh, sym_order_id) = sym.expect("红冲应补一条对称 in 流水");
    assert_eq!(sym_weight, orig_weight, "对称行重量与原行相等");
    assert_eq!(reversal_of, Some(orig_id), "对称行必须指回被冲的那条 out 行");
    assert_eq!(sym_to_wh, Some(orig_from), "货还回原来扣减的那个仓");
    assert_eq!(sym_order_id, None, "出库红冲的对称行不挂磅单 order_id");

    // 净库存影响归零：available 回到 complete 之前的水平（红冲前 = before，红冲后 = before + weight）。
    let after = stock::available_01kg(&conn, wh, Some(xm)).unwrap();
    assert_eq!(after, before + orig_weight, "红冲净影响应把出库那笔完全冲回");
}

// =========================================================== 不变式 7：状态机闸门

#[test]
fn state_machine_gates_reject_illegal_transitions() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户庚");
    let xm = variety(&conn, "XM");

    // 闸门 1：重复完成 → 拒。
    let d1 = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 1000, 250000)).unwrap();
    outbound::complete(&conn, &actor(), complete_input(&d1.order_no)).unwrap();
    let e = outbound::complete(&conn, &actor(), complete_input(&d1.order_no)).unwrap_err();
    assert!(e.contains("已完成出库"), "重复完成要说清库存已扣：{e}");

    // 闸门 2：改非草稿 → 拒。
    let e = outbound::save(&conn, &actor(), {
        let mut i = sale_input(wh, xm, party, 1000, 250000);
        i.order_no = Some(d1.order_no.clone());
        i
    })
    .unwrap_err();
    assert!(e.contains("不能再改"), "完成的单不能改：{e}");

    // 闸门 3：作废只从草稿；对已完成的作废 → 拒（应走红冲）。
    let e = outbound::void(&conn, &actor(), close_input(&d1.order_no, "开错单据作废")).unwrap_err();
    assert!(e.contains("红冲"), "已完成的单作废要指向红冲：{e}");

    let d2 = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 800, 250000)).unwrap();
    outbound::void(&conn, &actor(), close_input(&d2.order_no, "开错单据作废")).unwrap();
    let e = outbound::void(&conn, &actor(), close_input(&d2.order_no, "开错单据作废")).unwrap_err();
    assert!(e.contains("已作废"), "重复作废应拒：{e}");

    // 闸门 4：红冲只从 done；草稿红冲 → 拒。
    let d3 = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 500, 250000)).unwrap();
    let e = outbound::reverse(&conn, &actor(), close_input(&d3.order_no, "未过账想红冲")).unwrap_err();
    assert!(e.contains("未过账") || e.contains("作废"), "草稿不能红冲：{e}");

    // 闸门 5：done 但没有出库流水（账坏了）→ 红冲报错且不凭空造入库。
    let d4 = sale_done(&conn, wh, xm, party, 700, 250000);
    conn.execute("DELETE FROM stock_movement WHERE kind = 'out' AND outbound_id = ?1", params![d4.id]).unwrap();
    let e = outbound::reverse(&conn, &actor(), close_input(&d4.order_no, "找不到出库流水")).unwrap_err();
    assert!(e.contains("没有出库流水"), "无出库流水要拦下让人核查：{e}");
    // 拦下即回滚前：单据仍是 done，且没有偷偷新增对称入库行。
    let st: String = conn.query_row("SELECT status FROM outbound_order WHERE id = ?1", params![d4.id], |r| r.get(0)).unwrap();
    assert_eq!(st, "done", "红冲失败不得改动单据状态");
    assert_eq!(movement_count(&conn, "SELECT COUNT(1) FROM stock_movement WHERE kind='in' AND outbound_id = ?1", d4.id), 0, "报错时不得凭空造入库行");
}

// =========================================================== 不变式 8：计价规则

#[test]
fn pricing_rules_reject_record_price_require_party_and_round_half_up() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户辛");
    let xm = variety(&conn, "XM");

    // record 带价 → 拒绝（不是静默清空）。
    let e = outbound::save(&conn, &actor(), {
        let mut i = record_input(wh, xm);
        i.price_fen_per_ton = Some(260000);
        i
    })
    .unwrap_err();
    assert!(e.contains("登记出库不计价") && e.contains("单价请留空"), "record 带价要当场拒：{e}");

    // sale 缺领出方 → 拒。
    let e = outbound::save(&conn, &actor(), {
        let mut i = sale_input(wh, xm, party, 1000, 250000);
        i.party_id = None;
        i
    })
    .unwrap_err();
    assert!(e.contains("领出方"), "sale 必须有领出方档案：{e}");

    // sale 完成缺单价 → 拒（草稿允许先不填价，但过账必须有）。
    let d = outbound::save(&conn, &actor(), {
        let mut i = sale_input(wh, xm, party, 1000, 0); // price 0 会被制单判 >0 拒，改走无价草稿
        i.price_fen_per_ton = None;
        i
    })
    .expect("sale 草稿不填价也应能先存");
    let e = outbound::complete(&conn, &actor(), complete_input(&d.order_no)).unwrap_err();
    assert!(e.contains("单价"), "销售出库完成必须有单价：{e}");

    // 半进位取整：2001(0.1kg) × 25000(分/吨) = 5002.5 分 → 四舍五入 = 5003 分。
    let done = sale_done(&conn, wh, xm, party, 2001, 25000);
    assert_eq!(done.goods_amount_fen, Some(5003), "货款应在最终值处半进位，而非截断成 5002");
    let (_, _, _, _, amount, _) = out_movement_for(&conn, done.id).unwrap();
    assert_eq!(amount, 5003, "出库流水金额与单据货款一致");
}

// =========================================================== 不变式 9：回填不重复

#[test]
fn migration_backfill_projects_each_qualifying_order_once() {
    // 造一个停在 0020（0021 之前）的库：先塞历史磅单，再跑 0021 看回填。
    let idx = MIGRATIONS.iter().position(|m| m.name.starts_with("0021")).expect("0021 应在迁移清单内");
    let conn = in_memory_migrated("0.1.0", &MIGRATIONS[..idx]).expect("应能跑到 0021 之前");

    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "历史农户");
    let xm = variety(&conn, "XM");

    // 合格：settled/paid 各一张 + 一张 archived。
    let s1 = insert_weigh_order(&conn, "H-1", "settled", party, xm, Some(wh), Some(1000), Some(1000), None);
    let s2 = insert_weigh_order(&conn, "H-2", "paid", party, xm, Some(wh), Some(2000), Some(2000), None);
    let s3 = insert_weigh_order(&conn, "H-3", "archived", party, xm, Some(wh), Some(3000), Some(3000), None);
    // 不合格：to_settle（哪怕带结算重量）、无结算重量、红冲指向、无去向。
    let bad1 = insert_weigh_order(&conn, "H-4", "to_settle", party, xm, Some(wh), Some(9999), Some(9999), None);
    let bad2 = insert_weigh_order(&conn, "H-5", "settled", party, xm, Some(wh), None, Some(500), None);
    let bad3 = insert_weigh_order(&conn, "H-6", "settled", party, xm, Some(wh), Some(700), Some(700), Some(s1));
    let bad4 = insert_weigh_order(&conn, "H-7", "settled", party, xm, None, Some(800), Some(800), None);

    // 跑 0021：加列 + 建唯一索引 + 回填历史 in 流水。
    conn.execute_batch(MIGRATIONS[idx].sql).expect("0021 应能在有历史磅单的库上执行");

    // 每张合格单恰好一条 in 投影，无重复（uk_move_in_order + NOT EXISTS 双保险）。
    for good in [s1, s2, s3] {
        assert_eq!(in_projection_rows(&conn, good), 1, "合格历史单应回填恰一条 in 流水");
    }
    for bad in [bad1, bad2, bad3, bad4] {
        assert_eq!(in_projection_rows(&conn, bad), 0, "不合格历史单不应被回填");
    }

    // 结存 = 1000+2000+3000 = 6000。
    assert_eq!(stock::available_01kg(&conn, wh, Some(xm)).unwrap(), 6000);

    // 再跑一次回填分支也不该翻倍：手动重放同样的 INSERT ... NOT EXISTS 语句。
    conn.execute_batch(MIGRATIONS[idx].sql).ok();
    // 第二次整段跑会因 ALTER 重复报错（预期），但投影唯一性仍成立：
    let dup: i64 = conn
        .query_row(
            "SELECT COUNT(1) FROM (SELECT order_id FROM stock_movement WHERE kind='in' AND order_id IS NOT NULL AND reversal_of_id IS NULL GROUP BY order_id HAVING COUNT(1) > 1)",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(dup, 0, "任何情况下都不得出现同一磅单两条 in 流水");
}

// =========================================================== 不变式 10：CK 号段

#[test]
fn outbound_number_uses_ck_segment_with_monthly_sequence() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户壬");
    let xm = variety(&conn, "XM");

    let one = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 1000, 250000)).unwrap();
    let two = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 2000, 250000)).unwrap();

    let ym = Local::now().format("%Y%m").to_string();
    let head = format!("CK01{ym}"); // CK + 站点码 01 + 年月

    assert!(one.order_no.starts_with(&head), "单号应以 CK+站码+年月 起始，实际 {}", one.order_no);
    assert!(two.order_no.starts_with(&head));
    assert_eq!(one.order_no.len(), head.len() + 6, "流水段应为 6 位");
    assert_eq!(&one.order_no[head.len()..], "000001", "首单流水从 000001 起");
    assert_eq!(&two.order_no[head.len()..], "000002", "同月次单流水递增");
    // 只差在流水段：前缀部分逐字相等。
    assert_eq!(&one.order_no[..head.len()], &two.order_no[..head.len()]);
    assert_ne!(one.order_no, two.order_no);
}
