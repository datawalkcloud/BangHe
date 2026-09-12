//! 结算台账的行为守卫（05 §3 /settlements；01 §F5.2 分次收款）
//!
//! 台账列表走 `settlement_list`（归 tests/reports_contract.rs），这里守的是
//! `settlements.rs` 的四件事：
//!  1. **待结算池**：to_settle / reweigh 的磅单按售粮人分组、多者在前——
//!     当天不清的"粮进仓、钱没算"必须一眼可见。
//!  2. **详情三件套**：结算单 + 覆盖磅单（按 seq）+ 付款流水必须同源同形，
//!     mock 与真库共用一个页面契约。
//!  3. **补录收款**：partial→paid 只能由累计已付推出来；磅单侧按结算明细
//!     逐单填满应付再轮下一单；每笔都落 payment_record + `pay.record` 审计，
//!     绝不覆盖已付数（01 §F5.2）。
//!  4. **拒绝口径**（真库比 mock 严的四处）：超额、已撤销单、非法金额 /
//!     付款方式、非现金缺流水号全部用中文短句拒绝；签字位 `signed_by_party`
//!     收款不得顺手置 1。
//!  另挂 **挂账账龄**：时效读 `payment_due_warn_hours`（72h = 3 天），
//!  due_date / overdue_days 与业务日对得上，已付与撤销的单不进清单。

use rusqlite::{params, Connection};

use banghe_lib::auth::AuthProfile;
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::orders::{
    capture, create_order, save_party, settle, CaptureInput, CreateOrderInput, PartySaveInput, SettleInput,
};
use banghe_lib::settlements::{credits, pending_settlements, record_payment, settlement_detail, RecordPaymentInput};

fn db() -> Connection {
    let conn = in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本");
    // 「制单必须绑卡」默认开着，闸门本身由 orders_contract 专测；这套用例测结算，不替每张单造卡
    conn.execute("UPDATE app_setting SET value_json = 'false' WHERE key = 'card_required_on_create'", [])
        .unwrap();
    conn
}

fn actor(id: i64, role: &str) -> AuthProfile {
    AuthProfile { id, username: format!("u{id}"), display_name: format!("测试{id}"), role: role.into(), must_change_pwd: false }
}

fn new_party(conn: &Connection, name: &str, idc: &str) -> i64 {
    save_party(
        conn,
        &actor(1, "station_master"),
        PartySaveInput {
            id: None,
            name: Some(name.into()),
            party_type: Some("farmer".into()),
            id_card_no: Some(idc.into()),
            phone: None,
            address: None,
            bank_name: None,
            bank_account: None,
            credit_limit_fen: None,
            default_warehouse_id: None,
            default_vehicle_no: None,
            last_tare_01kg: None,
            remark: None,
            id_card_verified: None,
            status: None,
            operator_id: None,
        },
    )
    .expect("建档应成功")
    .id
}

/// 磅员与出纳（user_account 外键要求真实行；id 依序 2 / 4，与 orders_contract 同法）
fn ensure_users(conn: &Connection) {
    for (u, role) in [("w2", "weigher"), ("cash", "cashier")] {
        conn.execute(
            "INSERT INTO user_account (username, display_name, password_hash, role, is_active, created_at)
             VALUES (?1, ?1, '!x', ?2, 1, '2026-01-01T00:00:00.000+08:00')",
            params![u, role],
        )
        .unwrap();
    }
}

/// 走完 制单 → 毛重 → 皮重 → 结算（pay_now=false 留挂账），返回结算单号。
/// 净重固定 100000（0.1kg = 10 t），单价 240000 分/吨 ⇒ 应付 2 400 000 分。
fn settle_credit(conn: &Connection, party: i64, variety: i64) -> String {
    conn.execute(
        "INSERT INTO price_list (variety_id, grade, price_fen_per_ton, effective_from, effective_to, basis, made_by, created_at, created_by)
         VALUES (?1, '一等', 240000, '2026-01-01', '9999-12-31', '测试定价', 1, '2026-01-01T00:00:00.000+08:00', 1)",
        params![variety],
    )
    .unwrap();
    let price = conn.last_insert_rowid();
    let no = create_order(
        conn,
        &actor(1, "weigher"),
        CreateOrderInput {
            party_id: party,
            variety_id: variety,
            vehicle_no: Some("豫A12345".into()),
            warehouse_id: None,
            slot_id: None,
            remark: None,
            card_no: None,
            registered_by: None,
            weight_source: "scale".into(),
        },
    )
    .expect("制单应成功")
    .order_no;
    for (wt, w) in [("gross", 200000i64), ("tare", 100000)] {
        capture(
            conn,
            &actor(2, "weigher"),
            CaptureInput {
                order_no: no.clone(),
                weigh_type: wt.into(),
                weight_01kg: w,
                source: "scale".into(),
                operator_id: None,
                raw_frame: None,
                has_photo: Some(false),
                tare_override: None,
                tare_warning: None,
            },
        )
        .unwrap()
        .expect("单应存在");
    }
    let r = settle(
        conn,
        &actor(4, "cashier"),
        SettleInput {
            order_no: no,
            price_fen_per_ton: 240000,
            package_deduct_01kg: 0,
            moisture_deduct_01kg: 0,
            impurity_deduct_01kg: 0,
            other_deduct_01kg: 0,
            deduction_fee_fen: 0,
            pay_now: false,
            payment_method: "cash".into(),
            settler_id: None,
            price_list_id: Some(price),
            price_override_reason: None,
            party_signed: Some(true),
        },
    )
    .unwrap()
    .expect("应可结算");
    r.settlement.settle_no
}

fn wheat(conn: &Connection) -> i64 {
    conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap()
}

fn pay(conn: &Connection, settle_no: &str, amount_fen: i64, method: &str, trade_no: Option<&str>) -> Result<Option<banghe_lib::orders::Settlement>, String> {
    record_payment(
        conn,
        &actor(4, "cashier"),
        RecordPaymentInput { settle_no: settle_no.into(), amount_fen, method: method.into(), trade_no: trade_no.map(str::to_string), operator_id: None },
    )
}

#[test]
fn pending_pool_groups_unsettled_orders_by_party() {
    let conn = db();
    ensure_users(&conn);
    let xm = wheat(&conn);
    let a = new_party(&conn, "张三", "341204199301272015");
    let b = new_party(&conn, "李四", "341204199301272016");
    for _ in 0..2 {
        let _ = settle_to_create(&conn, a, xm);
    }
    let _ = settle_to_create(&conn, b, xm);

    let pool = pending_settlements(&conn).unwrap();
    assert_eq!(pool.len(), 2, "两个售粮人两组");
    assert_eq!(pool[0].party.name, "张三", "压单多者在前");
    assert_eq!(pool[0].rows.len(), 2);
    assert_eq!(pool[1].rows.len(), 1);
    assert!(pool[0].rows.iter().all(|o| o.status == "to_settle"));
}

/// 制单 + 双称重，停在 to_settle（不结算）
fn settle_to_create(conn: &Connection, party: i64, variety: i64) -> String {
    let no = create_order(
        conn,
        &actor(1, "weigher"),
        CreateOrderInput {
            party_id: party,
            variety_id: variety,
            vehicle_no: None,
            warehouse_id: None,
            slot_id: None,
            remark: None,
            card_no: None,
            registered_by: None,
            weight_source: "scale".into(),
        },
    )
    .expect("制单应成功")
    .order_no;
    for (wt, w) in [("gross", 200000i64), ("tare", 100000)] {
        capture(
            conn,
            &actor(2, "weigher"),
            CaptureInput {
                order_no: no.clone(),
                weigh_type: wt.into(),
                weight_01kg: w,
                source: "scale".into(),
                operator_id: None,
                raw_frame: None,
                has_photo: Some(false),
                tare_override: None,
                tare_warning: None,
            },
        )
        .unwrap()
        .expect("单应存在");
    }
    no
}

#[test]
fn detail_assembles_settlement_orders_and_payments() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "王五", "341204199301272017");
    let no = settle_credit(&conn, party, wheat(&conn));

    let d = settlement_detail(&conn, &no).unwrap().expect("详情应命中");
    assert_eq!(d.settlement.payable_fen, 2_400_000);
    assert_eq!(d.settlement.paid_fen, 0);
    assert_eq!(d.orders.len(), 1);
    assert_eq!(d.orders[0].status, "settled");
    assert_eq!(d.orders[0].settlement_weight_01kg, Some(100000));
    assert_eq!(d.orders[0].payable_amount_fen, Some(2_400_000));
    assert!(d.payments.is_empty(), "挂账单起初没有流水");

    pay(&conn, &no, 1_000_000, "bank", Some("BOC-2026-0001")).unwrap().expect("应登记成功");
    let d = settlement_detail(&conn, &no).unwrap().unwrap();
    assert_eq!(d.payments.len(), 1);
    let p = &d.payments[0];
    assert_eq!(p.amount_fen, 1_000_000);
    assert_eq!(p.method, "bank");
    assert_eq!(p.trade_no.as_deref(), Some("BOC-2026-0001"));
    assert_eq!(p.settle_no.as_deref(), Some(no.as_str()));
    assert_eq!(p.party_name, "王五");
    assert_eq!(p.payee_name, "王五");
    assert_eq!(p.reversed, 0);
    assert!(p.pay_no.starts_with("FK01"), "付款流水号走 §3.5 取号：{}", p.pay_no);

    assert!(settlement_detail(&conn, "JS01999999000001").unwrap().is_none(), "查无此单回 None，不是报错");
}

#[test]
fn record_payment_drives_partial_then_paid_and_leaves_trail() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "赵六", "341204199301272018");
    let no = settle_credit(&conn, party, wheat(&conn));

    let s = pay(&conn, &no, 900_000, "cash", None).unwrap().unwrap();
    assert_eq!(s.payment_status, "partial");
    assert_eq!(s.paid_fen, 900_000);
    assert_eq!(s.main_method.as_deref(), Some("cash"));
    let (o_status, o_paid, o_paid_at): (String, i64, Option<String>) = conn
        .query_row("SELECT payment_status, paid_amount_fen, paid_at FROM weigh_order", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    assert_eq!((o_status.as_str(), o_paid), ("partial", 900_000), "磅单侧同步分摊");
    assert!(o_paid_at.is_none(), "未结清不写 paid_at");

    let s = pay(&conn, &no, 1_500_000, "wechat", Some("WX-9")).unwrap().unwrap();
    assert_eq!(s.payment_status, "paid");
    assert_eq!(s.paid_fen, 2_400_000, "已付数只累加、不覆盖");
    let (o_status, o_paid_at): (String, Option<String>) = conn
        .query_row("SELECT payment_status, paid_at FROM weigh_order", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(o_status, "paid");
    assert!(o_paid_at.is_some());

    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM payment_record WHERE settlement_id = (SELECT id FROM settlement WHERE settle_no=?1)", params![no], |r| r.get(0)).unwrap();
    assert_eq!(rows, 2, "分次收款每次追加一条");
    let audits: i64 = conn
        .query_row("SELECT COUNT(*) FROM audit_log WHERE action='pay.record' AND entity='settlement' AND entity_no=?1", params![no], |r| r.get(0))
        .unwrap();
    assert_eq!(audits, 2);
}

#[test]
fn payment_does_not_flip_signature_and_rejects_bad_inputs() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "孙七", "341204199301272019");
    let no = settle_credit(&conn, party, wheat(&conn));
    conn.execute("UPDATE settlement SET signed_by_party = 0 WHERE settle_no = ?1", params![&no]).unwrap();

    let e = pay(&conn, &no, 0, "cash", None).unwrap_err();
    assert!(e.contains("大于 0"), "{e}");
    let e = pay(&conn, &no, 9_999_999, "cash", None).unwrap_err();
    assert!(e.contains("超出未付余额"), "{e}");
    let e = pay(&conn, &no, 100, "bitcoin", None).unwrap_err();
    assert!(e.contains("未知付款方式"), "{e}");
    let e = pay(&conn, &no, 100, "bank", None).unwrap_err();
    assert!(e.contains("流水号"), "{e}");
    assert!(pay(&conn, "JS01999999000002", 100, "cash", None).unwrap().is_none(), "查无此单回 None");

    let s = pay(&conn, &no, 100, "cash", None).unwrap().unwrap();
    assert_eq!(s.signed_by_party, 0, "收款不代签");
    assert_eq!(s.payment_status, "partial", "前面所有失败都不得留下半笔状态");

    conn.execute("UPDATE settlement SET status='revoked' WHERE settle_no=?1", params![&no]).unwrap();
    let e = pay(&conn, &no, 100, "cash", None).unwrap_err();
    assert!(e.contains("已撤销"), "{e}");
}

#[test]
fn credits_lists_aging_and_excludes_settled_and_revoked() {
    let conn = db();
    ensure_users(&conn);
    let xm = wheat(&conn);
    let fresh = settle_credit(&conn, new_party(&conn, "钱一", "341204199301272020"), xm);
    let stale = settle_credit(&conn, new_party(&conn, "钱二", "341204199301272021"), xm);
    let paid_out = settle_credit(&conn, new_party(&conn, "钱三", "341204199301272022"), xm);

    // 默认时效 72h = 3 天；把第二张的业务日推到 10 天前 ⇒ 逾期 7 天
    let stale_day = chrono::Local::now().date_naive() - chrono::Duration::days(10);
    let stale_date = stale_day.format("%Y-%m-%d").to_string();
    let stale_due = (stale_day + chrono::Duration::days(3)).format("%Y-%m-%d").to_string();
    conn.execute("UPDATE settlement SET business_date = ?1 WHERE settle_no = ?2", params![&stale_date, &stale]).unwrap();
    pay(&conn, &paid_out, 2_400_000, "cash", None).unwrap().unwrap();

    let list = credits(&conn).unwrap();
    assert_eq!(list.len(), 2, "已付清的不进挂账清单");
    assert_eq!(list[0].settlement.settle_no, stale, "逾期最久在前");
    assert_eq!(list[0].overdue_days, 7);
    assert_eq!(list[0].due_date, stale_due);
    assert_eq!(list[0].unpaid_fen, 2_400_000);
    assert_eq!(list[1].settlement.settle_no, fresh);
    assert_eq!(list[1].overdue_days, 0);

    // 部分付款后挂账额跟着降
    pay(&conn, &fresh, 400_000, "alipay", Some("ALI-1")).unwrap().unwrap();
    let c = credits(&conn).unwrap().into_iter().find(|x| x.settlement.settle_no == fresh).unwrap();
    assert_eq!(c.unpaid_fen, 2_000_000);

    conn.execute("UPDATE settlement SET status='revoked' WHERE settle_no=?1", params![&stale]).unwrap();
    assert!(!credits(&conn).unwrap().iter().any(|x| x.settlement.settle_no == stale), "撤销单退出挂账（看板 v_payable 同口径）");
}
