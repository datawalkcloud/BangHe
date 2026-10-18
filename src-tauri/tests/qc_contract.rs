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

use chrono::Local;
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

/// 一张"能过磅的单"要先有价：`capture` 在毛重那一捕上有价格闸（02 §F1.4），没价这一捕直接被拒。
/// 只在**这个品种还没有任何价**时补一条——已经 seed 过的用例不动，免得把 `price_list_id` 那个锚挪走。
fn ensure_price(conn: &Connection, variety: i64) -> i64 {
    let existing: Option<i64> = conn
        .query_row("SELECT id FROM price_list WHERE variety_id = ?1 ORDER BY id LIMIT 1", params![variety], |r| r.get(0))
        .ok();
    if let Some(id) = existing {
        return id;
    }
    conn.execute(
        "INSERT INTO price_list (variety_id, grade, price_fen_per_ton, effective_from, effective_to, basis, made_by, created_at, created_by)
         VALUES (?1, '一等', 240000, '2026-01-01', '9999-12-31', '测试定价', 1, '2026-01-01T00:00:00.000+08:00', 1)",
        params![variety],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn new_order(conn: &Connection, party: i64, no_hint: &str) -> String {
    let _ = no_hint;
    ensure_price(conn, 1);
    create_order(
        conn,
        &actor(2, "weigher"),
        CreateOrderInput {
            party_id: party,
            variety_id: Some(1),
            vehicle_no: Some("豫A12345".into()),
            warehouse_id: None,
            slot_id: None,
            remark: None,
            card_no: None,
            allow_no_card: false,
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
            frames: Vec::new(),
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
            frames: Vec::new(),
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

/// 样品号与留样号：一单一号、号段到天、复检沿用（§3.5 的那条例外，0025 纳入统一取号）。
///
/// 换掉的旧写法在真库里会以两种形态咬人：`YP + yymmdd + order_id % 1000` 在同日两单 id
/// 只差 1000 的整数倍时重号，`LY + yymmdd + "M"` 更是**同一天所有化验单同一串**。这两条
/// 断言分别钉住"跨单不撞"与"跨复检不变"，正对着那两种翻车形状。
#[test]
fn sample_and_retention_labels_are_per_order_and_reused_by_recheck() {
    let conn = db();
    ensure_users(&conn);
    let ymd = Local::now().format("%Y%m%d").to_string();

    let p1 = new_party(&conn, "样一", "410101199001010021");
    let a = new_order(&conn, p1, "a");
    let first = accept_qc(&conn, &a);
    assert_eq!(first.sample_no, format!("YP01{ymd}000001"), "§3.5 例外：YP + 站码2 + 到日的 8 位 + 流水6");
    assert_eq!(first.retention_no.as_deref(), Some(format!("LY01{ymd}000001").as_str()), "留样号同一条通道、同样到天");

    // 复检不另发号：不变式 7 只是把首检降级留档，台上那一瓶样还是原来那一瓶
    let second = recheck_qc(&conn, &a);
    assert_eq!(second.sample_no, first.sample_no, "复检必须沿用首检的样品号，同一瓶不能两张标签");
    assert_eq!(second.retention_no, first.retention_no, "留样号同理");

    // 同日另一单绝不重号——旧写法就是在这一条上撞车的
    let p2 = new_party(&conn, "样二", "410101199001010022");
    let b = new_order(&conn, p2, "b");
    let other = accept_qc(&conn, &b);
    assert_eq!(other.sample_no, format!("YP01{ymd}000002"));
    assert_ne!(other.sample_no, first.sample_no, "两张磅单共用一枚样品号，按号找样就找不出是哪车粮");

    let cur: i64 = conn
        .query_row(
            "SELECT current FROM seq_counter WHERE prefix_key = ?1",
            params![format!("YP:01:{ymd}")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cur, 2, "按日归零的游标必须与当天已发号数对上（月段那套键不参与）");
    assert_eq!(
        0i64,
        conn.query_row("SELECT COUNT(*) FROM seq_counter WHERE prefix_key LIKE 'YP:%' AND prefix_key <> ?1", params![format!("YP:01:{ymd}")], |r| r.get::<_, i64>(0)).unwrap(),
        "样品号只走按日那一条通道，不该再出现月段计数器"
    );
}

/// 化验表的一条形状不变式：每张有化验单的磅单**恰好一行** `is_effective = 1`。
///
/// 上半截（至多一行）由 `uk_qc_effective` 在库里硬挡；下半截（至少一行）SQLite 表达不了，
/// 只能这样查——将来谁加一条"撤销化验单只把有效行置 0、不插新单"的路径，那一单在结算与质检
/// 队列里就退回"从没化验过"，而库里还留着它的留档行。
///
/// 号的唯一性不再归这条测试管：0027 起两枚号存在 `weigh_order` 上，由不带 WHERE 的全表唯一
/// 索引 `uk_order_sample` / `uk_order_retention` 兜住；"会不会咬人"由 `schema_contract::
/// migration_0027_...` 直接探。这里只验服务层把号发对了、且一单一枚。
#[test]
fn effective_report_and_labels_stay_one_per_order() {
    let conn = db();
    ensure_users(&conn);

    // 四条形状都走一遍：只有首检、首检+复检、一条三行的复检链、以及拒收判定
    let a = new_order(&conn, new_party(&conn, "形一", "410101199001010031"), "a");
    accept_qc(&conn, &a);
    let b = new_order(&conn, new_party(&conn, "形二", "410101199001010032"), "a");
    accept_qc(&conn, &b);
    recheck_qc(&conn, &b);
    let c = new_order(&conn, new_party(&conn, "形三", "410101199001010033"), "a");
    accept_qc(&conn, &c);
    recheck_qc(&conn, &c);
    recheck_qc(&conn, &c);
    let d = new_order(&conn, new_party(&conn, "形四", "410101199001010034"), "a");
    save_qc(
        &conn,
        &actor(3, "inspector"),
        SaveQcInput {
            order_no: d,
            grade: Some("等外".into()),
            decision: "reject".into(),
            test_method: "visual".into(),
            indicators: vec![QcIndicatorInput {
                code: "moisture".into(),
                name: "水分".into(),
                value_num: Some(1800),
                value_text: None,
                unit: "0.01pct".into(),
                std_value: Some(1400),
                over_std: 1,
            }],
            moisture_deduct_01kg: 0,
            impurity_deduct_01kg: 0,
            inspector_id: None,
            reject_reason: Some("水分 18.00% 超拒收红线".into()),
        },
    )
    .unwrap()
    .expect("拒收化验单应保存");

    // 先确认形状确实种进去了：库里空转会让下面每条断言都假绿（本机刚上过一次这个当）
    let (rows, orders): (i64, i64) = conn
        .query_row("SELECT COUNT(*), COUNT(DISTINCT order_id) FROM qc_report", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((rows, orders), (7, 4), "应为 4 张单、化验单 1+2+3+1 行，实际 {rows} 行 / {orders} 单");
    assert_eq!(
        2,
        conn.query_row(
            "SELECT COUNT(*) FROM qc_report WHERE order_id = (SELECT id FROM weigh_order WHERE order_no = ?1) AND is_effective = 0",
            params![c],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        "三行那条复检链应降级了两行留档——结算与质检队列都以有效行为准"
    );

    let bad_effective: Vec<(i64, i64)> = conn
        .prepare("SELECT order_id, SUM(is_effective) FROM qc_report GROUP BY order_id HAVING SUM(is_effective) <> 1")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(
        bad_effective.is_empty(),
        "有化验单的磅单不再是「一单一行有效行」，那单会退回没化验过的状态、库里却还留着留档行：{bad_effective:?}"
    );

    // 号在磅单上：一张化验过的单恰好一枚号，四张单四枚互不相同（复检不另发）。
    // 这里查的是服务层有没有把号发对；"两张单敢共用一枚号会被库拦下"由
    // schema_contract::migration_0027_... 直接拿 UPDATE 探。
    let (labels, with_label): (i64, i64) = conn
        .query_row(
            "SELECT COUNT(DISTINCT sample_no), COUNT(sample_no) FROM weigh_order WHERE sample_no IS NOT NULL",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((labels, with_label), (4, 4), "复检链上的三行化验单必须共用磅单上那一枚号");
    let retentions: i64 = conn
        .query_row("SELECT COUNT(DISTINCT retention_no) FROM weigh_order WHERE retention_no IS NOT NULL", [], |r| r.get(0))
        .unwrap();
    assert_eq!(retentions, 4, "留样号同理：一单一枚");
}

/// 留样保存期跟着参数走、并且**跟瓶走不跟化验单走**。
///
/// 两件事分开看：`retention_sample_days` 在设置页叫「留样保存（天）」，站长改完必须真的
/// 反映到票面与清库阈值上（更早的版本在 orders.rs 里写死 30 天，那一栏纯属摆设）；
/// 而到期日是在**首次留样那天**定下的，复检只是再检一次同一瓶，不该让这瓶样凭空多活几天。
/// 后半截原先每张化验单各自算一次"自己那张的当天 + 天数"，于是同一单的两张化验单会印出
/// 两个到期日，迎检翻留样台账时说不清。
#[test]
fn retention_until_follows_the_sample_days_setting() {
    let conn = db();
    ensure_users(&conn);
    conn.execute("UPDATE app_setting SET value_json = '7' WHERE key = 'retention_sample_days'", [])
        .unwrap();
    let party = new_party(&conn, "期一", "410101199001010023");
    let no = new_order(&conn, party, "a");
    let r = accept_qc(&conn, &no);
    let want = (Local::now() + chrono::Duration::days(7)).format("%Y-%m-%d").to_string();
    assert_eq!(r.retention_until.as_deref(), Some(want.as_str()), "站长把留样改成 7 天，票面与清库阈值就得是 7 天后");

    let again = recheck_qc(&conn, &no);
    assert_eq!(
        again.retention_until, r.retention_until,
        "复检检的是同一瓶样，到期日不许被重新算一次"
    );

    // 参数改了只影响之后新留的样，不许回头去改已有留样的到期日
    conn.execute("UPDATE app_setting SET value_json = '90' WHERE key = 'retention_sample_days'", [])
        .unwrap();
    let later = accept_qc(&conn, &new_order(&conn, new_party(&conn, "期二", "410101199001010024"), "a"));
    let want90 = (Local::now() + chrono::Duration::days(90)).format("%Y-%m-%d").to_string();
    assert_eq!(later.retention_until.as_deref(), Some(want90.as_str()), "新留的样按改后的天数算");
    assert_eq!(
        conn.query_row::<String, _, _>("SELECT retention_until FROM weigh_order WHERE order_no = ?1", params![no], |x| x.get(0)).unwrap(),
        want,
        "已有留样的到期日不许被追改——瓶上的标签已经贴出去了"
    );
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
            paid_amount_fen: None,
            payment_method: "cash".into(),
            settler_id: None,
            price_list_id: None,
            price_override_reason: Some("测试结算：本轮不建价目行".into()),
            party_signed: Some(true),
            grade: None,
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
