//! 化验单读的行为守卫（05 §3 `/qc` 与 `/qc/$reportNo`；02 §F3；01 §F3.4）
//!
//! 守的是把质检页两块 mock 换成真库后才会暴露的错：
//!  1. **队列只认「无有效化验单」**：出单即退出；被复检替换掉的留档单（`is_effective=0`）
//!     不能让本单重新变成"已检完"，否则质检员看不见这车。
//!  2. **队列口径含「已毛重未化验」**（mock 只认登记态）——抽样→毛重→化验→皮重
//!     是粮站实际顺序，毛重后没出单的车正是该催的那批。
//!  3. **终态不入队**：作废 / 已结算 / 拒收的单不该出现在待检里。
//!  4. **详情形状与 mock 逐字一致**：`{ report, first? }`，`first` 仅复检才出现，
//!     且指标明细必须带全（并排对比列没有第二份数据源）。
//!  5. 队列行是列表形状：详情才有的四个字段不得出现在序列化结果里。

use rusqlite::{params, Connection};

use banghe_lib::auth::AuthProfile;
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::orders::{
    capture, create_order, save_party, save_qc, settle, void_order, CaptureInput, CreateOrderInput, PartySaveInput, QcIndicatorInput, SaveQcInput, SettleInput, VoidOrderInput,
};
use banghe_lib::qc::{qc_detail, qc_queue};

fn db() -> Connection {
    let conn = in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本");
    // 「制单必须绑卡」默认开着，闸门本身由 orders_contract 专测；这套用例测化验，不替每张单造卡
    conn.execute("UPDATE app_setting SET value_json = 'false' WHERE key = 'card_required_on_create'", [])
        .unwrap();
    conn
}

fn actor(id: i64, role: &str) -> AuthProfile {
    AuthProfile { id, username: format!("u{id}"), display_name: format!("测试{id}"), role: role.into(), must_change_pwd: false }
}

/// 迁移种子给了 station 01 与 admin(id=1,站长)；化验员与磅员要真行（FK 到 user_account）
fn ensure_users(conn: &Connection) {
    for (u, role) in [("w2", "weigher"), ("insp", "inspector")] {
        conn.execute(
            "INSERT INTO user_account (username, display_name, password_hash, role, is_active, created_at)
             VALUES (?1, ?1, '!x', ?2, 1, '2026-01-01T00:00:00.000+08:00')",
            params![u, role],
        )
        .unwrap();
    }
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

fn new_order(conn: &Connection, party: i64, no_hint: &str) -> String {
    let _ = no_hint;
    create_order(
        conn,
        &actor(2, "weigher"),
        CreateOrderInput {
            party_id: party,
            variety_id: 1,
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
    .order_no
}

fn capture_gross(conn: &Connection, no: &str, w: i64) {
    capture(
        conn,
        &actor(2, "weigher"),
        CaptureInput {
            order_no: no.into(),
            weigh_type: "gross".into(),
            weight_01kg: w,
            source: "scale".into(),
            operator_id: None,
            raw_frame: Some("=10000.0kg".into()),
            has_photo: None,
            tare_override: None,
            tare_warning: None,
        },
    )
    .unwrap()
    .expect("单应存在");
}

fn capture_tare(conn: &Connection, no: &str, w: i64) {
    capture(
        conn,
        &actor(2, "weigher"),
        CaptureInput {
            order_no: no.into(),
            weigh_type: "tare".into(),
            weight_01kg: w,
            source: "scale".into(),
            operator_id: None,
            raw_frame: None,
            has_photo: None,
            tare_override: None,
            tare_warning: None,
        },
    )
    .unwrap()
    .expect("单应存在");
}

fn accept_qc(conn: &Connection, no: &str) -> banghe_lib::orders::QcReport {
    save_qc(
        conn,
        &actor(3, "inspector"),
        SaveQcInput {
            order_no: no.into(),
            grade: Some("一等".into()),
            decision: "accept".into(),
            test_method: "nir".into(),
            indicators: vec![
                QcIndicatorInput { code: "impurity".into(), name: "杂质".into(), value_num: Some(80), value_text: None, unit: "0.01pct".into(), std_value: Some(100), over_std: 0 },
                QcIndicatorInput { code: "moisture".into(), name: "水分".into(), value_num: Some(1400), value_text: None, unit: "0.01pct".into(), std_value: Some(1400), over_std: 0 },
            ],
            moisture_deduct_01kg: 0,
            impurity_deduct_01kg: 0,
            inspector_id: None,
            reject_reason: None,
        },
    )
    .unwrap()
    .expect("化验单应保存")
}

fn recheck_qc(conn: &Connection, no: &str) -> banghe_lib::orders::QcReport {
    save_qc(
        conn,
        &actor(3, "inspector"),
        SaveQcInput {
            order_no: no.into(),
            grade: Some("二等".into()),
            decision: "accept".into(),
            test_method: "lab".into(),
            indicators: vec![QcIndicatorInput { code: "moisture".into(), name: "水分".into(), value_num: Some(1520), value_text: None, unit: "0.01pct".into(), std_value: Some(1400), over_std: 1 }],
            moisture_deduct_01kg: 120,
            impurity_deduct_01kg: 0,
            inspector_id: None,
            reject_reason: None,
        },
    )
    .unwrap()
    .expect("复检单应保存")
}

fn queue_nos(conn: &Connection) -> Vec<String> {
    qc_queue(conn).unwrap().into_iter().map(|o| o.order_no).collect()
}

#[test]
fn queue_holds_registered_orders_and_drops_after_effective_report() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "张一", "410101199001010011");
    let no = new_order(&conn, party, "a");
    assert_eq!(queue_nos(&conn), vec![no.clone()], "新登记的单必须在待检队列里");

    let report = accept_qc(&conn, &no);
    assert!(queue_nos(&conn).is_empty(), "出了有效化验单就该退出队列");
    assert_eq!(report.is_effective, 1, "首检即有效单");
}

#[test]
fn queue_keeps_order_whose_first_report_was_replaced_by_recheck() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "张二", "410101199001010012");
    let no = new_order(&conn, party, "a");
    let first = accept_qc(&conn, &no);
    let second = recheck_qc(&conn, &no);
    assert_eq!(second.is_recheck, 1);
    assert!(queue_nos(&conn).is_empty(), "复检单有效，本单不能重新排队");

    // 留档单本身仍可查，且必须带回首检做并排对比
    let detail = qc_detail(&conn, &second.report_no).unwrap().expect("复检单应查到");
    let first_back = detail.first.expect("复检详情必须带首检单");
    assert_eq!(first_back.report_no, first.report_no);
    assert_eq!(first_back.is_effective, 0, "首检已被复检替换为留档");
    assert_eq!(detail.report.indicators.len(), 1);
    assert_eq!(first_back.indicators.len(), 2, "指标明细按 sort_order 全量带出");
}

#[test]
fn queue_includes_gross_weighed_order_without_report() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "张三", "410101199001010013");
    let no = new_order(&conn, party, "a");
    capture_gross(&conn, &no, 120_000);
    assert!(queue_nos(&conn).contains(&no), "已毛重未化验的车必须在队列里——mock 只认登记态，真库按粮站实际顺序补上");
}

#[test]
fn queue_excludes_terminal_orders() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "张四", "410101199001010014");
    let draft = new_order(&conn, party, "a");
    let settled = new_order(&conn, party, "b");
    accept_qc(&conn, &settled);
    capture_gross(&conn, &settled, 120_000);
    capture_tare(&conn, &settled, 20_000);
    settle(
        &conn,
        &actor(4, "cashier"),
        SettleInput {
            order_no: settled.clone(),
            price_fen_per_ton: 240_000,
            package_deduct_01kg: 0,
            moisture_deduct_01kg: 0,
            impurity_deduct_01kg: 0,
            other_deduct_01kg: 0,
            deduction_fee_fen: 0,
            pay_now: true,
            payment_method: "cash".into(),
            settler_id: None,
            price_list_id: None,
            price_override_reason: Some("测试结算：本轮不建价目行".into()),
            party_signed: Some(true),
        },
    )
    .unwrap()
    .expect("结算应成功");

    assert_eq!(queue_nos(&conn), vec![draft.clone()], "已结算的单不再属于质检，作废的更不该出现");

    void_order(
        &conn,
        &actor(1, "station_master"),
        VoidOrderInput { order_no: draft.clone(), reason: "登记错人了，重新制单".into(), operator_id: None, authorized_by: Some(1) },
    )
    .unwrap()
    .expect("作废应成功");
    assert!(queue_nos(&conn).is_empty(), "作废单必须退出待检队列");
}

#[test]
fn queue_rows_carry_list_shape_only() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "张五", "410101199001010015");
    let no = new_order(&conn, party, "a");
    let json = serde_json::to_value(&qc_queue(&conn).unwrap()[0]).unwrap();
    assert_eq!(json["order_no"].as_str().unwrap(), no);
    for detail_only in ["records", "photos", "prints", "timeline"] {
        assert!(json.get(detail_only).is_none(), "队列行是列表形状，{detail_only} 只在详情里给");
    }
}

#[test]
fn detail_returns_none_for_unknown_no_and_omits_first_on_first_report() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "张六", "410101199001010016");
    let no = new_order(&conn, party, "a");
    assert!(qc_detail(&conn, "QC00000000").unwrap().is_none(), "查无此单回 None，不能报错");

    let report = accept_qc(&conn, &no);
    let json = serde_json::to_value(qc_detail(&conn, &report.report_no).unwrap().expect("首检单应查到")).unwrap();
    assert!(json.get("first").is_none(), "首检没有上一张，first 字段整个缺席（与 mock 的 first? 一致）");
    assert_eq!(json["report"]["decision"].as_str().unwrap(), "accept");
    assert_eq!(json["report"]["party_name"].as_str().unwrap(), "张六");
}
