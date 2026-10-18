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
//! 11. 出库过地磅（0029）：净重 = 毛 − 皮 由服务端算、半截读数不顶掉净重、复称不删行、
//!     手录过一次来源就回不到 scale、称过的单表单改不动净重；
//!     **轨迹按 `doc_kind` 分家**——同 id 的磅单与出库单互不串号。
//!
//! 与 orders_contract 同一套内存库 + 真实迁移（种子：station 01、admin(id=1,站长)、
//! 四个默认品种）。AuthProfile 手工构造，直接调用 `stock`/`outbound` 的 pub 服务函数。

use chrono::Local;
use rusqlite::{params, Connection};

use banghe_lib::auth::AuthProfile;
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::orders;
use banghe_lib::outbound::{
    self, OutboundCaptureInput, OutboundCloseInput, OutboundCompleteInput, OutboundSaveInput,
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
    let head = format!("01{ym}"); // 站点码 01 + 年月（0026 起单号不带前缀）

    assert!(one.order_no.starts_with(&head), "单号应以站码+年月起始，实际 {}", one.order_no);
    assert!(two.order_no.starts_with(&head));
    assert_eq!(one.order_no.len(), head.len() + 6, "流水段应为 6 位");
    assert_eq!(&one.order_no[head.len()..], "000001", "首单流水从 000001 起");
    assert_eq!(&two.order_no[head.len()..], "000002", "同月次单流水递增");
    // 只差在流水段：前缀部分逐字相等。
    assert_eq!(&one.order_no[..head.len()], &two.order_no[..head.len()]);
    assert_ne!(one.order_no, two.order_no);
}

// ======================================== F11.6 出库过地磅（0029）：行为契约

fn cap_input(order_no: &str, weigh_type: &str, weight_01kg: i64, source: &str) -> OutboundCaptureInput {
    OutboundCaptureInput {
        order_no: order_no.into(),
        weigh_type: weigh_type.into(),
        weight_01kg,
        source: source.into(),
        raw_frame: (source == "scale").then(|| format!("=W{:.1}kg ST", weight_01kg as f64 / 10.0)),
        operator_id: None,
    }
}

/// 本单在轨迹表里有几行、其中采用几行。`doc_kind` 必须进 WHERE——不带就查不到真值。
fn trail_of(conn: &Connection, outbound_id: i64) -> (i64, i64) {
    let all = conn
        .query_row(
            "SELECT COUNT(1) FROM weigh_record WHERE doc_kind = 'outbound_order' AND order_id = ?1",
            params![outbound_id],
            |r| r.get(0),
        )
        .unwrap();
    let adopted = conn
        .query_row(
            "SELECT COUNT(1) FROM weigh_record WHERE doc_kind = 'outbound_order' AND order_id = ?1 AND is_adopted = 1",
            params![outbound_id],
            |r| r.get(0),
        )
        .unwrap();
    (all, adopted)
}

fn net_now(conn: &Connection, no: &str) -> Option<i64> {
    outbound::detail(conn, no).unwrap().and_then(|d| d.order.net_weight_01kg)
}

/// 毛 + 皮两捕凑出净重：净 = 毛 − 皮，货款按新净重当场重算。
#[test]
fn two_scale_captures_derive_net_and_reprice_goods() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户戊");
    let xm = variety(&conn, "XM");
    // 制单时手填净重 500.0kg（5000）、单价 2600 元/吨（260000 分/吨）→ 货款 130000 分
    let doc = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 5000, 260000)).unwrap();
    assert_eq!(doc.weight_source, "manual", "手填那一条路来源就是 manual");
    assert_eq!(doc.goods_amount_fen, Some(130000));

    // 只称了毛重：净重**不许**被半截读数顶掉
    let after_gross = outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "gross", 30000, "scale")).unwrap();
    assert_eq!(after_gross.gross_weight_01kg, Some(30000));
    assert_eq!(after_gross.tare_weight_01kg, None);
    assert_eq!(after_gross.net_weight_01kg, Some(5000), "只有一项时净重保持原值，别拿 30000 当净重");
    assert_eq!(after_gross.weight_source, "scale", "秤取的读数即地磅");
    assert_eq!(after_gross.goods_amount_fen, Some(130000), "净重没动，货款也不该动");

    // 补上皮重：净重与货款这一刻才由秤说了算
    let done = outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "tare", 12000, "scale")).unwrap();
    assert_eq!(done.net_weight_01kg, Some(18000), "净重 = 毛 − 皮");
    assert_eq!(done.goods_amount_fen, Some(468000), "货款按秤出来的新净重重算（18000 × 260000 ÷ 10⁴）");
    assert_eq!(done.weight_source, "scale");
    assert_eq!(trail_of(&conn, done.id), (2, 2), "毛皮各一条、都是采用值");
}

/// 复称不删行：旧那一捕留在轨迹里，只是「采用」标记挪到新那一捕。
#[test]
fn reweigh_moves_the_adopted_flag_without_deleting_history() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户己");
    let ym = variety(&conn, "YM");
    let doc = outbound::save(&conn, &actor(), sale_input(wh, ym, party, 1000, 250000)).unwrap();

    outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "gross", 30000, "scale")).unwrap();
    let again = outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "gross", 31000, "scale")).unwrap();

    assert_eq!(again.gross_weight_01kg, Some(31000), "采用值取最新那一捕");
    let (all, adopted) = trail_of(&conn, doc.id);
    assert_eq!(all, 2, "复称多一行轨迹，不是原地覆盖——迎检要看得见称过两次");
    assert_eq!(adopted, 1, "同一类型任何时候只有一个采用值");
    let old_row: i64 = conn
        .query_row(
            "SELECT weight_01kg FROM weigh_record WHERE doc_kind = 'outbound_order' AND order_id = ?1 AND seq = 1",
            params![doc.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old_row, 30000, "被替换那一捕的原始读数必须原样在");
}

/// 毛不高于皮 → 拒绝，而且**一行都不落**（先判后写，否则轨迹里全是废行、seq 也白占）。
#[test]
fn non_positive_net_is_rejected_without_writing_trail() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户庚");
    let dd = variety(&conn, "DD");
    let doc = outbound::save(&conn, &actor(), sale_input(wh, dd, party, 1000, 250000)).unwrap();

    outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "tare", 30000, "scale")).unwrap();
    let e = outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "gross", 30000, "scale")).unwrap_err();
    assert!(e.contains("净重不为正"), "毛 = 皮同样不是正净重，实际：{e}");
    assert_eq!(trail_of(&conn, doc.id), (1, 1), "被拒的那一捕不得留下轨迹行");

    for bad in [
        cap_input(&doc.order_no, "net", 30000, "scale"),
        cap_input(&doc.order_no, "tare", 30000, "guess"),
        cap_input(&doc.order_no, "tare", 0, "scale"),
    ] {
        assert!(outbound::capture(&conn, &actor(), bad).is_err(), "值域外的入参必须被拒");
    }
    assert_eq!(trail_of(&conn, doc.id), (1, 1), "三次被拒都没写进库");
}

/// 手录过一次，来源就永久标手录：秤取的那一捕不能替它洗白（迎检必查项）。
#[test]
fn one_manual_capture_keeps_source_manual() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户辛");
    let xm = variety(&conn, "XM");
    let doc = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 1000, 250000)).unwrap();

    outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "gross", 30000, "scale")).unwrap();
    let manual = outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "tare", 12000, "manual")).unwrap();
    assert_eq!(manual.weight_source, "manual", "皮重是人敲的，这一单就不能再自称「地磅」");
    assert_eq!(manual.net_weight_01kg, Some(18000), "手录照样把净重凑出来——手录不是二等公民");

    // 之后重上一磅也不能把来源改回 scale；只有把两捕都从秤上取，才谈得上「地磅」
    let later = outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "gross", 30500, "scale")).unwrap();
    assert_eq!(later.weight_source, "manual", "手录的皮重还在采用中，这一单就还不能自称「地磅」");
    assert_eq!(later.net_weight_01kg, Some(18500), "但采用值仍随新那一捕更新");

    // 空车重上一磅、把那条手录皮重换掉之后，来源才回到 scale：
    // 判据是"采用中的那一捕是不是手录"，不是"历史上手录过一次"（见 adopted_has_manual）。
    // 磅单侧那条粘滞口径不照抄到这里，是因为出库单的 weight_source 建表默认就是 manual。
    let final_row = outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "tare", 12100, "scale")).unwrap();
    assert_eq!(final_row.weight_source, "scale", "两个采用值都来自秤 ⇒ 地磅");
    assert_eq!(final_row.net_weight_01kg, Some(18400));
    let (all, _) = trail_of(&conn, doc.id);
    assert_eq!(all, 4, "四次捕获四行轨迹，一行都不许被就地覆盖");
}

/// 状态闸门：过账后不能称重，而且要说清"该走哪条路"。
#[test]
fn only_draft_outbound_can_be_weighed() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户壬");
    let ym = variety(&conn, "YM");
    let doc = outbound::save(&conn, &actor(), sale_input(wh, ym, party, 5000, 250000)).unwrap();
    outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "gross", 30000, "scale")).unwrap();
    outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "tare", 25000, "scale")).unwrap();
    outbound::complete(&conn, &actor(), complete_input(&doc.order_no)).unwrap();

    let e = outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "gross", 31000, "scale")).unwrap_err();
    assert!(e.contains("已出库"), "实际：{e}");
    assert!(e.contains("红冲"), "要告诉磅员该走哪条路，实际：{e}");
    assert_eq!(trail_of(&conn, doc.id), (2, 2), "过账后的复称尝试不得改动画像");
}

/// 称过磅的单，表单那格净重改不动（一份数只有一个来源）。
#[test]
fn save_cannot_overwrite_a_weighed_net() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户癸");
    let xm = variety(&conn, "XM");
    let doc = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 5000, 260000)).unwrap();
    outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "gross", 30000, "scale")).unwrap();
    let weighed = outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "tare", 12000, "scale")).unwrap();
    assert_eq!(weighed.net_weight_01kg, Some(18000));

    // 手改净重 → 拒，并把人指回称重那块
    let mut edit = sale_input(wh, xm, party, 4000, 260000);
    edit.order_no = Some(doc.order_no.clone());
    let e = outbound::save(&conn, &actor(), edit).unwrap_err();
    assert!(e.contains("已过地磅"), "实际：{e}");
    assert!(e.contains("地磅称重"), "要说出去哪儿改，实际：{e}");
    assert_eq!(net_now(&conn, &doc.order_no), Some(18000), "被拒的改单不得动到净重");

    // 同一张单改单价/备注（净重按原值回传）照样成功——界面表单就是这么提交的
    let mut keep = sale_input(wh, xm, party, 18000, 270000);
    keep.order_no = Some(doc.order_no.clone());
    keep.remark = Some("班组长口头同意".into());
    let edited = outbound::save(&conn, &actor(), keep).expect("原值回传的改单不该被误伤");
    assert_eq!(edited.price_fen_per_ton, Some(270000));
    assert_eq!(edited.net_weight_01kg, Some(18000));
    assert_eq!(edited.weight_source, weighed.weight_source);
}

/// **0029 最要命的那一条**：出库单的 id 与磅单的 id 各自递增、数字会重叠。
/// 轨迹表共用之后，同 id 的两张单据必须各看各的轨迹，谁也不串谁。
#[test]
fn trail_is_isolated_between_the_two_doc_chains() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户甲");
    let xm = variety(&conn, "XM");

    // 两张单据的 id 撞在同一个数字上（各自独立 AUTOINCREMENT，第一张都是 1）
    let weigh_id = insert_weigh_order(&conn, "BD-0029", "gross_weighed", party, xm, Some(wh), None, None, None);
    let doc = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 5000, 260000)).unwrap();
    assert_eq!(doc.id, weigh_id, "本测试的前提就是两张单据 id 相同；若号段变了请另造同 id 场景");

    // 磅单侧先有一条毛重轨迹
    conn.execute(
        "INSERT INTO weigh_record (doc_kind, order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg,
                 is_adopted, source, stable, captured_at, operator_id)
         VALUES ('weigh_order', ?1, 1, 'gross', 40000, 40000, 1, 'scale', 1, '2026-10-08T08:00:00.000', 1)",
        params![weigh_id],
    )
    .unwrap();

    let weighed = outbound::capture(&conn, &actor(), cap_input(&doc.order_no, "gross", 30000, "scale")).unwrap();
    assert_eq!(weighed.gross_weight_01kg, Some(30000));

    // 1) 出库侧编号从自己的 1 开始，没把磅单那条算进自己的 seq
    let ob_seq: Vec<(i64, i64)> = {
        let mut st = conn
            .prepare("SELECT seq, weight_01kg FROM weigh_record WHERE doc_kind = 'outbound_order' AND order_id = ?1 ORDER BY seq")
            .unwrap();
        st.query_map(params![doc.id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    };
    assert_eq!(ob_seq, vec![(1, 30000)], "出库侧的 seq 必须自成一段");

    // 2) 磅单那条没被出库的复称摘掉「采用」标记
    let keep_adopted: i64 = conn
        .query_row(
            "SELECT is_adopted FROM weigh_record WHERE doc_kind = 'weigh_order' AND order_id = ?1 AND seq = 1",
            params![weigh_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(keep_adopted, 1, "少了 doc_kind 的那句 UPDATE 会把别人家的轨迹改成未采用");

    // 3) 磅单详情读轨迹也只看见自己那一条（`orders::load_order_full` 是唯一的取轨迹入口）
    let full = banghe_lib::orders::load_order_full(&conn, "BD-0029")
        .unwrap()
        .expect("磅单应读得回来");
    let recs = full.records.expect("详情应带轨迹");
    assert_eq!(recs.len(), 1, "磅单轨迹里混进出库的读数＝串号");
    assert_eq!(recs[0].weight_01kg, 40000);

    // 4) 出库详情读回来的是出库自己那两条，不是磅单的
    let detail = outbound::detail(&conn, &doc.order_no).unwrap().expect("出库单应读得回来");
    assert_eq!(detail.records.len(), 1);
    assert_eq!(detail.records[0].weight_01kg, 30000);
}

// ================================= F11.7 出库码单（0030）：打印留痕

/// 落一条打印留痕，绕开 Tauri 命令层直接走服务函数。
fn log_ticket(conn: &Connection, doc_type: &str, doc_no: &str, reprint: bool) {
    orders::log_print(
        conn,
        &actor(),
        orders::PrintLogInput {
            doc_type: doc_type.into(),
            doc_no: doc_no.into(),
            paper: "A4".into(),
            printer_name: "HP LaserJet M403d".into(),
            channel: "pdf_silent".into(),
            is_reprint: reprint,
            operator_id: None,
        },
    )
    .unwrap();
}

/// **0030 的那道 CHECK 真的扩了没有**：出库码单与付款小票的留痕都要写得进去。
/// 写不进去的现场表现是"纸出来了、弹一句留痕失败"，而补打角标从此不准（06 §2.2）。
#[test]
fn print_log_accepts_the_new_doc_types() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户乙");
    let xm = variety(&conn, "XM");
    let doc = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 12000, 260000)).unwrap();

    log_ticket(&conn, "outbound_order", &doc.order_no, false);
    log_ticket(&conn, "payment_receipt", "FK-TEST-1", true);
    let (out_rows, pay_rows): (i64, i64) = {
        let a = conn.query_row("SELECT COUNT(1) FROM print_log WHERE doc_type = 'outbound_order'", [], |r| r.get(0)).unwrap();
        let b = conn.query_row("SELECT COUNT(1) FROM print_log WHERE doc_type = 'payment_receipt'", [], |r| r.get(0)).unwrap();
        (a, b)
    };
    assert_eq!((out_rows, pay_rows), (1, 1), "两种新票种的留痕都必须写得进 print_log");

    // 值域仍然有边界：没扩进去的种类照样撞 CHECK（不是把闸门一拆了之）
    let e = conn
        .execute(
            "INSERT INTO print_log (doc_type, doc_id, doc_no, copies, paper, printer_name, channel, result, printed_at, operator_id)
             VALUES ('passport', 1, 'X', 1, 'A4', 'p', 'preview', 'success', '2026-10-08T10:00:00.000', 1)",
            [],
        )
        .unwrap_err()
        .to_string();
    assert!(e.contains("CHECK"), "越界 doc_type 必须仍被 CHECK 拦住，实际：{e}");
}

/// `log_print` 要把出库单号翻成 `doc_id`：挂 0 等于"查无此单"，审计按单追就断在这里。
#[test]
fn print_log_resolves_the_outbound_number_to_its_row() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户丙");
    let ym = variety(&conn, "YM");
    let doc = outbound::save(&conn, &actor(), sale_input(wh, ym, party, 12000, 250000)).unwrap();

    log_ticket(&conn, "outbound_order", &doc.order_no, false);
    let id: i64 = conn
        .query_row("SELECT doc_id FROM print_log WHERE doc_type = 'outbound_order'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(id, doc.id, "出库单号必须翻得回出库单那一行");

    // 号不存在时不炸、也不假挂：留痕照记，doc_id 落 0（`log_print` 会往 stderr 喊一声）
    log_ticket(&conn, "outbound_order", "01209999000099", false);
    let ghost: i64 = conn
        .query_row("SELECT doc_id FROM print_log WHERE doc_no = '01209999000099'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(ghost, 0);
}

/// **同形号的那一条底线**：号面上没有票种字母（0026），计数器又按票种各自从 1 排起，
/// 所以同一站同一月的磅单与出库单会撞成同一串数字。两张纸各自的打印记录必须各看各的。
#[test]
fn print_history_does_not_leak_across_same_numbered_docs() {
    let conn = db();
    let wh = seed_warehouse(&conn, "CW-A");
    let party = seed_party(&conn, "农户丁");
    let xm = variety(&conn, "XM");

    let weigh_id = insert_weigh_order(&conn, "01202610000007", "settled", party, xm, Some(wh), Some(12000), Some(12000), None);
    let doc = outbound::save(&conn, &actor(), sale_input(wh, xm, party, 12000, 260000)).unwrap();
    // 本夹具里两张单的号不同（出库号取的是 CK 计数器），这里刻意把出库单改成与磅单同号：
    // 现场就是同站同月各排到第 7 号的那个形状，而 print_log 只认 `doc_no` 那一串。
    conn.execute("UPDATE outbound_order SET order_no = '01202610000007' WHERE id = ?1", params![doc.id]).unwrap();

    log_ticket(&conn, "weigh_order", "01202610000007", false);
    log_ticket(&conn, "outbound_order", "01202610000007", false);
    log_ticket(&conn, "outbound_order", "01202610000007", true);

    let detail = outbound::detail(&conn, "01202610000007").unwrap().expect("出库单读得回来");
    assert_eq!(detail.order.id, doc.id, "同号时按号取详情取到的是出库这一张");
    assert_eq!(detail.prints.len(), 2, "出库详情只该看见出库自己的两条留痕");
    assert!(detail.prints.iter().all(|p| p.doc_type == "outbound_order"));
    assert_eq!(detail.prints.iter().filter(|p| p.is_reprint == 1).count(), 1, "一条首打一条补打");

    let full = orders::load_order_full(&conn, "01202610000007").unwrap().expect("磅单读得回来");
    let prints = full.prints.unwrap();
    assert_eq!(prints.len(), 1, "磅单详情混进出库的留痕 = 把「已打 1 张」报成 3 张");
    assert_eq!(prints[0].doc_type, "weigh_order");
    assert_eq!(full.id, weigh_id);
}
