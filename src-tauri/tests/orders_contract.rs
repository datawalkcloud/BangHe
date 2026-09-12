//! 工作台录单链路的行为守卫（docs/design/02 §7 M2–M5、03 §3.5 / §4.3）
//!
//! 守的是接上 SQLite 才会犯、纸面 review 看不出来的错：
//!  1. **取号**：单号必须走 seq_counter（§3.5 站点+前缀+年月+流水），两位站码、
//!     月内递增、断电不重号；`uk_order_no` 兜底前服务层就得给出唯一号。
//!  2. **状态机**：毛/皮齐 → to_settle；已结算/已作废的单再称重、再补化验必须拒绝；
//!     重复结算被不变式 6（uk_so_order）拦住并回人话。
//!  3. **复检链**：同单第二次化验，旧报告必须降级、新报告 is_recheck=1 且回首检
//!     （不变式 7 的 uk_qc_effective 会直接拒插，服务层顺序错了就是保存失败）。
//!  4. **结算金额**：货款 = 结算重量 × 单价 ÷ 10000，只在最终取整（03 §3.1 规则 3）；
//!     应付 = 货款 − 扣款；当场结清要同事务落 payment_record（付款台账无出处的洞）。
//!  5. **皮重授权**：放行人必须是在职站长，普通磅员自放行要拒。
//!  6. **证号归并**：SHA-256 fp 唯一建档；改证号撞别人档案要拦。
//!  7. **列表口径**：合计行（summary）只算参与汇总的单，剔除作废/拒收——与看板同源。
//!
//! 与 masters_contract 同样走内存库 + 真实迁移（种子：station 01、admin(id=1,站长)、
//! 四个默认品种）。AuthProfile 手工构造，和命令层从会话里拿到的是同一形状。

use chrono::Local;
use rusqlite::{params, Connection};

use banghe_lib::auth::AuthProfile;
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::orders::{
    capture, create_order, get_party, list_orders, list_parties, list_qc, load_order_full, log_print, open_orders, save_party, save_qc, settlement_of, settle, void_order,
    CaptureInput, CreateOrderInput, OrderFilters, PartySaveInput, PrintLogInput, QcIndicatorInput, QcListOpts, SaveQcInput, SettleInput, TareOverride, VoidOrderInput,
};

fn db() -> Connection {
    in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本")
}

fn actor(id: i64, role: &str) -> AuthProfile {
    AuthProfile {
        id,
        username: format!("u{id}"),
        display_name: format!("测试{id}"),
        role: role.into(),
        must_change_pwd: false,
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

/// 磅员/化验员/出纳三个工位账号，id 依序落到 2/3/4——测试里硬编码的
/// actor(2..4) 与 user_account 外键从此对齐（weigher_id/inspector_id 都有 FK）。
fn ensure_users(conn: &Connection) {
    for (u, role) in [("w2", "weigher"), ("insp", "inspector"), ("cash", "cashier")] {
        conn.execute(
            "INSERT INTO user_account (username, display_name, password_hash, role, is_active, created_at)
             VALUES (?1, ?1, '!x', ?2, 1, '2026-01-01T00:00:00.000+08:00')",
            params![u, role],
        )
        .unwrap();
    }
}

/// 一条小麦一等价，供结算 price_list_id 外键与"按价目取价"路径使用
fn seed_price(conn: &Connection, variety: i64) -> i64 {
    conn.execute(
        "INSERT INTO price_list (variety_id, grade, price_fen_per_ton, effective_from, effective_to, basis, made_by, created_at, created_by)
         VALUES (?1, '一等', 240000, '2026-01-01', '9999-12-31', '测试定价', 1, '2026-01-01T00:00:00.000+08:00', 1)",
        params![variety],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn create(conn: &Connection, party: i64, variety: i64) -> String {
    create_order(
        conn,
        &actor(1, "weigher"),
        CreateOrderInput {
            party_id: party,
            variety_id: variety,
            vehicle_no: Some("豫A12345".into()),
            warehouse_id: None,
            slot_id: None,
            remark: None,
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
            raw_frame: Some("=W1000.0kg ST".into()),
            has_photo: Some(true),
            tare_override: None,
        },
    )
    .unwrap()
    .expect("单应存在");
}

fn capture_tare(conn: &Connection, no: &str, w: i64, ov: Option<TareOverride>) {
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
            has_photo: Some(false),
            tare_override: ov,
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
            indicators: vec![QcIndicatorInput {
                code: "moisture".into(),
                name: "水分".into(),
                value_num: Some(1400),
                value_text: None,
                unit: "0.01pct".into(),
                std_value: Some(1400),
                over_std: 0,
            }],
            moisture_deduct_01kg: 0,
            impurity_deduct_01kg: 0,
            inspector_id: None,
            reject_reason: None,
        },
    )
    .unwrap()
    .expect("单应存在")
}

fn latest_price(conn: &Connection) -> i64 {
    conn.query_row("SELECT id FROM price_list ORDER BY id DESC LIMIT 1", [], |r| r.get(0)).unwrap()
}

fn settle_now(conn: &Connection, no: &str, price: i64, pay_now: bool) -> banghe_lib::orders::SettleResult {
    settle(
        conn,
        &actor(4, "cashier"),
        SettleInput {
            order_no: no.into(),
            price_fen_per_ton: price,
            package_deduct_01kg: 0,
            moisture_deduct_01kg: 0,
            impurity_deduct_01kg: 0,
            other_deduct_01kg: 0,
            deduction_fee_fen: 0,
            pay_now,
            payment_method: "cash".into(),
            settler_id: None,
            price_list_id: Some(latest_price(conn)),
            price_override_reason: None,
            party_signed: Some(true),
        },
    )
    .unwrap()
    .expect("应可结算")
}

fn filters() -> OrderFilters {
    OrderFilters {
        date_from: None, date_to: None, status: None, variety_id: None, payment_status: None,
        weight_source: None, party_id: None, keyword: None, page: None, page_size: None, sort: None, order: None,
    }
}

// ------------------------------------------------------------------------ 测试

#[test]
fn create_order_numbers_by_spec_and_snapshots_party() {
    let conn = db();
    let party = new_party(&conn, "张三", "341204199301272015");
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();

    let a = create(&conn, party, xm);
    let b = create(&conn, party, xm);
    let ym = Local::now().format("%Y%m").to_string();
    assert_eq!(a, format!("BD01{ym}000001"), "§3.5：前缀+2位站码+年月+6位流水");
    assert_eq!(b, format!("BD01{ym}000002"), "流水在月内递增");
    let cur: i64 = conn
        .query_row("SELECT current FROM seq_counter WHERE prefix_key = ?1", params![format!("BD:01:{ym}")], |r| r.get(0))
        .unwrap();
    assert_eq!(cur, 2);
    assert_eq!(
        1,
        conn.query_row("SELECT COUNT(*) FROM audit_log WHERE action='order.create' AND entity_no=?1", params![a], |r| r.get::<_, i64>(0)).unwrap(),
        "制单必留审计"
    );

    let o = load_order_full(&conn, &a).unwrap().unwrap();
    assert_eq!(o.status, "registered");
    assert_eq!(o.party_name, "张三");
    assert_eq!(o.variety_name, "小麦");
    assert_eq!(o.id_card_no, "341204199301272015");
    assert_eq!(o.business_date, Local::now().format("%Y-%m-%d").to_string());
    assert!(o.records.as_ref().unwrap().is_empty());
    assert!(o.photos.as_ref().unwrap().is_empty());
    assert_eq!(o.timeline.as_ref().unwrap().len(), 1, "刚制单只有一条取号事件");
}

#[test]
fn weigh_flow_drives_status_and_party_tare() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "李四", "341204199301272016");
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    seed_price(&conn, xm);
    let no = create(&conn, party, xm);

    capture_gross(&conn, &no, 200000);
    let o = load_order_full(&conn, &no).unwrap().unwrap();
    assert_eq!(o.status, "gross_weighed");
    assert_eq!(o.records.as_ref().unwrap().len(), 1);
    assert_eq!(o.records.as_ref().unwrap()[0].seq, 1);
    assert_eq!(o.records.as_ref().unwrap()[0].device_code, "—", "库里没登记地磅，设备列不得编一个");

    capture_tare(&conn, &no, 100000, None);
    let o = load_order_full(&conn, &no).unwrap().unwrap();
    assert_eq!(o.status, "to_settle");
    assert_eq!(o.net_weight_01kg, Some(100000));
    assert_eq!(o.weigher_id, Some(2));
    // 抓拍墙按真库口径：photo_attachment_id 还没接，一律"无抓拍"
    let photos = o.photos.as_ref().unwrap();
    assert_eq!(photos.len(), 2);
    assert!(photos.iter().all(|p| p.missing));

    let last: Option<i64> = conn.query_row("SELECT last_tare_01kg FROM party WHERE id=?1", params![party], |r| r.get(0)).unwrap();
    assert_eq!(last, Some(100000), "皮重捕获要刷新最近皮重（§9.6 列职责）");

    // 已结算后不得再称重
    settle_now(&conn, &no, 240000, false);
    let e = capture(
        &conn,
        &actor(2, "weigher"),
        CaptureInput { order_no: no.clone(), weigh_type: "gross".into(), weight_01kg: 1, source: "scale".into(), operator_id: None, raw_frame: None, has_photo: None, tare_override: None },
    )
    .unwrap_err();
    assert!(e.contains("不能再称重"), "拒绝原因要回人话：{e}");
}

#[test]
fn tare_override_only_active_station_master() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "王五", "341204199301272017");
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    let no = create(&conn, party, xm);
    capture_gross(&conn, &no, 200000);

    // 授权人是磅员（ensure_users 已建 w2）→ 拒
    let w2: i64 = conn.query_row("SELECT id FROM user_account WHERE username='w2'", [], |r| r.get(0)).unwrap();
    let e = capture_tare_err(&conn, &no, &TareOverride { by: w2, reason: "带水箱满水".into() });
    assert!(e.contains("站长"), "需站长授权：{e}");

    // 空理由 → 拒
    let e = capture_tare_err(&conn, &no, &TareOverride { by: 1, reason: "  ".into() });
    assert!(e.contains("理由"));

    // 站长放行 → 落列 + 审计（authorized_by 是站长 id）
    capture_tare(&conn, &no, 150000, Some(TareOverride { by: 1, reason: "带水箱满水，复验属实".into() }));
    let o = load_order_full(&conn, &no).unwrap().unwrap();
    assert_eq!(o.tare_override_by, Some(1));
    let audit: (String, Option<i64>) = conn
        .query_row("SELECT actor_name, authorized_by FROM audit_log WHERE action='tare.override' AND entity_no=?1", params![no], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(audit.1, Some(1));
}

fn capture_tare_err(conn: &Connection, no: &str, ov: &TareOverride) -> String {
    capture(
        conn,
        &actor(2, "weigher"),
        CaptureInput {
            order_no: no.into(),
            weigh_type: "tare".into(),
            weight_01kg: 150000,
            source: "scale".into(),
            operator_id: None,
            raw_frame: None,
            has_photo: None,
            tare_override: Some(TareOverride { by: ov.by, reason: ov.reason.clone() }),
        },
    )
    .unwrap_err()
}

#[test]
fn qc_recheck_chain_and_reject_flow() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "赵六", "341204199301272018");
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    let no = create(&conn, party, xm);

    let first = accept_qc(&conn, &no);
    let o = load_order_full(&conn, &no).unwrap().unwrap();
    assert_eq!(o.status, "qc_done");
    assert_eq!(o.grade.as_deref(), Some("一等"));
    assert_eq!(o.inspector_id, Some(3));

    // 再录 = 复检：旧报告降级、新报告回首检；uk_qc_effective 逼着必须同事务降级
    let second = save_qc(
        &conn,
        &actor(3, "inspector"),
        SaveQcInput {
            order_no: no.clone(),
            grade: Some("二等".into()),
            decision: "accept".into(),
            test_method: "lab".into(),
            indicators: vec![QcIndicatorInput { code: "moisture".into(), name: "水分".into(), value_num: Some(1500), value_text: None, unit: "0.01pct".into(), std_value: Some(1400), over_std: 1 }],
            moisture_deduct_01kg: 300,
            impurity_deduct_01kg: 50,
            inspector_id: None,
            reject_reason: None,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(second.is_recheck, 1);
    assert_eq!(second.first_report_id, Some(first.id));
    let eff: i64 = conn.query_row("SELECT COUNT(*) FROM qc_report WHERE order_id=?1 AND is_effective=1", params![o.id], |r| r.get(0)).unwrap();
    assert_eq!(eff, 1, "同单同时刻唯一有效报告（不变式 7）");
    assert_eq!(o.qc_report_id, Some(first.id)); // 前一次读的旧值，仅用于对照 id
    let o2 = load_order_full(&conn, &no).unwrap().unwrap();
    assert_eq!(o2.qc_report_id, Some(second.id));
    assert_eq!(second.indicators[0].over_std, 1);

    // 拒收要理由；拒收后进 rejected；复检接收要恢复流转（不能永久卡死）
    let e = save_qc(
        &conn,
        &actor(3, "inspector"),
        SaveQcInput { order_no: no.clone(), grade: None, decision: "reject".into(), test_method: "visual".into(), indicators: vec![], moisture_deduct_01kg: 0, impurity_deduct_01kg: 0, inspector_id: None, reject_reason: None },
    )
    .unwrap_err();
    assert!(e.contains("理由") || e.contains("指标"), "先卡理由/指标必填：{e}");
    let rej = save_qc(
        &conn,
        &actor(3, "inspector"),
        SaveQcInput {
            order_no: no.clone(),
            grade: None,
            decision: "reject".into(),
            test_method: "visual".into(),
            indicators: vec![QcIndicatorInput { code: "odor".into(), name: "气味".into(), value_num: None, value_text: Some("霉变".into()), unit: "text".into(), std_value: None, over_std: 1 }],
            moisture_deduct_01kg: 0,
            impurity_deduct_01kg: 0,
            inspector_id: None,
            reject_reason: Some("霉变超上限，拒收退粮".into()),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(rej.decision, "reject");
    assert_eq!(load_order_full(&conn, &no).unwrap().unwrap().status, "rejected");
    accept_qc(&conn, &no);
    assert_eq!(load_order_full(&conn, &no).unwrap().unwrap().status, "qc_done", "拒收后复检接收要恢复流转");

    // qc_list 关键字（工作台按单号回查）
    let rows = list_qc(&conn, &QcListOpts { keyword: Some(no.clone()) }).unwrap();
    assert!(rows.len() >= 3, "该单历次化验（含降级旧报告）都能按单号查到");
    assert!(rows.iter().all(|r| r.order_no == no));
    // 待检队列已改由 qc::qc_queue 真接库，守卫在 tests/qc_contract.rs
}

#[test]
fn settle_math_and_money_trail() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "孙七", "341204199301272019");
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    seed_price(&conn, xm);
    let no = create(&conn, party, xm);
    capture_gross(&conn, &no, 200000);
    capture_tare(&conn, &no, 100000, None); // net = 100000 (10 t)

    // 单价 240000 分/吨 → 全额货款 2400000 分；扣袋重 4000 → 结算重 96000 → 2304000
    let r = settle(
        &conn,
        &actor(4, "cashier"),
        SettleInput {
            order_no: no.clone(),
            price_fen_per_ton: 240000,
            package_deduct_01kg: 4000,
            moisture_deduct_01kg: 0,
            impurity_deduct_01kg: 0,
            other_deduct_01kg: 0,
            deduction_fee_fen: 5000,
            pay_now: false,
            payment_method: "cash".into(),
            settler_id: None,
            price_list_id: Some(latest_price(&conn)),
            price_override_reason: None,
            party_signed: Some(false),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(r.order.settlement_weight_01kg, Some(96000));
    assert_eq!(r.order.goods_amount_fen, Some(2304000));
    assert_eq!(r.order.payable_amount_fen, Some(2299000), "应付 = 货款 − 扣款");
    assert_eq!(r.settlement.payment_status, "unpaid");
    assert_eq!(r.settlement.settle_no, format!("JS01{}000001", Local::now().format("%Y%m")));
    assert_eq!(r.settlement.orders[0].order_no, no);
    assert_eq!(r.order.status, "settled");
    assert_eq!(r.order.payment_status, "unpaid");
    // 挂账进 v_payable → 看板告警查得到（真库联动，不用第二轮对数）
    let in_payable: i64 = conn.query_row("SELECT COUNT(*) FROM v_payable WHERE settle_no=?1", params![r.settlement.settle_no], |r| r.get(0)).unwrap();
    assert_eq!(in_payable, 1);

    // 重复结算必须拒（不变式 6）
    let e = settle(
        &conn,
        &actor(4, "cashier"),
        SettleInput {
            order_no: no.clone(), price_fen_per_ton: 240000, package_deduct_01kg: 0, moisture_deduct_01kg: 0, impurity_deduct_01kg: 0,
            other_deduct_01kg: 0, deduction_fee_fen: 0, pay_now: true, payment_method: "cash".into(), settler_id: None,
            price_list_id: Some(latest_price(&conn)), price_override_reason: None, party_signed: None,
        },
    )
    .unwrap_err();
    assert!(e.contains("重复结算"), "回人话：{e}");

    // 手填单价不填事由 → 拒（历史价可追溯出处）
    let no2 = create(&conn, party, xm);
    capture_gross(&conn, &no2, 200000);
    capture_tare(&conn, &no2, 100000, None);
    let e = settle(
        &conn,
        &actor(4, "cashier"),
        SettleInput {
            order_no: no2.clone(), price_fen_per_ton: 250000, package_deduct_01kg: 0, moisture_deduct_01kg: 0, impurity_deduct_01kg: 0,
            other_deduct_01kg: 0, deduction_fee_fen: 0, pay_now: true, payment_method: "cash".into(), settler_id: None,
            price_list_id: None, price_override_reason: None, party_signed: None,
        },
    )
    .unwrap_err();
    assert!(e.contains("改价事由"), "手填价必须留事由：{e}");

    // 当场结清：付款流水同事务落，FK 单号同 seq_counter
    let r2 = settle(
        &conn,
        &actor(4, "cashier"),
        SettleInput {
            order_no: no2.clone(), price_fen_per_ton: 250000, package_deduct_01kg: 0, moisture_deduct_01kg: 0, impurity_deduct_01kg: 0,
            other_deduct_01kg: 0, deduction_fee_fen: 0, pay_now: true, payment_method: "wechat".into(), settler_id: None,
            price_list_id: None, price_override_reason: Some("当日市场价上浮，站长口头确认".into()), party_signed: Some(true),
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(r2.order.paid_amount_fen, 2500000);
    assert_eq!(r2.order.payment_status, "paid");
    let pay: (String, i64, String) = conn
        .query_row("SELECT pay_no, amount_fen, method FROM payment_record WHERE settlement_id=?1", params![r2.settlement.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    assert_eq!(pay.1, 2500000);
    assert_eq!(pay.2, "wechat");
    assert!(pay.0.starts_with(&format!("FK01{}", Local::now().format("%Y%m"))));
    let audits: Vec<String> = {
        let mut st = conn.prepare("SELECT action FROM audit_log WHERE entity_no IN (?1,?2) ORDER BY id").unwrap();
        st.query_map(params![r2.settlement.settle_no, pay.0], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap()
    };
    assert!(audits.contains(&"settle.create".to_string()) && audits.contains(&"pay.record".to_string()));
}

#[test]
fn party_id_card_fingerprint_merges_and_blocks_duplicates() {
    let conn = db();
    let a = new_party(&conn, "钱一", "341204199301272020");
    // 同证号再建 → 拒，且报错带原档案姓名
    let e = save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput { id: None, name: Some("钱一复制".into()), party_type: Some("farmer".into()), id_card_no: Some("341204199301272020".into()), ..empty_party_input() },
    )
    .unwrap_err();
    assert!(e.contains("钱一") && e.contains("已建档"), "{e}");

    // fp 必须落库且是证号 SHA-256 小写十六进制
    let fp: String = conn.query_row("SELECT id_card_no_fp FROM party WHERE id=?1", params![a], |r| r.get(0)).unwrap();
    assert_eq!(fp.len(), 64);
    // 编辑：手机号、读卡核验标记
    save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput { id: Some(a), name: None, party_type: None, id_card_no: None, phone: Some("13800000000".into()), address: None, bank_name: None, bank_account: None, credit_limit_fen: None, default_warehouse_id: None, default_vehicle_no: None, last_tare_01kg: None, remark: None, id_card_verified: Some(1), status: None, operator_id: None },
    )
    .unwrap();
    let p = get_party(&conn, a).unwrap().unwrap();
    assert_eq!(p.party.phone, "13800000000");
    assert_eq!(p.party.id_card_verified, 1);
    assert_eq!(p.credit_fen, 0);
    assert!(p.recent.is_empty());

    // 检索：姓名/证号后 4 位/手机号 都走 listParties 海堆
    assert!(list_parties(&conn, "钱一", None).unwrap().iter().any(|x| x.id == a));
    assert!(list_parties(&conn, "2020", None).unwrap().iter().any(|x| x.id == a), "证号后 4 位可检索（与 mock 海堆同口径）");
    assert!(list_parties(&conn, "13800000000", None).unwrap().iter().any(|x| x.id == a));
    assert!(list_parties(&conn, "查无此人", None).unwrap().is_empty());
}

fn empty_party_input() -> PartySaveInput {
    PartySaveInput {
        id: None, name: None, party_type: None, id_card_no: None, phone: None, address: None, bank_name: None,
        bank_account: None, credit_limit_fen: None, default_warehouse_id: None, default_vehicle_no: None,
        last_tare_01kg: None, remark: None, id_card_verified: None, status: None, operator_id: None,
    }
}

#[test]
fn list_orders_summary_excludes_unsettled_and_filters() {
    let conn = db();
    ensure_users(&conn);
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    seed_price(&conn, xm);
    let p1 = new_party(&conn, "甲", "341204199301272021");
    let p2 = new_party(&conn, "乙", "341204199301272022");
    // 三张完成单（两张挂账、一张结清）+ 一张作废 + 一张在途
    let n1 = create(&conn, p1, xm);
    capture_gross(&conn, &n1, 200000);
    capture_tare(&conn, &n1, 100000, None);
    settle_now(&conn, &n1, 240000, false);
    let n2 = create(&conn, p2, xm);
    capture_gross(&conn, &n2, 300000);
    capture_tare(&conn, &n2, 100000, None);
    settle_now(&conn, &n2, 240000, true);
    let n3 = create(&conn, p1, xm);
    conn.execute("UPDATE weigh_order SET status='voided', voided_at=registered_at, voided_by=1, void_reason='测试作废' WHERE order_no=?1", params![n3]).unwrap();
    let open = create(&conn, p1, xm);

    let all = list_orders(&conn, &filters()).unwrap();
    assert_eq!(all.total, 4, "作废单也在台账（可筛掉），但不进汇总");
    assert_eq!(all.summary.count, 2, "summary 只算参与汇总的单");
    assert_eq!(all.summary.net_01kg, 100000 + 200000);
    assert_eq!(all.summary.payable_fen, 2400000 + 4800000);

    let mut f_reg = filters();
    f_reg.status = Some("registered".into());
    let only_reg = list_orders(&conn, &f_reg).unwrap();
    assert_eq!(only_reg.total, 1, "未称重的 open 单仍是 registered");
    assert_eq!(only_reg.summary.count, 0, "它在汇总里不该有数");
    let mut f_v = filters();
    f_v.status = Some("voided".into());
    let voided = list_orders(&conn, &f_v).unwrap();
    assert_eq!(voided.total, 1);
    assert_eq!(voided.summary.count, 0);
    let mut f_p = filters();
    f_p.party_id = Some(serde_json::json!(p2));
    let by_party = list_orders(&conn, &f_p).unwrap();
    assert_eq!(by_party.total, 1);
    assert_eq!(by_party.rows[0].order_no, n2);
    let mut f_k = filters();
    f_k.keyword = Some("2022".into());
    let kw = list_orders(&conn, &f_k).unwrap();
    assert_eq!(kw.total, 1, "证号尾号检索");
    let mut f_pg = filters();
    f_pg.page = Some(1);
    f_pg.page_size = Some(2);
    let page = list_orders(&conn, &f_pg).unwrap();
    assert_eq!(page.rows.len(), 2);
    assert_eq!(page.total, 4);
    assert_eq!(page.summary.count, 2, "合计跨页，不随 LIMIT 缩水");

    // 在途条与看板 openOrders 同集合
    let o = open_orders(&conn).unwrap();
    assert!(o.iter().any(|x| x.order_no == open) && !o.iter().any(|x| x.order_no == n1));
}

#[test]
fn print_log_records_reprint_and_operator() {
    let conn = db();
    ensure_users(&conn);
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    let p = new_party(&conn, "丙", "341204199301272023");
    let no = create(&conn, p, xm);
    log_print(
        &conn,
        &actor(2, "weigher"),
        PrintLogInput { doc_type: "weigh_order".into(), doc_no: no.clone(), paper: "A4".into(), printer_name: "主票据打印机".into(), channel: "raw".into(), is_reprint: false, operator_id: None },
    )
    .unwrap();
    log_print(
        &conn,
        &actor(2, "weigher"),
        PrintLogInput { doc_type: "weigh_order".into(), doc_no: no.clone(), paper: "A4".into(), printer_name: "主票据打印机".into(), channel: "preview".into(), is_reprint: true, operator_id: None },
    )
    .unwrap();
    let o = load_order_full(&conn, &no).unwrap().unwrap();
    let prints = o.prints.unwrap();
    assert_eq!(prints.len(), 2);
    assert_eq!(prints[1].is_reprint, 1);
    assert_eq!(prints[0].operator_id, 2, "经办人以会话为准，不认前端传的 operator_id");
}

// -------------------------------------------------------------- 作废与结算归属

fn void_input(no: &str, reason: &str, authorized_by: i64) -> VoidOrderInput {
    VoidOrderInput { order_no: no.into(), reason: reason.into(), operator_id: None, authorized_by }
}

/// 作废在 mock 里谁点都放行，真库的三道闸门（岗位、事由、状态）逐条钉死。
#[test]
fn void_gates_on_reason_authorizer_and_state_machine() {
    let conn = db();
    ensure_users(&conn);
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    let p = new_party(&conn, "丁", "341204199301272024");
    let no = create(&conn, p, xm);
    let w2: i64 = conn.query_row("SELECT id FROM user_account WHERE username='w2'", [], |r| r.get(0)).unwrap();
    let weigher = actor(2, "weigher");

    // 事由：迎检要看懂"为什么废"，两个字不算理由
    let e = void_order(&conn, &weigher, void_input(&no, "手滑", 1)).unwrap_err();
    assert!(e.contains("6 个字"), "事由长度要回人话：{e}");
    // 授权人：磅员自己放行 = 没有授权
    let e = void_order(&conn, &weigher, void_input(&no, "农户临时取消售粮", w2)).unwrap_err();
    assert!(e.contains("站长"), "授权人岗位要挑明：{e}");
    let e = void_order(&conn, &weigher, void_input(&no, "农户临时取消售粮", 9999)).unwrap_err();
    assert!(e.contains("不存在"), "{e}");

    // 站长授权 → 置状态、记经办人、留审计与时间轴
    let reason = "农户临时取消售粮，车辆已卸离磅面";
    let o = void_order(&conn, &weigher, void_input(&no, reason, 1)).unwrap().unwrap();
    assert_eq!(o.status, "voided");
    assert_eq!(o.void_reason.as_deref(), Some(reason));
    assert!(o.voided_at.is_some());
    let (voided_by, audit_auth): (i64, Option<i64>) = conn
        .query_row(
            "SELECT o.voided_by, a.authorized_by FROM weigh_order o JOIN audit_log a ON a.entity_no = o.order_no AND a.action='order.void' WHERE o.order_no=?1",
            params![no],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(voided_by, 2, "经办人是点作废的磅员");
    assert_eq!(audit_auth, Some(1), "授权人另记一笔，迎检查得到是谁批的");
    let tl = o.timeline.unwrap();
    assert!(tl.iter().any(|e| e.action == "order.void"), "时间轴要出现作废这一步");

    // 重复作废 → 拒（不是静默成功）
    let e = void_order(&conn, &weigher, void_input(&no, "再废一次试试看", 1)).unwrap_err();
    assert!(e.contains("已作废"), "{e}");

    // 台账仍查得到，汇总不再有它的数
    let all = list_orders(&conn, &filters()).unwrap();
    assert_eq!(all.total, 1, "作废单永不物理删除");
    assert_eq!(all.summary.count, 0, "不参与任何汇总统计");
}

/// 详情页的「所属结算单」跳转：真库口径必须能反复查到，不是只在结算那一刻返回一次。
#[test]
fn settlement_of_links_order_and_settled_order_cannot_be_voided() {
    let conn = db();
    ensure_users(&conn);
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    seed_price(&conn, xm);
    let p = new_party(&conn, "戊", "341204199301272025");
    let no = create(&conn, p, xm);
    capture_gross(&conn, &no, 200000);
    capture_tare(&conn, &no, 100000, None);

    // 未结算 → None（详情页据此显示"本单尚未结算"）
    assert!(settlement_of(&conn, &no).unwrap().is_none());
    assert!(settlement_of(&conn, "BD01202601000000").unwrap().is_none(), "查无此单同样回 None，不编一个出来");

    let r = settle_now(&conn, &no, 240000, false);
    let s = settlement_of(&conn, &no).unwrap().unwrap();
    assert_eq!(s.settle_no, r.settlement.settle_no);
    assert_eq!(s.payable_fen, 2400000);
    assert_eq!(s.payment_status, "unpaid");
    assert!(s.orders.iter().any(|o| o.order_no == no), "明细里能看见本单");

    // 已结算的单禁止作废（02 §F2.3：只能走红冲更正）
    let e = void_order(&conn, &actor(4, "cashier"), void_input(&no, "价格算错了想废了重开", 1)).unwrap_err();
    assert!(e.contains("红冲"), "已结算要指路红冲：{e}");
    assert_eq!(load_order_full(&conn, &no).unwrap().unwrap().status, "settled", "拒绝作废不得改坏状态");
}

// ---------------------------------------------------- 服务端不变式回归（P0 加固）

/// 直接调 capture 拿 Result，用于断言"该被拦下"的路径（`capture_gross/tare` 会 panic）。
fn cap(
    conn: &Connection,
    no: &str,
    wt: &str,
    w: i64,
    ov: Option<TareOverride>,
) -> Result<Option<banghe_lib::orders::WeighOrder>, String> {
    capture(
        conn,
        &actor(2, "weigher"),
        CaptureInput {
            order_no: no.into(),
            weigh_type: wt.into(),
            weight_01kg: w,
            source: "scale".into(),
            operator_id: None,
            raw_frame: None,
            has_photo: Some(false),
            tare_override: ov,
        },
    )
}

/// 以一条基准 SettleInput 起步，闭包按需改字段后交给 settle，返回 Result 以便断言报错。
fn settle_full(
    conn: &Connection,
    no: &str,
    f: impl FnOnce(&mut SettleInput),
) -> Result<Option<banghe_lib::orders::SettleResult>, String> {
    let mut input = SettleInput {
        order_no: no.into(),
        price_fen_per_ton: 240000,
        package_deduct_01kg: 0,
        moisture_deduct_01kg: 0,
        impurity_deduct_01kg: 0,
        other_deduct_01kg: 0,
        deduction_fee_fen: 0,
        pay_now: false,
        payment_method: "cash".into(),
        settler_id: None,
        price_list_id: Some(latest_price(conn)),
        price_override_reason: None,
        party_signed: Some(true),
    };
    f(&mut input);
    settle(conn, &actor(4, "cashier"), input)
}

fn xm_id(conn: &Connection) -> i64 {
    conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap()
}

#[test]
fn capture_rejects_nonpositive_weight() {
    let conn = db();
    ensure_users(&conn);
    let p = new_party(&conn, "壬", "341204199301272029");
    let no = create(&conn, p, xm_id(&conn));
    let e = cap(&conn, &no, "gross", 0, None).unwrap_err();
    assert!(e.contains("大于 0"), "0 读数必须在服务端就被拒（P0-2）：{e}");
}

#[test]
fn capture_rejects_tare_not_below_gross() {
    let conn = db();
    ensure_users(&conn);
    seed_price(&conn, xm_id(&conn));
    let p = new_party(&conn, "癸", "341204199301272030");
    let no = create(&conn, p, xm_id(&conn));
    capture_gross(&conn, &no, 80000);
    // 皮重(90000) 高于 毛重(80000)：去掉 abs() 后应报错，而不是洗成 10000 的"合法"净重
    let e = cap(&conn, &no, "tare", 90000, None).unwrap_err();
    assert!(e.contains("毛重") || e.contains("净重"), "皮≥毛要拦下（C4）：{e}");
    let o = load_order_full(&conn, &no).unwrap().unwrap();
    assert!(o.net_weight_01kg.is_none(), "拦下不得写入净重，也不得留下已采用轨迹");
}

#[test]
fn capture_reweigh_keeps_single_adopted_per_type() {
    let conn = db();
    ensure_users(&conn);
    let p = new_party(&conn, "辛", "341204199301272028");
    let no = create(&conn, p, xm_id(&conn));
    capture_gross(&conn, &no, 200000);
    cap(&conn, &no, "gross", 210000, None).unwrap(); // 复称：同类型再取一次

    let oid: i64 = conn.query_row("SELECT id FROM weigh_order WHERE order_no=?1", params![no], |r| r.get(0)).unwrap();
    let adopted: i64 = conn.query_row(
        "SELECT COUNT(*) FROM weigh_record WHERE order_id=?1 AND weigh_type='gross' AND is_adopted=1",
        params![oid],
        |r| r.get(0),
    )
    .unwrap();
    assert_eq!(adopted, 1, "复称后同类只能有一条已采用（P0-3）");
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM weigh_record WHERE order_id=?1", params![oid], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 2, "旧轨迹保留做留痕，只是降级为未采用");
    assert_eq!(load_order_full(&conn, &no).unwrap().unwrap().gross_weight_01kg, Some(210000), "头值取最新采用值");
}

#[test]
fn capture_tare_tolerance_gate_enforced_server_side() {
    let conn = db();
    ensure_users(&conn);
    let p = new_party(&conn, "己", "341204199301272026");
    let no = create(&conn, p, xm_id(&conn));
    capture_gross(&conn, &no, 200000);
    capture_tare(&conn, &no, 100000, None); // 首次无基准 → 放行并记为最近皮重

    // 第二次皮重偏离基准 30%（远超 3% 容差），未带授权 → 服务端必须拦下（补 C2 的 fail-open）
    let e = cap(&conn, &no, "tare", 130000, None).unwrap_err();
    assert!(e.contains("容差"), "超差皮重要指路授权：{e}");

    // 带在职站长授权后放行
    let ok = cap(&conn, &no, "tare", 130000, Some(TareOverride { by: 1, reason: "车上加了备胎，站长现场确认".into() }));
    assert!(ok.is_ok(), "站长授权的异常皮重应放行：{ok:?}");

    // 异常皮重不得污染基准：last_tare 仍是 100000
    let base: i64 = conn.query_row("SELECT last_tare_01kg FROM party WHERE id=?1", params![p], |r| r.get(0)).unwrap();
    assert_eq!(base, 100000, "超差放行的皮重不得改写最近皮重基准");
}

#[test]
fn settle_rejects_over_deduction_and_negative_payable() {
    let conn = db();
    ensure_users(&conn);
    seed_price(&conn, xm_id(&conn));
    let p = new_party(&conn, "庚", "341204199301272027");
    let no = create(&conn, p, xm_id(&conn));
    capture_gross(&conn, &no, 150000);
    capture_tare(&conn, &no, 50000, None); // 净重 = 100000 (0.1kg)

    // 扣量合计超过净重：以前静默 Ok(None)，现在必须明确报错（P0-5）
    let e = settle_full(&conn, &no, |i| i.other_deduct_01kg = 120000).unwrap_err();
    assert!(e.contains("结算重量"), "超扣要报结算重量不为正：{e}");

    // 扣款大于货款 → 应付为负必须拒（P0-5）
    let e2 = settle_full(&conn, &no, |i| i.deduction_fee_fen = 999_999_999).unwrap_err();
    assert!(e2.contains("应付"), "扣款超货款要报应付不得为负：{e2}");

    // 合法边界仍应通过：全额净重、无扣款
    let ok = settle_full(&conn, &no, |_| {});
    assert!(ok.is_ok(), "正常结算不应被新闸门误伤：{ok:?}");
}

#[test]
fn list_parties_supports_type_and_keyword_together() {
    let conn = db();
    new_party(&conn, "甲张", "341204199301272031");
    new_party(&conn, "乙李", "341204199301272032");
    // 关键字 + 分类同时给：曾因 match 落到 query_map([]) 而绑定数不符直接报错（C8）
    let hit = list_parties(&conn, "甲", Some("farmer")).expect("分类+关键字联合检索不应报错");
    assert_eq!(hit.len(), 1);
    assert_eq!(hit[0].name, "甲张");
    let none = list_parties(&conn, "王", Some("farmer")).expect("无匹配同样应正常返回空集合");
    assert!(none.is_empty());
}
