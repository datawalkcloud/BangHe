//! 全局检索（05 §5 顶栏 Ctrl/Alt+K）的行为守卫
//!
//! 这个搜索框接真库后才有的错，全部在这里钉住：
//!  1. **空关键词不查库**：搜索框每次按键都打一次，空串必须直接回三空
//!     （用一条没跑迁移的裸库连接证明"真的没查"——任何 SELECT 都会 no such table）。
//!  2. **四条命中口径**：单号 / 姓名 / 车牌 直接包含，**证号只看后 4 位**
//!     （拿出生年 1993 搜到别人的单是误命中）；手机号只算档案命中，不算磅单命中。
//!  3. **LIKE 转义**：`%` 与 `_` 当字面量，不能把整表捞出来，也不能反过来漏掉
//!     真含 `%` 的那条。
//!  4. **上限 8 / 6 / 6 在 SQL 里截**，排序：磅单业务日 + 单号倒序、售粮人姓名命中优先。
//!  5. **序列化出来的磅单行就是 OrderRow**：records / photos / prints / timeline 四个键
//!     整字段缺席，页面拿到的一直是"列表形状"。
//!
//! 造数据全部复用 orders.rs 的公开写入函数（save_party / create_order / capture / settle），
//! 不手写 INSERT 复制一份业务规则；user_account 行同 settlements_contract 的 ensure_users。

use rusqlite::{params, Connection};

use banghe_lib::auth::AuthProfile;
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::orders::{capture, create_order, save_party, settle, CaptureInput, CreateOrderInput, PartySaveInput, SettleInput};
use banghe_lib::search::{global_search, SearchResult};

fn db() -> Connection {
    let conn = in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本");
    // 「制单必须绑卡」默认开着，闸门本身由 orders_contract 专测；这套用例测检索，不替每张单造卡
    conn.execute("UPDATE app_setting SET value_json = 'false' WHERE key = 'card_required_on_create'", [])
        .unwrap();
    conn
}

fn actor(id: i64, role: &str) -> AuthProfile {
    AuthProfile { id, username: format!("u{id}"), display_name: format!("测试{id}"), role: role.into(), must_change_pwd: false }
}

/// 磅员 / 化验员 / 出纳（id 依序 2/3/4）：外键要求 user_account 有真实行
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

fn wheat(conn: &Connection) -> i64 {
    conn.query_row("SELECT id FROM grain_variety WHERE code='XM'", [], |r| r.get(0)).unwrap()
}

fn party(conn: &Connection, name: &str, idc: &str, phone: Option<&str>) -> i64 {
    save_party(
        conn,
        &actor(1, "station_master"),
        PartySaveInput {
            id: None,
            name: Some(name.into()),
            party_type: Some("farmer".into()),
            id_card_no: Some(idc.into()),
            phone: phone.map(str::to_string),
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

fn new_party(conn: &Connection, name: &str, idc: &str) -> i64 {
    party(conn, name, idc, None)
}

/// 软删一条档案（真库独有的 deleted_at，用来守"检索不返回死链"）
fn soft_delete(conn: &Connection, id: i64) {
    conn.execute("UPDATE party SET deleted_at = '2026-01-02T00:00:00.000+08:00' WHERE id = ?1", params![id]).unwrap();
}

/// 制单 + 毛/皮双称，停在 to_settle；车牌可空
fn weighed_order(conn: &Connection, party_id: i64, variety: i64, vehicle_no: Option<&str>) -> String {
    let no = create_order(
        conn,
        &actor(1, "weigher"),
        CreateOrderInput {
            party_id,
            variety_id: Some(variety),
            vehicle_no: vehicle_no.map(str::to_string),
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
                frames: Vec::new(),
            },
        )
        .unwrap()
        .expect("单应存在");
    }
    no
}

/// 走完 制单 → 双称 → 结算（pay_now=false 留挂账），返回 (单号, 结算单号)
fn settled_order(conn: &Connection, party_id: i64, variety: i64, price: i64) -> (String, String) {
    let no = weighed_order(conn, party_id, variety, None);
    let r = settle(
        conn,
        &actor(4, "cashier"),
        SettleInput {
            order_no: no.clone(),
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
            price_list_id: Some(price),
            price_override_reason: None,
            party_signed: Some(true),
            grade: None,
        },
    )
    .unwrap()
    .expect("应可结算");
    (no, r.settlement.settle_no)
}

fn seed_price(conn: &Connection, variety: i64) -> i64 {
    conn.execute(
        "INSERT INTO price_list (variety_id, grade, price_fen_per_ton, effective_from, effective_to, basis, made_by, created_at, created_by)
         VALUES (?1, '一等', 240000, '2026-01-01', '9999-12-31', '测试定价', 1, '2026-01-01T00:00:00.000+08:00', 1)",
        params![variety],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn names(rows: &[banghe_lib::orders::Party]) -> Vec<String> {
    rows.iter().map(|p| p.name.clone()).collect()
}

fn order_nos(rows: &[banghe_lib::orders::WeighOrder]) -> Vec<String> {
    rows.iter().map(|o| o.order_no.clone()).collect()
}

// ------------------------------------------------------------------ 空关键词

#[test]
fn blank_keyword_returns_three_empty_groups_without_touching_the_database() {
    // 故意用一条**没跑迁移**的连接：任何 SELECT 都会以 "no such table" 失败。
    // 这里能 Ok 回三空，就说明确实一行都没查（与 mock 的早退同口径）。
    let bare = Connection::open_in_memory().expect("裸内存库");
    for kw in ["", "   ", "\t\n  \r"] {
        let r = global_search(&bare, kw).expect("空关键词不该碰库");
        assert!(r.orders.is_empty() && r.parties.is_empty() && r.settlements.is_empty(), "{kw:?} 应回三空");
    }

    // 有数据的库上同样不查：结果恒空，而不是把全表端出来
    let conn = db();
    ensure_users(&conn);
    let xm = wheat(&conn);
    let a = new_party(&conn, "张三", "341204199301272015");
    weighed_order(&conn, a, xm, Some("豫A12345"));
    let r = global_search(&conn, "  ").unwrap();
    assert!(r.orders.is_empty() && r.parties.is_empty() && r.settlements.is_empty());
}

// ---------------------------------------------------------------- 四条命中口径

#[test]
fn order_hits_cover_no_name_vehicle_and_last_four_id_digits() {
    let conn = db();
    ensure_users(&conn);
    let xm = wheat(&conn);
    let a = party(&conn, "张三", "341204199301272015", Some("13800001111"));
    let no = weighed_order(&conn, a, xm, Some("豫A12345"));

    for kw in [no.as_str(), "张三", "2015", "201", "豫A12345", "a123"] {
        let r = global_search(&conn, kw).unwrap();
        assert_eq!(order_nos(&r.orders), vec![no.clone()], "关键词 {kw:?} 应命中这张单");
    }

    // 后 4 位是"取尾再比"：出生年 1993 在证号中间，不该命中磅单，只命中档案
    let by_mid = global_search(&conn, "1993").unwrap();
    assert!(by_mid.orders.is_empty(), "证号中段不得命中磅单");
    assert_eq!(names(&by_mid.parties), vec!["张三".to_string()]);

    // 手机号只算档案海堆（mock 的磅单串里也没拼 phone）
    let by_phone = global_search(&conn, "1380000").unwrap();
    assert!(by_phone.orders.is_empty() && by_phone.settlements.is_empty());
    assert_eq!(names(&by_phone.parties), vec!["张三".to_string()]);

    // 查无此词：三空，不是 Err
    let none = global_search(&conn, "查无此词").unwrap();
    assert!(none.orders.is_empty() && none.parties.is_empty() && none.settlements.is_empty());
}

#[test]
fn soft_deleted_party_leaves_the_results() {
    let conn = db();
    ensure_users(&conn);
    let xm = wheat(&conn);
    let a = new_party(&conn, "删除户", "341204199301272016");
    weighed_order(&conn, a, xm, None);
    soft_delete(&conn, a);

    let r = global_search(&conn, "删除户").unwrap();
    assert!(r.parties.is_empty(), "软删档案点进去就是死链，检索不给命中");
}

// -------------------------------------------------------------------- LIKE 转义

#[test]
fn wildcard_characters_in_keyword_are_matched_literally() {
    let conn = db();
    ensure_users(&conn);
    let xm = wheat(&conn);
    let price = seed_price(&conn, xm);
    let a = new_party(&conn, "张三", "341204199301272017");
    let b = new_party(&conn, "李四", "341204199301272018");
    new_party(&conn, "百分%农场", "341204199301272019");
    for p in [a, b] {
        settled_order(&conn, p, xm, price);
    }

    // 不转义的话 "%" 会命中全表（2 张磅单 + 2 张结算单 + 3 条档案全出来）
    let r = global_search(&conn, "%").unwrap();
    assert!(r.orders.is_empty(), "磅单里没有字面 %，不得命中");
    assert_eq!(names(&r.parties), vec!["百分%农场".to_string()]);
    assert!(r.settlements.is_empty());

    let r = global_search(&conn, "_").unwrap();
    assert!(r.orders.is_empty() && r.parties.is_empty() && r.settlements.is_empty(), "下划线转义后按字面匹配，这批数据里没有");

    // 转义符自身也要按字面理解
    let r = global_search(&conn, "\\").unwrap();
    assert!(r.orders.is_empty() && r.parties.is_empty() && r.settlements.is_empty());

    // 真含 % 的那条仍能搜到（跨字段的组合关键词）
    let r = global_search(&conn, "%农场").unwrap();
    assert_eq!(names(&r.parties), vec!["百分%农场".to_string()]);
}

// ------------------------------------------------------------------ 上限与排序

#[test]
fn each_group_is_capped_in_sql_at_8_6_6() {
    let conn = db();
    ensure_users(&conn);
    let xm = wheat(&conn);
    let price = seed_price(&conn, xm);

    // 同一个售粮人 10 张已结算单：磅单截 8、结算单截 6
    let big = new_party(&conn, "张大全", "341204199301272020");
    for _ in 0..10 {
        settled_order(&conn, big, xm, price);
    }
    // 8 条同姓档案：售粮人截 6
    for i in 1..=8 {
        new_party(&conn, &format!("李{i:02}"), &format!("3412041993012721{i:02}"));
    }

    let r = global_search(&conn, "大全").unwrap();
    assert_eq!(r.orders.len(), 8, "磅单在 SQL 的 LIMIT 里就截掉，不是取全表");
    assert_eq!(r.settlements.len(), 6);
    assert_eq!(r.parties.len(), 1);

    let r = global_search(&conn, "李0").unwrap();
    assert_eq!(r.parties.len(), 6, "档案同样截 6");
    assert_eq!(names(&r.parties), (1..=6).map(|i| format!("李{i:02}")).collect::<Vec<_>>(), "姓名命中后按 id 升序");
    assert!(r.orders.is_empty() && r.settlements.is_empty());
}

#[test]
fn orders_come_newest_first_and_party_name_hits_outrank_field_hits() {
    let conn = db();
    ensure_users(&conn);
    let xm = wheat(&conn);
    let a = new_party(&conn, "王小明", "341204199301272021");
    let early = weighed_order(&conn, a, xm, None);
    let late = weighed_order(&conn, a, xm, None);

    // 同一天先按单号倒序（取号日内单调），再把前一张推到更晚的业务日验证日期优先
    let r = global_search(&conn, &late).unwrap();
    assert_eq!(r.orders[0].order_no, late);
    conn.execute("UPDATE weigh_order SET business_date = '2027-01-01' WHERE order_no = ?1", params![&early]).unwrap();
    let r = global_search(&conn, "王小明").unwrap();
    assert_eq!(order_nos(&r.orders), vec![early.clone(), late.clone()], "业务日期近的在前");

    // 姓名命中的档案排在证号命中的前面（哪怕 id 更大）
    new_party(&conn, "1993种粮大户", "341204199001010099");
    let r = global_search(&conn, "1993").unwrap();
    assert_eq!(names(&r.parties), vec!["1993种粮大户".to_string(), "王小明".to_string()], "姓名命中优先，再按 id");
}

// -------------------------------------------------------------- 序列化即 OrderRow

#[test]
fn payload_matches_the_frontend_contract_without_detail_buckets() {
    let conn = db();
    ensure_users(&conn);
    let xm = wheat(&conn);
    let price = seed_price(&conn, xm);
    let a = new_party(&conn, "张三", "341204199301272022");
    let (no, settle_no) = settled_order(&conn, a, xm, price);

    let r: SearchResult = global_search(&conn, "张三").unwrap();
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(
        v.as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()),
        Some(vec!["orders".into(), "parties".into(), "settlements".into()]),
        "顶层就是 mock.search 那三组"
    );

    let o = &v["orders"][0];
    for k in ["records", "photos", "prints", "timeline"] {
        assert!(o.get(k).is_none(), "OrderRow 不得带出 {k}（详情才带）");
    }
    for k in ["id", "order_no", "business_date", "status", "party_name", "variety_name", "settlement_weight_01kg", "payable_amount_fen"] {
        assert!(o.get(k).is_some(), "GlobalSearch / 列表要读 {k}");
    }
    assert_eq!(o["order_no"].as_str().unwrap(), no.as_str());

    let p = &v["parties"][0];
    for k in ["id", "code", "name", "party_type", "id_card_no", "phone", "status"] {
        assert!(p.get(k).is_some(), "档案行缺 {k}");
    }
    assert_eq!(p["id_card_no"].as_str().unwrap(), "341204199301272022");

    let s = &v["settlements"][0];
    for k in ["id", "settle_no", "party_name", "business_date", "payable_fen", "paid_fen", "payment_status", "orders"] {
        assert!(s.get(k).is_some(), "结算单缺 {k}");
    }
    assert_eq!(s["settle_no"].as_str().unwrap(), settle_no.as_str());
    assert_eq!(s["orders"].as_array().unwrap().len(), 1, "结算明细由 load_settlement_by_id 现算");
}
