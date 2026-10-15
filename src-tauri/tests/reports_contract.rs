//! 「系统与审计 → 日结交班」两个读命令的行为守卫（docs/design/03 §10、05 §3）
//!
//! 这个 tab 换真库后最容易翻车、纸面 review 看不出来的几件事，逐条守住：
//!  1. **汇总口径**：`stat2`（结算重量非空 + 剔 voided / rejected）漏一条就会让
//!     交接表的净重虚高；红冲单必须仍以负值参与（不变式 4）。
//!  2. **`reject_count` 不套 `stat2`**：拒收单本来就被 `stat2` 排除，套了就恒为 0，
//!     而这一列正是迎检时"今天拒了几车"的唯一答案。
//!  3. **平均水分**：只认 `is_effective = 1` 的化验单（被复核推翻的旧单不能进平均），
//!     取整必须与 mock 的 `Math.round` 一致（.5 上取整），否则交接表与历史打印件差 1。
//!  4. **边界用 `business_date`**：跨零点单（`created_at` 是今天）只能归业务日那天。
//!  5. **付款状态三分**：交接页拿 `unpaid` + `partial` 两份列表拼挂账，`paid` 不能漏进来，
//!     `partial` 不能出现在 `unpaid` 里（否则同一笔钱点两遍）。
//!  6. **JSON 键名**：`DailyReport` / `Settlement` 的键集合与 `src/mock/types.ts`
//!     逐字对齐并写成断言——尤其 `prevDayNet_01kg` 这类驼峰残留，改了就静默显示 0。
//!
//! 建库方式与 `dashboard_contract.rs` 一致：内存库跑真实迁移（含种子：station id=1、
//! admin id=1、四个默认品种 YM/XM/DG/DD、22 个参数键），前提变了这里先红。
//!
//! 测的是 `banghe_lib::reports` 本体（`lib.rs` 已 `pub mod reports;` 并注册两个命令），
//! 不是副本——命令薄壳与页面调用的是同一份代码。

use banghe_lib::reports::{build_daily, list_settlements, Settlement, SettlementFilters};

use chrono::{Duration, Local};
use rusqlite::{params, Connection};
use serde_json::{json, Value};

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
    (Local::now() - Duration::milliseconds((h * 3_600_000.0) as i64))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

// ---------------------------------------------------------------------- 造数据

/// 一张最小可过 CHECK 的磅单。未提到的列走库默认值。
struct Order<'a> {
    no: &'a str,
    variety: &'a str,
    party: i64,
    business_date: String,
    created_at: String,
    status: &'a str,
    gross: Option<i64>,
    tare: Option<i64>,
    net: Option<i64>,
    deduct: i64,
    settle: Option<i64>,
    price: Option<i64>,
    goods: Option<i64>,
    fee: i64,
    payable: Option<i64>,
    paid: i64,
    weight_source: &'a str,
    qc: Option<i64>,
}

impl<'a> Default for Order<'a> {
    fn default() -> Self {
        Self {
            no: "",
            variety: "YM",
            party: 0,
            business_date: today(),
            created_at: hours_ago(0.5),
            status: "settled",
            gross: None,
            tare: None,
            net: None,
            deduct: 0,
            settle: None,
            price: None,
            goods: None,
            fee: 0,
            payable: None,
            paid: 0,
            weight_source: "scale",
            qc: None,
        }
    }
}

fn new_party(conn: &Connection, name: &str) -> i64 {
    conn.execute(
        "INSERT INTO party (name, party_type, created_at, created_by) VALUES (?1, 'farmer', ?2, 1)",
        params![name, hours_ago(0.0)],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn variety_id(conn: &Connection, code: &str) -> i64 {
    conn.query_row("SELECT id FROM grain_variety WHERE code = ?1", params![code], |r| r.get(0))
        .unwrap()
}

fn insert_order(conn: &Connection, o: Order<'_>) -> i64 {
    conn.execute(
        "INSERT INTO weigh_order (
            order_no, station_id, business_date, status, party_id, variety_id,
            gross_weight_01kg, tare_weight_01kg, net_weight_01kg, deduct_total_01kg,
            settlement_weight_01kg, price_fen_per_ton, goods_amount_fen, deduction_fee_fen,
            payable_amount_fen, paid_amount_fen, weight_source, qc_report_id,
            registered_by, registered_at, created_at, created_by)
         VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 1, ?18, ?18, 1)",
        rusqlite::params![
            o.no, o.business_date, o.status, o.party, variety_id(conn, o.variety),
            o.gross, o.tare, o.net, o.deduct, o.settle, o.price, o.goods, o.fee,
            o.payable, o.paid, o.weight_source, o.qc, o.created_at,
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// 一张有效/无效化验单 + 水分指标。`effective = false` 模拟"被复核推翻"的旧单。
fn insert_qc(conn: &Connection, order_id: i64, variety: &str, no: &str, moisture: i64, effective: bool) -> i64 {
    conn.execute(
        "INSERT INTO qc_report (report_no, order_id, variety_id, decision, test_method,
                 is_effective, inspector_id, inspected_at, created_at, created_by)
         VALUES (?1, ?2, ?3, 'accept', 'nir', ?4, 1, ?5, ?5, 1)",
        params![no, order_id, variety_id(conn, variety), effective as i64, hours_ago(1.0)],
    )
    .unwrap();
    let id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO qc_indicator (report_id, code, name, value_num, unit) VALUES (?1, 'moisture', '水分', ?2, '0.01pct')",
        params![id, moisture],
    )
    .unwrap();
    id
}

#[allow(clippy::too_many_arguments)]
fn insert_settlement(
    conn: &Connection,
    no: &str,
    party: i64,
    business_date: &str,
    count: i64,
    net: i64,
    settle: i64,
    goods: i64,
    payable: i64,
    paid: i64,
    payee: Option<&str>,
    status: &str,
) -> i64 {
    conn.execute(
        "INSERT INTO settlement (settle_no, station_id, party_id, business_date, period_from, period_to,
                 order_count, total_net_01kg, total_deduct_01kg, total_settle_01kg, total_goods_fen,
                 payable_fen, paid_fen, payment_status, main_method, payee_name, signed_by_party,
                 status, settled_at, settler_id)
         VALUES (?1, 1, ?2, ?3, ?3, ?3, ?4, ?5, 0, ?6, ?7, ?8, ?9,
                 CASE WHEN ?9 = 0 THEN 'unpaid' WHEN ?9 >= ?8 THEN 'paid' ELSE 'partial' END,
                 CASE WHEN ?9 = 0 THEN NULL ELSE 'cash' END, ?10, ?11, ?12, ?13, 1)",
        params![
            no, party, business_date, count, net, settle, goods, payable, paid,
            payee, if paid == 0 { 0 } else { 1 }, status, hours_ago(2.0)
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn link_settlement_order(conn: &Connection, settlement_id: i64, order_id: i64, seq: i64) {
    let (goods, price, settle): (Option<i64>, Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT goods_amount_fen, price_fen_per_ton, settlement_weight_01kg FROM weigh_order WHERE id = ?1",
            params![order_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    conn.execute(
        "INSERT INTO settlement_order (settlement_id, order_id, goods_amount_fen, price_fen_per_ton,
                 settlement_weight_01kg, seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![settlement_id, order_id, goods.unwrap_or(0), price.unwrap_or(0), settle.unwrap_or(0), seq],
    )
    .unwrap();
}

fn insert_payment(conn: &Connection, pay_no: &str, settlement_id: i64, party: i64, amount: i64) {
    conn.execute(
        "INSERT INTO payment_record (pay_no, settlement_id, amount_fen, method, payee_name,
                 paid_at, operator_id, created_at, created_by)
         VALUES (?1, ?2, ?3, 'cash', (SELECT name FROM party WHERE id = ?4), ?5, 1, ?5, 1)",
        params![pay_no, settlement_id, amount, party, hours_ago(1.0)],
    )
    .unwrap();
}

/// 走 JSON 构造入参：顺带把「前端传驼峰 `paymentStatus`」这条契约钉住。
fn filters(spec: Value) -> SettlementFilters {
    serde_json::from_value(spec).expect("SettlementFilters 应能吃下前端会传的 JSON")
}

/// 交接页那一天的完整数据：3 张完成单（两个品种）+ 1 拒收 + 1 作废 + 环比基数若干。
/// 手算结果全部写死在下面各断言里，改数据就得重算——这正是本文件的用处。
fn seed_shift_day(conn: &Connection) {
    let a = new_party(conn, "张三");
    let b = new_party(conn, "李四");

    // 玉米：两张完成单（其中一张手录），水分只有有效单 RB01 的 1350 进平均
    let rb01 = insert_order(
        conn,
        Order {
            no: "RB01", variety: "YM", party: a,
            gross: Some(13000), tare: Some(1000), net: Some(12000), deduct: 300,
            settle: Some(11700), price: Some(200000), goods: Some(1170000), fee: 20000,
            payable: Some(1150000), paid: 500000, weight_source: "manual",
            ..Default::default()
        },
    );
    let rb05 = insert_order(
        conn,
        Order {
            no: "RB05", variety: "YM", party: a,
            gross: Some(4500), tare: Some(500), net: Some(4000), deduct: 100,
            settle: Some(3900), price: Some(200000), goods: Some(400000), fee: 1000,
            payable: Some(399000),
            ..Default::default()
        },
    );
    let q1 = insert_qc(conn, rb01, "YM", "QC1", 1350, true);
    conn.execute("UPDATE weigh_order SET qc_report_id = ?1 WHERE id = ?2", params![q1, rb01]).unwrap();
    // RB05 的化验单已被复核推翻（is_effective = 0）：不得进平均水分
    let q5 = insert_qc(conn, rb05, "YM", "QC5", 9999, false);
    conn.execute("UPDATE weigh_order SET qc_report_id = ?1 WHERE id = ?2", params![q5, rb05]).unwrap();

    // 小麦：一张完成单，没有化验单 ⇒ avg_moisture_001pct = null
    insert_order(
        conn,
        Order {
            no: "RB02", variety: "XM", party: b,
            gross: Some(6000), tare: Some(1000), net: Some(5000), deduct: 200,
            settle: Some(4800), price: Some(125000), goods: Some(600000),
            payable: Some(590000),
            ..Default::default()
        },
    );
    // 拒收：进 reject_count，不进任何金额/重量列
    insert_order(
        conn,
        Order {
            no: "RB03", variety: "YM", party: a, status: "rejected",
            net: Some(9000), settle: Some(9000), goods: Some(900000), payable: Some(900000),
            ..Default::default()
        },
    );
    // 作废：连 reject_count 都不进
    insert_order(
        conn,
        Order {
            no: "RB04", variety: "YM", party: b, status: "voided",
            net: Some(7000), settle: Some(7000), goods: Some(700000), payable: Some(700000),
            ..Default::default()
        },
    );

    // 环比/同比基数：前一日 8000、前两日 4000（不该进任何一个基数）、前七日 3000
    insert_order(conn, Order { no: "RB10", business_date: days_ago(1), net: Some(8000), settle: Some(8000), goods: Some(800000), payable: Some(800000), party: a, ..Default::default() });
    insert_order(conn, Order { no: "RB11", business_date: days_ago(2), net: Some(4000), settle: Some(4000), goods: Some(400000), payable: Some(400000), party: a, ..Default::default() });
    insert_order(conn, Order { no: "RB12", business_date: days_ago(7), net: Some(3000), settle: Some(3000), goods: Some(300000), payable: Some(300000), party: a, ..Default::default() });
    insert_order(conn, Order { no: "RB13", business_date: days_ago(1), status: "rejected", net: Some(99999), settle: Some(99999), goods: Some(1), payable: Some(1), party: a, ..Default::default() });
}

// ------------------------------------------------------------------------ 测试

#[test]
fn empty_db_returns_zero_shape_not_error() {
    let conn = db();
    let d = build_daily(&conn, Some(&today())).expect("空库（只有种子）不该报错");
    assert_eq!(d.date, today());
    assert!(d.rows.is_empty(), "没有单就不该有品种行（mock 的 !list.length ⇒ continue）");
    assert_eq!(d.total.orders, 0);
    assert_eq!(d.total.parties, 0);
    assert_eq!(
        (
            d.total.net_01kg,
            d.total.settle_01kg,
            d.total.goods_fen,
            d.total.payable_fen,
            d.total.paid_fen,
            d.total.credit_fen
        ),
        (0, 0, 0, 0, 0, 0),
        "total 必须全零：交接表要能打印'今日无业务'"
    );
    assert_eq!((d.prev_day_net_01kg, d.last_week_net_01kg), (0, 0));

    // date 缺省 = 本地当天；空串按缺省处理（页面日期框清空时会传 ""）
    assert_eq!(build_daily(&conn, None).unwrap().date, today());
    assert_eq!(build_daily(&conn, Some("  ")).unwrap().date, today());
    assert!(build_daily(&conn, Some("2026/05/01")).is_err(), "非法日期不能静默当今天");

    let rows = list_settlements(&conn, &filters(json!({}))).unwrap();
    assert!(rows.is_empty(), "空库结算单列表是空数组，不是 Err");
    // 前端 {} → 全部字段缺省；驼峰键必须能吃到
    assert_eq!(list_settlements(&conn, &filters(json!({"paymentStatus": "unpaid"}))).unwrap().len(), 0);
}

#[test]
fn daily_rows_and_total_are_hand_computed() {
    let conn = db();
    seed_shift_day(&conn);
    let d = build_daily(&conn, Some(&today())).unwrap();

    // 品种行：净重倒序；今天没单的种子品种（DG/DD）不出行
    let codes: Vec<&str> = d.rows.iter().map(|r| r.variety_code.as_str()).collect();
    assert_eq!(codes, vec!["YM", "XM"], "按 net 倒序，且空品种不留行");

    let ym = &d.rows[0];
    assert_eq!((ym.variety_name.as_str(), ym.orders, ym.parties), ("玉米", 2, 1));
    assert_eq!((ym.gross_01kg, ym.tare_01kg, ym.net_01kg), (13000 + 4500, 1000 + 500, 12000 + 4000));
    assert_eq!((ym.deduct_01kg, ym.settle_01kg), (300 + 100, 11700 + 3900));
    assert_eq!((ym.goods_fen, ym.deduction_fee_fen), (1170000 + 400000, 20000 + 1000));
    assert_eq!((ym.payable_fen, ym.paid_fen), (1150000 + 399000, 500000));
    assert_eq!(ym.credit_fen, ym.payable_fen - ym.paid_fen, "挂账 = 应付 − 已付，必须同行闭合");
    assert_eq!(ym.credit_fen, 1049000);
    assert_eq!(ym.avg_moisture_001pct, Some(1350), "被推翻的 QC5(9999) 不得进平均");
    assert_eq!(ym.manual_count, 1, "手录列套 stat2（与看板的 manualCount 不同口径）");
    assert_eq!(ym.reject_count, 1, "拒收列不套 stat2，否则整列恒 0");

    let xm = &d.rows[1];
    assert_eq!((xm.orders, xm.parties, xm.net_01kg, xm.settle_01kg), (1, 1, 5000, 4800));
    assert_eq!((xm.goods_fen, xm.payable_fen, xm.paid_fen, xm.credit_fen), (600000, 590000, 0, 590000));
    assert_eq!(xm.avg_moisture_001pct, None, "无有效水分样本 ⇒ null，不是 0（0 会被读成'水分为零'）");
    assert_eq!((xm.manual_count, xm.reject_count), (0, 0));

    // 合计与行同源：逐列相加必须等于 total（03 §10 总分相符）
    let t = &d.total;
    assert_eq!((t.orders, t.parties), (3, 2), "张三 2 单 + 李四 1 单；拒收/作废不进合计");
    assert_eq!(t.net_01kg, d.rows.iter().map(|r| r.net_01kg).sum::<i64>());
    assert_eq!((t.net_01kg, t.settle_01kg), (21000, 20400));
    assert_eq!(t.goods_fen, 2170000);
    assert_eq!((t.payable_fen, t.paid_fen, t.credit_fen), (2139000, 500000, 1639000));
    assert_eq!(t.credit_fen, t.payable_fen - t.paid_fen);
    assert_eq!(d.rows.iter().map(|r| r.credit_fen).sum::<i64>(), t.credit_fen);

    // 基数以「所查日期」为轴，不是以今天为轴
    assert_eq!(d.prev_day_net_01kg, 8000, "前两日的 4000 不得混进前一日");
    assert_eq!(d.last_week_net_01kg, 3000);
    let yesterday = build_daily(&conn, Some(&days_ago(1))).unwrap();
    assert_eq!(yesterday.total.net_01kg, 8000);
    assert_eq!(yesterday.prev_day_net_01kg, 4000, "查昨天时，前一日是前天");
    assert_eq!(yesterday.last_week_net_01kg, 0);
    assert_eq!(yesterday.date, days_ago(1));
}

#[test]
fn avg_moisture_rounds_like_javascript_math_round() {
    let conn = db();
    let a = new_party(&conn, "轮四舍");
    let r1 = insert_order(&conn, Order { no: "RR1", party: a, net: Some(1000), settle: Some(1000), goods: Some(100000), payable: Some(100000), ..Default::default() });
    let r2 = insert_order(&conn, Order { no: "RR2", party: a, net: Some(1000), settle: Some(1000), goods: Some(100000), payable: Some(100000), ..Default::default() });
    let q1 = insert_qc(&conn, r1, "YM", "QR1", 1350, true);
    let q2 = insert_qc(&conn, r2, "YM", "QR2", 1451, true);
    conn.execute("UPDATE weigh_order SET qc_report_id = ?1 WHERE id = ?2", params![q1, r1]).unwrap();
    conn.execute("UPDATE weigh_order SET qc_report_id = ?1 WHERE id = ?2", params![q2, r2]).unwrap();

    // (1350 + 1451) / 2 = 1400.5 ⇒ mock 的 Math.round 上取整成 1401（不是银行家舍入的 1400）
    assert_eq!(build_daily(&conn, Some(&today())).unwrap().rows[0].avg_moisture_001pct, Some(1401));
}

#[test]
fn cross_midnight_order_belongs_to_business_date_only() {
    let conn = db();
    let a = new_party(&conn, "夜车");
    // 业务日=昨天、落库时间=今天（跨零点过磅）
    insert_order(
        &conn,
        Order {
            no: "RN1", party: a,
            business_date: days_ago(1), created_at: hours_ago(0.0),
            net: Some(6000), settle: Some(6000), goods: Some(600000), payable: Some(600000),
            ..Default::default()
        },
    );

    let t = build_daily(&conn, Some(&today())).unwrap();
    assert!(t.rows.is_empty() && t.total.orders == 0 && t.total.net_01kg == 0, "created_at 不得成为统计边界");
    assert_eq!(t.prev_day_net_01kg, 6000, "昨天的日报基数里必须看得到这张夜车单");

    let y = build_daily(&conn, Some(&days_ago(1))).unwrap();
    assert_eq!((y.total.orders, y.total.net_01kg), (1, 6000));
    assert_eq!((y.rows[0].variety_code.as_str(), y.rows[0].orders), ("YM", 1));
}

#[test]
fn settlement_status_three_way_split_matches_shift_tabs() {
    let conn = db();
    seed_shift_day(&conn);
    let a = conn.query_row("SELECT id FROM party WHERE name = '张三'", [], |r| r.get::<_, i64>(0)).unwrap();
    let c = new_party(&conn, "王五");
    let b = conn.query_row("SELECT id FROM party WHERE name = '李四'", [], |r| r.get::<_, i64>(0)).unwrap();

    let js900 = insert_settlement(&conn, "JS900", a, &today(), 2, 16000, 15600, 1570000, 1549000, 500000, None, "normal");
    insert_settlement(&conn, "JS903", c, &today(), 1, 1000, 1000, 120000, 120000, 0, Some("王五代领"), "normal");
    insert_settlement(&conn, "JS905", b, &today(), 1, 900, 900, 100000, 100000, 100000, None, "normal");
    insert_settlement(&conn, "JS907", a, &today(), 1, 10, 10, 77, 77, 0, None, "revoked");
    let rb01 = conn.query_row("SELECT id FROM weigh_order WHERE order_no = 'RB01'", [], |r| r.get::<_, i64>(0)).unwrap();
    let rb05 = conn.query_row("SELECT id FROM weigh_order WHERE order_no = 'RB05'", [], |r| r.get::<_, i64>(0)).unwrap();
    link_settlement_order(&conn, js900, rb01, 1);
    link_settlement_order(&conn, js900, rb05, 2);
    insert_payment(&conn, "FK900", js900, a, 500000);

    let nos = |v: Vec<Settlement>| -> Vec<String> { v.iter().map(|s| s.settle_no.clone()).collect() };
    let by = |ps: &str| nos(list_settlements(&conn, &filters(json!({ "paymentStatus": ps }))).unwrap());

    assert_eq!(by("partial"), vec!["JS900"], "交接页 partial 页签只要这一张");
    assert_eq!(by("unpaid"), vec!["JS907", "JS903"], "unpaid 不得混进 partial 的单");
    assert_eq!(by("paid"), vec!["JS905"], "已付清的两边都不该出现");
    assert_eq!(nos(list_settlements(&conn, &filters(json!({}))).unwrap()), vec!["JS907", "JS905", "JS903", "JS900"]);
    // "all" 是页面下拉的哨兵值，等价于不筛
    assert_eq!(by("all").len(), 4);
    assert!(list_settlements(&conn, &filters(json!({ "paymentStatus": "not_required" }))).is_err(), "非法状态要人话报错，不能静默全给");

    // 交接页的挂账合计 = unpaid + partial 两份拼接后逐张 payable − paid
    let due: Vec<Settlement> = [list_settlements(&conn, &filters(json!({ "paymentStatus": "unpaid" }))).unwrap(), list_settlements(&conn, &filters(json!({ "paymentStatus": "partial" }))).unwrap()].concat();
    assert_eq!(due.iter().map(|s| s.payable_fen - s.paid_fen).sum::<i64>(), 120000 + 77 + 1049000);
    // 结算单的挂账与日报玉米行的挂账同源
    let js = &list_settlements(&conn, &filters(json!({ "keyword": "JS900" }))).unwrap()[0];
    assert_eq!(js.payable_fen - js.paid_fen, build_daily(&conn, Some(&today())).unwrap().rows[0].credit_fen);
    assert_eq!(js.payee_name, "张三", "库里 payee_name 为 NULL ⇒ 回落售粮人（与 orders.rs 同口径）");
    assert_eq!(js.main_method.as_deref(), Some("cash"));
    assert_eq!((js.order_count, js.total_net_01kg, js.payment_status.as_str(), js.status.as_str(), js.signed_by_party),
        (2, 16000, "partial", "normal", 1));
    assert_eq!(js.remark, None);
    // 明细：按 seq 顺序、带上磅单号快照
    let rows: Vec<(String, i64, i64)> = js.orders.iter().map(|o| (o.order_no.clone(), o.seq, o.goods_amount_fen)).collect();
    assert_eq!(rows, vec![("RB01".to_string(), 1, 1170000), ("RB05".to_string(), 2, 400000)]);
    assert_eq!(js.orders[0].settlement_weight_01kg, 11700);
    assert_eq!(js.orders[0].price_fen_per_ton, 200000);
    assert!(list_settlements(&conn, &filters(json!({ "keyword": "JS903" }))).unwrap()[0].orders.is_empty(), "没有明细就是空数组");
    // revoked 不静默删行（与 mock listSettlements 一致），由页面按 status 自己筛
    assert!(by("unpaid").contains(&"JS907".to_string()));
}

#[test]
fn settlement_keyword_date_and_limit() {
    let conn = db();
    let a = new_party(&conn, "张三");
    let c = new_party(&conn, "王五");
    insert_settlement(&conn, "JS800", a, &today(), 1, 1000, 1000, 100000, 100000, 0, None, "normal");
    insert_settlement(&conn, "JS801", c, &today(), 1, 1000, 1000, 100000, 100000, 0, Some("王五代领"), "normal");
    insert_settlement(&conn, "JS799", a, &days_ago(30), 1, 1000, 1000, 100000, 100000, 0, None, "normal");
    let nos = |v: Vec<Settlement>| -> Vec<String> { v.iter().map(|s| s.settle_no.clone()).collect() };

    assert_eq!(nos(list_settlements(&conn, &filters(json!({ "keyword": " js800 "}))).unwrap()), vec!["JS800"], "LIKE 对 ASCII 本就大小写不敏感，且首尾空格要忽略");
    assert_eq!(nos(list_settlements(&conn, &filters(json!({ "keyword": "五代领" }))).unwrap()), vec!["JS801"], "收款人列可搜（比 mock 多的一列，交接页显示的就是收款人）");
    assert_eq!(nos(list_settlements(&conn, &filters(json!({ "keyword": "张三" }))).unwrap()), vec!["JS800", "JS799"], "售粮人姓名按 mock 同口径参与搜索，日期倒序");
    assert!(list_settlements(&conn, &filters(json!({ "keyword": "%99" }))).unwrap().is_empty(), "% 是字面量，不是通配符");
    assert_eq!(list_settlements(&conn, &filters(json!({ "keyword": "" }))).unwrap().len(), 3, "空关键词 = 不筛");

    assert_eq!(nos(list_settlements(&conn, &filters(json!({ "dateFrom": days_ago(1), "dateTo": today() }))).unwrap()), vec!["JS801", "JS800"]);
    assert_eq!(nos(list_settlements(&conn, &filters(json!({ "dateTo": days_ago(1) }))).unwrap()), vec!["JS799"]);
    assert!(list_settlements(&conn, &filters(json!({ "dateFrom": "昨天" }))).is_err(), "非法日期要报错，不能静默返回空表");
    assert_eq!(list_settlements(&conn, &filters(json!({ "limit": 1 }))).unwrap().len(), 1);
    assert_eq!(list_settlements(&conn, &filters(json!({ "limit": 0 }))).unwrap().len(), 1, "limit 钳到下限 1：0 不能被当成'不限制'或'不给'");
    assert_eq!(list_settlements(&conn, &filters(json!({ "limit": 999999 }))).unwrap().len(), 3, "上限 2000，本例只有 3 张 ⇒ 全给");
}

#[test]
fn serde_keys_match_frontend_contract() {
    let conn = db();
    seed_shift_day(&conn);
    let a = conn.query_row("SELECT id FROM party WHERE name = '张三'", [], |r| r.get::<_, i64>(0)).unwrap();
    let js = insert_settlement(&conn, "JS999", a, &today(), 1, 16000, 15600, 1570000, 1549000, 500000, Some("张三"), "normal");
    let rb01 = conn.query_row("SELECT id FROM weigh_order WHERE order_no = 'RB01'", [], |r| r.get::<_, i64>(0)).unwrap();
    link_settlement_order(&conn, js, rb01, 1);

    let keys = |v: &Value| -> Vec<String> {
        let mut k: Vec<String> = v.as_object().expect("应为对象").keys().cloned().collect();
        k.sort();
        k
    };
    let sorted = |list: &[&str]| -> Vec<String> {
        let mut v: Vec<String> = list.iter().map(|s| s.to_string()).collect();
        v.sort();
        v
    };

    let d = serde_json::to_value(build_daily(&conn, Some(&today())).unwrap()).unwrap();
    assert_eq!(keys(&d), sorted(&["date", "rows", "total", "prevDayNet_01kg", "lastWeekNet_01kg"]));
    assert!(d.get("prevDayNet_01kg").is_some(), "驼峰残留必须原样输出，改成 prev_day 页面就静默 0");
    assert_eq!(keys(&d["rows"][0]), sorted(&[
        "variety_name", "variety_code", "orders", "parties", "gross_01kg", "tare_01kg", "net_01kg",
        "deduct_01kg", "settle_01kg", "goods_fen", "deduction_fee_fen", "payable_fen", "paid_fen",
        "credit_fen", "avg_moisture_001pct", "manual_count", "reject_count",
    ]));
    assert_eq!(keys(&d["total"]), sorted(&[
        "orders", "parties", "net_01kg", "settle_01kg", "goods_fen", "payable_fen", "paid_fen", "credit_fen",
    ]));
    assert!(d["rows"][1].get("avg_moisture_001pct").unwrap().is_null(), "无样本序列化成 null");

    let s = serde_json::to_value(list_settlements(&conn, &filters(json!({ "keyword": "JS999" }))).unwrap()).unwrap();
    assert_eq!(keys(&s[0]), sorted(&[
        "id", "settle_no", "party_id", "party_name", "business_date", "period_from", "period_to",
        "order_count", "total_net_01kg", "total_deduct_01kg", "total_settle_01kg", "total_goods_fen",
        "total_deduction_fen", "total_advance_fen", "payable_fen", "paid_fen", "payment_status",
        "main_method", "payee_name", "signed_by_party", "status", "settled_at", "settler_id", "orders", "remark",
    ]));
    assert_eq!(keys(&s[0]["orders"][0]), sorted(&[
        "order_id", "order_no", "goods_amount_fen", "price_fen_per_ton", "settlement_weight_01kg", "seq",
    ]));
}
