//! 付款流水读的行为守卫（05 §3 /payments；03 §9.18 payment_record）
//!
//! 这页是"半真半假"过得最久的一页：挂账账龄读库、流水读 mock，页头上的两个数来自两个世界。
//! 这里钉住五件事：
//!  1. **读出来 = 写进去**：`orders::settle(pay_now)` 与 `settlements::record_payment`
//!     落的 `pay_no` / `payee_name` / `operator_id` / `remark` 必须原样回到 DTO 里，
//!     且序列化字段集与 `src/mock/types.ts` 的 `PaymentRecord` 逐字一致——
//!     **`account_enc`（银行账号密文）不许出现在任何键里**。
//!  2. **两种挂账的 JOIN**：挂结算单的取 `settlement.settle_no` + `settlement.party_id`，
//!     只挂磅单的（§9.18 允许不合并时直接付款）回退 `weigh_order.order_no` → `party.name`。
//!  3. **冲销**：列表原样带回 `reversed=1` 让页面标"已冲销"，分布里一分都不算。
//!  4. **日期**：`substr(paid_at,1,10)` 闭区间（与 mock 的 slice 比较同句）；空 = 这一头不限；
//!     非法格式中文短句拒绝。行序是登记顺序（`pr.id`），不跟 `paid_at` 走。
//!  5. **分布的稳定性**：同一份数据两次调用一字不差，渠道配色跟着 method 而不是跟着名次
//!     （mock 的 `tones[i % 5]` 正是"换个区间就改色"的那处假随机）；撞服务端上限时拒绝而非静默截断。
//!
//! 造数据一律走 `orders.rs` / `settlements.rs` 的公开写入函数，只有真实写入路径覆盖不到的
//! 两件事（按单直付、冲销位、指定付款日）才直接 INSERT——不复制第二份建表脚本。
//! 固定日期用 2024-11，与"今天"（种子与写入路径都落当天）彻底错开，断言才不被运行日期牵连。

use banghe_lib::auth::AuthProfile;
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::orders::{capture, create_order, save_party, settle, CaptureInput, CreateOrderInput, PartySaveInput, SettleInput};
use banghe_lib::payments::{list_payments, method_dist};
use banghe_lib::settlements::{record_payment, RecordPaymentInput};
use rusqlite::{params, Connection};

fn db() -> Connection {
    let conn = in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本");
    // 「制单必须绑卡」默认开着，闸门本身由 orders_contract 专测；这套用例测付款，不替每张单造卡
    conn.execute("UPDATE app_setting SET value_json = 'false' WHERE key = 'card_required_on_create'", [])
        .unwrap();
    conn
}

fn actor(id: i64, role: &str) -> AuthProfile {
    AuthProfile { id, username: format!("u{id}"), display_name: format!("测试{id}"), role: role.into(), must_change_pwd: false }
}

/// 迁移种子里唯一的可用账号（id=1）；operator_id / created_by 的外键都指向它
fn admin() -> AuthProfile {
    actor(1, "cashier")
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn new_party(conn: &Connection, name: &str, idc: &str) -> i64 {
    save_party(
        conn,
        &admin(),
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

fn wheat(conn: &Connection) -> i64 {
    conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap()
}

/// 制单 + 毛重 + 皮重，停在可结算状态。净重 100000（0.1kg）= 10 t
fn open_order(conn: &Connection, party: i64, variety: i64) -> String {
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
            &admin(),
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
                photo_b64: None,
            },
        )
        .unwrap()
        .expect("单应存在");
    }
    no
}

/// 结算一张单；`pay_now` 决定走不走工作台的「当场结清」写入路径。
/// 10 t × 240000 分/吨 = 2 400 000 分。
fn settle_order(conn: &Connection, order_no: &str, pay_now: bool) -> (i64, String) {
    let r = settle(
        conn,
        &admin(),
        SettleInput {
            order_no: order_no.into(),
            price_fen_per_ton: 240000,
            package_deduct_01kg: 0,
            moisture_deduct_01kg: 0,
            impurity_deduct_01kg: 0,
            other_deduct_01kg: 0,
            deduction_fee_fen: 0,
            pay_now,
            paid_amount_fen: None,
            payment_method: "cash".into(),
            settler_id: None,
            price_list_id: None,
            price_override_reason: Some("测试改价事由".into()),
            party_signed: Some(true),
            grade: None,
        },
    )
    .unwrap()
    .expect("应可结算");
    (r.settlement.id, r.settlement.settle_no)
}

/// 走完 制单 → 称重 → 当场结清，返回 (settlement_id, settle_no, pay_no)
fn paid_settlement(conn: &Connection, party: i64) -> (i64, String, String) {
    let order = open_order(conn, party, wheat(conn));
    let (id, no) = settle_order(conn, &order, true);
    let pay_no: String = conn
        .query_row("SELECT pay_no FROM payment_record WHERE settlement_id = ?1", params![id], |r| r.get(0))
        .unwrap();
    (id, no, pay_no)
}

#[allow(clippy::too_many_arguments)]
fn insert_payment(conn: &Connection, pay_no: &str, settlement_id: Option<i64>, order_id: Option<i64>, amount_fen: i64, method: &str, day: &str, reversed: i64) {
    let paid_at = format!("{day}T08:00:00.000+08:00");
    conn.execute(
        "INSERT INTO payment_record (pay_no, settlement_id, order_id, amount_fen, method, paid_at, operator_id, reversed, created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?6, 1)",
        params![pay_no, settlement_id, order_id, amount_fen, method, paid_at, reversed],
    )
    .unwrap();
}

fn order_id_of(conn: &Connection, no: &str) -> i64 {
    conn.query_row("SELECT id FROM weigh_order WHERE order_no = ?1", params![no], |r| r.get(0)).unwrap()
}

#[test]
fn list_reads_back_what_the_write_paths_produced() {
    let conn = db();
    let party = new_party(&conn, "张三", "341204199301272015");
    let (stl_a, no_a, pay_no_a) = paid_settlement(&conn, party);

    // 第二张留挂账，再由出纳补录一笔银行转账：两条写入路径都要被同一份读接回来
    let order_b = open_order(&conn, party, wheat(&conn));
    let (stl_b, no_b) = settle_order(&conn, &order_b, false);
    record_payment(
        &conn,
        &admin(),
        RecordPaymentInput { settle_no: no_b.clone(), amount_fen: 400_000, method: "bank".into(), trade_no: Some("BIO-9".into()), operator_id: None },
    )
    .unwrap()
    .expect("结算单应在");

    let rows = list_payments(&conn, &today(), &today()).unwrap();
    assert_eq!(rows.len(), 2, "当场结清 + 补录各一笔");
    assert_eq!(rows[0].pay_no, pay_no_a, "行序即登记顺序（与 mock 的数组给序同向）");
    assert_eq!(rows[0].settlement_id, Some(stl_a));
    assert_eq!(rows[0].settle_no.as_deref(), Some(no_a.as_str()));
    assert_eq!(rows[0].order_id, None, "两条写入路径都只挂结算单");
    assert_eq!(rows[0].order_no, None);
    assert_eq!((rows[0].party_id, rows[0].party_name.as_str()), (party, "张三"));
    assert_eq!(rows[0].amount_fen, 2_400_000);
    assert_eq!(rows[0].method, "cash");
    assert_eq!(rows[0].trade_no, None);
    assert_eq!(rows[0].payee_name, "张三", "payee_name 与写入时的 COALESCE(s.payee_name, p.name) 同口径");
    assert_eq!(rows[0].operator_id, 1, "经手人以写入时的会话为准");
    assert_eq!(rows[0].remark.as_deref(), Some("当场结清"));
    assert_eq!(rows[0].reversed, 0);
    assert!(rows[0].paid_at.starts_with(&today()));

    assert_eq!(rows[1].settlement_id, Some(stl_b), "补录的那笔挂在第二张结算单上");
    assert_eq!(rows[1].settle_no.as_deref(), Some(no_b.as_str()));
    assert_eq!(rows[1].amount_fen, 400_000);
    assert_eq!(rows[1].method, "bank");
    assert_eq!(rows[1].trade_no.as_deref(), Some("BIO-9"));
    assert_eq!(rows[1].payee_name, "张三");
    assert_eq!(rows[1].remark, None, "补录不顺手写备注");

    // 银行账号密文绝不外流：塞一行 account_enc，序列化后不许多出一个键
    conn.execute("UPDATE payment_record SET account_enc = ?1 WHERE id = ?2", params![vec![7u8, 8, 9], rows[1].id]).unwrap();
    let json = serde_json::to_value(list_payments(&conn, "", "").unwrap()).unwrap();
    let keys: Vec<String> = json.as_array().unwrap()[0].as_object().unwrap().keys().cloned().collect();
    // serde_json 的键按字典序出，所以比的是字段名集合（顺序对 TS 消费方无意义）
    let mut want = vec![
        "id", "pay_no", "settlement_id", "settle_no", "order_id", "order_no", "party_id", "party_name", "amount_fen", "method", "trade_no", "payee_name",
        "paid_at", "operator_id", "voucher_no", "reversed", "remark",
    ];
    want.sort();
    assert_eq!(keys, want, "字段名与 src/mock/types.ts 的 PaymentRecord 逐字一致");
    assert!(!keys.iter().any(|k| k.contains("account")), "银行账号密文不得经这条读路径出门");
}

#[test]
fn order_only_payment_falls_back_to_weigh_order_and_party() {
    let conn = db();
    let party = new_party(&conn, "李四", "341204199301272016");
    let order = open_order(&conn, party, wheat(&conn));
    let oid = order_id_of(&conn, &order);
    insert_payment(&conn, "FK01DIRECT01", None, Some(oid), 123_400, "wechat", "2024-11-05", 0);

    let rows = list_payments(&conn, "", "").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].settle_no, None, "没挂结算单就没有结算单号，页面该显示磅单号");
    assert_eq!(rows[0].order_no.as_deref(), Some(order.as_str()));
    assert_eq!((rows[0].party_id, rows[0].party_name.as_str()), (party, "李四"), "收款人经 weigh_order.party_id 回退");
    assert_eq!(rows[0].payee_name, "李四", "payee_name 为空时回退售粮人名，不留空串");
    assert_eq!(rows[0].amount_fen, 123_400);
}

#[test]
fn reversed_stays_in_list_and_leaves_dist() {
    let conn = db();
    let party = new_party(&conn, "王五", "341204199301272017");
    let (stl, _, _) = paid_settlement(&conn, party);
    insert_payment(&conn, "FK01VOIDED1", Some(stl), None, 500_000, "cash", "2024-11-06", 1);
    insert_payment(&conn, "FK01GOOD001", Some(stl), None, 700_000, "alipay", "2024-11-06", 0);

    let rows = list_payments(&conn, "2024-01-01", "").unwrap();
    assert_eq!(rows.len(), 3, "冲销行照样进列表（页面自己标状态、合计里剔掉）");
    assert_eq!(rows.iter().filter(|p| p.reversed == 1).count(), 1);

    let dist = method_dist(&conn, "2024-01-01", "").unwrap();
    assert_eq!(dist.iter().find(|d| d.label == "现金").unwrap().fen, 2_400_000, "冲销的 50 万现金一分不进分布");
    assert_eq!(dist.iter().map(|d| d.fen).sum::<i64>(), rows.iter().filter(|p| p.reversed == 0).map(|p| p.amount_fen).sum::<i64>());
    assert_eq!(dist[0].label, "现金", "按金额倒序");
}

#[test]
fn date_window_is_closed_and_blank_bound_is_open() {
    let conn = db();
    let party = new_party(&conn, "赵六", "341204199301272018");
    let (stl, _, pay_today) = paid_settlement(&conn, party);
    for (d, no) in [("2024-11-01", "FK01D0001"), ("2024-11-02", "FK01D0002"), ("2024-11-03", "FK01D0003")] {
        insert_payment(&conn, no, Some(stl), None, 100_000, "cash", d, 0);
    }
    // 后登记但付款日更早：行序认登记顺序，不跟着 paid_at 重排（mock 的数组序同此）
    insert_payment(&conn, "FK01D0004", Some(stl), None, 100_000, "cash", "2024-10-01", 0);

    let within = |from: &str, to: &str| list_payments(&conn, from, to).unwrap().into_iter().map(|p| p.pay_no).collect::<Vec<_>>();
    assert_eq!(within("2024-11-01", "2024-11-01"), vec!["FK01D0001"], "起始日当天要收到（闭区间）");
    assert_eq!(within("2024-11-01", "2024-11-02"), vec!["FK01D0001", "FK01D0002"], "截止日当天要收到（闭区间）");
    assert_eq!(within("2024-11-02", "2024-11-02"), vec!["FK01D0002"]);
    assert_eq!(within("2024-01-01", "2024-11-03"), vec!["FK01D0001", "FK01D0002", "FK01D0003", "FK01D0004"]);
    assert_eq!(
        within("", ""),
        vec![pay_today.as_str(), "FK01D0001", "FK01D0002", "FK01D0003", "FK01D0004"],
        "两头都空 = 全不限；今天的当场结清排最前、付款日最早的 D0004 排最后 ⇒ 行序认登记顺序"
    );
    assert_eq!(within("2024-11-02", ""), vec![pay_today.as_str(), "FK01D0002", "FK01D0003"], "只填一头时另一头不设界（mock 传 \"\" 会整表空掉）");
    assert_eq!(within("", "2024-11-02"), vec!["FK01D0001", "FK01D0002", "FK01D0004"]);
    assert_eq!(within("2024-11-04", "2024-11-05"), Vec::<String>::new(), "窗口外为空，但不是错误");
    assert_eq!(within("2024-11-03", "2024-11-01"), Vec::<String>::new(), "起始日晚于截止日：照 mock 给空表");
    assert_eq!(method_dist(&conn, "2024-11-01", "2024-11-01").unwrap().iter().map(|d| d.fen).sum::<i64>(), 100_000, "分布同一条日期口径");
}

#[test]
fn bad_date_is_rejected_in_chinese() {
    let conn = db();
    for (from, to, which) in [("2024/11/01", "", "起始日"), ("", "2024-11-1", "截止日"), ("2024-02-30", "", "起始日")] {
        let e = list_payments(&conn, from, to).unwrap_err();
        assert!(e.contains(which) && e.contains("YYYY-MM-DD"), "{e}");
        let e2 = method_dist(&conn, from, to).unwrap_err();
        assert!(e2.contains(which) && e2.contains("YYYY-MM-DD"), "{e2}");
    }
    assert!(list_payments(&conn, "  ", &today()).is_ok(), "全空白等同没填");
}

#[test]
fn dist_tone_follows_channel_not_rank_and_is_repeatable() {
    let conn = db();
    let party = new_party(&conn, "孙七", "341204199301272019");
    let (stl, _, _) = paid_settlement(&conn, party);
    insert_payment(&conn, "FK01CASH001", Some(stl), None, 10_000, "cash", "2024-11-08", 0);
    insert_payment(&conn, "FK01ALIPY01", Some(stl), None, 90_000, "alipay", "2024-11-08", 0);
    insert_payment(&conn, "FK01CREDIT1", Some(stl), None, 20_000, "credit_writeoff", "2024-11-08", 0);

    // 现金在这个窗口排第三、放宽到整月还是第三；换任何窗口都不许改色（mock 按名次轮转就会）
    let narrow = method_dist(&conn, "2024-11-08", "2024-11-08").unwrap();
    let wide = method_dist(&conn, "2024-11-01", "2024-11-30").unwrap();
    assert_eq!(wide, narrow, "上限换月但数据没变 ⇒ 结果一字不差");
    assert_eq!(narrow.len(), 3);
    let tone_of = |label: &str| narrow.iter().find(|d| d.label == label).map(|d| d.tone);
    assert_eq!(tone_of("支付宝"), Some("warning"));
    assert_eq!(tone_of("现金"), Some("success"));
    assert_eq!(tone_of("挂账核销"), Some("neutral"));
    assert_eq!(narrow.iter().map(|d| d.fen).collect::<Vec<_>>(), vec![90_000, 20_000, 10_000], "金额倒序");
    assert_eq!(method_dist(&conn, "", "2024-11-30").unwrap(), narrow, "同一份数据两次调用一致");
    for d in &narrow {
        assert!(matches!(d.tone, "neutral" | "info" | "success" | "warning" | "danger"), "Tone 取值非法：{}", d.tone);
    }
    assert_eq!(narrow.iter().map(|d| d.label.as_str()).collect::<Vec<_>>(), vec!["支付宝", "挂账核销", "现金"]);
}

#[test]
fn over_limit_range_is_refused_not_truncated() {
    let conn = db();
    let party = new_party(&conn, "周八", "341204199301272023");
    let (stl, _, _) = paid_settlement(&conn, party);
    // 半截清单会让页头"期间付款额"算出一个看起来正确的错数，所以撞上限是拒绝而不是截断
    conn.execute(
        "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2001)
         INSERT INTO payment_record (pay_no, settlement_id, order_id, amount_fen, method, paid_at, operator_id, reversed, created_at, created_by)
         SELECT printf('FKBULK%07d', i), ?1, NULL, 100, 'cash', '2024-11-09T08:00:00.000+08:00', 1, 0, '2024-11-09T08:00:00.000+08:00', 1 FROM n",
        params![stl],
    )
    .unwrap();

    let e = list_payments(&conn, "2024-11-09", "2024-11-09").unwrap_err();
    assert!(e.contains("2000") && e.contains("缩短日期区间"), "{e}");
    assert!(list_payments(&conn, "2024-11-08", "2024-11-08").unwrap().is_empty(), "窗口收窄后照常给");
    // 分布在服务端聚合，行数与区间无关，不受上限牵连
    assert_eq!(method_dist(&conn, "2024-11-09", "2024-11-09").unwrap().iter().map(|d| d.fen).sum::<i64>(), 200_100);
}
