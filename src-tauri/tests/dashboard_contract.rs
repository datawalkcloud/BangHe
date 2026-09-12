//! 首页看板聚合的行为守卫（docs/design/02 §7 M1、03 §10、§9.24）
//!
//! 看板换真库后最容易翻车、且纸面 review 看不出来的几件事，这里逐条守住：
//!  1. **口径漂移**：汇总必须剔 voided / rejected，但**红冲对（原单+负值单）必须
//!     双双参与**（不变式 4）——按状态白名单筛就会把红冲单丢掉，今日合计虚高；
//!  2. **时区陷阱**：§9.24 视图旧版用 `julianday('now','localtime')` 比带
//!     +08:00 偏移的落库文本恒定虚增 8 小时，刚进磅的车会显示"停留 8 小时"。
//!     0005 迁移已修，看板直接取视图列，`views_do_not_inflate_elapsed_time`
//!     把这条回归在**视图层**钉死（不依赖看板消费路径）；
//!  3. **阈值来源**：挂账时效读 `payment_due_warn_hours`（小时），改它必须能
//!     立刻改变告警名单；`open_order_alert_minutes` 库里没种时走默认 30；
//!  4. **JSON 键名**：前端 Dashboard 是驼峰/下划线混写（`openOrders`、`net_01kg`、
//!     `manualCount`），序列化名字逐字钉死，改一个页面就瞎一块；
//!  5. **区间边界**：`build_dashboard` 收 [from, to] 闭区间，趋势逐日补零覆盖整段，
//!     分组与汇总同一条 BETWEEN；区间外的单（本测试放 days_ago(20)）不得混进来。
//!
//! 与 `masters_contract.rs` 同样走内存库 + 真实迁移（含种子：station id=1、
//! admin id=1、四个默认品种、22 个参数键），前提变了这里先红。

use chrono::{Duration, Local, SecondsFormat};
use rusqlite::{params, Connection};

use banghe_lib::dashboard::build_dashboard;

fn db() -> Connection {
    banghe_lib::db::in_memory_migrated("0.1.0", banghe_lib::db::MIGRATIONS)
        .expect("内存库应能跑完全部迁移脚本")
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn days_ago(n: i64) -> String {
    (Local::now() - Duration::days(n)).format("%Y-%m-%d").to_string()
}

fn hours_ago(h: f64) -> String {
    (Local::now() - Duration::milliseconds((h * 3_600_000.0) as i64)).to_rfc3339_opts(SecondsFormat::Millis, false)
}

fn iso_at(date: &str, hour: i64) -> String {
    format!("{date}T{hour:02}:15:00.000+08:00")
}

/// 建一张最小可过 CHECK 的磅单。未提到的列全部走库默认值。
struct Order<'a> {
    no: &'a str,
    status: &'a str,
    party: i64,
    variety: i64,
    business_date: String,
    registered_at: String,
    net: Option<i64>,
    settle: Option<i64>,
    goods: Option<i64>,
    payable: Option<i64>,
    paid: i64,
    weight_source: &'a str,
    reversed_of: Option<i64>,
}

impl<'a> Default for Order<'a> {
    fn default() -> Self {
        Self {
            no: "",
            status: "settled",
            party: 0, // 0 = 现场补一个默认农户（种子里 party 表是空的，FK 会拦）
            variety: 1,
            business_date: today(),
            registered_at: hours_ago(0.5),
            net: None,
            settle: None,
            goods: None,
            payable: None,
            paid: 0,
            weight_source: "scale",
            reversed_of: None,
        }
    }
}

fn new_party(conn: &Connection, name: &str, party_type: &str) -> i64 {
    conn.execute(
        "INSERT INTO party (name, party_type, created_at, created_by) VALUES (?1, ?2, ?3, 1)",
        params![name, party_type, hours_ago(0.0)],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn insert_order(conn: &Connection, mut o: Order<'_>) -> i64 {
    if o.party == 0 {
        o.party = new_party(conn, "默认农户", "farmer");
    }
    conn.execute(
        "INSERT INTO weigh_order (
            order_no, station_id, business_date, status, party_id, variety_id,
            net_weight_01kg, settlement_weight_01kg, goods_amount_fen,
            payable_amount_fen, paid_amount_fen, weight_source, reversed_order_id,
            registered_by, registered_at, created_at, created_by)
         VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?13, 1)",
        params![
            o.no, o.business_date, o.status, o.party, o.variety,
            o.net, o.settle, o.goods, o.payable, o.paid, o.weight_source, o.reversed_of,
            o.registered_at,
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// 只取 variety id：种子顺序 YM=1, XM=2, DG=3, DD=4，测试不依赖具体编号
fn variety_id(conn: &Connection, code: &str) -> i64 {
    conn.query_row("SELECT id FROM grain_variety WHERE code = ?1", params![code], |r| r.get(0))
        .unwrap()
}

fn set_setting(conn: &Connection, key: &str, value_json: &str) {
    conn.execute(
        "INSERT INTO app_setting (key, value_json, value_type, updated_at)
         VALUES (?1, ?2, 'int', ?3)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        params![key, value_json, hours_ago(0.0)],
    )
    .unwrap();
}

// ------------------------------------------------------------------------ 测试

#[test]
fn empty_db_dashboard_is_zeroed_but_well_shaped() {
    let conn = db();
    // 传一段 15 天区间，保留"趋势逐日补零、品种全集各占一行"的旧断言语义。
    let d = build_dashboard(&conn, &days_ago(14), &today()).expect("空库（只有种子）不应该报错");
    assert_eq!(d.summary.orders, 0);
    assert_eq!(d.summary.credit_fen, 0);
    assert!(d.open_orders.is_empty());
    assert!(d.alerts.is_empty(), "没有单据没有设备，不该凭空告警");
    assert_eq!(d.trend.len(), 15);
    assert_eq!(d.trend.last().unwrap().date, today());
    assert_eq!(d.hour_curve.len(), 15);
    assert!(d.hour_curve.iter().all(|h| h.orders == 0));
    // 品种全集来自档案：即便一单没有，四个种子品种也要各占一行 0（柱状图不缺柱）
    assert_eq!(d.by_variety.len(), 4);
    assert!(d.by_variety.iter().all(|v| v.net_01kg == 0));
    assert!(d.by_party_type.is_empty());
}

#[test]
fn today_totals_redflush_pairs_counted_void_rejected_excluded() {
    let conn = db();
    // 正常完成单
    insert_order(&conn, Order { no: "BD01", net: Some(12345), settle: Some(12000), goods: Some(100000), payable: Some(99000), ..Default::default() });
    // 红冲对：原单已标 reversed，负值红冲单必须双双进合计（不变式 4）
    let orig = insert_order(&conn, Order { no: "BD02", status: "reversed", net: Some(5000), settle: Some(5000), goods: Some(40000), payable: Some(40000), paid: 10000, ..Default::default() });
    insert_order(&conn, Order { no: "BD03", net: Some(-5000), settle: Some(-5000), goods: Some(-40000), payable: Some(-40000), reversed_of: Some(orig), ..Default::default() });
    // 作废：即便带完整结算字段也不得进任何合计
    insert_order(&conn, Order { no: "BD04", status: "voided", net: Some(99999), settle: Some(99999), goods: Some(999999), payable: Some(999999), ..Default::default() });
    // 拒收：不进汇总，但进 rejectCount
    insert_order(&conn, Order { no: "BD05", status: "rejected", net: Some(8888), settle: Some(8888), goods: Some(88888), payable: Some(88888), ..Default::default() });
    // 手录完成单：进汇总 + manualCount + 手录告警
    insert_order(&conn, Order { no: "BD06", net: Some(5000), settle: Some(5000), goods: Some(5000), payable: Some(5000), paid: 5000, weight_source: "manual", ..Default::default() });

    let d = build_dashboard(&conn, &today(), &today()).unwrap();
    assert_eq!(d.summary.orders, 4, "BD01/02/03/06 参与汇总；红冲对不能漏");
    assert_eq!(d.summary.net_01kg, 12345 + 5000 - 5000 + 5000);
    assert_eq!(d.summary.settle_01kg, 12000 + 5000 - 5000 + 5000);
    assert_eq!(d.summary.goods_fen, 100000 + 40000 - 40000 + 5000);
    assert_eq!(d.summary.payable_fen, 99000 + 40000 - 40000 + 5000);
    assert_eq!(d.summary.paid_fen, 15000);
    assert_eq!(d.summary.credit_fen, d.summary.payable_fen - d.summary.paid_fen, "挂账 = 应付 − 已付，必须同源闭合");
    assert_eq!(d.summary.manual_count, 1);
    assert_eq!(d.summary.reject_count, 1);
    assert!(d.alerts.iter().any(|a| a.title == "本期 1 单为手录称重" && a.href == "/orders?weightSource=manual"));
}

#[test]
fn open_order_overdue_follows_setting_and_fresh_order_not_inflated() {
    let conn = db();
    // 2 小时前的登记单：默认阈值 30 分钟 ⇒ 超时
    insert_order(&conn, Order { no: "BD10", status: "registered", registered_at: hours_ago(2.0), ..Default::default() });
    // 刚落单：停留应 ≈ 0（视图那个 +8 小时的坑若回归，这里必炸）
    insert_order(&conn, Order { no: "BD11", status: "to_settle", registered_at: hours_ago(0.02), ..Default::default() });
    // settled / paid 不属于在途（看板语义是"还没结完钱的车"）
    insert_order(&conn, Order { no: "BD12", status: "settled", registered_at: hours_ago(9.0), ..Default::default() });

    let d = build_dashboard(&conn, &today(), &today()).unwrap();
    let nos: Vec<&str> = d.open_orders.iter().map(|o| o.order_no.as_str()).collect();
    assert_eq!(nos, vec!["BD10", "BD11"], "按停留降序，且不得混入 settled");
    assert!(d.open_orders[0].since_minutes >= 100 && d.open_orders[0].since_minutes <= 130);
    assert!(d.open_orders[1].since_minutes <= 5, "刚登记的单被算成停留数小时 = julianday 时区回归");
    assert!(d.open_orders[0].overdue && !d.open_orders[1].overdue);
    let alert = d.alerts.iter().find(|a| a.title.contains("在途超时")).expect("应有在途超时告警");
    assert!(alert.detail.contains("BD10"));

    // 阈值挪到 300 分钟：同一份数据不再报警（读的是 app_setting，不是写死）
    set_setting(&conn, "open_order_alert_minutes", "300");
    let d2 = build_dashboard(&conn, &today(), &today()).unwrap();
    assert!(d2.alerts.iter().all(|a| !a.title.contains("在途超时")));
    assert!(d2.open_orders.iter().all(|o| !o.overdue));
}

#[test]
fn credit_alert_reads_warn_hours_setting() {
    let conn = db();
    let party = new_party(&conn, "张三", "farmer");
    let settle = |no: &str, payable: i64, paid: i64, settled_at: String| {
        conn.execute(
            "INSERT INTO settlement (settle_no, station_id, party_id, business_date, period_from, period_to,
                     order_count, total_net_01kg, total_deduct_01kg, total_settle_01kg, total_goods_fen,
                     payable_fen, paid_fen, payment_status, settled_at, settler_id)
             VALUES (?1, 1, ?2, ?3, ?3, ?3, 1, 1000, 0, 1000, ?4, ?4, ?5,
                     CASE WHEN ?5 >= ?4 THEN 'paid' ELSE 'unpaid' END, ?6, 1)",
            params![no, party, today(), payable, paid, settled_at],
        )
        .unwrap();
    };
    settle("JS100", 100000, 0, hours_ago(100.0)); // 超 72h ⇒ 告警
    settle("JS101", 50000, 0, hours_ago(40.0)); // 未超 ⇒ 不进
    settle("JS102", 30000, 30000, hours_ago(500.0)); // 已付清 ⇒ 不进（v_payable 排除 paid）

    let d = build_dashboard(&conn, &today(), &today()).unwrap();
    let a = d.alerts.iter().find(|x| x.title.contains("挂账")).expect("应有一条挂账告警");
    assert_eq!(a.title, "1 笔挂账超过付款时效");
    assert_eq!(a.detail, "合计 ¥1,000.00 未付，已超 3 天时效", "72 小时要说成 3 天，单位与前端 format 对齐");
    assert_eq!(a.href, "/payments");

    // 收紧到 12 小时 ⇒ 两条都进；放宽到 108 小时 ⇒ 全出。参数必须真在链路上。
    set_setting(&conn, "payment_due_warn_hours", "12");
    let d = build_dashboard(&conn, &today(), &today()).unwrap();
    assert_eq!(d.alerts.iter().find(|x| x.title.contains("挂账")).unwrap().title, "2 笔挂账超过付款时效");
    set_setting(&conn, "payment_due_warn_hours", "108");
    let d = build_dashboard(&conn, &today(), &today()).unwrap();
    assert!(d.alerts.iter().all(|x| !x.title.contains("挂账")));
}

#[test]
fn device_panel_and_offline_alert_share_source() {
    let conn = db();
    let dev = |code: &str, kind: &str, enabled: i64, status: &str, err: Option<&str>| {
        conn.execute(
            "INSERT INTO device_config (code, name, kind, driver, is_enabled, last_status, last_error, created_at)
             VALUES (?1, ?1, ?2, 'mock', ?3, ?4, ?5, ?6)",
            params![code, kind, enabled, status, err, hours_ago(0.0)],
        )
        .unwrap();
    };
    dev("scale1", "scale", 1, "offline", Some("串口未连接或线缆松动"));
    dev("prn1", "printer", 1, "error", None);
    dev("cam1", "camera", 0, "offline", Some("不该出现")); // 停用 ⇒ 面板与告警都不计
    dev("idcard1", "idcard", 1, "online", None);

    let d = build_dashboard(&conn, &today(), &today()).unwrap();
    assert_eq!(d.devices.len(), 3, "只列启用设备");
    assert!(d.devices.iter().all(|x| x.code != "cam1"));
    let a = d.alerts.iter().find(|x| x.title.contains("设备")).expect("离线+故障应告警");
    assert_eq!(a.title, "2 台设备离线或故障");
    assert!(a.detail.contains("scale1（串口未连接或线缆松动）"));
    assert!(a.detail.contains("prn1（未连接）"), "last_error 为空要兜底成'未连接'");
}

#[test]
fn trend_and_grouping_window_is_14_days_back() {
    let conn = db();
    let xm = variety_id(&conn, "XM");
    let broker = new_party(&conn, "李四", "broker");
    insert_order(&conn, Order { no: "BD20", variety: xm, net: Some(1000), settle: Some(1000), goods: Some(2000), payable: Some(2000), ..Default::default() });
    insert_order(&conn, Order { no: "BD21", party: broker, variety: xm, business_date: days_ago(3), net: Some(500), settle: Some(500), goods: Some(900), payable: Some(900), ..Default::default() });
    insert_order(&conn, Order { no: "BD22", variety: xm, business_date: days_ago(20), net: Some(7000), settle: Some(7000), goods: Some(8000), payable: Some(8000), ..Default::default() });

    let d = build_dashboard(&conn, &days_ago(14), &today()).unwrap();
    assert_eq!(d.trend.iter().map(|t| t.orders).sum::<i64>(), 2, "20 天前的单不得进窗口");
    let t3 = d.trend.iter().find(|t| t.date == days_ago(3)).unwrap();
    assert_eq!((t3.orders, t3.net_01kg, t3.goods_fen), (1, 500, 900));
    let xm_row = d.by_variety.iter().find(|v| v.variety_code == "XM").unwrap();
    assert_eq!((xm_row.net_01kg, xm_row.goods_fen), (1500, 2900), "分组窗口与趋势同一条 BETWEEN");
    assert_eq!(d.by_party_type.len(), 2);
    let farmer = d.by_party_type.iter().find(|p| p.r#type == "farmer").unwrap();
    assert_eq!((farmer.label.as_str(), farmer.orders), ("农户", 1), "label 用 constants.PARTY_TYPE 的中文");
}

#[test]
fn hour_curve_counts_all_today_arrivals() {
    let conn = db();
    insert_order(&conn, Order { no: "BD30", registered_at: iso_at(&today(), 9), ..Default::default() });
    insert_order(&conn, Order { no: "BD31", status: "voided", registered_at: iso_at(&today(), 9), ..Default::default() });
    insert_order(&conn, Order { no: "BD32", status: "registered", registered_at: iso_at(&today(), 14), ..Default::default() });
    insert_order(&conn, Order { no: "BD33", business_date: days_ago(1), registered_at: iso_at(&days_ago(1), 9), ..Default::default() });

    let d = build_dashboard(&conn, &today(), &today()).unwrap();
    let h = |x: i64| d.hour_curve.iter().find(|c| c.hour == x).unwrap().orders;
    assert_eq!((h(9), h(14)), (2, 1), "画的是'什么时候来过车'，作废/在途也计入");
    assert_eq!(h(8), 0);
    assert_eq!(h(6), 0);
    assert!(d.hour_curve.first().unwrap().hour == 6 && d.hour_curve.last().unwrap().hour == 20);
}

#[test]
fn serde_keys_match_frontend_dashboard_contract() {
    let conn = db();
    insert_order(&conn, Order { no: "BD40", status: "registered", net: Some(10), settle: Some(10), goods: Some(10), payable: Some(10), weight_source: "manual", ..Default::default() });
    let json = serde_json::to_value(build_dashboard(&conn, &today(), &today()).unwrap()).unwrap();
    for key in [
        "summary", "openOrders", "alerts", "trend", "byVariety", "byPartyType", "hourCurve", "devices",
    ] {
        assert!(json.get(key).is_some(), "顶层缺 {key}");
    }
    for key in ["orders", "net_01kg", "settle_01kg", "goods_fen", "payable_fen", "paid_fen", "credit_fen", "manualCount", "rejectCount"] {
        assert!(json["summary"].get(key).is_some(), "summary 缺 {key}");
    }
    for key in ["order_no", "party_name", "status", "variety_name", "since_minutes", "overdue"] {
        assert!(json["openOrders"][0].get(key).is_some(), "openOrders 行缺 {key}");
    }
    for key in ["level", "title", "detail", "action", "href"] {
        assert!(json["alerts"][0].get(key).is_some(), "alerts 行缺 {key}");
    }
    assert!(json["byPartyType"][0].get("type").is_some(), "r#type 应序列化为 type");
    assert!(json["devices"].as_array().unwrap().is_empty());
}

#[test]
fn views_do_not_inflate_elapsed_time() {
    // 直接对视图列断言，不绕看板：0005 若被人改回 julianday('now','localtime')，
    // 刚落的单会立刻虚增一个时区（东八区 = 8 小时 / 480 分钟）。
    let conn = db();
    insert_order(&conn, Order { no: "BD50", status: "registered", registered_at: hours_ago(0.0), ..Default::default() });
    let party = new_party(&conn, "刚结算的农户", "farmer");
    conn.execute(
        "INSERT INTO settlement (settle_no, station_id, party_id, business_date, period_from, period_to,
                 order_count, total_net_01kg, total_deduct_01kg, total_settle_01kg, total_goods_fen,
                 payable_fen, paid_fen, payment_status, settled_at, settler_id)
         VALUES ('JS50', 1, ?1, ?2, ?2, ?2, 1, 1000, 0, 1000, 10000, 10000, 0, 'unpaid', ?3, 1)",
        params![party, today(), hours_ago(0.0)],
    )
    .unwrap();

    let stuck: i64 = conn
        .query_row("SELECT stuck_minutes FROM v_open_order WHERE order_no = 'BD50'", [], |r| r.get(0))
        .unwrap();
    assert!((0..=5).contains(&stuck), "v_open_order.stuck_minutes 时区回归：刚落单读出 {stuck} 分钟");
    let hours: i64 = conn
        .query_row("SELECT unpaid_hours FROM v_payable WHERE settle_no = 'JS50'", [], |r| r.get(0))
        .unwrap();
    assert!((0..=1).contains(&hours), "v_payable.unpaid_hours 时区回归：刚落账读出 {hours} 小时");

    // 真超时仍然要报得出：25 小时前的挂账必须读出 ≈ 25，不能被截成 0 或负数
    conn.execute("UPDATE settlement SET settled_at = ?1 WHERE settle_no = 'JS50'", params![hours_ago(25.0)]).unwrap();
    let hours: i64 = conn
        .query_row("SELECT unpaid_hours FROM v_payable WHERE settle_no = 'JS50'", [], |r| r.get(0))
        .unwrap();
    assert!((24..=25).contains(&hours), "真实时长也被读错了：25 小时前的账读出 {hours}");
}
