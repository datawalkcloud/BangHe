//! 基础档案读写的行为守卫（docs/design/02 §7 M6、03 §9.8–§9.10、§9.21）
//!
//! 这一层换的是**真库**，所以守的必须是"接上 SQLite 才会犯、纸面 review 看不出来"的错：
//!  1. 软删除漏掉一处过滤 ⇒ 档案页列出一条界面上根本删不掉的记录；
//!  2. 唯一约束直接把 SQLite 原文怼给界面 ⇒ 站长读到 `UNIQUE constraint failed`；
//!  3. 可空列被 `COALESCE` 成 0 ⇒ "国标规定水分 0.00%"这种假基准会进化验提示；
//!  4. 重叠价按 id 排除自身没写对 ⇒ 调过一次价的站点再也发不了新价；
//!  5. 新员工落了能用的哈希 ⇒ 等于全站共用一个后门密码。
//!  6. 参数存的是 `value_json`（`"preview"` 带引号）而界面只吃扁平文本；
//!     前端参数目录与库里的键名一漂移，设置页就静默少一整组。
//!
//! 全部走内存库 + 真实迁移脚本（含 0002/0003/0004 的种子），所以"库里到底有几条种子"
//! 这类前提一旦变了，这里会先红。结构层面的断言（列、快照、枚举三源）归 `schema_contract.rs`。

use rusqlite::{params, Connection};

use banghe_lib::auth::{self, authenticate, Kind, PWD_UNSET};
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::masters::{
    delete_slot, delete_warehouse, get_station, list_prices, list_settings, list_staff,
    list_varieties, list_warehouses, save_price, save_setting, save_slot, save_staff, save_variety,
    save_warehouse, PriceInput, Setting, SettingInput, SlotInput, StaffInput, VarietyInput,
    WarehouseInput,
};


fn db() -> Connection {
    in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本")
}

/// 命令层的 `operator()` 从会话里拿人，测试直接构造同一个结构，
/// 保证被测的库函数与线上跑的是同一份入参形状。
fn actor() -> auth::AuthProfile {
    auth::AuthProfile {
        id: 1,
        username: "admin".into(),
        display_name: "站长".into(),
        role: "station_master".into(),
        must_change_pwd: false,
    }
}

fn variety_input(code: &str) -> VarietyInput {
    VarietyInput {
        id: None,
        code: code.into(),
        name: format!("测试{code}"),
        category: "主粮".into(),
        std_moisture_001pct: None,
        std_impurity_001pct: None,
        std_unsound_001pct: None,
        std_bulk_density: None,
        reject_moisture_001pct: None,
        enabled_indicators: vec!["moisture".into()],
        default_package_deduct_01kg: 0,
        sort_order: 90,
        is_active: 1,
    }
}

fn warehouse_input(code: &str) -> WarehouseInput {
    WarehouseInput {
        id: None,
        code: code.into(),
        name: format!("{code}号仓"),
        kind: "house".into(),
        capacity_ton: None,
        is_active: 1,
    }
}

fn slot_input(warehouse_id: i64, code: &str) -> SlotInput {
    SlotInput {
        id: None,
        warehouse_id,
        code: code.into(),
        label: String::new(),
        is_active: 1,
    }
}

fn price_input(variety_id: i64, from: &str, to: &str) -> PriceInput {
    PriceInput {
        id: None,
        variety_id,
        grade: "二等".into(),
        price_fen_per_ton: 2_500_00,
        effective_from: from.into(),
        effective_to: to.into(),
        basis: "周农发〔2026〕3号".into(),
        remark: None,
    }
}

fn staff_input(username: &str, role: &str) -> StaffInput {
    StaffInput {
        id: None,
        username: username.into(),
        display_name: format!("测试·{username}"),
        role: role.into(),
        phone: String::new(),
        is_active: 1,
    }
}

fn seed_variety_id(conn: &Connection, code: &str) -> i64 {
    conn.query_row(
        "SELECT id FROM grain_variety WHERE code = ?1",
        params![code],
        |r| r.get(0),
    )
    .expect("0002 应已种下该品种")
}

fn audit_count(conn: &Connection, action: &str, entity_no: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM audit_log WHERE action = ?1 AND entity_no = ?2",
        params![action, entity_no],
        |r| r.get(0),
    )
    .unwrap_or(-1)
}

fn err_of<T>(r: Result<T, String>) -> String {
    match r {
        Ok(_) => panic!("本应被拒绝，却保存成功了"),
        Err(e) => e,
    }
}

// --------------------------------------------------------------- 软删除 §3.4

#[test]
fn soft_deleted_rows_never_reach_the_archive_page() {
    let conn = db();
    let id = seed_variety_id(&conn, "YM");
    conn.execute(
        "UPDATE grain_variety SET deleted_at = '2026-09-11T10:00:00.000+08:00' WHERE id = ?1",
        params![id],
    )
    .unwrap();

    let codes: Vec<String> = list_varieties(&conn).unwrap().into_iter().map(|v| v.code).collect();
    assert!(!codes.contains(&"YM".to_string()), "软删的品种仍在档案页可见：{codes:?}");
    assert!(
        codes.contains(&"XM".to_string()),
        "过滤过头了，正常品种也没了：{codes:?}"
    );
}

#[test]
fn a_soft_deleted_variety_still_owns_its_code() {
    // 唯一索引不带 deleted_at 条件，所以"删掉再建同名"必然撞库。
    // 这条测试钉的是：撞了要回人话，而不是把 SQLite 原文怼到界面上。
    let conn = db();
    let id = seed_variety_id(&conn, "YM");
    conn.execute(
        "UPDATE grain_variety SET deleted_at = '2026-09-11T10:00:00.000+08:00' WHERE id = ?1",
        params![id],
    )
    .unwrap();

    let message = err_of(save_variety(&conn, &actor(), variety_input("YM")));
    assert!(message.contains("YM") && message.contains("已存在"), "文案没给出冲突的编码：{message}");
    assert!(!message.contains("UNIQUE"), "把 SQLite 原文泄露给界面了：{message}");
}

// ------------------------------------------------------------------- 品种

#[test]
fn a_blank_standard_stays_null_instead_of_becoming_zero() {
    let conn = db();
    let saved = save_variety(&conn, &actor(), variety_input("GT")).unwrap();
    let read = list_varieties(&conn).unwrap().into_iter().find(|v| v.code == "GT").unwrap();

    assert_eq!(saved.id, read.id, "保存后重新读出的必须是同一行");
    assert_eq!(read.std_moisture_001pct, None, "0 会被读成「国标规定水分 0.00%」");
    assert_eq!(read.std_bulk_density, None);
    assert_eq!(read.category, "主粮", "空类别按未填处理，不能出现一串空白");
}

#[test]
fn a_variety_without_indicators_is_refused() {
    let conn = db();
    let mut input = variety_input("GT2");
    input.enabled_indicators.clear();
    let message = err_of(save_variety(&conn, &actor(), input));
    assert!(message.contains("检测项目"), "应说明为什么存不了：{message}");
}

#[test]
fn editing_a_variety_keeps_its_own_id_out_of_the_uniqueness_check() {
    let conn = db();
    let id = seed_variety_id(&conn, "XM");
    let mut input = variety_input("XM");
    input.id = Some(id);
    input.name = "小麦（更新）".into();
    let saved = save_variety(&conn, &actor(), input).unwrap();
    assert_eq!(saved.id, id, "改自己不该变成新增");
    assert_eq!(saved.name, "小麦（更新）");
}

#[test]
fn code_is_trimmed_and_upper_cased_before_it_lands() {
    let conn = db();
    let mut input = variety_input("  gt3  ");
    input.name = "  " .into();
    assert!(err_of(save_variety(&conn, &actor(), input)).contains("名称"));

    let saved = save_variety(&conn, &actor(), variety_input(" gt4 ")).unwrap();
    assert_eq!(saved.code, "GT4");
}

// ------------------------------------------------------------------- 仓房

#[test]
fn warehouses_carry_their_slots_so_the_page_needs_one_request() {
    let conn = db();
    let wh = save_warehouse(&conn, &actor(), warehouse_input("cw01")).unwrap();
    assert_eq!(wh.code, "CW01", "编码统一大写，与品种同一口径");
    assert_eq!(wh.capacity_ton, None, "容量没填不能变成 0 吨");

    save_slot(&conn, &actor(), slot_input(wh.id, "C01-01")).unwrap();
    save_slot(&conn, &actor(), slot_input(wh.id, "C01-02")).unwrap();
    let again = list_warehouses(&conn).unwrap().into_iter().find(|w| w.id == wh.id).unwrap();
    assert_eq!(again.slots.len(), 2);
    // label 留空 ⇒ SQL 里 COALESCE(label, code)，界面拿到的永远是可直出的字符串
    assert_eq!(again.slots[0].label, "C01-01");
}

#[test]
fn an_out_of_range_warehouse_kind_is_named_in_the_error() {
    let conn = db();
    let mut input = warehouse_input("CW09");
    input.kind = "igloo".into();
    let message = err_of(save_warehouse(&conn, &actor(), input));
    assert!(message.contains("igloo"), "要指出是哪个值不对：{message}");
    assert!(message.contains("house"), "要给出可用值，否则站长猜不到：{message}");
}

#[test]
fn slot_codes_are_unique_within_a_warehouse_and_free_across_it() {
    let conn = db();
    let a = save_warehouse(&conn, &actor(), warehouse_input("CW02")).unwrap();
    let b = save_warehouse(&conn, &actor(), warehouse_input("CW03")).unwrap();

    save_slot(&conn, &actor(), slot_input(a.id, "S01")).unwrap();
    let same_again = err_of(save_slot(&conn, &actor(), slot_input(a.id, "S01")));
    assert!(same_again.contains("同一仓房"), "文案要说清重复范围：{same_again}");
    assert!(!same_again.contains("UNIQUE"), "把 SQLite 原文泄露给界面了：{same_again}");

    let other = save_slot(&conn, &actor(), slot_input(b.id, "S01")).unwrap();
    assert_eq!(other.warehouse_id, b.id, "不同仓房之间编码互不相干");

    // 给已存在的货位改名（label），编码不变，不该撞 uk_slot
    let mut rename = slot_input(b.id, "S01");
    rename.id = Some(other.id);
    rename.label = "东一列".into();
    let renamed = save_slot(&conn, &actor(), rename).unwrap();
    assert_eq!(renamed.label, "东一列");
}

#[test]
fn a_slot_pointing_at_a_missing_warehouse_is_refused() {
    let conn = db();
    let message = err_of(save_slot(&conn, &actor(), slot_input(9999, "SX")));
    assert!(message.contains("仓房"), "应指向仓房而不是外键原文：{message}");
    assert!(!message.contains("FOREIGN KEY"), "{message}");
}

// -------------------------------------------------------- 删除：仓房（软删）/ 货位（硬删）

/// 建一个往来单位，可把它「常用去向」挂到某仓房（§9.6：created_by 指向种子 admin）
fn seed_party(conn: &Connection, name: &str, default_wh: Option<i64>) -> i64 {
    conn.execute(
        "INSERT INTO party (name, party_type, default_warehouse_id, created_at, created_by)
         VALUES (?1, 'farmer', ?2, '2026-09-01T10:00:00.000+08:00', 1)",
        params![name, default_wh],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// 直接落一张最小磅单，按需把 warehouse_id / slot_id 挂上，用来造「已被引用」的场景
fn seed_order_ref(conn: &Connection, order_no: &str, warehouse_id: Option<i64>, slot_id: Option<i64>) {
    let station_id: i64 = conn
        .query_row("SELECT id FROM station LIMIT 1", [], |r| r.get(0))
        .unwrap();
    let variety_id = seed_variety_id(conn, "YM");
    let party_id = seed_party(conn, &format!("农户{order_no}"), None);
    conn.execute(
        "INSERT INTO weigh_order
            (order_no, station_id, business_date, status, party_id, variety_id, warehouse_id, slot_id, registered_by, registered_at, created_at, created_by)
         VALUES (?1, ?2, '2026-09-01', 'registered', ?3, ?4, ?5, ?6, 1, '2026-09-01T10:00:00.000+08:00', '2026-09-01T10:00:00.000+08:00', 1)",
        params![order_no, station_id, party_id, variety_id, warehouse_id, slot_id],
    )
    .unwrap();
}

fn slot_count(conn: &Connection, wh_id: i64) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM storage_slot WHERE warehouse_id = ?1",
        params![wh_id],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn deleting_a_clean_warehouse_soft_deletes_it_and_removes_its_slots() {
    let conn = db();
    let a = actor();
    let wh = save_warehouse(&conn, &a, warehouse_input("CW70")).unwrap();
    save_slot(&conn, &a, slot_input(wh.id, "CW70-01")).unwrap();
    save_slot(&conn, &a, slot_input(wh.id, "CW70-02")).unwrap();
    assert_eq!(slot_count(&conn, wh.id), 2);

    let deleted = delete_warehouse(&conn, &a, wh.id).unwrap();
    assert_eq!(deleted.code, "CW70");

    assert!(
        !list_warehouses(&conn).unwrap().iter().any(|w| w.id == wh.id),
        "软删的仓房还在档案页可见"
    );
    assert_eq!(slot_count(&conn, wh.id), 0, "删仓房要连带清掉名下没有历史的货位，别留孤儿");
    // 软删而非硬删：行仍留在库里、deleted_at 有值，历史单据此旧能读回去向
    let still: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM warehouse WHERE id = ?1 AND deleted_at IS NOT NULL",
            params![wh.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(still, 1, "仓房走的是软删，行不该物理消失");
    assert_eq!(audit_count(&conn, "warehouse.delete", "CW70"), 1);
}

#[test]
fn a_warehouse_reachable_only_through_its_slots_is_not_deletable() {
    let conn = db();
    let a = actor();
    let wh = save_warehouse(&conn, &a, warehouse_input("CW71")).unwrap();
    let slot = save_slot(&conn, &a, slot_input(wh.id, "CW71-01")).unwrap();
    // 磅单只登记到货位、没填仓房：仓房级引用计数必须把这条一并算进来
    seed_order_ref(&conn, "BD-CW71", None, Some(slot.id));

    let message = err_of(delete_warehouse(&conn, &a, wh.id));
    assert!(message.contains("磅单"), "应说明被磅单引用：{message}");
    assert!(message.contains("停用"), "应给出下一步（改停用）：{message}");
    assert!(!message.contains("FOREIGN KEY"), "{message}");
    assert!(
        list_warehouses(&conn).unwrap().iter().any(|w| w.id == wh.id),
        "被引用的仓房不该被删掉"
    );
    assert_eq!(slot_count(&conn, wh.id), 1, "拒删时名下货位一根手指都不能动");
}

#[test]
fn a_warehouse_used_as_a_party_default_destination_is_not_deletable() {
    let conn = db();
    let a = actor();
    let wh = save_warehouse(&conn, &a, warehouse_input("CW72")).unwrap();
    seed_party(&conn, "张农户", Some(wh.id));

    let message = err_of(delete_warehouse(&conn, &a, wh.id));
    assert!(message.contains("往来单位") && message.contains("常用去向"), "{message}");
    assert!(list_warehouses(&conn).unwrap().iter().any(|w| w.id == wh.id));
}

#[test]
fn a_clean_slot_hard_deletes_but_a_referenced_one_only_stops() {
    let conn = db();
    let a = actor();
    let wh = save_warehouse(&conn, &a, warehouse_input("CW73")).unwrap();
    let junk = save_slot(&conn, &a, slot_input(wh.id, "CW73-01")).unwrap();
    let used = save_slot(&conn, &a, slot_input(wh.id, "CW73-02")).unwrap();
    seed_order_ref(&conn, "BD-CW73", Some(wh.id), Some(used.id));

    // 没有历史的错录货位：storage_slot 无 deleted_at，就地硬删
    assert_eq!(delete_slot(&conn, &a, junk.id).unwrap().code, "CW73-01");
    let gone: i64 = conn
        .query_row("SELECT COUNT(*) FROM storage_slot WHERE id = ?1", params![junk.id], |r| r.get(0))
        .unwrap();
    assert_eq!(gone, 0, "干净货位应被物理删除");

    // 被磅单挂过的货位：拒删、引导停用
    let message = err_of(delete_slot(&conn, &a, used.id));
    assert!(message.contains("磅单") && message.contains("停用"), "{message}");
    let still: i64 = conn
        .query_row("SELECT COUNT(*) FROM storage_slot WHERE id = ?1", params![used.id], |r| r.get(0))
        .unwrap();
    assert_eq!(still, 1, "被引用的货位不能消失");
    assert_eq!(audit_count(&conn, "slot.delete", "CW73-01"), 1);
}

// --------------------------------------------------- 编码选填：留空由系统补号

#[test]
fn blank_codes_get_numbered_instead_of_bouncing_back_to_the_operator() {
    let conn = db();
    let a = actor();

    let wh = save_warehouse(&conn, &a, warehouse_input("")).unwrap();
    assert_eq!(wh.code, "CW01", "仓房补号 = CW + 两位序号，与界面上的示例同形");
    let slot = save_slot(&conn, &a, slot_input(wh.id, "")).unwrap();
    assert_eq!(slot.code, "CW01-01", "货位补号带上所属仓房编码，磅单一眼看得出是哪处");
    assert_eq!(save_variety(&conn, &a, variety_input("")).unwrap().code, "V01", "补号另起 V 段，避开种子里的拼音码");
    assert_eq!(save_staff(&conn, &a, staff_input("", "weigher")).unwrap().username, "u01");

    // 再留空一次要往后号，不能回头撞刚补出去的那条
    assert_eq!(save_warehouse(&conn, &a, warehouse_input("")).unwrap().code, "CW02");
    assert_eq!(save_slot(&conn, &a, slot_input(wh.id, "")).unwrap().code, "CW01-02");

    // 编辑时清空编码＝沿用原号：历史磅单按编码留痕，重新编号会把历史接不上
    let mut rename = warehouse_input("");
    rename.id = Some(wh.id);
    assert_eq!(save_warehouse(&conn, &a, rename).unwrap().code, "CW01");
    let mut slot_rename = slot_input(wh.id, "");
    slot_rename.id = Some(slot.id);
    assert_eq!(save_slot(&conn, &a, slot_rename).unwrap().code, "CW01-01");

    // 补号必须避开软删行仍占着的编码——code 上的 UNIQUE 索引不过滤 deleted_at，
    // 撞号的后果是 INSERT 直接失败，而不是安静地多出一条同型号。
    let mut retired = variety_input("");
    retired.name = "高粱".into();
    let retired = save_variety(&conn, &a, retired).unwrap();
    assert_eq!(retired.code, "V02");
    conn.execute(
        "UPDATE grain_variety SET deleted_at = ?2 WHERE id = ?1",
        params![retired.id, "2026-01-01T00:00:00+08:00"],
    )
    .unwrap();
    let mut next = variety_input("");
    next.name = "荞麦".into();
    // 只查活行的补号会拿出 V02 —— 看着空着，INSERT 却当场撞 UNIQUE。要 V03 才算避开了软删行。
    assert_eq!(save_variety(&conn, &a, next).unwrap().code, "V03", "补号要避开软删行仍占着的编码");
}

// ------------------------------------------------------------------- 价目

#[test]
fn overlapping_price_ranges_are_rejected_with_the_offending_period() {
    let conn = db();
    let xm = seed_variety_id(&conn, "XM");
    save_price(&conn, &actor(), price_input(xm, "2026-01-01", "2026-06-30")).unwrap();

    let message = err_of(save_price(&conn, &actor(), price_input(xm, "2026-06-01", "2026-12-31")));
    assert!(message.contains("2026-01-01") && message.contains("2026-06-30"), "要指出跟哪条撞：{message}");
    assert!(message.contains("截止日"), "要给出下一步动作：{message}");

    // 首尾相接不算重叠：6/30 止、7/1 起可以同时存在
    save_price(&conn, &actor(), price_input(xm, "2026-07-01", "2026-12-31")).unwrap();
    assert_eq!(
        list_prices(&conn).unwrap().into_iter().filter(|p| p.variety_id == xm).count(),
        2
    );
}

#[test]
fn editing_a_price_does_not_conflict_with_itself() {
    let conn = db();
    let xm = seed_variety_id(&conn, "XM");
    let created = save_price(&conn, &actor(), price_input(xm, "2026-01-01", "2026-12-31")).unwrap();

    let mut reprice = price_input(xm, "2026-01-01", "2026-12-31");
    reprice.id = Some(created.id);
    reprice.price_fen_per_ton = 2_600_00;
    let saved = save_price(&conn, &actor(), reprice).unwrap();
    assert_eq!(saved.id, created.id, "改价目是就地更新这一条，不新增");
    assert_eq!(saved.price_fen_per_ton, 2_600_00);
}

#[test]
fn a_price_with_a_bad_period_or_nonpositive_unit_is_refused() {
    let conn = db();
    let xm = seed_variety_id(&conn, "XM");

    let mut backwards = price_input(xm, "2026-12-31", "2026-01-01");
    backwards.id = None;
    assert!(err_of(save_price(&conn, &actor(), backwards)).contains("起始日"));

    let mut free = price_input(xm, "2026-01-01", "2026-12-31");
    free.price_fen_per_ton = 0;
    assert!(err_of(save_price(&conn, &actor(), free)).contains("单价"));

    let ghost = price_input(9999, "2026-01-01", "2026-12-31");
    assert!(err_of(save_price(&conn, &actor(), ghost)).contains("品种"));
}

// ------------------------------------------------------------------- 员工

#[test]
fn new_staff_get_the_placeholder_hash_not_a_usable_one() {
    let conn = db();
    let created = save_staff(&conn, &actor(), staff_input("WangWei", "weigher")).unwrap();
    assert_eq!(created.username, "wangwei", "登录名统一小写，避免 Wang/wang 两个账号");

    let (hash, must): (String, i64) = conn
        .query_row(
            "SELECT password_hash, must_change_pwd FROM user_account WHERE id = ?1",
            params![created.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(hash, PWD_UNSET, "库里落死哈希等于全站共用一个后门密码");
    assert_eq!(must, 1);

    // 占位哈希这条路只认装机初始密码，且登录后立刻要求改密
    let wrong = authenticate(&conn, "wangwei", "随便一个密码", Kind::Login, None);
    assert!(!wrong.ok);
    let boot = authenticate(&conn, "wangwei", auth::bootstrap_password(), Kind::Login, None);
    assert!(boot.ok, "新员工应能用装机初始密码登入：{:?}", boot.error);
    assert_eq!(boot.needs_password_setup, Some(true));
    assert!(boot.session.unwrap().actor.must_change_pwd);
}

#[test]
fn username_collisions_and_out_of_range_roles_fail_in_plain_words() {
    let conn = db();
    let message = err_of(save_staff(&conn, &actor(), staff_input("ADMIN", "weigher")));
    assert!(message.contains("admin"), "要说清被占用的是哪个登录名：{message}");
    assert!(!message.contains("UNIQUE"), "{message}");

    let message = err_of(save_staff(&conn, &actor(), staff_input("newbie", "auditor")));
    assert!(message.contains("auditor"), "{message}");
}

#[test]
fn the_last_active_station_master_cannot_be_demoted_or_disabled() {
    let conn = db();
    // 种子给了 admin + superadmin 两名站长，先停掉一个才能验"最后一名"
    conn.execute("UPDATE user_account SET is_active = 0 WHERE username = 'superadmin'", [])
        .unwrap();
    let admin = conn
        .query_row("SELECT id FROM user_account WHERE username = 'admin'", [], |r| r.get::<_, i64>(0))
        .unwrap();

    for (role, active, label) in [
        ("weigher", 1_i64, "改岗"),
        ("station_master", 0, "停用"),
    ] {
        let mut input = staff_input("admin", role);
        input.id = Some(admin);
        input.is_active = active;
        let message = err_of(save_staff(&conn, &actor(), input));
        assert!(message.contains("最后一名在职站长"), "{label}应被挡住：{message}");
    }

    // 同一个人改电话（岗位与在职都不动）必须放行，否则档案页就成了只读页
    let mut rename = staff_input("admin", "station_master");
    rename.id = Some(admin);
    rename.phone = "13900000000".into();
    let saved = save_staff(&conn, &actor(), rename).unwrap();
    assert_eq!(saved.phone, "13900000000");

    // 另立一名在职站长之后，原来那位就可以改岗了
    save_staff(&conn, &actor(), staff_input("heir", "station_master")).unwrap();
    let mut demote = staff_input("admin", "weigher");
    demote.id = Some(admin);
    assert!(save_staff(&conn, &actor(), demote).is_ok(), "有接班人在岗时不该再拦");
}

#[test]
fn staff_listing_never_carries_a_password_hash_or_lock_counters() {
    let conn = db();
    save_staff(&conn, &actor(), staff_input("lisi", "weigher")).unwrap();
    let json = serde_json::to_string(&list_staff(&conn).unwrap()).unwrap();
    for leak in ["password_hash", "failed_count", "locked_until"] {
        assert!(!json.contains(leak), "{leak} 出了 Rust 边界");
    }
    assert!(!json.contains(PWD_UNSET), "占位符本身也不该出现在返回值里");
}

// ------------------------------------------------------------------- 审计

#[test]
fn every_write_leaves_exactly_one_audit_row_with_the_mock_action_names() {
    let conn = db();
    let a = actor();

    save_variety(&conn, &a, variety_input("AU1")).unwrap();
    save_warehouse(&conn, &a, warehouse_input("AU1")).unwrap();
    let wh = list_warehouses(&conn).unwrap().into_iter().find(|w| w.code == "AU1").unwrap();
    save_slot(&conn, &a, slot_input(wh.id, "AU1-01")).unwrap();
    save_price(&conn, &a, price_input(seed_variety_id(&conn, "DG"), "2026-01-01", "2026-12-31")).unwrap();
    save_staff(&conn, &a, staff_input("zhao", "weigher")).unwrap();
    // 改一次，动作名要从 .create 变成 .update，两回事都得留下
    let mut again = variety_input("AU1");
    again.id = Some(list_varieties(&conn).unwrap().into_iter().find(|v| v.code == "AU1").unwrap().id);
    save_variety(&conn, &a, again).unwrap();

    let dg = seed_variety_id(&conn, "DG");
    let price_no = format!("{dg}/二等");
    for (action, entity_no) in [
        ("variety.create", "AU1"),
        ("variety.update", "AU1"),
        ("warehouse.create", "AU1"),
        ("slot.create", "AU1-01"),
        ("price.create", price_no.as_str()),
        ("staff.create", "zhao"),
    ] {
        assert_eq!(audit_count(&conn, action, entity_no), 1, "动作 {action} 的审计对不上");
    }

    let (name, result): (String, String) = conn
        .query_row(
            "SELECT actor_name, result FROM audit_log WHERE action = 'variety.create' AND entity_no = 'AU1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(name, "站长", "审计记的是当时的显示名快照");
    assert_eq!(result, "ok");
}

#[test]
fn a_rejected_write_leaves_no_audit_row_and_no_data() {
    let conn = db();
    let before = audit_count(&conn, "variety.create", "XM");
    let _ = err_of(save_variety(&conn, &actor(), variety_input("XM")));
    assert_eq!(audit_count(&conn, "variety.create", "XM"), before, "没改成东西就不该有成功审计");
    assert_eq!(
        list_varieties(&conn).unwrap().into_iter().filter(|v| v.code == "XM").count(),
        1
    );
}

// ------------------------------------------------------------------- 站点

#[test]
fn station_reads_the_single_active_row_with_blank_instead_of_null() {
    let conn = db();
    let s = get_station(&conn).unwrap();
    assert_eq!(s.code, "01");
    assert!(!s.name.is_empty(), "抬头用的站名不能是空白");
    // address / phone 未填 ⇒ 空串，界面直接渲染，不必每处判 null
    assert_eq!(s.address, "");
    assert_eq!(s.phone, "");
}

#[test]
fn list_helpers_survive_the_seed_baseline() {
    let conn = db();
    assert_eq!(list_varieties(&conn).unwrap().len(), 4, "0002 只种了玉米/小麦/稻谷/大豆");
    assert_eq!(list_warehouses(&conn).unwrap().len(), 0, "不灌演示数据：档案由站长在页面上建");
    assert_eq!(list_prices(&conn).unwrap().len(), 0);
    assert_eq!(list_staff(&conn).unwrap().len(), 2, "admin + superadmin");
    assert!(get_station(&conn).is_ok());
}

// --------------------------------------------------------------- 站点参数 §9.3

use std::collections::BTreeSet;
use std::path::Path;

fn setting_input(key: &str, value: &str) -> SettingInput {
    SettingInput { key: key.into(), value: value.into(), verify_note: None }
}

fn only<'a>(rows: &'a [Setting], key: &str) -> &'a Setting {
    rows.iter().find(|s| s.key == key).unwrap_or_else(|| panic!("参数表里没有「{key}」，设置页会缺这一项"))
}

/// 直接看库里的原文：界面上那个扁平值是它解出来的，两边都要能对上
fn raw_json(conn: &Connection, key: &str) -> String {
    conn.query_row("SELECT value_json FROM app_setting WHERE key = ?1", params![key], |r| r.get(0))
        .unwrap()
}

fn audit_reason(conn: &Connection, key: &str) -> String {
    conn.query_row(
        "SELECT reason FROM audit_log WHERE action = 'setting.update' AND entity_no = ?1",
        params![key],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn settings_read_the_whole_table_with_the_station_name_synthetised_first() {
    let conn = db();
    let rows = list_settings(&conn).unwrap();
    let lib_rows: i64 = conn.query_row("SELECT COUNT(*) FROM app_setting", [], |r| r.get(0)).unwrap();
    assert_eq!(rows.len() as i64, lib_rows + 1, "整表 + 合成的站名，一条都不该在读取时丢掉");
    assert_eq!(rows[0].key, "station_name", "站名固定排第一");
    assert!(!rows[0].value.is_empty(), "站名读成空串，参数页的抬头预览就是空的");

    // 界面拿到的必须是解好引号的值：`"A4"` 漏出去就成了下拉框里带引号的一个字
    assert_eq!(raw_json(&conn, "print_paper"), "\"A4\"");
    assert_eq!(only(&rows, "print_paper").value, "A4");
    assert_eq!(only(&rows, "tare_tolerance_pct").value, "300", "§9.3.1 的皮重容差基线动过就要改这里");
}

#[test]
fn the_seven_interface_keys_came_in_with_the_parity_migration() {
    let conn = db();
    let rows = list_settings(&conn).unwrap();
    for key in [
        "stable_window_ms",
        "stable_tolerance_01kg",
        "open_order_alert_minutes",
        "settle_merge_by_day",
        "reprint_need_auth",
        "retention_sample_days",
        "pii_mask_id_card",
    ] {
        assert!(rows.iter().any(|s| s.key == key), "「{key}」没进库，设置页改了也不生效");
    }
    // 0011 起 print_channel 已退役（工作台无预览直打，通道按纸型自动分流），不该复活
    assert!(!rows.iter().any(|s| s.key == "print_channel"), "退役的打印通道参数还留在库里");
}

#[test]
fn a_value_is_encoded_by_the_type_in_the_library_not_the_text_the_ui_sent() {
    let conn = db();
    let a = actor();

    let rows = save_setting(&conn, &a, setting_input("stable_window_ms", " 2000 ")).unwrap();
    assert_eq!(only(&rows, "stable_window_ms").value, "2000");
    assert_eq!(
        raw_json(&conn, "stable_window_ms"),
        "2000",
        "int 键存成带引号的字符串，看板那些按整数读的地方就读成 0 了"
    );

    let e = err_of(save_setting(&conn, &a, setting_input("stable_window_ms", "两秒")));
    assert!(e.contains("整数"), "{e}");
    let e = err_of(save_setting(&conn, &a, setting_input("pii_mask_id_card", "开")));
    assert!(e.contains("开、关"), "{e}");
    assert_eq!(
        only(&list_settings(&conn).unwrap(), "stable_window_ms").value,
        "2000",
        "被拒的那次不该留下半个字"
    );

    save_setting(&conn, &a, setting_input("print_paper", "dot241")).unwrap();
    assert_eq!(raw_json(&conn, "print_paper"), "\"dot241\"");
    assert_eq!(only(&list_settings(&conn).unwrap(), "print_paper").value, "dot241");
}

#[test]
fn a_key_the_library_does_not_have_is_refused_in_plain_words() {
    let conn = db();
    let before = audit_count(&conn, "setting.update", "allow_credit");
    let e = err_of(save_setting(&conn, &actor(), setting_input("allow_credit", "true")));
    assert!(e.contains("库里没有这一项"), "{e}");
    assert!(!e.contains("no such"), "SQLite 原文不该怼到界面上：{e}");
    assert_eq!(audit_count(&conn, "setting.update", "allow_credit"), before);
}

#[test]
fn a_setting_change_leaves_one_audit_row_naming_old_and_new() {
    let conn = db();
    let a = actor();
    save_setting(&conn, &a, setting_input("tare_tolerance_pct", "500")).unwrap();
    assert_eq!(audit_reason(&conn, "tare_tolerance_pct"), "300 → 500");
    assert_eq!(audit_count(&conn, "setting.update", "tare_tolerance_pct"), 1);

    // 真机测不到也要把这笔账留下，否则日后查打印事故查不出是谁在没验过的情况下改的
    save_setting(
        &conn,
        &a,
        SettingInput {
            key: "print_paper".into(),
            value: "thermal80".into(),
            verify_note: Some("未经真机验证".into()),
        },
    )
    .unwrap();
    let reason = audit_reason(&conn, "print_paper");
    assert!(reason.contains("A4 → thermal80") && reason.contains("未经真机验证"), "{reason}");
}

#[test]
fn station_name_writes_the_station_row_and_no_audit_when_nothing_changed() {
    let conn = db();
    let a = actor();
    let rows = save_setting(&conn, &a, setting_input("station_name", "  验收粮油站  ")).unwrap();
    assert_eq!(rows[0].value, "验收粮油站", "首尾空格会跟着进打印抬头");
    assert_eq!(get_station(&conn).unwrap().name, "验收粮油站");
    let as_setting: i64 = conn
        .query_row("SELECT COUNT(*) FROM app_setting WHERE key = 'station_name'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(as_setting, 0, "站名归 §9.2 的 station 表，参数表里再存一份迟早对不上");
    assert_eq!(audit_count(&conn, "setting.update", "station_name"), 1);

    save_setting(&conn, &a, setting_input("station_name", "验收粮油站")).unwrap();
    assert_eq!(audit_count(&conn, "setting.update", "station_name"), 1, "原样保存不该多记一笔");

    let e = err_of(save_setting(&conn, &a, setting_input("station_name", "   ")));
    assert!(e.contains("不能为空"), "{e}");
    assert_eq!(get_station(&conn).unwrap().name, "验收粮油站");
}

/// 目录里的键必须在库里真存在，否则设置页渲染出一行"改了也不生效"的死项——
/// 这正是本轮要根治的漂移。反向不要求：库里新增、目录没补的键由 `mergeSettings`
/// 收进"其它"分组，看得见但提示去补目录，比静默少一项好查。
#[test]
fn every_key_the_frontend_catalog_renders_exists_in_the_library() {
    let src = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/settings-catalog.ts"),
    )
    .expect("前端参数目录应当存在");
    let catalog: BTreeSet<String> = src
        .lines()
        .filter_map(|l| l.split_once("key: \""))
        .filter_map(|(_, rest)| rest.split('"').next())
        .map(str::to_string)
        .collect();
    assert!(catalog.len() >= 30, "只解析出 {} 项，八成是目录写法变了让这个断言空转", catalog.len());

    let conn = db();
    let db_keys: BTreeSet<String> = list_settings(&conn).unwrap().into_iter().map(|s| s.key).collect();
    let missing: Vec<&String> = catalog.iter().filter(|k| !db_keys.contains(*k)).collect();
    assert!(missing.is_empty(), "目录里这些键库里没有：{missing:?}");
}
