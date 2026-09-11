//! 系统与审计页（`src-tauri/src/system.rs`）的行为守卫
//!
//! 这一层的特色是**它一半在测文件系统，不是在测 SQL**：备份/校验/恢复碰的是磁盘上的
//! 库文件本身，纸面 review 看不出"淘汰把待恢复的副本删了"、"改一个字节但结构照样
//! 完整"这类错。所以这里全部用临时目录里的真文件跑，测完删掉。
//!
//! 守的条目：
//!  1. **审计列表**：中文人名能检索到、结果与日期筛选生效、limit 生效、
//!     `authorized_by` 出的是**人名**（库里存的是整数外键）；日期区间按 `at` 的前 10 位比，
//!     跨零点那几小时的留痕不能被 UTC 折算挪到昨天去；
//!  2. **备份**：`VACUUM INTO` 出来的副本能只读打开、校验和旁文件与实算一致、
//!     淘汰只删更旧的且 `.db` 与 `.sha256` 成对消失、写下一条 `backup` 留痕、
//!     文件名注入（`../`）被拒；
//!  3. **校验**：完好副本 `ok=true`；被截断的副本 `ok=false` 且 `integrity` 有内容；
//!     只改**一个字节**的副本必须被校验和拦住（结构照样"完整"，integrity 拦不住它）；
//!  4. **体检**：刚迁移完的库 `integrity_ok=true` 且没有悬挂外键；真的悬挂引用要能报出来；
//!  5. **预检**：不存在的名字、含 `..`/反斜杠的名字、被篡改的副本一律 `ok=false` 且
//!     `errors` 是人话；无旁文件的迁移前快照只给 warning（它是"装错版本"唯一的退路）；
//!  6. **恢复**：确认文案不对、岗位不对都要被拒；成功路径必须走到"当前库被改名保留 +
//!     现库内容等于备份 + 退路副本里还能查到备份之后那张单"。
//!
//! 站点参数只从库里读：`retention_sample_days` / `pii_mask_id_card` 由 0006 补种，
//! 这里断言的是**键在就给值、键删了就给 null**，不写死具体数值——键的存在与否会变，
//! "不替站长编默认值"这条规矩不能变。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection};

use banghe_lib::auth::AuthProfile;
use banghe_lib::db::{self, in_memory_migrated, locked, MIGRATIONS};
use banghe_lib::system::{
    self, apply_restore, check_role, create_backup, list_audit, list_backups, preflight_copy,
    prune_backups, restore_apply_guard, sha256_of, verify_backup, AuditFilters, Locations,
    BACKUP_ROLES, RESTORE_ROLES,
};

// ------------------------------------------------------------------------ 夹具

/// 临时目录守卫：Drop 时先清只读位再递归删——被只读打开过的副本在 Windows 上会留下
/// 删不掉的属性，`remove_dir_all` 直接报错会把 CI 弄成"测试过了但临时目录在涨"。
struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(tag: &str) -> Self {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("banghe-sys-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).expect("临时目录应可创建");
        Self { path }
    }

    fn clear_read_only(dir: &Path) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    Self::clear_read_only(&p);
                } else if let Ok(m) = std::fs::metadata(&p) {
                    let perms = m.permissions();
                    if perms.readonly() {
                        let mut w = perms.clone();
                        w.set_readonly(false);
                        let _ = std::fs::set_permissions(&p, w);
                    }
                }
            }
        }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        Self::clear_read_only(&self.path);
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 内存库 + 全部真实迁移（含种子：站点 id=1 code=01、admin 显示名"站长"、30 个参数键）。
/// 前提变了这里先红。
fn mem_db() -> Connection {
    in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本")
}

/// 临时目录里的真库：走生产同一条启动路径（`open_and_migrate`），于是 `banghe.db`、
/// `backup/`、`app_meta` 都是真的——备份与恢复只有在真文件系统上才测得出东西。
fn file_db(tag: &str) -> (TempDir, Arc<Mutex<Connection>>, Locations) {
    let tmp = TempDir::new(tag);
    let app_dir = tmp.path.clone();
    let (database, _report) = db::open_and_migrate(&app_dir, "0.1.0").expect("临时目录应能建库并完成迁移");
    // 连接句柄拿出来就行：Db 只是个 Arc<Mutex<Connection>> 的壳，壳被 drop 不影响已开的库
    let pool = database.shared();
    (tmp, pool, Locations::new(app_dir))
}

fn actor(role: &str) -> AuthProfile {
    AuthProfile {
        id: 1,
        username: "tester".into(),
        display_name: "测试员".into(),
        role: role.into(),
        must_change_pwd: false,
    }
}

fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

fn set_setting(conn: &Connection, key: &str, value_json: &str) {
    conn.execute(
        "INSERT INTO app_setting (key, value_json, value_type, updated_at) VALUES (?1, ?2, 'int', ?3)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        params![key, value_json, now_iso()],
    )
    .unwrap();
}

fn audit_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM audit_log", [], |r| r.get(0)).unwrap()
}

/// 插一条留痕。`authorized_by` 传的是**用户 id**（§9.21 是外键），
/// 页面上要的人名由 system.rs 的 LEFT JOIN 负责——测试正是去验那次 JOIN。
fn insert_audit(
    conn: &Connection,
    at: &str,
    actor_name: &str,
    action: &str,
    entity: &str,
    entity_no: Option<&str>,
    reason: Option<&str>,
    result: &str,
    authorized_by: Option<i64>,
) -> i64 {
    conn.execute(
        "INSERT INTO audit_log (at, actor_id, actor_name, action, entity, entity_no, reason, result, authorized_by, client_info)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, '测试机 / banghe test')",
        params![at, 1i64, actor_name, action, entity, entity_no, reason, result, authorized_by],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn new_staff(conn: &Connection, username: &str, display_name: &str) -> i64 {
    conn.execute(
        "INSERT INTO user_account (username, display_name, password_hash, role, must_change_pwd, is_active)
         VALUES (?1, ?2, '!set_on_first_run', 'station_master', 1, 1)",
        params![username, display_name],
    )
    .unwrap();
    conn.last_insert_rowid()
}

/// 建一张最小可过 CHECK 的磅单（种子里 party 表是空的，先补一个售粮人）。
fn seed_order(conn: &Connection, no: &str, business_date: &str) -> i64 {
    let party: i64 = match conn.query_row("SELECT id FROM party LIMIT 1", [], |r| r.get(0)) {
        Ok(id) => id,
        Err(_) => {
            conn.execute(
                "INSERT INTO party (name, party_type, created_at, created_by) VALUES ('测试农户', 'farmer', ?1, 1)",
                params![now_iso()],
            )
            .unwrap();
            conn.last_insert_rowid()
        }
    };
    conn.execute(
        "INSERT INTO weigh_order (order_no, station_id, business_date, status, party_id, variety_id,
                                  weight_source, registered_by, registered_at, created_at, created_by)
         VALUES (?1, 1, ?2, 'registered', ?3, 1, 'scale', 1, ?4, ?4, 1)",
        params![no, business_date, party, now_iso()],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn order_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM weigh_order", [], |r| r.get(0)).unwrap()
}

fn backup_dir_of(pool: &Arc<Mutex<Connection>>, loc: &Locations) -> PathBuf {
    locked(pool, |conn| loc.backup_dir(conn))
}

/// 合成时间戳：文件名里的时间决定淘汰顺序，用合成值就不必为了避开同秒重名去 sleep。
fn stamps(n: usize) -> Vec<String> {
    (1..=n).map(|i| format!("20260101-0000{i:02}")).collect()
}

// ------------------------------------------------------------------------ 审计

#[test]
fn audit_list_hits_chinese_names_and_honours_filters() {
    let conn = mem_db();
    insert_audit(&conn, "2026-09-10T09:00:00.000+08:00", "张伟", "order.create", "weigh_order", Some("BD01202609000001"), Some("正常制单"), "ok", None);
    insert_audit(&conn, "2026-09-10T10:00:00.000+08:00", "李四", "tare.override", "weigh_order", Some("BD01202609000002"), Some("皮重异常，站长授权"), "denied", None);
    insert_audit(&conn, "2026-09-11T08:00:00.000+08:00", "王五", "settle.create", "settlement", Some("JS01202609000001"), None, "error", None);

    // 中文人名：instr 走字节子串，不依赖 FTS 也能命中
    let hits = list_audit(&conn, &AuditFilters { keyword: Some("张伟".into()), ..Default::default() }).unwrap();
    assert_eq!(hits.len(), 1, "关键字「张伟」应只命中一条");
    assert_eq!(hits[0].actor_name, "张伟");

    // 单号大小写不敏感（检索框里没人按 Shift）
    let hits = list_audit(&conn, &AuditFilters { keyword: Some("bd01202609000002".into()), ..Default::default() }).unwrap();
    assert_eq!(hits.len(), 1, "小写单号应命中大写落库的那条");
    assert_eq!(hits[0].action, "tare.override");
    // 事由里的中文同样能搜（"皮重异常"没出现在别的列里）
    assert_eq!(list_audit(&conn, &AuditFilters { keyword: Some("皮重异常".into()), ..Default::default() }).unwrap().len(), 1);

    // 结果筛选，值域与 §9.21 的 CHECK 一致
    let denied = list_audit(&conn, &AuditFilters { result: Some("denied".into()), ..Default::default() }).unwrap();
    assert_eq!(denied.iter().map(|a| a.actor_name.as_str()).collect::<Vec<_>>(), vec!["李四"]);
    assert_eq!(list_audit(&conn, &AuditFilters { result: Some("error".into()), ..Default::default() }).unwrap().len(), 1);
    assert_eq!(list_audit(&conn, &AuditFilters { result: Some("ok".into()), ..Default::default() }).unwrap().len(), 1);
    // 页面下拉框的"全部"传 all / 空，都不该当成筛选项
    assert_eq!(list_audit(&conn, &AuditFilters { result: Some("all".into()), ..Default::default() }).unwrap().len(), 3);
    let bogus = list_audit(&conn, &AuditFilters { result: Some("成功".into()), ..Default::default() });
    assert!(bogus.is_err(), "值域外的筛选要回中文错误，不能静默返回全量");
    assert!(bogus.unwrap_err().contains("值域"));

    // limit + at DESC
    let page = list_audit(&conn, &AuditFilters { limit: Some(2), ..Default::default() }).unwrap();
    assert_eq!(page.len(), 2, "limit 必须生效（否则审计页把整张表拉进浏览器）");
    assert_eq!(page[0].actor_name, "王五", "最新的留痕必须排第一行");
    assert_eq!(page[1].actor_name, "李四");
    assert_eq!(list_audit(&conn, &AuditFilters { limit: Some(0), ..Default::default() }).unwrap().len(), 1, "0 夹到 1，不是 0 行");
    assert_eq!(list_audit(&conn, &AuditFilters { limit: Some(-5), ..Default::default() }).unwrap().len(), 1);
    assert_eq!(list_audit(&conn, &AuditFilters { limit: Some(99999), ..Default::default() }).unwrap().len(), 3, "超上限夹到 2000 而不是无界");

    // 空 filters / 全空格 keyword = 不过滤，也不能炸
    assert_eq!(list_audit(&conn, &AuditFilters::default()).unwrap().len(), 3);
    assert_eq!(list_audit(&conn, &AuditFilters { keyword: Some("   ".into()), ..Default::default() }).unwrap().len(), 3);
    // 详情页要展开前后值，这些列不能缺
    let one = &list_audit(&conn, &AuditFilters::default()).unwrap()[0];
    assert!(one.before_json.is_none() && one.after_json.is_none() && one.error_msg.is_none());
    assert_eq!(one.client_info.as_deref(), Some("测试机 / banghe test"));
}

#[test]
fn audit_list_authorizes_by_person_name_not_by_id() {
    let conn = mem_db();
    let uid = new_staff(&conn, "boss", "王站长");
    let id = insert_audit(&conn, "2026-09-10T10:00:00.000+08:00", "李四", "tare.override", "weigh_order", Some("BD01202609000002"), Some("皮重异常"), "ok", Some(uid));
    let orphan = insert_audit(&conn, "2026-09-10T11:00:00.000+08:00", "李四", "order.void", "weigh_order", None, None, "ok", None);

    // 库里存的是整数外键，这一点不能被查询改掉
    let raw: i64 = conn.query_row("SELECT authorized_by FROM audit_log WHERE id = ?1", params![id], |r| r.get(0)).unwrap();
    assert_eq!(raw, uid, "§9.21 的 authorized_by 是 user_account 外键");

    let rows = list_audit(&conn, &AuditFilters::default()).unwrap();
    let with_auth = rows.iter().find(|a| a.id == id).unwrap();
    assert_eq!(with_auth.authorized_by.as_deref(), Some("王站长"), "页面这一列直接显示人名");
    assert_ne!(with_auth.authorized_by.as_deref(), Some(uid.to_string().as_str()));
    // 没有授权人的记录（多数留痕都是）如实 null，而不是 0 或 "—" 这种编出来的值
    assert_eq!(rows.iter().find(|a| a.id == orphan).unwrap().authorized_by, None);

    // 授权人账号被删也不该把整行留痕丢掉：LEFT JOIN，人名退回 null
    conn.execute("PRAGMA foreign_keys=OFF", []).unwrap();
    conn.execute("DELETE FROM user_account WHERE id = ?1", params![uid]).unwrap();
    conn.execute("PRAGMA foreign_keys=ON", []).unwrap();
    let rows = list_audit(&conn, &AuditFilters::default()).unwrap();
    let kept = rows.iter().find(|a| a.id == id).expect("授权人被删，留痕本身必须还在");
    assert_eq!(kept.authorized_by, None);
    assert_eq!(kept.actor_name, "李四", "actor_name 是快照，不受账号增删影响");
}

#[test]
fn audit_list_date_range_uses_local_day_not_utc() {
    let conn = mem_db();
    // 00:30 +08:00 = 前一天 16:30 UTC。谁用 date()/julianday 比较，这条就会被挪到 09-10。
    insert_audit(&conn, "2026-09-11T00:30:00.000+08:00", "张伟", "order.create", "weigh_order", Some("BD1"), Some("跨零点的单"), "ok", None);
    insert_audit(&conn, "2026-09-12T23:30:00.000+08:00", "李四", "order.create", "weigh_order", Some("BD2"), None, "ok", None);

    let same_day = list_audit(&conn, &AuditFilters {
        date_from: Some("2026-09-11".into()),
        date_to: Some("2026-09-11".into()),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(same_day.len(), 1, "00:30+08:00 的记录属于 09-11 这天，不能被 UTC 折算吞掉");
    assert_eq!(same_day[0].actor_name, "张伟");
    assert_eq!(list_audit(&conn, &AuditFilters { date_to: Some("2026-09-11".into()), ..Default::default() }).unwrap().len(), 1);
    let from12 = list_audit(&conn, &AuditFilters { date_from: Some("2026-09-12".into()), ..Default::default() }).unwrap();
    assert_eq!(from12.len(), 1);
    assert_eq!(from12[0].actor_name, "李四");

    for bad in ["2026-9-1", "2026/09/11", "2026-09-11T00:00", "全部", "2026-09-111"] {
        let e = list_audit(&conn, &AuditFilters { date_from: Some(bad.into()), ..Default::default() }).unwrap_err();
        assert!(e.contains("YYYY-MM-DD"), "日期格式错误要回人话：{e}");
    }
    let reversed = list_audit(&conn, &AuditFilters {
        date_from: Some("2026-09-12".into()),
        date_to: Some("2026-09-11".into()),
        ..Default::default()
    });
    assert!(reversed.is_err(), "区间反了不能当成空结果静默放过");
}

// ------------------------------------------------------------------------ 备份

#[test]
fn backup_run_produces_a_usable_copy_with_sidecar() {
    let (tmp, pool, loc) = file_db("backup-run");
    let actor = actor("station_master");
    let dir = backup_dir_of(&pool, &loc);
    assert_eq!(dir, tmp.path.join("backup"), "默认备份目录就是 AppDataDir/backup（§7）");

    let file = locked(&pool, |conn| {
        seed_order(conn, "BD01202609000001", "2026-09-10");
        create_backup(conn, &loc, &actor, "manual", &stamps(1)[0], &[])
    })
    .unwrap();
    assert_eq!(file.name, "banghe_20260101-000001_manual.db");
    assert_eq!(file.kind, "manual");
    assert!(file.path.ends_with(&file.name));
    assert!(file.size_bytes > 0);
    assert_eq!(file.pruned.as_deref(), Some(&[][..]), "没到保留数就不该删任何东西");
    let path = PathBuf::from(&file.path);
    assert!(path.is_file(), "回执里的路径必须真的存在");

    // 旁文件与实算一致，列表读出来的就是这个值
    let real = sha256_of(&path).unwrap();
    assert_eq!(file.sha256.as_deref(), Some(real.as_str()));
    assert_eq!(real.len(), 64);
    assert_eq!(std::fs::read_to_string(format!("{}.sha256", path.display())).unwrap().trim(), real);
    let listed = list_backups(&dir);
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].sha256_ok, Some(true));
    assert_eq!(listed[0].kind, "manual");

    // 副本是真能打开、真能查的库，不是一个看起来正常的空文件
    let v = verify_backup(&dir, &file.name).unwrap();
    assert!(v.ok, "完好副本必须校验通过：{}", v.integrity);
    assert_eq!(v.integrity, "ok");
    assert_eq!(v.orders, 1);
    assert!(v.page_count > 0);
    // 留痕在 VACUUM INTO **之后**才写，所以副本里不含这次备份自己的记录——
    // 这条顺序钉住，否则"备份发生在备份内容里"会绕出一个说不清的自指。
    assert_eq!(v.audit_rows, 0);
    let after = locked(&pool, audit_count);
    assert_eq!(after, 1);

    // 留痕写的是人话：文件名 + 大小都进去，事后对账能直接找到那个文件
    let (reason, entity, action): (String, String, String) = locked(&pool, |conn| {
        conn.query_row(
            "SELECT reason, entity, action FROM audit_log WHERE action = 'backup' ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap()
    });
    assert_eq!(action, "backup");
    assert_eq!(entity, "app_meta", "§9.21 的 entity 是表名，备份没有专属表");
    assert!(reason.contains(&file.name) && reason.contains(&file.size_bytes.to_string()), "事由应写明文件名与大小：{reason}");

    // 备份页的读数全部来自真库真文件
    let status = locked(&pool, |conn| system::collect_backup_status(conn, &loc)).unwrap();
    assert_eq!(status.backups.len(), 1);
    assert_eq!(status.audit_rows, after);
    assert_eq!(status.doc_oldest_date.as_deref(), Some("2026-09-10"));
    assert!(status.db_size_bytes > 0);
    assert_eq!(status.keep_count, 30, "0002 种的 backup_keep_count");
    assert_eq!(status.attachment_keep_days, 3650);
    assert_eq!(status.last_backup_at.as_deref(), Some(status.backups[0].created_at.as_str()));
    assert_eq!(status.backup_dir, dir.to_string_lossy().to_string());
}

#[test]
fn backup_status_reports_settings_only_as_stored() {
    let conn = mem_db();
    let loc = Locations::new(std::env::temp_dir());
    // 0006 把两个键补进了 app_setting，所以正常库里它们有值
    let s = system::collect_backup_status(&conn, &loc).unwrap();
    assert_eq!(s.retention_sample_days, Some(30), "0006 补种后读得到真实值");
    assert_eq!(s.pii_mask_id_card, Some(true));
    assert!(s.backups.is_empty() && s.last_backup_at.is_none());
    assert_eq!(s.audit_rows, 0);
    assert_eq!(s.doc_oldest_date, None, "一张单都没有时不编日期");

    // 键被删掉（老副本被恢复回来、或站长自己删过参数行）时如实 null——
    // 后端替站长填一个"合规"的默认值，合规自查那一栏就成假的了
    conn.execute("DELETE FROM app_setting WHERE key = 'retention_sample_days'", []).unwrap();
    conn.execute("DELETE FROM app_setting WHERE key = 'pii_mask_id_card'", []).unwrap();
    let s = system::collect_backup_status(&conn, &loc).unwrap();
    assert_eq!(s.retention_sample_days, None);
    assert_eq!(s.pii_mask_id_card, None);
    // 有历史默认值的键仍然回退（0002 一直如此），两种处理的区别在 §9.3.1 有没有这个键
    assert_eq!(s.keep_count, 30);
}

#[test]
fn backup_run_prunes_only_older_copies_and_deletes_pairs() {
    let (_tmp, pool, loc) = file_db("prune");
    let actor = actor("cashier");
    let (dir, first, third) = {
        let conn = pool.lock().unwrap();
        set_setting(&conn, "backup_keep_count", "2");
        let s = stamps(3);
        let a = create_backup(&conn, &loc, &actor, "manual", &s[0], &[]).unwrap();
        let b = create_backup(&conn, &loc, &actor, "manual", &s[1], &[]).unwrap();
        let c = create_backup(&conn, &loc, &actor, "manual", &s[2], &[]).unwrap();
        (loc.backup_dir(&conn), a, (b, c))
    };
    let (second, newest) = third;

    let names: Vec<String> = list_backups(&dir).iter().map(|f| f.name.clone()).collect();
    assert_eq!(names.len(), 2, "保留数 2 就该只剩 2 份");
    assert!(names.contains(&newest.name), "刚生成的那份永不删除：{names:?}");
    assert!(names.contains(&second.name), "淘汰的只能是最旧的：{names:?}");
    assert!(!names.contains(&first.name));
    assert_eq!(newest.pruned.as_deref(), Some(&[first.name.clone()][..]));
    assert_eq!(newest.prune_error, None);
    assert!(!Path::new(&first.path).exists(), "最旧的那份应被删除");
    assert!(!PathBuf::from(format!("{}.sha256", first.path)).exists(), "旁文件必须成对删除");
    for f in &names {
        let p = dir.join(f);
        assert!(p.is_file());
        assert!(PathBuf::from(format!("{}.sha256", p.display())).is_file(), "{f} 的旁文件不该被牵连删掉");
    }

    // pre_migrate 快照不参与淘汰：它是"库结构版本超前"时唯一的退路
    let snapshot = dir.join("pre_migrate_0000_to_0006_20260101-000000.db");
    std::fs::write(&snapshot, b"not really a db").unwrap();
    let (victims, errs) = prune_backups(&dir, 1, &[]);
    assert!(errs.is_empty(), "{errs:?}");
    assert!(!victims.iter().any(|v| v.starts_with("pre_migrate_")), "迁移前快照不能被淘汰：{victims:?}");
    assert!(snapshot.exists(), "迁移前快照必须还在盘上：{victims:?}");
    assert_eq!(victims, vec![second.name.clone()], "保留 1 份时只留最新那份");
    std::fs::remove_file(&snapshot).ok();
}

#[test]
fn backup_run_rejects_injected_kind_and_bad_stamp() {
    let (_tmp, pool, loc) = file_db("inject");
    let actor = actor("station_master");
    for bad in ["../../windows/system32/calc", "a b.db", "..", "manual; drop table", "手动"] {
        let e = locked(&pool, |conn| create_backup(conn, &loc, &actor, bad, "20260101-000001", &[])).unwrap_err();
        assert!(e.contains("备份类型"), "{bad} 应被当作非法类型拒绝：{e}");
    }
    // 空 / 缺省的 kind 落回 manual
    let f = locked(&pool, |conn| create_backup(conn, &loc, &actor, "  ", "20260101-000002", &[])).unwrap();
    assert_eq!(f.kind, "manual");
    assert_eq!(f.name, "banghe_20260101-000002_manual.db");
    // pre-restore 这种带短横的合法值必须放行（恢复流程就用它）
    assert!(locked(&pool, |conn| create_backup(conn, &loc, &actor, "pre-restore", "20260101-000003", &[])).is_ok());
    // 时间戳是内部值，格式不对一样不许进文件名
    assert!(locked(&pool, |conn| create_backup(conn, &loc, &actor, "manual", "../x", &[])).is_err());
    assert!(locked(&pool, |conn| create_backup(conn, &loc, &actor, "manual", "2026-01-01", &[])).is_err());
    // 同一秒再点一次：宁可拒绝也不能悄悄覆盖掉已有的退路
    let dup = locked(&pool, |conn| create_backup(conn, &loc, &actor, "manual", "20260101-000002", &[])).unwrap_err();
    assert!(dup.contains("隔一秒"), "同秒重名应回可重试的提示：{dup}");
    // 非法入参不能留下半个文件
    assert!(list_backups(&backup_dir_of(&pool, &loc)).iter().all(|f| f.name.starts_with("banghe_")));
}

#[test]
fn backup_verify_catches_truncated_and_single_byte_edits() {
    let (_tmp, pool, loc) = file_db("verify");
    let actor = actor("station_master");
    let dir = locked(&pool, |conn| {
        seed_order(conn, "BD01202609000009", "2026-09-11");
        create_backup(conn, &loc, &actor, "manual", &stamps(1)[0], &[]).unwrap();
        loc.backup_dir(conn)
    });
    let name = "banghe_20260101-000001_manual.db";
    let path = dir.join(name);
    assert!(verify_backup(&dir, name).unwrap().ok, "完好副本必须 ok");

    // 改一个字节：结构照样"完整"，integrity_check 未必看得出来 —— 只有校验和拦得住
    let keep = sha256_of(&path).unwrap();
    let mut bytes = std::fs::read(&path).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0xFF;
    std::fs::write(&path, &bytes).unwrap();
    let v = verify_backup(&dir, name).unwrap();
    assert!(!v.ok, "被改过一个字节的副本不能报 ok");
    assert!(!v.sha256_matches);
    assert_eq!(v.sha256_expected.as_deref(), Some(keep.as_str()), "旁文件的值要原样报出来，好让站长比对");
    assert_ne!(v.sha256_actual, keep);
    assert!(!v.integrity.is_empty(), "integrity 必须有内容可看");

    // 截断到只剩头一页：完整性检查本身就该过不去
    std::fs::write(&path, &bytes[..4096]).unwrap();
    let v = verify_backup(&dir, name).unwrap();
    assert!(!v.ok);
    assert!(!v.integrity.is_empty(), "截断的副本必须给出诊断文本");
    assert_ne!(v.integrity, "ok", "只剩一页的库不可能通过 integrity_check：{}", v.integrity);
    assert_eq!(v.orders, 0, "结构不过关时不去查行数");

    // 旁文件缺失 = 无从判定：列表里如实 null，既不算通过也不算损坏
    std::fs::remove_file(format!("{}.sha256", path.display())).unwrap();
    let listed = list_backups(&dir);
    assert_eq!(listed[0].sha256, None);
    assert_eq!(listed[0].sha256_ok, None);
    let v = verify_backup(&dir, name).unwrap();
    assert!(!v.ok && !v.sha256_matches && v.sha256_expected.is_none());
}

#[test]
fn verify_and_prune_survive_a_missing_backup_dir() {
    let (tmp, _pool, _loc) = file_db("nodir");
    let dir = tmp.path.join("backup");
    assert!(!dir.exists(), "没备份过就不该凭空出现备份目录");
    assert!(list_backups(&dir).is_empty(), "目录不存在时列表为空而不是炸掉");
    let (v, e) = prune_backups(&dir, 3, &[]);
    assert!(v.is_empty() && e.is_empty());
    let err = verify_backup(&dir, "banghe_20260101-000001_manual.db").unwrap_err();
    assert!(err.contains("不存在"), "缺目录时报的是\"文件不存在\"，不是 IO 天书：{err}");
    assert!(err.contains("backup"), "错误里要带上它找过的目录：{err}");
}

// ------------------------------------------------------------------------ 体检

#[test]
fn health_report_on_a_fresh_library_is_clean() {
    let conn = mem_db();
    let loc = Locations::new(std::env::temp_dir());
    let h = system::collect_health(&conn, &loc).unwrap();
    assert!(h.integrity_ok, "刚迁移完的库必须干净：{}", h.integrity);
    assert_eq!(h.integrity, "ok");
    assert!(h.fk_violations.is_empty(), "迁移后的悬挂外键本就该被 post_checks 拦住：{:?}", h.fk_violations);
    assert_eq!(h.counts.weigh_order, 0);
    assert_eq!(h.counts.settlement, 0);
    assert_eq!(h.counts.attachment, 0);
    assert_eq!(h.counts.audit_log, 0, "0002/0003 不种演示留痕");
    assert_eq!(h.app_version.as_deref(), Some("0.1.0"));
    assert_eq!(h.schema_version, Some(db::migrate::max_version(MIGRATIONS).to_string()));
    assert_eq!(h.last_backup_at, None, "一份备份都没有时不许编时间");
}

#[test]
fn health_report_flags_a_dangling_reference() {
    let (_tmp, pool, loc) = file_db("fk");
    let (journal, page_size, size, integrity_ok) = {
        let conn = pool.lock().unwrap();
        // 现场要能看见"哪张单挂了哪个不存在的户"。绕过 FK 闸门造一条脏数据。
        conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        conn.execute(
            "INSERT INTO weigh_order (order_no, station_id, business_date, status, party_id, variety_id,
                                       weight_source, registered_by, registered_at, created_at, created_by)
             VALUES ('BD01X', 1, '2026-09-10', 'registered', 999999, 1, 'scale', 1, ?1, ?1, 1)",
            params![now_iso()],
        )
        .unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let h = system::collect_health(&conn, &loc).unwrap();
        assert_eq!(h.counts.weigh_order, 1);
        assert_eq!(h.fk_violations.len(), 1, "{:?}", h.fk_violations);
        assert!(h.fk_violations[0].starts_with("weigh_order(rowid "), "每条都要带表名与 rowid：{}", h.fk_violations[0]);
        assert!(h.fk_violations[0].contains("party"), "要指明挂在哪个父表：{}", h.fk_violations[0]);
        // 有悬挂引用不等于完整性坏了——两件事分开报，界面才能分开配色
        assert!(h.integrity_ok);
        (h.journal_mode, h.page_size, h.db_size_bytes, h.integrity_ok)
    };
    assert_eq!(journal, "wal", "§10.4 要求生产走 WAL");
    assert!(page_size >= 512);
    assert!(size > 0, "文件体检要报真实体积");
    assert!(integrity_ok);
    assert!(locked(&pool, |conn| system::collect_health(conn, &loc)).unwrap().fk_violations.len() == 1, "结论必须稳定，不是读一次少一次");
}

#[test]
fn health_report_caps_the_foreign_key_sample() {
    let conn = mem_db();
    let loc = Locations::new(std::env::temp_dir());
    conn.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
    for i in 0..60 {
        conn.execute(
            "INSERT INTO weigh_order (order_no, station_id, business_date, status, party_id, variety_id,
                                      weight_source, registered_by, registered_at, created_at, created_by)
             VALUES (?1, 1, '2026-09-10', 'registered', ?2, 1, 'scale', 1, ?3, ?3, 1)",
            params![format!("BD{i:02}"), 900000 + i, now_iso()],
        )
        .unwrap();
    }
    let h = system::collect_health(&conn, &loc).unwrap();
    assert_eq!(h.fk_violations.len(), 50, "体检样例必须封顶，不能把几万条脏数据怼给界面");
    assert_eq!(h.counts.weigh_order, 60, "行数照常全量统计，封顶只针对样例清单");
}

// ------------------------------------------------------------------------ 预检

#[test]
fn preflight_rejects_missing_and_traversing_names() {
    let (_tmp, pool, loc) = file_db("preflight-names");
    let dir = backup_dir_of(&pool, &loc);
    let bad = [
        "banghe_20200101-000000_manual.db",
        "../banghe.db",
        "..\\..\\banghe.db",
        "sub/banghe_x.db",
        "sub\\banghe_x.db",
        "x.db/../y.db",
        "",
        "not_a_backup.txt",
    ];
    for name in bad {
        let p = locked(&pool, |conn| preflight_copy(conn, &dir, name)).unwrap();
        assert!(!p.ok, "非法或不存在的副本名必须判否：{name:?}");
        assert!(!p.errors.is_empty(), "{name:?} 必须给出可读原因");
        assert!(
            p.errors[0].chars().any(|c| !c.is_ascii()),
            "原因要写成中文人话，直接把 IO/SQLite 文本怼上去没法看：{:?}",
            p.errors[0]
        );
    }
    // 绝对路径也不能被当成"名字"用（那正是路径穿越想干的事）
    let abs = loc.db_path().to_string_lossy().to_string();
    let p = locked(&pool, |conn| preflight_copy(conn, &dir, &abs)).unwrap();
    assert!(!p.ok && !p.errors.is_empty());
    // 判否时字段留空，不是编一个 0 字节的"看起来像报告"的东西
    assert_eq!(p.orders, 0);
    assert_eq!(p.size_bytes, 0);
    assert!(p.created_at.is_none());
}

#[test]
fn preflight_accepts_a_real_copy_and_flags_a_tampered_one() {
    let (_tmp, pool, loc) = file_db("preflight-ok");
    let actor = actor("station_master");
    let (dir, name) = locked(&pool, |conn| {
        seed_order(conn, "BD01202609000001", "2026-09-09");
        seed_order(conn, "BD01202609000002", "2026-09-11");
        let f = create_backup(conn, &loc, &actor, "manual", &stamps(1)[0], &[]).unwrap();
        (loc.backup_dir(conn), f.name)
    });

    let p = locked(&pool, |conn| preflight_copy(conn, &dir, &name)).unwrap();
    // 站点名不在测试里写死（种子改一次就假红），证的是"预检回的名字 == 副本里的名字"
    let seed_station: String = locked(&pool, |conn| {
        conn.query_row("SELECT name FROM station WHERE id = 1", [], |r| r.get(0)).unwrap()
    });
    assert!(p.ok, "完好副本该通过预检：{:?}", p.errors);
    assert_eq!(p.orders, 2);
    assert_eq!(p.settlements, 0);
    assert_eq!(p.station_code.as_deref(), Some("01"), "站点档案必须从**副本**里读出来");
    assert_eq!(p.station_name.as_deref(), Some(seed_station.as_str()));
    assert_eq!(p.oldest_date.as_deref(), Some("2026-09-09"));
    assert_eq!(p.newest_date.as_deref(), Some("2026-09-11"));
    assert_eq!(p.integrity, "ok");
    assert_eq!(p.schema_version, p.current_schema_version, "同一份代码生成的库，版本应当相等");
    assert_eq!(p.size_bytes, std::fs::metadata(dir.join(&name)).unwrap().len() as i64);
    assert!(p.errors.is_empty(), "{:?}", p.errors);

    // 篡改：预检判否，原因里要点名校验和
    let path = dir.join(&name);
    let mut bytes = std::fs::read(&path).unwrap();
    let mid = bytes.len() / 2;
    bytes[mid] ^= 0x01;
    std::fs::write(&path, &bytes).unwrap();
    let p = locked(&pool, |conn| preflight_copy(conn, &dir, &name)).unwrap();
    assert!(!p.ok);
    assert!(p.errors.iter().any(|e| e.contains("校验和")), "{:?}", p.errors);

    // 没有旁文件的快照只给 warning，不判否（否则装错版本时唯一能退的库反而恢复不了）
    let snapshot = "pre_migrate_0000_to_0006_20260101-000009.db";
    std::fs::copy(dir.join(&name), dir.join(snapshot)).unwrap();
    let p = locked(&pool, |conn| preflight_copy(conn, &dir, snapshot)).unwrap();
    assert!(p.warnings.iter().any(|w| w.contains("校验和")), "{:?}", p.warnings);
    assert!(!p.errors.iter().any(|e| e.contains("校验和")), "缺旁文件不是错误：{:?}", p.errors);
}

#[test]
fn preflight_refuses_a_copy_whose_schema_the_app_cannot_open() {
    // 恢复一份"结构版本超前"的库，会让应用直接拒绝启动（migrate.rs 的 Downgrade）。
    // 这必须是预检里的 error，而不是换完库之后才发现的砖。
    let (_tmp, pool, loc) = file_db("preflight-version");
    let actor = actor("station_master");
    let (dir, name) = locked(&pool, |conn| {
        seed_order(conn, "BD01202609000003", "2026-09-10");
        let f = create_backup(conn, &loc, &actor, "manual", &stamps(1)[0], &[]).unwrap();
        (loc.backup_dir(conn), f.name)
    });
    // 只读打不开就改不了，所以复制一份"未来版本"的库：直接改 app_meta 记账
    let path = dir.join(&name);
    {
        let rw = Connection::open(&path).unwrap();
        rw.execute("UPDATE app_meta SET value = '99' WHERE key = 'schema_version'", []).unwrap();
    }
    // 改了字节 → 校验和必然对不上，先看这条被拦住
    let p = locked(&pool, |conn| preflight_copy(conn, &dir, &name)).unwrap();
    assert!(!p.ok && p.errors.iter().any(|e| e.contains("校验和")), "{:?}", p.errors);

    // 清掉旁文件后绕过校验和，版本比较那条检查仍必须独立成立
    std::fs::remove_file(format!("{}.sha256", path.display())).unwrap();
    let p = locked(&pool, |conn| preflight_copy(conn, &dir, &name)).unwrap();
    assert!(!p.ok, "{:?}", p.errors);
    assert_eq!(p.schema_version.as_deref(), Some("99"));
    assert!(p.errors.iter().any(|e| e.contains("拒绝启动") || e.contains("高于")), "{:?}", p.errors);
}

// ------------------------------------------------------------------------ 恢复

#[test]
fn restore_requires_verbatim_confirm_and_the_right_role() {
    let (_tmp, pool, loc) = file_db("restore-gate");
    let owner = actor("station_master");
    let name = locked(&pool, |conn| create_backup(conn, &loc, &owner, "manual", &stamps(1)[0], &[])).unwrap().name;
    let before = order_count(&pool.lock().unwrap());

    for wrong in ["", "  ", "确认恢复", "恢复 备份", "RESTORE", "restore", "确认要恢复备份"] {
        let e = apply_restore(&pool, &loc, &owner, &name, wrong).unwrap_err();
        assert!(e.contains("恢复备份"), "确认文案不对时要告诉站长该输入什么：{e}");
    }
    assert_eq!(order_count(&pool.lock().unwrap()), before, "确认不通过时一个字节都不许动");
    assert!(apply_restore(&pool, &loc, &owner, "banghe_19700101-000000_manual.db", "恢复备份").is_err());

    // 岗位闸门（命令层用的就是这份 check_role，所以测它等于测线上那条）
    for role in ["registrar", "weigher", "inspector", "keeper", "viewer"] {
        let e = check_role(&actor(role), RESTORE_ROLES, "恢复备份（请找站长）").unwrap_err();
        assert!(e.contains("岗位") && e.contains("station_master"), "{role} 应被拒：{e}");
    }
    assert!(check_role(&actor("station_master"), RESTORE_ROLES, "恢复备份").is_ok());
    assert!(check_role(&actor("cashier"), BACKUP_ROLES, "手动备份").is_ok());
    assert!(check_role(&actor("weigher"), BACKUP_ROLES, "手动备份").is_err(), "过磅员不该能触发备份");
    assert!(check_role(&actor("cashier"), RESTORE_ROLES, "恢复备份").is_err(), "出纳能备份，但不能换库");
    // 首登未改密的账号一律挡住：占位哈希状态下做任何不可逆动作都不合适
    let mut unset = actor("station_master");
    unset.must_change_pwd = true;
    assert!(check_role(&unset, RESTORE_ROLES, "恢复备份").is_err());
    // 命令层真正调的是这道守卫（岗位与首登改密都在里面），所以这里也走它
    assert!(restore_apply_guard(&pool, &loc, &unset, &name, "恢复备份").is_err(), "改密前连换库也不许");
    assert_eq!(order_count(&pool.lock().unwrap()), before, "被岗位挡住时同样一个字节都不许动");
}

#[test]
fn restore_swaps_the_live_db_and_keeps_the_old_file() {
    let (tmp, pool, loc) = file_db("restore-apply");
    let actor = actor("station_master");
    let live = tmp.path.join("banghe.db");

    // 备份里有 BD-0001；备份之后再写一张 BD-9999，用来验证"恢复真的把后来的丢掉了"
    let name = locked(&pool, |conn| {
        seed_order(conn, "BD01202609000001", "2026-09-09");
        create_backup(conn, &loc, &actor, "manual", &stamps(1)[0], &[])
    })
    .unwrap()
    .name;
    locked(&pool, |conn| {
        seed_order(conn, "BD01202609009999", "2026-09-12");
    });
    assert_eq!(order_count(&pool.lock().unwrap()), 2);

    let out = restore_apply_guard(&pool, &loc, &actor, &name, "恢复备份").expect("成功路径不该失败");
    assert!(out.ok && out.restart_required, "换库必须要求重启：{out:?}");

    // ① 旧库是**改名**而不是删除，并且旧库里那张后补的单还在（这就是回退的凭据）
    let old = PathBuf::from(&out.old_db_path);
    assert!(old.exists(), "旧库必须还在：{}", old.display());
    assert!(old.to_string_lossy().contains(".old-"), "旧库按 banghe.db.old-<时间戳> 保留：{out:?}");
    let recovered: i64 = {
        let ro = Connection::open_with_flags(&old, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap_or_else(|e| panic!("旧库 {} 应能只读打开：{e}", old.display()));
        ro.query_row("SELECT count(*) FROM weigh_order WHERE order_no = 'BD01202609009999'", [], |r| r.get(0))
            .unwrap()
    };
    assert_eq!(recovered, 1, "旧库里应有备份之后那张单——它是唯一能救回来的东西");

    // ② 换库前强制生成的退路备份
    let dir = backup_dir_of(&pool, &loc);
    assert!(out.safety_backup.starts_with("banghe_") && out.safety_backup.ends_with(".db"));
    assert!(out.safety_backup.contains("pre-restore"), "退路备份的 kind 必须能自证身份：{}", out.safety_backup);
    assert!(dir.join(&out.safety_backup).is_file());

    // ③ 现库内容 == 备份内容：后补的单没了，恢复前的单在，且新库里留下了 restore 审计
    let (orders, restore_rows) = locked(&pool, |conn| {
        (
            order_count(conn),
            conn.query_row::<i64, _, _>("SELECT count(*) FROM audit_log WHERE action = 'restore'", [], |r| r.get(0)).unwrap(),
        )
    });
    assert_eq!(orders, 1, "换库后现库只剩备份里那一张单");
    assert_eq!(restore_rows, 1, "留痕写在新库上：这份数据自带\"哪天被换上来的\"证据");
    let reason: String = locked(&pool, |conn| {
        conn.query_row("SELECT reason FROM audit_log WHERE action = 'restore'", [], |r| r.get(0)).unwrap()
    });
    assert!(
        reason.contains(&name) && reason.contains(&out.safety_backup) && reason.contains(&out.old_db_path),
        "事由必须能三件对上：{reason}"
    );

    // ④ 现库仍然可用（连接被就地换掉，WAL 重新起来了）
    let h = locked(&pool, |conn| system::collect_health(conn, &loc)).unwrap();
    assert!(h.integrity_ok, "换库后的库必须能通过完整性检查：{}", h.integrity);
    assert!(h.fk_violations.is_empty(), "{:?}", h.fk_violations);
    assert_eq!(h.counts.weigh_order, 1);
    assert_eq!(h.journal_mode, "wal");
    assert!(live.is_file());
}

#[test]
fn restore_aborts_before_touching_files_when_preflight_fails() {
    let (tmp, pool, loc) = file_db("restore-abort");
    let actor = actor("station_master");
    let name = locked(&pool, |conn| create_backup(conn, &loc, &actor, "manual", &stamps(1)[0], &[])).unwrap().name;
    let dir = backup_dir_of(&pool, &loc);

    // 把副本改脏 → 预检必挂
    let path = dir.join(&name);
    let mut bytes = std::fs::read(&path).unwrap();
    let third = bytes.len() / 3;
    bytes[third] ^= 0xAA;
    std::fs::write(&path, &bytes).unwrap();

    let before = listing(&tmp.path);
    let e = apply_restore(&pool, &loc, &actor, &name, "恢复备份").unwrap_err();
    assert!(e.contains("预检"), "要先说清停在预检：{e}");
    assert_eq!(before, listing(&tmp.path), "预检没过时 app_dir 里一个文件都不许多出来：{e}");
    // 现库还能正常应答（预检全程只读，连接没被换过）
    let station: String = locked(&pool, |conn| {
        conn.query_row("SELECT name FROM station WHERE id = 1", [], |r| r.get(0)).unwrap()
    });
    assert!(!station.is_empty(), "现库还能正常应答（预检全程只读，连接没被换过）");
}

#[test]
fn prune_keeps_a_copy_that_a_restore_is_about_to_use() {
    // 恢复一份**很旧**的副本时，第②步生成的退路备份会占掉保留名额；
    // 待恢复的那一份必须一起进保护名单，否则第②步就把第⑤步要用的文件删了。
    let (_tmp, pool, loc) = file_db("prune-protect");
    let actor = actor("station_master");
    let (dir, old_name) = locked(&pool, |conn| {
        set_setting(conn, "backup_keep_count", "1");
        seed_order(conn, "BD01202609000007", "2026-09-08");
        let f = create_backup(conn, &loc, &actor, "manual", &stamps(1)[0], &[]).unwrap();
        (loc.backup_dir(conn), f.name)
    });
    assert!(dir.join(&old_name).is_file());

    let out = apply_restore(&pool, &loc, &actor, &old_name, "恢复备份")
        .expect("待恢复的旧副本必须被保护，不能被退路备份挤掉名额");
    assert!(out.safety_backup.contains("pre-restore"), "{out:?}");
    assert!(dir.join(&old_name).is_file(), "恢复完成后，作为输入的副本仍在盘上（它是拷过去的，不是搬走的）");
}

#[test]
fn filename_grammar_helpers_stay_inside_their_grammar() {
    assert_eq!(system::kind_of("banghe_20260101-000001_pre-restore.db"), "pre-restore");
    assert_eq!(system::kind_of("banghe_20260101-000001_manual.db"), "manual");
    assert_eq!(system::kind_of("pre_migrate_0000_to_0006_20260101-000001.db"), "pre");
    assert_eq!(system::kind_of("odd.db"), "odd");
    assert_eq!(system::name_stamp("banghe_20260101-000001_manual.db").as_deref(), Some("20260101-000001"));
    assert_eq!(system::name_stamp("banghe_manual.db"), None);

    // 淘汰与"永不删刚生成的"这条规矩的最小单元，不碰 Tauri 也能验
    let tmp = TempDir::new("prune-pure");
    let dir = tmp.path.join("backup");
    std::fs::create_dir_all(&dir).unwrap();
    for s in stamps(4) {
        let p = dir.join(format!("banghe_{s}_manual.db"));
        std::fs::write(&p, b"x").unwrap();
        std::fs::write(format!("{}.sha256", p.display()), "deadbeef").unwrap();
    }
    let newest = "banghe_20260101-000004_manual.db";
    let (victims, errs) = prune_backups(&dir, 2, &[newest]);
    assert!(errs.is_empty(), "{errs:?}");
    assert_eq!(
        victims,
        vec!["banghe_20260101-000002_manual.db".to_string(), "banghe_20260101-000001_manual.db".to_string()],
        "受保护的那份占掉一个名额，否则页面上写保留 2 份、磁盘上会长到 3 份"
    );
    assert!(dir.join(newest).exists());
    assert!(dir.join("banghe_20260101-000003_manual.db").exists());
    assert!(!dir.join("banghe_20260101-000001_manual.db.sha256").exists(), "旁文件成对删除");
    let listed: Vec<String> = list_backups(&dir).iter().map(|f| f.name.clone()).collect();
    assert_eq!(listed, vec![newest.to_string(), "banghe_20260101-000003_manual.db".to_string()]);
}

fn listing(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect()
}
