//! 台账报表四个视图的行为守卫（02 §F6/F7、03 §10、05 §3 `/reports/$kind`）
//!
//! 这四张表是磅站对外报送和迎检的脸面，错了不会被立刻发现——它会静静地错一个
//! 季度。所以这里只钉**纸面 review 看不出来**的那几类，不复述 SQL 写了什么：
//!  1. **键名契约**：`QualityReport` 外层是驼峰（`dateFrom`/`byVariety`/`gradeDist`/
//!     `moistureBuckets`）、行内是下划线，`LedgerRow.settled` 必须是 JSON 布尔。
//!     前端 `ReportsPage` 直接按这些键取值，改一个字母就是页面静默显示空表；
//!  2. **红冲必须参与**（不变式 4）：台账只剔 `voided`/`rejected`，红冲负值单要出现在
//!     表里并把合计抵掉。按状态白名单筛是本模块最容易犯的错；
//!  3. **两套分母不许混**（02 §F7.3）：质量分析 `orders` 含拒收、`samples` 只算生效
//!     化验单，`over_any` 同一单既超水又超杂只计一次（相加会让"问题率"超 100%）；
//!  4. **一行两种口径**（02 §F6.2）：排行的 `last_date` 走"非作废"全集、四个金额列走
//!     汇总子集，`avg_tare_01kg` 还是全历史均值、不受上方日期区间影响；
//!  5. **同一单两人各计一次**：作业量的"经手单数"合计必大于实际单数，
//!     这条如果不成立，说明归属写成了 `AND`，看板上就会出现"人均单数对不上"。
//!
//! 与 `dashboard_contract.rs` 同样走内存库 + 真实迁移（含种子：station id=1、
//! admin id=1、四个默认品种），前提变了这里先红。

use chrono::{Duration, Local, SecondsFormat};
use rusqlite::{params, Connection};
use serde_json::Value;

use banghe_lib::ledger::{build_ledger, build_party_rank, build_quality, build_staff_load};

fn db() -> Connection {
    banghe_lib::db::in_memory_migrated("0.1.0", banghe_lib::db::MIGRATIONS).expect("内存库应能跑完全部迁移脚本")
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn iso_now() -> String {
    Local::now().to_rfc3339_opts(SecondsFormat::Millis, false)
}

/// 区间参数：报表全部按 `business_date BETWEEN ? AND ?` 取数，测试一律用"今天前后各 10 天"
/// 这种一定覆盖到种子的宽区间，避免把区间边界和业务口径混在一个断言里。
fn wide() -> (String, String) {
    (
        (Local::now() - Duration::days(10)).format("%Y-%m-%d").to_string(),
        (Local::now() + Duration::days(10)).format("%Y-%m-%d").to_string(),
    )
}

fn new_party(conn: &Connection, name: &str, addr: Option<&str>) -> i64 {
    conn.execute(
        "INSERT INTO party (name, party_type, address, created_at, created_by) VALUES (?1, 'farmer', ?2, ?3, 1)",
        params![name, addr, iso_now()],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn new_user(conn: &Connection, username: &str, role: &str) -> i64 {
    conn.execute(
        "INSERT INTO user_account (username, display_name, password_hash, role, created_at)
         VALUES (?1, ?1, 'x', ?2, ?3)",
        params![username, role, iso_now()],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn variety_id(conn: &Connection, code: &str) -> i64 {
    conn.query_row("SELECT id FROM grain_variety WHERE code = ?1", params![code], |r| r.get(0)).unwrap()
}

/// 最小磅单。未提到的列走库默认值，所以 `settlement_weight_01kg` 等为 NULL 是有意的：
/// 台账必须能展示"已过皮但还没结算"的单（页面把它们渲染成 —，而不是冒充 0）。
struct Order<'a> {
    no: &'a str,
    party: i64,
    variety: i64,
    status: &'a str,
    business_date: String,
    net: Option<i64>,
    settle: Option<i64>,
    goods: Option<i64>,
    payable: Option<i64>,
    paid: i64,
    deduct: i64,
    tare: Option<i64>,
    grade: Option<&'a str>,
    weight_source: &'a str,
    weigher: Option<i64>,
    registrar: i64,
    /// 皮重偏差超容差的警示文案（非空即计入本单磅员的"超差"作业量；授权人列已废弃不再统计）
    override_reason: Option<&'a str>,
    /// 红冲单指向的原单。库里有 CHECK：`goods_amount_fen` 为负必须有 `reversed_order_id`
    reversed_of: Option<i64>,
    /// 作废时间。`build_staff_load` 照 mock 只算 `voided_at` 非空的作废单
    voided_at: Option<&'a str>,
}

impl<'a> Default for Order<'a> {
    fn default() -> Self {
        Self {
            no: "",
            party: 0,
            variety: 0,
            status: "settled",
            business_date: today(),
            net: None,
            settle: None,
            goods: None,
            payable: None,
            paid: 0,
            deduct: 0,
            tare: None,
            grade: None,
            weight_source: "scale",
            weigher: None,
            registrar: 1,
            override_reason: None,
            reversed_of: None,
            voided_at: None,
        }
    }
}

fn insert_order(conn: &Connection, o: Order<'_>) -> i64 {
    conn.execute(
        "INSERT INTO weigh_order (
            order_no, station_id, business_date, status, party_id, variety_id, grade,
            tare_weight_01kg, net_weight_01kg, deduct_total_01kg, settlement_weight_01kg,
            goods_amount_fen, payable_amount_fen, paid_amount_fen, weight_source,
            weigher_id, registered_by, tare_override_reason, reversed_order_id, voided_at,
            registered_at, created_at, created_by)
         VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20, 1)",
        params![
            o.no, o.business_date, o.status, o.party, o.variety, o.grade,
            o.tare, o.net, o.deduct, o.settle, o.goods, o.payable, o.paid, o.weight_source,
            o.weigher, o.registrar, o.override_reason, o.reversed_of, o.voided_at,
            iso_now(),
        ],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// 给单据挂一张化验单并填指标。`effective = false` 用来造"复检后首检降级"的样本。
fn attach_qc(conn: &Connection, order_id: i64, variety: i64, no: &str, decision: &str, effective: bool, indicators: &[(&str, i64, bool)]) {
    let now = iso_now();
    conn.execute(
        "INSERT INTO qc_report (report_no, order_id, variety_id, decision, test_method, is_effective, inspector_id, inspected_at, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, 'nir', ?5, 1, ?6, ?6, 1)",
        params![no, order_id, variety, decision, effective as i64, now],
    )
    .unwrap();
    let report_id = conn.last_insert_rowid();
    // moisture/impurity/unsound 三档基准存在品种档案里；over_std 由化验界面算好入库，
    // 报表读的是这个快照（见 ledger.rs 模块头的"同源"约定），所以这里显式传入。
    for (code, value, over) in indicators {
        conn.execute(
            "INSERT INTO qc_indicator (report_id, code, name, value_num, unit, over_std) VALUES (?1, ?2, ?2, ?3, '0.01pct', ?4)",
            params![report_id, code, value, *over as i64],
        )
        .unwrap();
    }
    conn.execute("UPDATE weigh_order SET qc_report_id = ?1 WHERE id = ?2", params![report_id, order_id]).unwrap();
}

fn insert_print_log(conn: &Connection, operator: i64, reprint: bool, on_date: &str) {
    conn.execute(
        "INSERT INTO print_log (doc_type, doc_id, doc_no, paper, printer_name, channel, is_reprint, result, printed_at, operator_id)
         VALUES ('weigh_order', 1, 'X', 'dot241', 'p', 'raw', ?1, 'success', ?2, ?3)",
        params![reprint as i64, format!("{on_date}T09:00:00.000+08:00"), operator],
    )
    .unwrap();
}

// =============================================================== 1. 键名契约

#[test]
fn json_keys_match_the_mock_types_verbatim() {
    let conn = db();
    let (from, to) = wide();
    // 三个视图都要有至少一行可断言，先造一张最小完成单（化验单交给下面的专项测试）
    let weigher = new_user(&conn, "键名磅员", "weigher");
    let party = new_party(&conn, "键名农户", None);
    let ym = variety_id(&conn, "YM");
    insert_order(
        &conn,
        Order { no: "K-1", party, variety: ym, net: Some(1), settle: Some(1), goods: Some(1), payable: Some(1), weight_source: "manual", weigher: Some(weigher), registrar: weigher, ..Default::default() },
    );

    let q = build_quality(&conn, &from, &to).unwrap();
    let v: Value = serde_json::to_value(&q).unwrap();
    // 外层驼峰、行内下划线：这套混写来自 src/mock/types.ts，页面按它取值，不许"顺手统一"
    for key in ["dateFrom", "dateTo", "byVariety", "gradeDist", "moistureBuckets"] {
        assert!(v.get(key).is_some(), "QualityReport 缺少前端约定的键 {key}");
    }
    assert!(v.get("date_from").is_none(), "外层不该再出现 snake_case 别名");
    let row = &v["byVariety"][0];
    for key in ["variety_name", "avg_moisture", "over_any", "net_01kg", "deduct_01kg"] {
        assert!(row.get(key).is_some(), "byVariety 行缺少键 {key}");
    }

    let ledger = build_ledger(&conn, &from, &to).unwrap();
    let v: Value = serde_json::to_value(&ledger[0]).unwrap();
    assert!(v["settled"].is_boolean(), "settled 必须是 JSON 布尔，页面按真值判断未结算");
    for key in ["id_card_no", "credit_amount_fen", "weight_source", "inspector_name", "seq"] {
        assert!(v.get(key).is_some(), "LedgerRow 缺少键 {key}");
    }

    let staff: Value = serde_json::to_value(build_staff_load(&conn, &from, &to).unwrap()).unwrap();
    let me = staff
        .as_array()
        .expect("staff 应是数组")
        .iter()
        .find(|r| r["user_id"].as_i64() == Some(weigher))
        .expect("经手过单据的岗位应出行");
    assert_eq!(me["role"].as_str().unwrap(), "weigher", "role 输出库里的枚举原值，前端 ROLE[role] 再映射中文");
    assert!(me["manual_ratio"].is_number(), "manual_ratio 是 0~1 的比率而不是百分数");
}

// ================================================ 2. 红冲参与、作废/拒收剔除

#[test]
fn ledger_keeps_redflush_pairs_and_numbers_rows_by_sequence() {
    let conn = db();
    let party = new_party(&conn, "张三", Some("某村一组"));
    let ym = variety_id(&conn, "YM");
    // 原单 + 红冲单（负值），两者都必须在台账里，合计互相抵消
    let original = insert_order(
        &conn,
        Order { no: "BD-1", party, variety: ym, net: Some(10000), settle: Some(10000), goods: Some(100_00), payable: Some(100_00), paid: 100_00, ..Default::default() },
    );
    insert_order(
        &conn,
        Order { no: "BD-2", party, variety: ym, net: Some(-10000), settle: Some(-10000), goods: Some(-100_00), payable: Some(-100_00), paid: -100_00, reversed_of: Some(original), ..Default::default() },
    );
    // 作废与拒收：不进台账（03 §4.3 不变式 4 的另一半）
    insert_order(&conn, Order { no: "BD-3", party, variety: ym, status: "voided", net: Some(5000), settle: Some(5000), ..Default::default() });
    insert_order(&conn, Order { no: "BD-4", party, variety: ym, status: "rejected", ..Default::default() });

    let (from, to) = wide();
    let rows = build_ledger(&conn, &from, &to).unwrap();
    let nos: Vec<&str> = rows.iter().map(|r| r.order_no.as_str()).collect();
    assert_eq!(nos, ["BD-1", "BD-2"], "作废与拒收不该出现在台账里");
    assert_eq!(rows.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2], "seq 要连续编号，报送台账用行号");
    assert_eq!(rows.iter().map(|r| r.net_weight_01kg.unwrap()).sum::<i64>(), 0, "红冲对必须互相抵消，合计为 0 才是真实净收购量");
    assert_eq!(rows.iter().map(|r| r.credit_amount_fen).sum::<i64>(), 0);
    assert_eq!(rows[0].address, "某村一组");
}

#[test]
fn ledger_shows_unsettled_order_with_null_amounts_instead_of_zero() {
    let conn = db();
    let party = new_party(&conn, "李四", None);
    let ym = variety_id(&conn, "YM");
    // 只过了毛重、还没结算：金额列必须保持 NULL，页面才会渲染成 — 而不是冒充 0 元
    insert_order(&conn, Order { no: "BD-OPEN", party, variety: ym, status: "tare_weighed", net: Some(8000), ..Default::default() });

    let (from, to) = wide();
    let rows = build_ledger(&conn, &from, &to).unwrap();
    assert_eq!(rows.len(), 1);
    let r = &rows[0];
    assert_eq!(r.settlement_weight_01kg, None);
    assert_eq!(r.goods_amount_fen, None);
    assert_eq!(r.payable_amount_fen, None);
    assert_eq!(r.credit_amount_fen, 0, "未结算的挂账按 0 输出，与 mock 的 (payable ?? 0) - paid 同式");
    assert!(!r.settled);
    assert_eq!(r.address, "", "住址为空要输出空串，页面直接渲染不该拿到 null");
}

// ==================================================== 3. 质量分析的两套分母

#[test]
fn quality_uses_two_denominators_and_dedupes_over_any() {
    let conn = db();
    let party = new_party(&conn, "王五", None);
    let xm = variety_id(&conn, "XM");

    // 样本 1：水分、杂质同时超基准 → over_any 只该 +1（拿两个计数相加就会让问题率超 100%）
    let a = insert_order(
        &conn,
        Order { no: "Q-1", party, variety: xm, net: Some(10000), settle: Some(9000), deduct: 1000, goods: Some(1), payable: Some(1), grade: Some("一等"), ..Default::default() },
    );
    attach_qc(&conn, a, xm, "QC-1", "accept", true, &[("moisture", 1600, true), ("impurity", 200, true), ("unsound", 50, false)]);

    // 样本 2：全部合格
    let b = insert_order(
        &conn,
        Order { no: "Q-2", party, variety: xm, net: Some(10000), settle: Some(10000), goods: Some(1), payable: Some(1), grade: Some("一等"), ..Default::default() },
    );
    attach_qc(&conn, b, xm, "QC-2", "accept", true, &[("moisture", 1200, false), ("impurity", 50, false), ("unsound", 40, false)]);

    // 样本 3：化验单已失效（复检取代首检）→ 进 orders 分母，不进 samples
    let c = insert_order(
        &conn,
        Order { no: "Q-3", party, variety: xm, net: Some(1000), settle: Some(1000), goods: Some(1), payable: Some(1), ..Default::default() },
    );
    attach_qc(&conn, c, xm, "QC-3", "accept", false, &[("moisture", 9000, true)]);

    // 拒收单：进 orders 与 reject，不进汇总。
    // 注意它**必须带化验单**才数得到——mock 的 `list` 与本表 JOIN 都要求
    // `qc_report_id IS NOT NULL`，所以"没化验就被赶走的单"两边都不计，这是同源而非疏漏。
    let d = insert_order(&conn, Order { no: "Q-4", party, variety: xm, status: "rejected", ..Default::default() });
    attach_qc(&conn, d, xm, "QC-4", "reject", true, &[("moisture", 9999, true), ("impurity", 10, false), ("unsound", 10, false)]);

    let (from, to) = wide();
    let q = build_quality(&conn, &from, &to).unwrap();
    let row = q.by_variety.iter().find(|r| r.variety_code == "XM").expect("小麦应有汇总行");
    assert_eq!(row.orders, 4, "orders 分母含拒收与失效化验单");
    assert_eq!(row.samples, 3, "samples 只算生效化验单");
    assert_eq!(row.reject, 1);
    assert_eq!(row.over_moisture, 2);
    assert_eq!(row.over_impurity, 1);
    assert_eq!(row.over_any, 2, "同一单既超水又超杂只计一次");
    // 生效样本的平均水分 = round((1600 + 1200 + 9999) / 3) = 4266；失效那张的 9000 不许混进来
    assert_eq!(row.avg_moisture, Some(4266));
    // 扣量率分子分母都只走参与汇总的完成单：拒收那张（净重 NULL）不影响 21000 / 1000
    assert_eq!(row.net_01kg, 21000);
    assert_eq!(row.deduct_01kg, 1000);

    // 等级分布与水分分箱各按自己的口径出数，页面图例直接取用
    let dist = q.grade_dist.iter().find(|g| g.variety_name.contains("小麦")).expect("等级分布应有小麦行");
    assert_eq!(dist.grades.iter().find(|g| g.grade == "一等").unwrap().count, 2);
    assert_eq!(q.moisture_buckets.len(), 5);
    assert_eq!(q.moisture_buckets.iter().map(|b| b.count).sum::<i64>(), 4, "分箱按单据当前挂的化验单统计（含失效那张）");
}

#[test]
fn quality_emits_a_zero_row_for_every_variety_in_the_archive() {
    let conn = db();
    let (from, to) = wide();
    let q = build_quality(&conn, &from, &to).unwrap();
    // 品种全集跟着档案走：一单没有也要占一行 0，页面的柱状图才不缺柱（与看板同源）
    assert_eq!(q.by_variety.len(), 4);
    assert!(q.by_variety.iter().all(|r| r.orders == 0 && r.samples == 0));
    assert!(q.by_variety.iter().all(|r| r.avg_moisture.is_none()), "无样本要输出 null，不能让页面把 0% 当成测过");
    assert!(q.moisture_buckets.iter().all(|b| b.count == 0));
}

// ==================================== 4. 排行的一行两口径与全历史皮重

#[test]
fn party_rank_separates_activity_from_totals_and_keeps_full_history_tare() {
    let conn = db();
    let (from, to) = wide();
    let party = new_party(&conn, "赵六", None);
    let ym = variety_id(&conn, "YM");
    // 完成单：进四个金额列（放在区间早端，好让"最近交粮"由下面那张未完成的单决定）
    insert_order(
        &conn,
        Order { no: "P-1", party, variety: ym, business_date: from.clone(), net: Some(10000), settle: Some(10000), goods: Some(200_00), payable: Some(200_00), paid: 50_00, tare: Some(2000), ..Default::default() },
    );
    // 未完成的单（settlement_weight 为空）：不进金额，但算"最近交粮"的依据
    insert_order(&conn, Order { no: "P-2", party, variety: ym, status: "registered", tare: Some(4000), ..Default::default() });
    // 作废单：既不进金额也不进 last_date
    insert_order(&conn, Order { no: "P-3", party, variety: ym, status: "voided", net: Some(1), settle: Some(1), business_date: today(), ..Default::default() });
    // 区间外的历史皮重：avg_tare 要包含它，这是"下次卸货偏差预判"的用途
    insert_order(
        &conn,
        Order { no: "P-0", party, variety: ym, net: Some(9), settle: Some(9), tare: Some(6000), business_date: "2020-01-01".to_string(), ..Default::default() },
    );

    let rows = build_party_rank(&conn, &from, &to).unwrap();
    assert_eq!(rows.len(), 1);
    let r = &rows[0];
    assert_eq!(r.orders, 1, "只有完成单参与经手计数");
    assert_eq!((r.net_01kg, r.goods_fen, r.paid_fen, r.credit_fen), (10000, 200_00, 50_00, 150_00));
    assert_eq!(r.last_date, today(), "最近交粮由未完成的单决定（作废那张也是今天，但不该算）");
    assert_eq!(r.avg_tare_01kg, Some(4000), "全历史皮重均值 = round((2000+4000+6000)/3)，不受查询区间影响");
}

#[test]
fn party_rank_sorted_by_net_weight_descending() {
    let conn = db();
    let (from, to) = wide();
    let ym = variety_id(&conn, "YM");
    let big = new_party(&conn, "大户", None);
    let small = new_party(&conn, "散户", None);
    insert_order(&conn, Order { no: "S-1", party: small, variety: ym, net: Some(1000), settle: Some(1000), ..Default::default() });
    insert_order(&conn, Order { no: "B-1", party: big, variety: ym, net: Some(9000), settle: Some(9000), ..Default::default() });
    let rows = build_party_rank(&conn, &from, &to).unwrap();
    assert_eq!(rows.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), ["大户", "散户"], "排行默认按净重倒序");
}

// ============================== 5. 作业量：同一单两人各计一次 + 超容差/补打归属

#[test]
fn staff_load_counts_one_order_for_both_weigher_and_registrar() {
    let conn = db();
    let (from, to) = wide();
    let weigher = new_user(&conn, "磅员甲", "weigher");
    let registrar = new_user(&conn, "登记乙", "registrar");
    let party = new_party(&conn, "孙七", None);
    let ym = variety_id(&conn, "YM");

    insert_order(
        &conn,
        Order {
            no: "W-1",
            party,
            variety: ym,
            net: Some(1),
            settle: Some(1),
            weigher: Some(weigher),
            registrar,
            weight_source: "manual",
            override_reason: Some("实测皮重偏差超容差"),
            ..Default::default()
        },
    );
    insert_print_log(&conn, weigher, true, &today());
    insert_print_log(&conn, weigher, false, &today()); // 首打不算补打
    insert_print_log(&conn, weigher, true, "2020-01-01"); // 区间外的补打不算

    let rows = build_staff_load(&conn, &from, &to).unwrap();
    let total: i64 = rows.iter().map(|r| r.orders).sum();
    assert_eq!(rows.len(), 2, "无经手单的用户不出行");
    assert_eq!(total, 2, "同一单磅员与登记员各计一次，合计必大于实际单数");

    let w = rows.iter().find(|r| r.user_id == weigher).unwrap();
    assert_eq!((w.orders, w.manual_count, w.void_count), (1, 1, 0));
    assert_eq!(w.manual_ratio, 1.0);
    assert_eq!(w.reprint_count, 1, "只算区间内的补打");
    assert_eq!(w.override_count, 1, "皮重超容差计入捕获该皮重的磅员（不再归授权人）");

    let g = rows.iter().find(|r| r.user_id == registrar).unwrap();
    assert_eq!((g.orders, g.manual_count, g.override_count), (1, 1, 0), "手录占比按经手单数算，登记员也看得到手录单；超容差不再挂登记员");
}

#[test]
fn staff_load_counts_voids_for_the_registrar_only() {
    let conn = db();
    let (from, to) = wide();
    let weigher = new_user(&conn, "磅员丙", "weigher");
    let registrar = new_user(&conn, "登记丁", "registrar");
    let party = new_party(&conn, "周八", None);
    let ym = variety_id(&conn, "YM");
    let voided_at = today();
    insert_order(
        &conn,
        Order { no: "V-1", party, variety: ym, status: "voided", voided_at: Some(&voided_at), weigher: Some(weigher), registrar, ..Default::default() },
    );
    let rows = build_staff_load(&conn, &from, &to).unwrap();
    let g = rows.iter().find(|r| r.user_id == registrar).unwrap();
    assert_eq!(g.void_count, 1, "作废记在登记员头上");
    assert_eq!(g.orders, 1, "作废单仍然进经手单数：台账要能看出这个人今天废过单");
    let w = rows.iter().find(|r| r.user_id == weigher).unwrap();
    assert_eq!(w.void_count, 0, "过磅人不为别人的作废担数");
}
