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
use banghe_lib::cards::{pool_register, pool_retire, RegisterInput, RetireInput};
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::orders::{
    capture, create_order, get_party, list_orders, list_parties, list_qc, load_order_full, log_print, open_orders, save_party, save_qc, settlement_of, settle, set_price, void_order, assign_destination,
    party_photo_view, capture_photo_view, set_party_photo, update_meta, set_variety, CaptureInput, CreateOrderInput, OrderFilters, PartyPhotoInput, PartySaveInput, PrintLogInput, QcIndicatorInput, QcListOpts, PriceAdjustInput, SaveQcInput, SettleInput, VarietyAdjustInput, VoidOrderInput, AssignDestinationInput, UpdateOrderInput,
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

/// 按指定卡号登记一张空闲在册卡（外来卡在测试里就是"没调这个辅助的卡号"）
fn register_card(conn: &Connection, card_no: &str) {
    pool_register(
        conn,
        &actor(1, "station_master"),
        RegisterInput { card_no: card_no.into(), label: None, remark: None, operator_id: None },
    )
    .expect("登记流转卡应成功");
}

/// 制单默认必须绑一张空闲卡（06 §4.0），所以这套用例每建一张单都先在卡池造一张在册卡。
fn free_card(conn: &Connection) -> String {
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM card", [], |r| r.get(0)).unwrap();
    let card_no = format!("04A2C{n:04X}");
    register_card(conn, &card_no);
    card_no
}

/// 一张"能过磅的单"要先有价：`capture` 在毛重那一捕上有价格闸（02 §F1.4），没价这一捕直接被拒。
///
/// 只在**这个品种还没有任何价**时补一条。已经 seed 过的用例一律不动——好几个用例是"先
/// `seed_price` 再制单"，为的是断言 `price_list_id` 锚到哪一行；多插一行会把那个锚挪到新行上。
fn ensure_price(conn: &Connection, variety: i64) -> i64 {
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM price_list WHERE variety_id = ?1 ORDER BY id LIMIT 1", params![variety], |r| r.get(0))
        .ok();
    existing.unwrap_or_else(|| seed_price(conn, variety))
}

fn create(conn: &Connection, party: i64, variety: i64) -> String {
    ensure_price(conn, variety);
    create_order(
        conn,
        &actor(1, "weigher"),
        CreateOrderInput {
            party_id: party,
            variety_id: Some(variety),
            vehicle_no: Some("豫A12345".into()),
            warehouse_id: None,
            slot_id: None,
            remark: None,
            card_no: Some(free_card(conn)),
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
            tare_warning: None,
            frames: Vec::new(),
        },
    )
    .unwrap()
    .expect("单应存在");
}

fn capture_tare(conn: &Connection, no: &str, w: i64, warning: Option<&str>) {
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
            tare_override: None,
            tare_warning: warning.map(str::to_string),
            frames: Vec::new(),
        },
    )
    .unwrap()
    .expect("单应存在");
}

fn qc_input(no: &str) -> SaveQcInput {
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
    }
}

fn accept_qc(conn: &Connection, no: &str) -> banghe_lib::orders::QcReport {
    save_qc(conn, &actor(3, "inspector"), qc_input(no)).unwrap().expect("单应存在")
}

/// 直接拿 Result 的那一条：断言"化验该被闸门拦下"时用（`accept_qc` 会 panic）
fn try_qc(conn: &Connection, no: &str) -> Result<Option<banghe_lib::orders::QcReport>, String> {
    save_qc(conn, &actor(3, "inspector"), qc_input(no))
}

fn latest_price(conn: &Connection) -> i64 {
    conn.query_row("SELECT id FROM price_list ORDER BY id DESC LIMIT 1", [], |r| r.get(0)).unwrap()
}

/// 结算辅助。改价事由恒带：`settle` 只在**真改价**时才落这条事由（照价目执行的那一遍落 NULL），
/// 所以带上它不会污染"照价目执行"那几个用例；而给某些没建价目行的品种结算时，正是这道闸门
/// （2026-09-14 起：偏离价目 / 手工定价必须写清事由）要求它。
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
            paid_amount_fen: None,
            payment_method: "cash".into(),
            settler_id: None,
            price_list_id: Some(latest_price(conn)),
            price_override_reason: Some("测试结算价".into()),
            party_signed: Some(true),
            grade: None,
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

/// 制单必须绑卡（06 §4.0）：读不到卡就不许取号，卡未登记/已注销/还挂着没做完的单都要拦下。
/// 全是接了真刷卡才犯得出来的错——尤其"闸门不过却已经把流水号吃掉了"这一条。
#[test]
fn create_order_binds_a_free_card_or_refuses_the_number() {
    let conn = db();
    ensure_users(&conn);
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    let party = new_party(&conn, "卡一", "341204199301272031");
    let ym = Local::now().format("%Y%m").to_string();
    let order_rows = |c: &Connection| c.query_row("SELECT COUNT(*) FROM weigh_order", [], |r| r.get::<_, i64>(0)).unwrap();
    let try_create = |card: Option<&str>| -> Result<String, String> {
        create_order(
            &conn,
            &actor(1, "weigher"),
            CreateOrderInput {
                party_id: party,
                variety_id: Some(xm),
                vehicle_no: None,
                warehouse_id: None,
                slot_id: None,
                remark: None,
                card_no: card.map(str::to_string),
                registered_by: None,
                weight_source: "scale".into(),
            },
        )
        .map(|o| o.order_no)
    };

    let seq_rows = |c: &Connection| {
        c.query_row("SELECT COUNT(*) FROM seq_counter WHERE prefix_key = ?1", params![format!("BD:01:{ym}")], |r| r.get::<_, i64>(0)).unwrap()
    };
    // 闸门 1：没刷到卡 —— 连号都不该取
    let e = try_create(None).unwrap_err();
    assert!(e.contains("没刷到流转卡"), "应提示没读到卡，实际：{e}");
    // 闸门 2：外来卡（卡池里没这串号）—— 不做"见卡就发"（06 §4.4 C2）
    let e = try_create(Some("DEADBEEF")).unwrap_err();
    assert!(e.contains("未登记"), "应提示卡未登记，实际：{e}");
    // 闸门 3：注销过的卡不能再拿来开单
    register_card(&conn, "04A2FFFF");
    pool_retire(&conn, &actor(1, "station_master"), RetireInput { card_no: "04A2FFFF".into(), reason: "磨损淘汰".into() })
        .expect("注销应成功");
    let e = try_create(Some("04a2 ffff")).unwrap_err();
    assert!(e.contains("已注销"), "应提示卡已注销，实际：{e}");
    assert_eq!(order_rows(&conn), 0, "被拦下的刷卡不该留下磅单");
    assert_eq!(seq_rows(&conn), 0, "闸门不过时不消耗流水号");

    // 空闲在册卡：制单成功，卡池占用与单据快照同事务对上
    register_card(&conn, "04A21F01");
    let no = try_create(Some(" 04a2-1f01 ")).expect("空闲卡应能制单");
    let (oid, snapshot): (i64, Option<String>) = conn
        .query_row("SELECT id, card_no FROM weigh_order WHERE order_no = ?1", params![&no], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!(snapshot.as_deref(), Some("04A21F01"), "单据侧快照要写归一后的卡号");
    let (card_status, card_order): (String, Option<i64>) = conn
        .query_row("SELECT status, current_order_id FROM card WHERE card_no = '04A21F01'", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((card_status.as_str(), card_order), ("in_use", Some(oid)), "占用真相在 card 表那一行");
    let issued: i64 = conn
        .query_row("SELECT COUNT(*) FROM audit_log WHERE action='card.issue' AND entity_no='04A21F01'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(issued, 1, "制单绑卡要留一笔发卡痕迹");

    // 闸门 4：这张卡还有没做完的单 —— 一张卡不能同时开两张单，文案要点出挂在哪张单上
    let e = try_create(Some("04A21F01")).unwrap_err();
    assert!(e.contains("还挂着没做完的单") && e.contains(&no), "要说清卡挂在哪个单，实际：{e}");
    assert_eq!(order_rows(&conn), 1, "被拦下的第二次制单不留单");
    assert_eq!(seq_rows(&conn), 1, "被拦下的第二次制单也不该多吃一个号");

    // 它挂着的单到终态却没自动回池（站点关了 card_release_on_terminal）：制单就地收回来再绑
    conn.execute("UPDATE weigh_order SET status = 'settled' WHERE id = ?1", params![oid]).unwrap();
    let no2 = try_create(Some("04A21F01")).expect("挂着终态单的卡应视同空闲");
    let card_order2: Option<i64> = conn
        .query_row("SELECT current_order_id FROM card WHERE card_no = '04A21F01'", [], |r| r.get(0))
        .unwrap();
    assert!(card_order2.is_some() && no2 != no, "卡应换挂到刚制的这张单上");
    let new_snapshot: Option<String> = conn
        .query_row("SELECT card_no FROM weigh_order WHERE order_no = ?1", params![&no2], |r| r.get(0))
        .unwrap();
    assert_eq!(new_snapshot.as_deref(), Some("04A21F01"), "新单要带上这张收回来的卡");
    assert_eq!(
        1,
        conn.query_row("SELECT COUNT(*) FROM weigh_order WHERE order_no = ?1 AND card_no = '04A21F01'", params![&no], |r| r.get::<_, i64>(0))
            .unwrap(),
        "旧单的卡号快照照旧留着：码单已按它印出，占用只跟最后一张单"
    );

    // 参数关掉：回到"制单不绑卡、卡事后靠后台监听发"（06 §3 的旧路径）
    conn.execute("UPDATE app_setting SET value_json = 'false' WHERE key = 'card_required_on_create'", []).unwrap();
    try_create(None).expect("关掉参数后无卡也能制单");
}

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
    assert_eq!(o.variety_name.as_deref(), Some("小麦"));
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
        CaptureInput { order_no: no.clone(), weigh_type: "gross".into(), weight_01kg: 1, source: "scale".into(), operator_id: None, raw_frame: None, has_photo: None, tare_override: None, tare_warning: None, frames: Vec::new() },
    )
    .unwrap_err();
    assert!(e.contains("不能再称重"), "拒绝原因要回人话：{e}");
}

/// 毛重那一捕之前单上必须有价（02 §F1.4）。
///
/// 闸口刻意落在**毛重**：那是"这车粮上磅"的那一刻，谈成才卸货。皮重不设这道闸——空车多重与
/// 这车粮值多少钱无关，而一次/二次称重顺序自由，先捕皮重后捕毛重的车，毛重那一捕照样被拦下。
/// 拦下的只是这一捕：单的状态、重量、轨迹一概不写，填好价再捕照常有迹可循。
#[test]
fn a_gross_capture_needs_a_price_on_the_order() {
    let conn = db();
    ensure_users(&conn);
    let p = new_party(&conn, "价", "341204199301272099");
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    // 这个品种在价目表里没有现行价 → 制单不带价。**制单那一刻不拦**（价是后头补得上的，
    // 号取不出来才是真卡住现场），拦的是收粮那一捕。
    let no = create_order(
        &conn,
        &actor(1, "weigher"),
        CreateOrderInput {
            party_id: p,
            variety_id: Some(xm),
            vehicle_no: None,
            warehouse_id: None,
            slot_id: None,
            remark: None,
            card_no: Some(free_card(&conn)),
            registered_by: None,
            weight_source: "scale".into(),
        },
    )
    .expect("没价的单也要制得出来")
    .order_no;

    let e = cap(&conn, &no, "gross", 200000, None).unwrap_err();
    assert!(e.contains("单价"), "没价的毛重捕获必须被拦下：{e}");
    let o = load_order_full(&conn, &no).unwrap().unwrap();
    assert!(o.price_fen_per_ton.is_none(), "制单时该品种没有现行价目，本单不该凭空有价");
    assert_eq!(o.status, "registered", "拦下的是这一捕，不推进状态");
    assert!(o.gross_weight_01kg.is_none());
    assert!(o.records.as_ref().unwrap().is_empty(), "被拦下的一捕不许留轨迹");

    // 皮重那一捕不设这道闸：先捕皮重的车（一次/二次称重顺序自由）照样收得下
    capture_tare(&conn, &no, 100000, None);

    // 现场谈定价（该品种无现行价目 ⇒ 手工定价，事由必填）→ 毛重那一捕照常过，净重也算得出
    set_price(
        &conn,
        &actor(1, "station_master"),
        PriceAdjustInput {
            order_no: no.clone(),
            price_fen_per_ton: 240000,
            price_list_id: None,
            reason: "现场谈的价".into(),
            operator_id: None,
        },
    )
    .unwrap()
    .expect("单应存在");
    capture_gross(&conn, &no, 200000);
    let o = load_order_full(&conn, &no).unwrap().unwrap();
    assert_eq!(o.net_weight_01kg, Some(100000));
    assert_eq!(o.status, "to_settle");
}

/// 皮重偏差超容差不再拦下：数据照常有效，捕获成功并自动记一条警示（无授权人），基准不被污染。
#[test]
fn tare_over_tolerance_still_captures_and_warns() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "王五", "341204199301272017");
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    let no = create(&conn, party, xm);
    capture_gross(&conn, &no, 200000);
    capture_tare(&conn, &no, 100000, None); // 首次无基准 → 放行并记为最近皮重 100000

    // 第二次皮重 150000 偏离基准 50%（远超 3% 容差），未带任何客户端文案 → 服务端仍放行，自动生成警示
    capture_tare(&conn, &no, 150000, None);
    let o = load_order_full(&conn, &no).unwrap().unwrap();
    let warn = o.tare_override_reason.expect("超容差皮重必须留醒目警示");
    assert!(warn.contains("容差"), "警示要写清超容差：{warn}");
    assert!(warn.contains("50.0%"), "自动生成文案要算出偏差比例：{warn}");
    assert_eq!(o.tare_override_by, None, "不再有授权人，此列恒空");
    assert_eq!(o.status, "to_settle", "捕获照常推进状态，不因超容差被卡住");

    // 审计留痕，且 authorized_by 为空（不再要求站长授权）
    let authorized_by: Option<i64> = conn
        .query_row("SELECT authorized_by FROM audit_log WHERE action='tare.override' AND entity_no=?1", params![no], |r| r.get(0))
        .unwrap();
    assert_eq!(authorized_by, None, "警示是自动记录，不存在授权人");

    // 超容差的皮重不得污染基准：last_tare 仍是 100000
    let base: i64 = conn.query_row("SELECT last_tare_01kg FROM party WHERE id=?1", params![party], |r| r.get(0)).unwrap();
    assert_eq!(base, 100000, "超容差皮重不得改写最近皮重基准");
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
            paid_amount_fen: None,
            payment_method: "cash".into(),
            settler_id: None,
            price_list_id: Some(latest_price(&conn)),
            price_override_reason: None,
            party_signed: Some(false),
            grade: None,
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
            other_deduct_01kg: 0, deduction_fee_fen: 0, pay_now: true, payment_method: "cash".into(), paid_amount_fen: None, settler_id: None,
            price_list_id: Some(latest_price(&conn)), price_override_reason: None, party_signed: None,
            grade: None,
        },
    )
    .unwrap_err();
    assert!(e.contains("重复结算"), "回人话：{e}");

    // 手填单价偏离价目表却不写事由 → **照常放行**（2026-09-14 起改口径：改价事由是选填）。
    // 写了才随结算留痕，不写那列就落 NULL——票面照出，"凭什么"留给事后解释。
    let no2 = create(&conn, party, xm);
    capture_gross(&conn, &no2, 200000);
    capture_tare(&conn, &no2, 100000, None);
    let settle_no2 = |reason: Option<&str>| SettleInput {
        order_no: no2.clone(), price_fen_per_ton: 250000, package_deduct_01kg: 0, moisture_deduct_01kg: 0, impurity_deduct_01kg: 0,
        other_deduct_01kg: 0, deduction_fee_fen: 0, pay_now: true, payment_method: "cash".into(), paid_amount_fen: None, settler_id: None,
        price_list_id: None, price_override_reason: reason.map(str::to_string), party_signed: None,
        grade: None,
    };
    let r3 = settle(&conn, &actor(4, "cashier"), settle_no2(None)).unwrap().unwrap();
    assert_eq!(r3.order.price_fen_per_ton, Some(250000), "偏离价目也放行：改价事由是选填");
    assert_eq!(r3.order.price_override_reason, None, "没写事由就不该凭空冒出一句");
    assert_eq!(r3.order.status, "settled");

    // 当场结清（写清事由）：付款流水同事务落，FK 单号同 seq_counter
    let no3 = create(&conn, party, xm);
    capture_gross(&conn, &no3, 200000);
    capture_tare(&conn, &no3, 100000, None);
    let r2 = settle(
        &conn,
        &actor(4, "cashier"),
        SettleInput {
            order_no: no3.clone(), price_fen_per_ton: 250000, package_deduct_01kg: 0, moisture_deduct_01kg: 0, impurity_deduct_01kg: 0,
            other_deduct_01kg: 0, deduction_fee_fen: 0, pay_now: true, payment_method: "wechat".into(), paid_amount_fen: None, settler_id: None,
            price_list_id: None, price_override_reason: Some("当日市场价上浮，站长口头确认".into()), party_signed: Some(true),
            grade: None,
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

/// 一人一号（02 §F3.1）：建档与改档都要先查后写，报错点出既有档案姓名；
/// 没填电话的两份档案不得互相顶掉（空号一律 NULL）。
#[test]
fn party_phone_is_unique_and_names_the_conflicting_archive() {
    let conn = db();
    let a = new_party(&conn, "孙大娘", "341221198203150011");
    save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput { id: Some(a), phone: Some("138-0013 8000".into()), ..empty_party_input() },
    )
    .unwrap();
    assert_eq!(get_party(&conn, a).unwrap().unwrap().party.phone, "13800138000", "入库前归一：去空白与 `-`");

    // 建档撞上别人的号：报错带原档案姓名
    let e = save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput {
            name: Some("李二".into()),
            party_type: Some("farmer".into()),
            id_card_no: Some("341221198203150029".into()),
            phone: Some("13800138000".into()),
            ..empty_party_input()
        },
    )
    .unwrap_err();
    assert!(e.contains("孙大娘") && e.contains("13800138000"), "{e}");

    // 改档撞上别人的号：同样拦，且这条档案没被写花
    let b = new_party(&conn, "王三", "341221198203150030");
    let e = save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput { id: Some(b), phone: Some("138 0013-8000".into()), ..empty_party_input() },
    )
    .unwrap_err();
    assert!(e.contains("孙大娘"), "写法不同（带空格/横线）也要认出来：{e}");
    assert_eq!(get_party(&conn, b).unwrap().unwrap().party.phone, "", "拦下来就不能留下一半结果");

    // 自己的号原样再存一次（顺带改备注）不该误伤自己
    save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput {
            id: Some(a),
            phone: Some("13800138000".into()),
            remark: Some("常年供粮".into()),
            ..empty_party_input()
        },
    )
    .unwrap();

    // 空号不占唯一位：清空电话＝没填电话，第二户照样建得出来
    save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput { id: Some(b), phone: Some("".into()), ..empty_party_input() },
    )
    .unwrap();
    let c = new_party(&conn, "赵四", "34122119820315004X");
    save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput { id: Some(c), phone: Some("  ".into()), ..empty_party_input() },
    )
    .unwrap();
    let nulls: i64 = conn
        .query_row("SELECT COUNT(*) FROM party WHERE phone_enc IS NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(nulls, 2, "空电话必须存 NULL，否则 `uk_party_phone` 会把第二户顶掉：{nulls}");
}

/// 建档最低要求＝姓名 + 证号与电话至少一个（02 §F3.1）：没带卡的临时户留个电话也得建得下来，
/// 此时证号列存 NULL（不是空串）、核验标记一律 0；两样都空才拦。
#[test]
fn phone_only_party_archives_are_allowed_and_stay_distinct() {
    let conn = db();
    let e = save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput { name: Some("临时户".into()), party_type: Some("farmer".into()), ..empty_party_input() },
    )
    .unwrap_err();
    assert!(e.contains("至少填一个"), "证号与电话都空要拦下：{e}");

    let a = save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput {
            name: Some("临时户".into()),
            party_type: Some("farmer".into()),
            phone: Some("13900001111".into()),
            // 这一刻根本没有证号可读，即便调用方把核验标记带过来也不该认账
            id_card_verified: Some(1),
            ..empty_party_input()
        },
    )
    .expect("只填电话应当建得档")
    .id;
    let p = get_party(&conn, a).unwrap().unwrap().party;
    assert_eq!(p.id_card_no, "");
    assert_eq!(p.id_card_verified, 0, "没证号谈不上已核验");
    let (enc_null, fp_null): (bool, bool) = conn
        .query_row(
            "SELECT id_card_no_enc IS NULL, id_card_no_fp IS NULL FROM party WHERE id = ?1",
            params![a],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert!(enc_null && fp_null, "空证号必须存 NULL，不能落一个和「没填」长得一样的空串");
    assert!(list_parties(&conn, "13900001111", None).unwrap().iter().any(|x| x.id == a), "电话就是搜人的抓手");

    // 无证号的档案之间不该被 fp 误认成同一人（NULL 不参与唯一约束）
    save_party(
        &conn,
        &actor(1, "station_master"),
        PartySaveInput {
            name: Some("另一临时户".into()),
            party_type: Some("farmer".into()),
            phone: Some("13900002222".into()),
            ..empty_party_input()
        },
    )
    .expect("第二张只填电话的档案照样建得出来");
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

fn void_input(no: &str, reason: &str) -> VoidOrderInput {
    // authorized_by 已废弃（作废不走授权），DTO 里只为兼容旧调用方而存在
    VoidOrderInput { order_no: no.into(), reason: reason.into(), operator_id: None, authorized_by: None }
}

/// 真库的三道闸门（岗位、事由、状态）逐条钉死；作废**不需要站长授权**。
#[test]
fn void_gates_on_reason_and_state_machine_without_authorization() {
    let conn = db();
    ensure_users(&conn);
    let xm: i64 = conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap();
    let p = new_party(&conn, "丁", "341204199301272024");
    let no = create(&conn, p, xm);
    let weigher = actor(2, "weigher");

    // 事由：迎检要看懂"为什么废"，两个字不算理由
    let e = void_order(&conn, &weigher, void_input(&no, "手滑")).unwrap_err();
    assert!(e.contains("6 个字"), "事由长度要回人话：{e}");

    // 磅员自己就能废：不查站长、不要求谁批——留痕的是经办人与事由
    let reason = "农户临时取消售粮，车辆已卸离磅面";
    let o = void_order(&conn, &weigher, void_input(&no, reason)).unwrap().unwrap();
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
    assert_eq!(audit_auth, None, "作废不走授权，审计里不得凭空冒出一个授权人");
    let tl = o.timeline.unwrap();
    assert!(tl.iter().any(|e| e.action == "order.void"), "时间轴要出现作废这一步");

    // 重复作废 → 拒（不是静默成功）
    let e = void_order(&conn, &weigher, void_input(&no, "再废一次试试看")).unwrap_err();
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
    let e = void_order(&conn, &actor(4, "cashier"), void_input(&no, "价格算错了想废了重开")).unwrap_err();
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
    warning: Option<&str>,
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
            tare_override: None,
            tare_warning: warning.map(str::to_string),
            frames: Vec::new(),
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
        paid_amount_fen: None,
        payment_method: "cash".into(),
        settler_id: None,
        price_list_id: Some(latest_price(conn)),
        price_override_reason: None,
        party_signed: Some(true),
        grade: None,
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

/// 服务端独立复算皮重容差：不信任前端有没有弹过提示，超差一律放行但自动补一条警示；
/// 客户端附带的现场说明要保留，且异常皮重不得污染最近皮重基准。
#[test]
fn capture_tare_tolerance_recomputed_server_side() {
    let conn = db();
    ensure_users(&conn);
    let p = new_party(&conn, "己", "341204199301272026");
    let no = create(&conn, p, xm_id(&conn));
    capture_gross(&conn, &no, 200000);
    capture_tare(&conn, &no, 100000, None); // 首次无基准 → 放行并记为最近皮重

    // 第二次皮重偏离基准 30%（远超 3% 容差），未带任何文案 → 服务端仍放行并自动补警示
    let ok = cap(&conn, &no, "tare", 130000, None).expect("超容差皮重不得被拦下");
    let o = ok.unwrap();
    assert!(o.tare_override_reason.as_deref().unwrap_or("").contains("30.0%"), "服务端要自己算出偏差：{:?}", o.tare_override_reason);

    // 客户端带现场说明 → 服务端复算仍触发，且原文案被并进警示里
    let o = cap(&conn, &no, "tare", 130000, Some("车上加了备胎")).unwrap().unwrap();
    let warn = o.tare_override_reason.expect("超容差必须留警示");
    assert!(warn.contains("备胎"), "客户端说明要保留：{warn}");
    assert!(warn.contains("容差"), "警示要写清超容差：{warn}");

    // 异常皮重不得污染基准：last_tare 仍是 100000
    let base: i64 = conn.query_row("SELECT last_tare_01kg FROM party WHERE id=?1", params![p], |r| r.get(0)).unwrap();
    assert_eq!(base, 100000, "超容差皮重不得改写最近皮重基准");
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
fn settle_part_pay_lands_on_credit_and_finishes_with_record_payment() {
    let conn = db();
    ensure_users(&conn);
    let xm = xm_id(&conn);
    seed_price(&conn, xm);
    let p = new_party(&conn, "辛", "341204199301272028");
    // 净重 10 t × 2400 元/吨 → 应付 2_400_000 分
    let weighed = |conn: &Connection| {
        let no = create(conn, p, xm);
        capture_gross(conn, &no, 150000);
        capture_tare(conn, &no, 50000, None);
        no
    };
    let no_full = weighed(&conn);
    let no_part = weighed(&conn);
    let no_zero = weighed(&conn);
    let no_over = weighed(&conn);

    // ① 老 payload：不带实付金额＝一次付清，行为与改造前一字不差
    let r = settle_full(&conn, &no_full, |i| i.pay_now = true).unwrap().unwrap();
    assert_eq!((r.settlement.payment_status.as_str(), r.settlement.paid_fen), ("paid", 2_400_000));
    assert!(r.order.paid_at.is_some(), "付清才允许落 paid_at");

    // ② 闸门：实付 0 要人改走挂账，超付当场拦（都回中文短句）
    let e = settle_full(&conn, &no_zero, |i| {
        i.pay_now = true;
        i.paid_amount_fen = Some(0);
    })
    .unwrap_err();
    assert!(e.contains("必须大于 0"), "实付 0 应被拦下：{e}");
    let e2 = settle_full(&conn, &no_over, |i| {
        i.pay_now = true;
        i.paid_amount_fen = Some(2_400_001);
    })
    .unwrap_err();
    assert!(e2.contains("超过应付"), "超付应被拦下：{e2}");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM settlement", [], |r| r.get::<_, i64>(0)).unwrap(),
        1,
        "被拦下的结算必须一点没写进去"
    );

    // ③ 部分付款：只付 1_000 元，差额挂账
    let r2 = settle_full(&conn, &no_part, |i| {
        i.pay_now = true;
        i.paid_amount_fen = Some(100_000);
    })
    .unwrap()
    .unwrap();
    assert_eq!(r2.settlement.payment_status, "partial", "付不够就是部分付款");
    assert_eq!(r2.settlement.paid_fen, 100_000);
    assert_eq!(r2.order.payment_status, "partial");
    assert!(r2.order.paid_at.is_none(), "没付清不许落 paid_at");
    let (flow_fen, flow_remark): (i64, Option<String>) = conn
        .query_row(
            "SELECT pr.amount_fen, pr.remark FROM payment_record pr JOIN settlement s ON s.id = pr.settlement_id WHERE s.settle_no = ?1",
            params![r2.settlement.settle_no],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(flow_fen, 100_000, "流水只登记实付那一段，不许把应付记成已付");
    assert_eq!(flow_remark.as_deref(), Some("当场部分付款"));

    // ④ 挂账台账与看板同源：这张单要带未付余额出现在台账里
    let row = banghe_lib::settlements::credits(&conn)
        .unwrap()
        .into_iter()
        .find(|c| c.settlement.settle_no == r2.settlement.settle_no)
        .expect("部分付款的单必须挂进挂账台账");
    assert_eq!(row.unpaid_fen, 2_300_000, "未付＝应付 − 实付");
    let in_payable: i64 = conn
        .query_row("SELECT COUNT(*) FROM v_payable WHERE settle_no=?1", params![r2.settlement.settle_no], |r| r.get(0))
        .unwrap();
    assert_eq!(in_payable, 1, "看板挂账告警读的是同一张视图");

    // ⑤ 补录付清后退出台账（与 record_payment 的三档口径接得上）
    banghe_lib::settlements::record_payment(
        &conn,
        &actor(4, "cashier"),
        banghe_lib::settlements::RecordPaymentInput {
            settle_no: r2.settlement.settle_no.clone(),
            amount_fen: 2_300_000,
            method: "cash".into(),
            trade_no: None,
            operator_id: None,
        },
    )
    .unwrap()
    .expect("补录付款应命中该结算单");
    assert!(
        !banghe_lib::settlements::credits(&conn)
            .unwrap()
            .iter()
            .any(|c| c.settlement.settle_no == r2.settlement.settle_no),
        "付清后必须退出挂账台账"
    );
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

#[test]
fn list_parties_treats_all_as_no_type_filter() {
    let conn = db();
    new_party(&conn, "甲张", "341204199301272031");
    new_party(&conn, "乙李", "341204199301272032");
    // "all" 是界面筛选项的兜底值（出库单领出方下拉就传过它），拿去比对 party_type
    // 会查成空表，所以这里必须当「不限类型」处理
    let all = list_parties(&conn, "", Some("all")).expect("all 不应报错");
    assert_eq!(all.len(), 2, "all＝不限类型，不该一条都查不出来");
    assert_eq!(
        list_parties(&conn, "", Some("")).unwrap().len(),
        2,
        "空串同样是「不限」"
    );
    assert!(
        list_parties(&conn, "", Some("company")).unwrap().is_empty(),
        "真类型照常过滤，别把兜底值和真类型混为一谈"
    );
}

// ------------------------------------------------------------ 补录入仓去向
// 去向在制单时选填（03 §9.9），所以这条写路径要守住三件事：填了就得自洽
// （不许留"有货位没仓房"的半截去向）、谁登记的署名进 keeper_id、改派留审计。

/// 值仓账号（keeper_id 有外键，岗位账号得真存在）
fn ensure_keeper(conn: &Connection) -> i64 {
    conn.execute(
        "INSERT INTO user_account (username, display_name, password_hash, role, is_active, created_at)
         VALUES ('keep', '值仓', '!x', 'keeper', 1, '2026-01-01T00:00:00.000+08:00')",
        [],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn seed_warehouse(conn: &Connection, code: &str, active: bool) -> i64 {
    conn.execute(
        "INSERT INTO warehouse (code, name, kind, is_active, created_at) VALUES (?1, ?1, 'house', ?2, '2026-01-01T00:00:00.000+08:00')",
        params![code, i64::from(active)],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn seed_slot(conn: &Connection, warehouse: i64, code: &str, active: bool) -> i64 {
    conn.execute(
        "INSERT INTO storage_slot (warehouse_id, code, label, is_active) VALUES (?1, ?2, ?2, ?3)",
        params![warehouse, code, i64::from(active)],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn assign(conn: &Connection, keeper: i64, no: &str, warehouse: Option<i64>, slot: Option<i64>) -> Result<Option<banghe_lib::orders::WeighOrder>, String> {
    assign_destination(
        conn,
        &actor(keeper, "keeper"),
        AssignDestinationInput { order_no: no.into(), warehouse_id: warehouse, slot_id: slot, operator_id: None },
    )
}

fn dest_audits(conn: &Connection, no: &str) -> Vec<(String, String)> {
    let mut st = conn
        .prepare("SELECT actor_name, reason FROM audit_log WHERE action='order.destination' AND entity_no=?1 ORDER BY id")
        .unwrap();
    st.query_map(params![no], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn destination_backfill_signs_the_keeper_and_audits_every_change() {
    let conn = db();
    ensure_users(&conn);
    let keep = ensure_keeper(&conn);
    let wh = seed_warehouse(&conn, "CW-A", true);
    let s1 = seed_slot(&conn, wh, "C01-01", true);
    let s2 = seed_slot(&conn, wh, "C01-02", true);
    let no = create(&conn, new_party(&conn, "补录", "341204199301272041"), xm_id(&conn));

    // 只选货位 ⇒ 反查补上仓房，库里不许出现"有货位没仓房"的半截去向
    let o = assign(&conn, keep, &no, None, Some(s1)).unwrap().unwrap();
    assert_eq!(o.warehouse_id, Some(wh), "只给货位也要补上所属仓房");
    assert_eq!(o.warehouse_name.as_deref(), Some("CW-A"));
    assert_eq!(o.slot_label.as_deref(), Some("C01-01"));
    assert_eq!(o.keeper_id, Some(keep), "谁指定的去向就署谁的名（三环节署名之一）");
    assert_eq!(
        dest_audits(&conn, &no),
        vec![(format!("测试{keep}"), "未指定 → CW-A / C01-01".into())]
    );

    // 改派：审计要看得出从哪儿换到哪儿
    let o = assign(&conn, keep, &no, Some(wh), Some(s2)).unwrap().unwrap();
    assert_eq!(o.slot_label.as_deref(), Some("C01-02"));
    assert_eq!(dest_audits(&conn, &no).len(), 2);
    assert_eq!(dest_audits(&conn, &no)[1].1, "CW-A / C01-01 → CW-A / C01-02");

    // 清空去向 ⇒ 署名一并抹掉，别留一个查不到指向的签名
    let o = assign(&conn, keep, &no, None, None).unwrap().unwrap();
    assert_eq!(o.warehouse_id, None);
    assert_eq!(o.slot_id, None);
    assert_eq!(o.keeper_id, None, "去向清空后不该还挂着保管员署名");
    assert_eq!(dest_audits(&conn, &no).last().unwrap().1, "CW-A / C01-02 → 未指定");
}

#[test]
fn destination_rejects_mismatched_and_inactive_archives() {
    let conn = db();
    ensure_users(&conn);
    let keep = ensure_keeper(&conn);
    let a = seed_warehouse(&conn, "CW-A", true);
    let b = seed_warehouse(&conn, "CW-B", true);
    let stopped = seed_warehouse(&conn, "CW-C", false);
    let sa = seed_slot(&conn, a, "C01-01", true);
    let sb = seed_slot(&conn, b, "C02-01", true);
    let sc = seed_slot(&conn, stopped, "C03-01", true);
    let no = create(&conn, new_party(&conn, "错配", "341204199301272042"), xm_id(&conn));

    // 货位不在所选仓房下：按去向统计会出现"A 仓的货位记到 B 仓"，必须当场拒
    let e = assign(&conn, keep, &no, Some(a), Some(sb)).unwrap_err();
    assert!(e.contains("不在该仓房下"), "错配要说清是哪一个：{e}");

    // 档案不存在 / 已停用（含"仓房停了但货位还挂着"）
    let e = assign(&conn, keep, &no, Some(9999), None).unwrap_err();
    assert!(e.contains("仓房"), "不存在的仓房要报仓房：{e}");
    let e = assign(&conn, keep, &no, Some(stopped), None).unwrap_err();
    assert!(e.contains("已停用"), "停用的仓房不能进新指定：{e}");
    let e = assign(&conn, keep, &no, None, Some(sc)).unwrap_err();
    assert!(e.contains("货位"), "所属仓房已停用的货位同样不能选：{e}");

    // 合法的一对不受影响
    assert!(assign(&conn, keep, &no, Some(a), Some(sa)).is_ok());
}

#[test]
fn destination_writes_are_refused_on_voided_tickets_but_not_on_settled_ones() {
    let conn = db();
    ensure_users(&conn);
    let keep = ensure_keeper(&conn);
    let wh = seed_warehouse(&conn, "CW-A", true);
    let slot = seed_slot(&conn, wh, "C01-01", true);

    // 作废单不参与汇总，再登记去向没有意义还会污染审计
    let no = create(&conn, new_party(&conn, "作废甲", "341204199301272043"), xm_id(&conn));
    void_order(&conn, &actor(2, "weigher"), void_input(&no, "农户临时取消售粮")).unwrap();
    let e = assign(&conn, keep, &no, Some(wh), Some(slot)).unwrap_err();
    assert!(e.contains("已作废"), "作废单要当场拒：{e}");

    // 已结算的单仍可补去向：粮进了哪个仓与钱结没结是两件事，事后清仓要靠它
    let no2 = create(&conn, new_party(&conn, "已结算甲", "341204199301272044"), xm_id(&conn));
    capture_gross(&conn, &no2, 150000);
    capture_tare(&conn, &no2, 50000, None);
    seed_price(&conn, xm_id(&conn));
    settle_now(&conn, &no2, 240000, true);
    let status_before = load_order_full(&conn, &no2).unwrap().unwrap().status;
    let o = assign(&conn, keep, &no2, Some(wh), Some(slot)).unwrap().unwrap();
    assert_eq!(o.status, status_before, "补去向不得改动单据状态");
    assert_eq!(o.warehouse_name.as_deref(), Some("CW-A"));
}

// --------------------------------------------------------------- 档案人像照片
//
// 02 §F3.1 的"照片选填 + 刷证自动带出"落到真库就是这一组。业务上最贵的两种错是
// **把 A 的脸挂到 B 的档案**与**库里有引用、盘上没图**，所以两头都用例钉着：
// 导入按文件头判格式（不信扩展名）、替换必须清干净旧的、清除不留死引用、读回不外泄本机路径。

/// 一个用例一个临时根目录，Drop 里整体删掉，不给 `%TEMP%` 攒农户人像
struct PhotoDir {
    path: std::path::PathBuf,
}

impl PhotoDir {
    fn new(tag: &str) -> Self {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("banghe-photo-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).expect("临时目录应可创建");
        Self { path }
    }

    /// 数据目录下现存的文件（递归），用来验"旧的删干净了没有"
    fn files(&self) -> Vec<std::path::PathBuf> {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else {
                    out.push(p);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.path, &mut out);
        out
    }
}

impl Drop for PhotoDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 一张 BMP：`BM` 头 + 102×126 的 DIB 头 + 内容指纹。身份证芯片照就是这个格式
/// （04 §3.5-1），尾部塞 `tag` 让不同用例的图内容不同、sha 也就不同。
fn fake_bmp(tag: &str) -> Vec<u8> {
    let mut v = b"BM".to_vec();
    v.extend_from_slice(&[0u8; 14]);
    v.extend_from_slice(&[0x28, 0, 0, 0, 102, 0, 0, 0, 126, 0, 0, 0]);
    v.extend_from_slice(tag.as_bytes());
    while v.len() < 600 {
        v.push(0x40);
    }
    v
}

/// 把一张图放到"读卡器本次落出来的暂存位置"，回绝对路径（前端的 `photo_path` 就是它）
fn staged_photo(root: &std::path::Path, name: &str, bytes: &[u8]) -> String {
    let dir = root.join("idcard");
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p.display().to_string()
}

fn photo_input(party_id: i64, source_path: &str) -> PartyPhotoInput {
    PartyPhotoInput {
        party_id,
        source_path: source_path.to_string(),
        operator_id: None,
        source_label: Some("读卡带入".into()),
    }
}

/// `attachment` 全表快照：行没漏、没多，一眼可见
fn attachments(conn: &Connection) -> Vec<(i64, String, Option<i64>, String, String, i64)> {
    let mut stmt = conn
        .prepare("SELECT id, file_path, biz_id, biz_type, mime, encrypted FROM attachment ORDER BY id")
        .unwrap();
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))
        .unwrap();
    rows.collect::<Result<Vec<_>, _>>().unwrap()
}

fn audits(conn: &Connection, action: &str) -> i64 {
    conn.query_row("SELECT count(*) FROM audit_log WHERE action = ?1", params![action], |r| r.get(0))
        .unwrap()
}

/// `party.updated_at` 直接查库：DTO 里不带这一列，而"这次到底动没动这行"正是这里要验的。
fn party_updated_at(conn: &Connection, id: i64) -> Option<String> {
    conn.query_row("SELECT updated_at FROM party WHERE id = ?1", params![id], |r| r.get(0))
        .unwrap()
}

fn is_chinese(err: &str) -> bool {
    err.chars().any(|c| c as u32 >= 0x4e00)
}

#[test]
fn card_photo_lands_on_the_party_and_reads_back_as_a_data_url() {
    let conn = db();
    let dir = PhotoDir::new("import");
    let party = new_party(&conn, "人像甲", "341204199301272051");
    let src = staged_photo(&dir.path, "photo.bmp", &fake_bmp("face-a"));

    let p = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(party, &src)).unwrap();
    let att = p.photo_attachment_id.expect("导入后档案应挂上附件");

    let rows = attachments(&conn);
    assert_eq!(rows.len(), 1, "一次导入只该有一行附件");
    let (id, rel, biz_id, biz_type, mime, encrypted) = &rows[0];
    assert_eq!(*id, att);
    assert_eq!(biz_id, &Some(party), "附件的 biz_id 要反指回这张档案");
    assert_eq!(biz_type, "id_card_photo");
    assert_eq!(mime, "image/bmp", "MIME 按文件头判，不是按扩展名猜");
    assert_eq!(*encrypted, 0, "字段加密基建还没落地，如实写 0（与证号明文过渡态同一条）");
    assert!(rel.starts_with("attachments/"), "库里只存相对路径：{rel}");
    assert!(dir.path.join(rel).exists(), "盘上应真有这张图");
    assert!(!rel.contains("idcard"), "库里不该出现读卡器的暂存路径：{rel}");

    let img = party_photo_view(&conn, &dir.path, &actor(1, "station_master"), party)
        .unwrap()
        .expect("有照片就该读得回来");
    assert!(img.data_url.starts_with("data:image/bmp;base64,"), "回的是 data URL：{}", &img.data_url[..24]);
    assert!(!img.data_url.contains(&src), "像素里也不该带上本机路径");
    assert_eq!(audits(&conn, "party.photo.update"), 1, "换照片要留一条修改痕迹");
    assert_eq!(audits(&conn, "pii.read"), 1, "看人像是一次 PII 访问，必须留痕");
    let accessed_by: Option<i64> = conn
        .query_row("SELECT accessed_by FROM attachment WHERE id = ?1", params![att], |r| r.get(0))
        .unwrap();
    assert_eq!(accessed_by, Some(1), "attachment.accessed_* 这两列现在真的有人写了");
}

#[test]
fn a_scale_capture_reads_back_by_attachment_and_absent_is_not_an_error() {
    use banghe_lib::camera::{store_snapshot, AttachmentMeta};
    let conn = db();
    let dir = PhotoDir::new("cap-read");
    let party = new_party(&conn, "抓拍甲", "341204199301272061");
    let no = create(&conn, party, 1);
    capture_gross(&conn, &no, 300000);
    let (record_id, order_id): (i64, i64) = conn
        .query_row(
            "SELECT wr.id, wr.order_id FROM weigh_record wr JOIN weigh_order wo ON wo.id = wr.order_id WHERE wo.order_no = ?1",
            params![no],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();

    // 读通道现在按 attachment.id 取（一次过磅最多 3 张、墙上逐张列）：
    // 不存在的附件 id 回 Ok(None) 不是错误（多半是到期清理掉了），且绝不虚记一次 PII 访问
    assert!(capture_photo_view(&conn, &dir.path, &actor(1, "station_master"), 999_999).unwrap().is_none());
    assert_eq!(audits(&conn, "pii.read"), 0, "没读到图就不该记一次'看过'");

    // 落两张 scale_capture 附件挂到同一条轨迹（模拟两台相机各拍一张、attach_weigh_photos 的产物）
    let put = |tag: &str| -> i64 {
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        jpeg.extend_from_slice(tag.as_bytes());
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        store_snapshot(
            &conn,
            &dir.path,
            &jpeg,
            &AttachmentMeta { order_id, weigh_record_id: record_id, operator_id: 2, device_id: None, device_code: tag.into() },
        )
        .unwrap()
    };
    let first = put("JFIF-scale-capture-A");
    let second = put("JFIF-scale-capture-B");
    conn.execute("UPDATE weigh_record SET photo_attachment_id = ?1 WHERE id = ?2", params![first, record_id]).unwrap();

    for att in [first, second] {
        let img = capture_photo_view(&conn, &dir.path, &actor(1, "station_master"), att)
            .unwrap()
            .expect("挂了附件就该读得回来");
        assert!(img.data_url.starts_with("data:image/jpeg;base64,"), "回的是 data URL：{}", &img.data_url[..24]);
    }
    assert_eq!(audits(&conn, "pii.read"), 2, "两台相机各看一次＝两次 PII 访问，都要留痕");
    let accessed_by: Option<i64> = conn
        .query_row("SELECT accessed_by FROM attachment WHERE id = ?1", params![second], |r| r.get(0))
        .unwrap();
    assert_eq!(accessed_by, Some(1), "读图要记到人");
    let audit_no: Option<String> = conn
        .query_row("SELECT entity_no FROM audit_log WHERE action = 'pii.read' AND entity = 'weigh_order' ORDER BY id DESC LIMIT 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(audit_no.as_deref(), Some(no.as_str()), "pii.read 审计要挂到这张磅单，不是别的单据");
}

#[test]
fn replacing_a_portrait_leaves_no_stale_row_or_file() {
    let conn = db();
    let dir = PhotoDir::new("replace");
    let party = new_party(&conn, "人像乙", "341204199301272052");
    let a = staged_photo(&dir.path, "a.bmp", &fake_bmp("face-b-first"));
    let b = staged_photo(&dir.path, "b.bmp", &fake_bmp("face-b-second"));

    let first = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(party, &a)).unwrap();
    let old_rel: String = conn
        .query_row("SELECT file_path FROM attachment WHERE id = ?1", params![first.photo_attachment_id.unwrap()], |r| r.get(0))
        .unwrap();
    assert!(dir.path.join(&old_rel).exists());

    let second = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(party, &b)).unwrap();
    assert_ne!(
        first.photo_attachment_id, second.photo_attachment_id,
        "换了图就是换了附件，不能把新图盖在旧行上"
    );
    let rows = attachments(&conn);
    assert_eq!(rows.len(), 1, "旧附件行必须跟着删掉：{rows:?}");
    assert!(!dir.path.join(&old_rel).exists(), "旧文件也得删干净——PII 不该因为'换了一张'继续留在盘上");
    assert_eq!(dir.files().len(), 3, "只剩两张暂存源图 + 一张新附件，旧的那张不该还在");
}

#[test]
fn saving_the_same_picture_twice_does_not_churn_the_attachment() {
    let conn = db();
    let dir = PhotoDir::new("same");
    let party = new_party(&conn, "人像丙", "341204199301272053");
    let src = staged_photo(&dir.path, "same.bmp", &fake_bmp("face-c"));

    let once = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(party, &src)).unwrap();
    let twice = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(party, &src)).unwrap();
    assert_eq!(once.photo_attachment_id, twice.photo_attachment_id, "同一张图重复保存不该换附件 id");
    assert_eq!(attachments(&conn).len(), 1, "更不该在盘上留第二份");
    assert_eq!(audits(&conn, "party.photo.update"), 1, "没发生的事不配留一条修改痕迹");
}

#[test]
fn clearing_a_portrait_removes_row_and_file() {
    let conn = db();
    let dir = PhotoDir::new("clear");
    let party = new_party(&conn, "人像丁", "341204199301272054");
    let src = staged_photo(&dir.path, "d.bmp", &fake_bmp("face-d"));
    let with = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(party, &src)).unwrap();
    let rel: String = conn
        .query_row("SELECT file_path FROM attachment WHERE id = ?1", params![with.photo_attachment_id.unwrap()], |r| r.get(0))
        .unwrap();

    let cleared = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(party, "")).unwrap();
    assert_eq!(cleared.photo_attachment_id, None, "空串就是清除");
    assert!(attachments(&conn).is_empty(), "清除后不该留附件行");
    assert!(!dir.path.join(&rel).exists(), "清除后盘上不该留人像");
    assert_eq!(audits(&conn, "party.photo.clear"), 1);
    assert!(party_photo_view(&conn, &dir.path, &actor(1, "station_master"), party).unwrap().is_none());
}

#[test]
fn clearing_when_there_was_no_photo_is_a_no_op() {
    let conn = db();
    let dir = PhotoDir::new("noop");
    let party = new_party(&conn, "没照片戊", "341204199301272055");
    let before = get_party(&conn, party).unwrap().unwrap().party;

    let after = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(party, "")).unwrap();
    assert_eq!(after.photo_attachment_id, before.photo_attachment_id);
    assert_eq!(party_updated_at(&conn, party), None, "什么都没改就不该把档案标成'已修改'");
    assert_eq!(audits(&conn, "party.photo.clear"), 0);
    assert!(dir.files().is_empty(), "空操作连一个文件都不该新建");
}

#[test]
fn junk_or_missing_source_is_refused_without_touching_the_party() {
    let conn = db();
    let dir = PhotoDir::new("junk");
    let party = new_party(&conn, "坏图己", "341204199301272056");

    // 改个 .bmp 后缀的文本文件：文件头判不过
    let not_image = dir.path.join("not-image.bmp");
    std::fs::write(&not_image, b"this is plain text pretending to be a bitmap, way longer than 16 bytes").unwrap();
    // 扩展名不在白名单
    let exe = dir.path.join("photo.exe");
    std::fs::write(&exe, fake_bmp("ok-content")).unwrap();

    for (label, path) in [
        ("内容不是图片", not_image.display().to_string()),
        ("后缀不允许", exe.display().to_string()),
        ("文件不存在", dir.path.join("gone.bmp").display().to_string()),
    ] {
        let e = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(party, &path))
            .expect_err(&format!("{label}应当被拒"));
        assert!(is_chinese(&e), "{label}：业务失败要中文短句：{e}");
        assert!(!e.contains(&path), "{label}：错误里不得回显操作员的本机路径：{e}");
    }
    let p = get_party(&conn, party).unwrap().unwrap().party;
    assert_eq!(p.photo_attachment_id, None, "被拒的导入不能留下半个引用");
    assert!(attachments(&conn).is_empty());
    assert_eq!(party_updated_at(&conn, party), None, "照片没成，档案的'已修改'也不该跟着翻");

    let e = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(999_999, &staged_photo(&dir.path, "ok.bmp", &fake_bmp("face-e"))))
        .expect_err("查无此档案应当直接拒绝");
    assert!(e.contains("不存在"), "要说清是找不到档案：{e}");
    assert!(dir.files().iter().all(|f| !f.to_string_lossy().contains("attachments")), "档案都不存在时更不该往数据目录写图");
}

#[test]
fn a_lost_file_reads_back_as_an_actionable_error() {
    let conn = db();
    let dir = PhotoDir::new("lost");
    let party = new_party(&conn, "图丢了庚", "341204199301272057");
    let src = staged_photo(&dir.path, "g.bmp", &fake_bmp("face-g"));
    let p = set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(party, &src)).unwrap();

    // 只还原了 .db、没带 attachments/ 目录，或缓存被清理，都会落到这一支
    for f in dir.files() {
        if f.to_string_lossy().contains("attachments") {
            std::fs::remove_file(f).unwrap();
        }
    }
    let e = party_photo_view(&conn, &dir.path, &actor(1, "station_master"), party).unwrap_err();
    assert!(e.contains("丢失"), "要说'文件已丢失'而不是笼统的读图失败：{e}");
    assert!(e.contains("重新上传") || e.contains("读卡"), "还得给出路：{e}");
    assert_eq!(audits(&conn, "pii.read"), 0, "没看到图就不该记一次'看过'");
    assert!(p.photo_attachment_id.is_some(), "库里的引用保持原样，由人来补图");
}

#[test]
fn party_rows_carry_the_photo_reference_through_list_and_detail() {
    let conn = db();
    let dir = PhotoDir::new("dto");
    let a = new_party(&conn, "带照辛", "341204199301272058");
    let b = new_party(&conn, "无照壬", "341204199301272059");
    set_party_photo(&conn, &dir.path, &actor(1, "station_master"), photo_input(a, &staged_photo(&dir.path, "h.bmp", &fake_bmp("face-h"))))
        .unwrap();

    // 列表也要带这个字段：档案页据此决定"要不要去读图"，缺了它列表就会逐个空查
    let rows = list_parties(&conn, "", None).unwrap();
    let by_id = |id: i64| rows.iter().find(|x| x.id == id).unwrap().photo_attachment_id;
    assert!(by_id(a).is_some());
    assert_eq!(by_id(b), None);
    assert!(get_party(&conn, b).unwrap().unwrap().party.photo_attachment_id.is_none());
}

// --------------------------------------------------------- 制单后就地补改车牌 / 备注

fn update_meta_no(conn: &Connection, no: &str, vehicle: Option<&str>, remark: Option<&str>) -> Option<banghe_lib::orders::WeighOrder> {
    update_meta(
        conn,
        &actor(1, "weigher"),
        UpdateOrderInput { order_no: no.into(), vehicle_no: vehicle.map(str::to_string), remark: remark.map(str::to_string), operator_id: None },
    )
    .unwrap()
}

fn meta_audit_count(conn: &Connection, no: &str) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM audit_log WHERE action='order.update' AND entity_no=?1", params![no], |r| r.get(0)).unwrap()
}

#[test]
fn meta_edit_autosaves_vehicle_and_remark_with_one_audit_per_change() {
    let conn = db();
    ensure_users(&conn);
    let no = create(&conn, new_party(&conn, "补录车牌", "341204199301272060"), xm_id(&conn));

    // 改车牌 + 补备注：一次事务两条都落，回读到的就是库里的样子
    let o = update_meta_no(&conn, &no, Some("皖K88888"), Some("带皮带过磅")).unwrap();
    assert_eq!(o.vehicle_no.as_deref(), Some("皖K88888"));
    assert_eq!(o.remark.as_deref(), Some("带皮带过磅"));
    assert_eq!(meta_audit_count(&conn, &no), 1, "一次改动画两个字段仍只留一条审计");

    // 值没变：既不写库也不留痕（防抖抖动 / 卸载补发都不该在审计表里堆"改了个寂寞"）
    let same = update_meta_no(&conn, &no, Some("皖K88888"), Some("带皮带过磅")).unwrap();
    assert_eq!(same.vehicle_no.as_deref(), Some("皖K88888"));
    assert_eq!(meta_audit_count(&conn, &no), 1, "无变化不该再记一条");

    // 空串 / 仅空格 → 清除该字段（对齐前端 trim 后落 null）
    let cleared = update_meta_no(&conn, &no, Some("   "), None).unwrap();
    assert_eq!(cleared.vehicle_no, None);
    assert_eq!(cleared.remark, None);
    assert_eq!(meta_audit_count(&conn, &no), 2, "把车牌和备注都清空又是一次变更");
}

#[test]
fn meta_edit_is_not_blocked_by_settlement_state() {
    // 车牌/备注不碰钱也不碰状态机：过磅、结算途中照样能就地补改（与 grade 的 VOIDABLE 闸门刻意不同）
    let conn = db();
    ensure_users(&conn);
    let no = create(&conn, new_party(&conn, "结算后补车牌", "341204199301272061"), xm_id(&conn));
    capture_gross(&conn, &no, 52000);
    // 只改这两个字段不该被任何状态闸门挡下
    let o = update_meta_no(&conn, &no, Some("豫B00001"), Some("复检留样")).unwrap();
    assert_eq!(o.vehicle_no.as_deref(), Some("豫B00001"));
    assert_eq!(o.remark.as_deref(), Some("复检留样"));
}

// ------------------------------------------------ 品种：制单必填 · 存量无品种单照旧可读

/// 造一张**没定品种**的单。制单这一步品种现在是必填（`create_order` 直接拒，见下一条），
/// 所以这种单只可能来自两处：升级前的存量行、以及事后被 `order_set_variety` 清空的那类。
/// 它们还在库里，读路径（详情 / 在途看板 / 列表 / 台账 / 码单）必须照旧看得见——
/// 车就在磅上、看板说没车，是最坏的一种丢单。
fn create_no_variety(conn: &Connection, party: i64) -> String {
    let no = create(conn, party, xm_id(conn));
    set_variety(conn, &actor(1, "weigher"), variety_adjust(&no, None)).expect("把品种清回未定应成功");
    no
}

/// 取号那一次到底吃没吃流水号（闸门不过时不许把号吃掉，05 §3.5）
fn seq_rows(conn: &Connection) -> i64 {
    let ym = Local::now().format("%Y%m").to_string();
    conn.query_row("SELECT COUNT(*) FROM seq_counter WHERE prefix_key = ?1", params![format!("BD:01:{ym}")], |r| r.get(0))
        .unwrap()
}

/// 兑现在源码里的那条规矩：**品种在取号这一刻就是必填**。它是这一单往后一切的锚——
/// 结算的单价要对回价目表、化验的指标集与扣量基准全来自品种档案，空着取号等于把这两件事
/// 都往后拖，拖到卸完货才发现，价格已经错过一次对照。
#[test]
fn a_new_order_must_carry_its_variety() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "没报品种就取号", "341204199301272116");
    let e = create_order(
        &conn,
        &actor(1, "weigher"),
        CreateOrderInput {
            party_id: party,
            variety_id: None,
            vehicle_no: None,
            warehouse_id: None,
            slot_id: None,
            remark: None,
            card_no: Some(free_card(&conn)),
            registered_by: None,
            weight_source: "scale".into(),
        },
    )
    .unwrap_err();
    assert!(e.contains("收购品种"), "要说清缺的是品种（磅员照着念就能补），实际：{e}");
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM weigh_order", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "闸门不过不许留半张单");
    assert_eq!(seq_rows(&conn), 0, "也不该白白吃掉一个流水号");
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM audit_log WHERE action='order.create'", [], |r| r.get::<_, i64>(0)).unwrap(),
        0,
        "没成的单不许留审计，否则账面多一笔没有实体的动作"
    );

    // 补上品种就照常出号，且是这一天的第 1 号——被拦下的那次没有占位
    let no = create(&conn, party, xm_id(&conn));
    assert!(no.ends_with("000001"), "被拦下的那次不许占号，实际：{no}");
}

/// 一个停用品种：验"给了品种仍要在册且启用"这条闸——停用档案只许存量单读出来，不许再挂新单
fn seed_inactive_variety(conn: &Connection, code: &str) -> i64 {
    conn.execute(
        "INSERT INTO grain_variety (code, name, category, enabled_indicators_json, sort_order, is_active, created_at)
         VALUES (?1, ?2, '主粮', '[\"moisture\"]', 90, 0, '2026-09-01T08:00:00.000')",
        params![code, "淘汰杂粮"],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// 结算框/化验区那个品种下拉提交的最小 payload：事由留空，审计里落「未填写」
fn variety_adjust(no: &str, v: Option<i64>) -> VarietyAdjustInput {
    VarietyAdjustInput { order_no: no.into(), variety_id: v, reason: String::new(), operator_id: None }
}

fn variety_audit(conn: &Connection, no: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT reason FROM audit_log WHERE action='order.variety' AND entity_no=?1 ORDER BY id")
        .unwrap();
    stmt.query_map(params![no], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

/// 被闸门拦下的化验不许落库：报个错就把报告写进去，等于凭空多一张化验单
fn qc_count(conn: &Connection, no: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM qc_report WHERE order_id = (SELECT id FROM weigh_order WHERE order_no = ?1)",
        params![no],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn an_order_without_variety_still_reads_back_on_every_path() {
    let conn = db();
    ensure_users(&conn);
    let party = new_party(&conn, "先到站后报品种", "341204199301272111");
    let no = create_no_variety(&conn, party);

    let o = load_order_full(&conn, &no).unwrap().expect("详情读得回来");
    assert_eq!(o.variety_id, None, "品种列就是 NULL，不是某个默认品种");
    assert_eq!(o.variety_name, None);
    // 时间轴与审计里那一格必须写「未定品种」——打出 "null" 的磅单没人敢签。
    // 时间轴那条是 `build_timeline` 在**读的时候**按 `o.variety_name` 现算的（不是照抄审计），
    // 所以这一条钉的正是读路径对 NULL 的处置
    let timeline = o.timeline.clone().unwrap_or_default();
    assert!(
        timeline.iter().any(|e| e.action == "order.create" && e.detail.as_deref().is_some_and(|d| d.contains("未定品种"))),
        "时间轴要写「未定品种」，实际：{:?}",
        timeline.iter().map(|e| (&e.action, &e.detail)).collect::<Vec<_>>()
    );
    // 清品种那一次落的审计（这张单的来路）同样不许打 null
    let audited: String = conn
        .query_row("SELECT reason FROM audit_log WHERE action='order.variety' AND entity_no = ?1", params![&no], |r| r.get(0))
        .unwrap();
    assert!(audited.contains("未定品种"), "审计 detail 同样不许打 null，实际：{audited}");

    // 在途看板读的是 v_open_order：那支视图没换成 LEFT JOIN，这张单就从看板上凭空消失——
    // 车就在磅上、看板说没车，这是最坏的一种丢单，所以单独钉一条。
    let in_view: i64 = conn
        .query_row("SELECT COUNT(*) FROM v_open_order WHERE order_no = ?1", params![&no], |r| r.get(0))
        .unwrap();
    assert_eq!(in_view, 1, "没品种的在途单必须还在看板视图里");
    assert!(open_orders(&conn).unwrap().iter().any(|x| x.order_no == no), "open_orders 也要含这张单");

    // 列表：能查得到、汇总也带上它（净重为零所以金额不变），按品种筛又确实筛得掉
    let listed = list_orders(&conn, &filters()).unwrap();
    assert!(listed.rows.iter().any(|r| r.order_no == no), "磅单列表不许漏掉没品种的单");
    let mut f_variety = filters();
    f_variety.variety_id = Some(serde_json::json!(xm_id(&conn)));
    let by_variety = list_orders(&conn, &f_variety).unwrap();
    assert!(!by_variety.rows.iter().any(|r| r.order_no == no), "按具体品种筛时这张单该被筛掉");
}

#[test]
fn variety_is_a_hard_gate_before_qc_and_settlement() {
    // 制单那边已经有闸了，但库里仍可能有没品种的单（存量行 / 事后被清空），
    // 所以化验与结算各自的闸门一条都不能撤——这时拦住才是最后一道防线
    let conn = db();
    ensure_users(&conn);
    let xm = xm_id(&conn);
    seed_price(&conn, xm);
    let no = create_no_variety(&conn, new_party(&conn, "库存单没品种", "341204199301272112"));
    capture_gross(&conn, &no, 52000);
    capture_tare(&conn, &no, 12000, None);

    // 化验的指标集、限值与扣量基准全部来自品种：没品种的化验单它的 grade 无从判定
    let e = try_qc(&conn, &no).unwrap_err();
    assert!(e.contains("还没有定收购品种"), "化验该拦下并说清缺什么，实际：{e}");
    assert_eq!(qc_count(&conn, &no), 0, "被拦下的化验不许落库");

    // 单价由前端送、服务端只判它 >0：品种是唯一能对回价目表的锚，这道闸必须在服务端
    let e = settle_full(&conn, &no, |_| {}).unwrap_err();
    assert!(e.contains("还没有定收购品种"), "结算该拦下并说清缺什么，实际：{e}");

    // 补定品种（结算框与化验区那个下拉走的就是这一条命令）→ 化验、结算一路走通
    let after = set_variety(&conn, &actor(3, "inspector"), variety_adjust(&no, Some(xm))).unwrap().expect("单应存在");
    assert_eq!(after.variety_id, Some(xm));
    assert_eq!(after.variety_name.as_deref(), Some("小麦"));
    accept_qc(&conn, &no);
    let r = settle_now(&conn, &no, 240000, true);
    assert_eq!(r.settlement.payable_fen, (40000 * 240000) / 10_000, "补上品种后金额与原口径一致");
}

/// `order_set_variety` 的四条：合法改判留痕、停用品种拒、已结算拒、值未变既不写库也不留痕
#[test]
fn set_variety_gates_and_stays_silent_when_nothing_changed() {
    let conn = db();
    ensure_users(&conn);
    let xm = xm_id(&conn);
    let ym = conn.query_row("SELECT id FROM grain_variety WHERE code='YM'", [], |r| r.get::<_, i64>(0)).unwrap();
    let dead = seed_inactive_variety(&conn, "ZZ");
    let no = create_no_variety(&conn, new_party(&conn, "改品种留痕", "341204199301272113"));
    // 这张单的来路是"先有品种、后被清成未定"，所以起点本来就有一条痕；下面判的是一共再多几条
    let base = variety_audit(&conn, &no).len();

    // 清成"仍然没定"＝值没变：库里这行不该被 touch，审计表里更不该有"改了个寂寞"
    set_variety(&conn, &actor(1, "weigher"), variety_adjust(&no, None)).unwrap().expect("单应存在");
    assert_eq!(variety_audit(&conn, &no).len(), base, "没变出一道痕迹就是噪音");

    // 停用的品种档案只许存量单读出来，不许再挂新单
    let e = set_variety(&conn, &actor(1, "weigher"), variety_adjust(&no, Some(dead))).unwrap_err();
    assert!(e.contains("不存在或已停用"), "实际：{e}");

    set_variety(&conn, &actor(1, "weigher"), variety_adjust(&no, Some(xm))).unwrap().expect("定品种应成功");
    let a = variety_audit(&conn, &no);
    assert_eq!(a.len(), base + 1, "定一次品种只留一条痕");
    assert!(a.last().unwrap().contains("未定品种 → 小麦"), "审计要写得清旧→新，实际：{a:?}");
    set_variety(&conn, &actor(1, "weigher"), variety_adjust(&no, Some(xm))).unwrap().expect("重复提交同一值不该报错");
    assert_eq!(variety_audit(&conn, &no).len(), base + 1, "值没变就不该再记一条");

    set_variety(&conn, &actor(1, "weigher"), variety_adjust(&no, Some(ym))).unwrap().expect("换成另一个品种应成功");
    let a = variety_audit(&conn, &no);
    assert_eq!(a.len(), base + 2, "两次改判两条痕");
    assert!(a.last().unwrap().contains("小麦 → 玉米"), "改判痕要写清新旧，实际：{a:?}");

    // 已结算：钱的凭据已经按这个品种印出去了，要改只能由站长红冲重录
    seed_price(&conn, ym);
    let paid = create(&conn, new_party(&conn, "已结算改品种", "341204199301272114"), xm);
    capture_gross(&conn, &paid, 52000);
    capture_tare(&conn, &paid, 12000, None);
    settle_now(&conn, &paid, 240000, true);
    let e = set_variety(&conn, &actor(1, "station_master"), variety_adjust(&paid, Some(ym))).unwrap_err();
    assert!(e.contains("已结算") && e.contains("红冲"), "要说清去走红冲，实际：{e}");
    assert_eq!(variety_audit(&conn, &paid), Vec::<String>::new(), "被拦下的改判不留痕");
}

/// 定价 / 改价（02 §F1.4，2026-09-14）：价是成交的前提，票面要把它印给客户，
/// 所以偏离价目表就是一次真实议价——**可以**留一句事由，但不留也放行（事由选填）；
/// 已结算的单则一律不许再改（只能走红冲）。
#[test]
fn set_price_keeps_reason_optional_and_blocks_settled_orders() {
    let conn = db();
    ensure_users(&conn);
    let xm = xm_id(&conn);
    let list_id = seed_price(&conn, xm);
    let party = new_party(&conn, "定价留痕", "341204199301272116");
    // 制单即带挂牌价：农户到站先问价，票打出来之前价就得在单上
    let no = create(&conn, party, xm);
    let o = load_order_full(&conn, &no).unwrap().unwrap();
    assert_eq!(o.price_fen_per_ton, Some(240000), "制单应按价目表带出挂牌价");
    assert_eq!(o.price_list_id, Some(list_id));

    let price_audit = |no: &str| -> Vec<String> {
        let mut st = conn
            .prepare("SELECT reason FROM audit_log WHERE action='price.override' AND entity_no=?1 ORDER BY id")
            .unwrap();
        let rows = st.query_map(params![no], |r| r.get::<_, Option<String>>(0)).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
        rows.into_iter().map(|r| r.unwrap_or_default()).collect()
    };
    let adjust = |price: i64, reason: &str| PriceAdjustInput {
        order_no: no.clone(),
        price_fen_per_ton: price,
        price_list_id: None,
        reason: reason.into(),
        operator_id: None,
    };

    // ① 照价目执行：事由不必填，取价来源记回那一行
    let o = set_price(&conn, &actor(1, "weigher"), PriceAdjustInput { price_list_id: Some(list_id), ..adjust(240000, "") }).unwrap().unwrap();
    assert_eq!((o.price_fen_per_ton, o.price_list_id, o.price_override_reason.clone()), (Some(240000), Some(list_id), None));
    assert!(price_audit(&no).is_empty(), "值没变就不该留痕");

    // ② 偏离价目、写清事由 → 落价、清掉取价来源、审计里能看见前后值
    let o = set_price(&conn, &actor(1, "weigher"), adjust(250000, "当日市场价上浮，站长口头确认")).unwrap().unwrap();
    assert_eq!(o.price_fen_per_ton, Some(250000));
    assert_eq!(o.price_override_reason.as_deref(), Some("当日市场价上浮，站长口头确认"));
    assert_eq!(o.price_list_id, None, "议价即与价目表脱钩（0001_init.sql:217）");
    let a = price_audit(&no);
    assert_eq!(a.len(), 1, "改一次价只留一条痕");
    assert!(a[0].contains("2.400") && a[0].contains("2.500"), "审计要写清前后值，实际：{a:?}");

    // ③ 不写事由同样放行（选填）：价照落、事由那列落 NULL，审计里写明"没写"而不是留一句空的
    let o = set_price(&conn, &actor(1, "weigher"), adjust(260000, "")).unwrap().unwrap();
    assert_eq!((o.price_fen_per_ton, o.price_override_reason.clone()), (Some(260000), None), "选填＝不写也落价");
    let a = price_audit(&no);
    assert_eq!(a.len(), 2);
    assert!(a[1].contains("未填写改价事由"), "没写事由审计里要写明没写，实际：{a:?}");

    // ④ 改回价目表价：事由随之清空（照价目执行不是议价）
    let o = set_price(&conn, &actor(1, "weigher"), PriceAdjustInput { price_list_id: Some(list_id), ..adjust(240000, "") }).unwrap().unwrap();
    assert_eq!((o.price_fen_per_ton, o.price_override_reason.clone()), (Some(240000), None));

    // ⑤ 已结算：票面已经把这个价印给客户了，要改只能站长红冲
    capture_gross(&conn, &no, 200000);
    capture_tare(&conn, &no, 100000, None);
    settle_now(&conn, &no, 240000, false);
    let e = set_price(&conn, &actor(1, "weigher"), adjust(260000, "市场价又涨了")).unwrap_err();
    assert!(e.contains("红冲"), "要说清去走红冲，实际：{e}");
    assert_eq!(price_audit(&no).len(), 3, "被拦下的改价不留痕");
}

/// 还没定品种的单不许定价：价对不回价目表，"偏离了多少"在库里没有任何一处能发现
#[test]
fn set_price_requires_a_variety() {
    let conn = db();
    ensure_users(&conn);
    let no = create_no_variety(&conn, new_party(&conn, "无品种定价", "341204199301272117"));
    let e = set_price(
        &conn,
        &actor(1, "weigher"),
        PriceAdjustInput { order_no: no.clone(), price_fen_per_ton: 240000, price_list_id: None, reason: "现场谈的价".into(), operator_id: None },
    )
    .unwrap_err();
    assert!(e.contains("品种"), "实际：{e}");
}

#[test]
fn creating_with_an_inactive_variety_is_still_refused() {
    // 必填的是"必须给一个品种"，不是"给什么都行"：给了就得过在册 + 启用那道闸（02 §F6.1）
    let conn = db();
    ensure_users(&conn);
    let dead = seed_inactive_variety(&conn, "ZZ");
    let e = create_order(
        &conn,
        &actor(1, "weigher"),
        CreateOrderInput {
            party_id: new_party(&conn, "选了停用品种", "341204199301272115"),
            variety_id: Some(dead),
            vehicle_no: None,
            warehouse_id: None,
            slot_id: None,
            remark: None,
            card_no: Some(free_card(&conn)),
            registered_by: None,
            weight_source: "scale".into(),
        },
    )
    .unwrap_err();
    assert!(e.contains("停用") || e.contains("不存在"), "实际：{e}");
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM weigh_order", [], |r| r.get::<_, i64>(0)).unwrap(), 0, "闸门不过不许留半张单");
}
