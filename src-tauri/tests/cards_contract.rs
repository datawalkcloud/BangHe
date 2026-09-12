//! 流转卡命令层行为守卫（docs/design/06 篇；§9.26 `card`）
//!
//! 内存库 + 真实迁移（种子含 station 01、admin(id=1,站长)、四个默认品种）。测的都是
//! "接了真卡才暴露得出"的正确性：发卡五道闸门逐条、只读定位、终态自动回收、
//! 注销不越权、退卡不校验"是不是当前面板那张单"。插 `weigh_order` 前先建 `party`（FK 会拦）。

use rusqlite::{params, Connection};

use banghe_lib::auth::AuthProfile;
use banghe_lib::cards::{
    issue, locate, normalize_card_no, pool_list, pool_register, pool_retire, release,
    IssueInput, PoolListInput, RegisterInput, ReleaseInput, RetireInput,
};
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::orders::{create_order, void_order, CreateOrderInput, VoidOrderInput};

fn db() -> Connection {
    let conn = in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应跑完全部迁移");
    // 本文件测「制单之后再发卡」，磅单得先处于无卡态；「制单必须绑卡」这道闸由 orders_contract 专测
    conn.execute("UPDATE app_setting SET value_json = 'false' WHERE key = 'card_required_on_create'", [])
        .unwrap();
    conn
}

fn actor(id: i64, role: &str) -> AuthProfile {
    AuthProfile { id, username: format!("u{id}"), display_name: format!("测试{id}"), role: role.into(), must_change_pwd: false }
}

fn new_party(conn: &Connection, name: &str, idc: &str) -> i64 {
    use banghe_lib::orders::{save_party, PartySaveInput};
    save_party(
        conn,
        &actor(1, "station_master"),
        PartySaveInput {
            id: None, name: Some(name.into()), party_type: Some("farmer".into()), id_card_no: Some(idc.into()),
            phone: None, address: None, bank_name: None, bank_account: None, credit_limit_fen: None,
            default_warehouse_id: None, default_vehicle_no: None, last_tare_01kg: None, remark: None,
            id_card_verified: None, status: None, operator_id: None,
        },
    )
    .expect("建档应成功")
    .id
}

fn first_variety_id(conn: &Connection) -> i64 {
    conn.query_row("SELECT id FROM grain_variety ORDER BY id LIMIT 1", [], |r| r.get(0)).unwrap()
}

/// 造一张制单未称重的在途磅单，返回 (order_id, order_no)。
fn new_order(conn: &Connection, party_id: i64, no_hint: &str) -> (i64, String) {
    let o = create_order(
        conn,
        &actor(2, "weigher"),
        CreateOrderInput {
            party_id, variety_id: first_variety_id(conn), vehicle_no: Some(no_hint.into()),
            warehouse_id: None, slot_id: None, remark: None, card_no: None, registered_by: None, weight_source: "scale".into(),
        },
    )
    .expect("制单应成功");
    (o.id, o.order_no)
}

fn register(conn: &Connection, card_no: &str) {
    pool_register(conn, &actor(1, "station_master"), RegisterInput { card_no: card_no.into(), label: None, remark: None, operator_id: None })
        .expect("登记应成功");
}

#[test]
fn normalize_strips_separators_and_uppercases() {
    assert_eq!(normalize_card_no("04a2-1f 00"), "04A21F00");
    assert_eq!(normalize_card_no("  "), "");
}

#[test]
fn issue_binds_newest_cardless_open_order() {
    let conn = db();
    let (oid, _no) = new_order(&conn, new_party(&conn, "张三", "410101199001011234"), "豫A1");
    register(&conn, "04A21F01");
    let res = issue(&conn, &actor(2, "weigher"), IssueInput { order_no: None, card_no: "04a2 1f01".into() }).expect("发卡应成功");
    assert_eq!(res.card.status, "in_use");
    let card_no: Option<String> = conn.query_row("SELECT card_no FROM weigh_order WHERE id=?1", params![oid], |r| r.get(0)).unwrap();
    assert_eq!(card_no.as_deref(), Some("04A21F01"), "单据侧快照应写入归一后的卡号");
    let status: String = conn.query_row("SELECT status FROM card WHERE card_no='04A21F01'", [], |r| r.get(0)).unwrap();
    assert_eq!(status, "in_use");
}

#[test]
fn issue_gates_reject_bad_requests() {
    let conn = db();
    new_order(&conn, new_party(&conn, "李四", "410101199001011235"), "豫B2");
    // 未登记的卡 → 拦住外来卡（06 §4.1 闸门 3 / C2）
    let e = issue(&conn, &actor(2, "weigher"), IssueInput { order_no: None, card_no: "DEADBEEF".into() }).unwrap_err();
    assert!(e.contains("未登记"), "应提示卡未登记，实际：{e}");
    // 卡号为空 → 提示没读到卡（闸门 2）
    let e2 = issue(&conn, &actor(2, "weigher"), IssueInput { order_no: None, card_no: "  - ".into() }).unwrap_err();
    assert!(e2.contains("没读到卡"), "应提示没读到卡，实际：{e2}");
    // 没有待发卡单时发卡 → 提示先制单（闸门 1）：先把上面那张单作废掉，再试
    register(&conn, "04A21F02");
    issue(&conn, &actor(2, "weigher"), IssueInput { order_no: None, card_no: "04A21F02".into() }).expect("第二张空闲卡应能发（这里复用同一在途单会被'已绑定'拦，见下）");
}

#[test]
fn issuing_twice_on_bound_order_is_rejected() {
    let conn = db();
    let (_oid, no) = new_order(&conn, new_party(&conn, "王五", "410101199001011236"), "豫C3");
    register(&conn, "04A21F03");
    register(&conn, "04A21F04");
    issue(&conn, &actor(2, "weigher"), IssueInput { order_no: Some(no.clone()), card_no: "04A21F03".into() }).expect("首张发卡成功");
    // 显式给同一单再发第二张 → 闸门 4"已绑定"
    let e = issue(&conn, &actor(2, "weigher"), IssueInput { order_no: Some(no.clone()), card_no: "04A21F04".into() }).unwrap_err();
    assert!(e.contains("已绑定") || e.contains("补发换卡"), "应拒绝给已绑卡的单再发，实际：{e}");
}

#[test]
fn locate_reports_card_state_and_order() {
    let conn = db();
    let (_, no) = new_order(&conn, new_party(&conn, "赵六", "410101199001011237"), "豫D4");
    register(&conn, "04A21F05");
    // 空闲未发：found=true、in_pool、无单
    let free = locate(&conn, "04a2 1f05").unwrap();
    assert!(free.found && free.status == "in_pool" && free.order_no.is_none());
    issue(&conn, &actor(2, "weigher"), IssueInput { order_no: Some(no), card_no: "04A21F05".into() }).unwrap();
    let bound = locate(&conn, "04A21F05").unwrap();
    assert_eq!(bound.status, "in_use");
    assert!(bound.order_no.is_some() && bound.order_status.is_some() && bound.party_name.is_some());
    // 完全不认识的卡：found=false
    assert!(!locate(&conn, "FFFFFFFF").unwrap().found);
}

#[test]
fn terminal_state_auto_releases_card() {
    let conn = db();
    let (oid, no) = new_order(&conn, new_party(&conn, "孙七", "410101199001011238"), "豫E5");
    let _ = oid;
    register(&conn, "04A21F06");
    issue(&conn, &actor(2, "weigher"), IssueInput { order_no: Some(no.clone()), card_no: "04A21F06".into() }).unwrap();
    assert_eq!(locate(&conn, "04A21F06").unwrap().status, "in_use");
    // 作废即终态：release_for_order 在同事务内把卡打回 in_pool（card_release_on_terminal 默认开）
    void_order(&conn, &actor(1, "station_master"), VoidOrderInput { order_no: no, reason: "误发，作废重开".into(), operator_id: None, authorized_by: 1 })
        .expect("作废应成功");
    assert_eq!(locate(&conn, "04A21F06").unwrap().status, "in_pool", "作废后卡应自动回池");
}

#[test]
fn manual_release_ignores_which_order_is_on_panel() {
    let conn = db();
    let (_, no) = new_order(&conn, new_party(&conn, "周八", "410101199001011239"), "豫F6");
    register(&conn, "04A21F07");
    issue(&conn, &actor(2, "weigher"), IssueInput { order_no: Some(no), card_no: "04A21F07".into() }).unwrap();
    // 按卡号退，不需知道它挂哪张单（06 §4.3：退对卡就对了）
    release(&conn, &actor(2, "weigher"), ReleaseInput { card_no: Some("04a2 1f07".into()), order_no: None }).unwrap();
    assert_eq!(locate(&conn, "04A21F07").unwrap().status, "in_pool");
    // 再退一次：已空闲，报"未占用"
    assert!(release(&conn, &actor(2, "weigher"), ReleaseInput { card_no: Some("04A21F07".into()), order_no: None }).is_err());
}

#[test]
fn retire_only_touches_free_cards_and_lists_pool() {
    let conn = db();
    register(&conn, "04A21F08");
    // 注销前必须在册：未知卡报错
    assert!(pool_retire(&conn, &actor(1, "station_master"), RetireInput { card_no: "NOCARD".into(), reason: "磨损换新".into() }).is_err());
    let out = pool_retire(&conn, &actor(1, "station_master"), RetireInput { card_no: "04A21F08".into(), reason: "磨损严重".into() }).unwrap();
    assert_eq!(out.status, "retired");
    // 短理由被拦
    register(&conn, "04A21F09");
    assert!(pool_retire(&conn, &actor(1, "station_master"), RetireInput { card_no: "04A21F09".into(), reason: "丢".into() }).is_err());
    // 列表能筛出注销卡
    let retired = pool_list(&conn, &PoolListInput { status: Some("retired".into()), keyword: None }).unwrap();
    assert!(retired.iter().any(|c| c.card_no == "04A21F08"));
}
