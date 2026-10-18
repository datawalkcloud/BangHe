//! 设备台账的行为守卫（03 §9.20 `device_config`、02 §M9；页面 `src/pages/DevicesPage.tsx`）
//!
//! 守的是"接上 SQLite 才会犯、纸面 review 看不出来"的六件事：
//!  1. **自检不许假装成功**：`probe_plan` 只放行本机真有通道的四类——ESC/POS 小票机、
//!     精伦读卡器、地磅（读数流 / 一次性试读）、内网摄像机（与过磅抓拍、工作台预览同一条
//!     HTTP 抓图通道），针式与窗口预览打印机必须落到
//!     "未接入探测通道"，台账里标成 Mock 或已停用的磅/摄像机绝不许去开口，本机 USB 摄像头
//!     更是留给 WebView2 探测（服务端压根没有那条通道）；
//!     VID/PID 还得从 `"0x0483"` 这种手写十六进制里解析出来——解析错了就是拿另一台机器的应答糊弄。
//!  2. **默认设备互斥**：`uk_dev_default` 是部分唯一索引，登记第二台默认机时
//!     不在同事务里降级就撞 UNIQUE；降级只能同 `kind`，跨类不能误伤。
//!  3. **编码重复要留痕**：拒绝文案是 mock 那一句，且审计必须活着进库（`CreateOutcome`
//!     随事务提交），否则台账页只会看到"失败了"而查不到是谁撞的。
//!  4. **探测回写的四字段口径**：online 清错、offline/error 计次、`unknown` 不计次，
//!     且**一律不碰 config_json**。
//!  5. **门禁**：`mode:"device"` 未通过时拒绝保存并原样带上原因；`mode:"none"`
//!     允许保存但状态停在未检测、原因进 last_error、审计后缀"（未经真机验证）"。
//!  6. **开关**：停用 ⇒ 灯落 offline、启用 ⇒ 未检测；切 Mock **不动**灯；两者都留审计。
//!
//! 全部走内存库 + 真实迁移脚本（`MIGRATIONS` 含 0002 的种子），表结构一旦漂移这里先红。

use rusqlite::{params, Connection};

use banghe_lib::auth::AuthProfile;
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};
use banghe_lib::devices::{
    create_device, list_devices, probe_plan, report_device_probe, scale_verdict_from_probe, scale_verdict_from_stream,
    set_device_enabled, set_device_mock, update_device, update_device_config,
    CreateDeviceInput, DeviceConfig, ProbePlan, ProbeResult, PrintVerify, UpdateDeviceConfigInput, UpdateDeviceInput,
};

fn db() -> Connection {
    in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本")
}

/// 审计的 `actor_id` 挂着 `user_account` 外键，所以必须真插一个人，不能凭空给 id。
fn master(conn: &Connection) -> AuthProfile {
    let id: i64 = conn
        .query_row("SELECT id FROM user_account WHERE role = 'station_master' ORDER BY id LIMIT 1", [], |r| r.get(0))
        .unwrap_or_else(|_| {
            conn.execute(
                "INSERT INTO user_account (username, display_name, password_hash, role, is_active, created_at)
                 VALUES ('dev_master', '测试站长', '!x', 'station_master', 1, '2026-01-01T00:00:00.000+08:00')",
                [],
            )
            .unwrap();
            conn.last_insert_rowid()
        });
    AuthProfile { id, username: "dev_master".into(), display_name: "测试站长".into(), role: "station_master".into(), must_change_pwd: false }
}

fn insert_device(conn: &Connection, code: &str, kind: &str, driver: &str, config_json: &str) -> i64 {
    conn.execute(
        "INSERT INTO device_config (code, name, kind, driver, config_json, is_enabled, is_mock, is_default, last_status, err_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, 0, 'unknown', 0, '2026-01-01T00:00:00.000+08:00')",
        params![code, format!("台账{code}"), kind, driver, config_json],
    )
    .expect("插入台账行");
    conn.last_insert_rowid()
}

fn device(conn: &Connection, code: &str) -> DeviceConfig {
    list_devices(conn)
        .unwrap()
        .into_iter()
        .find(|d| d.code == code)
        .unwrap_or_else(|| panic!("台账里应有 {code}"))
}

fn raw(conn: &Connection, code: &str, col: &str) -> String {
    conn.query_row(&format!("SELECT COALESCE({col}, '<NULL>') FROM device_config WHERE code = ?1"), params![code], |r| r.get(0))
        .unwrap()
}

fn audit_reason(conn: &Connection, action: &str, entity_no: &str) -> String {
    conn.query_row(
        "SELECT COALESCE(reason, '') FROM audit_log WHERE action = ?1 AND entity_no = ?2 ORDER BY id DESC LIMIT 1",
        params![action, entity_no],
        |r| r.get(0),
    )
    .unwrap_or_else(|_| panic!("应有一条 {action} / {entity_no} 审计"))
}

fn audit_count(conn: &Connection, action: &str, entity_no: &str) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM audit_log WHERE action = ?1 AND entity_no = ?2", params![action, entity_no], |r| r.get(0))
        .unwrap()
}

fn device_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM device_config", [], |r| r.get(0)).unwrap()
}

fn create_input(code: &str, kind: &str, driver: &str, is_default: bool) -> CreateDeviceInput {
    let mut config = std::collections::HashMap::new();
    config.insert("paper".to_string(), serde_json::json!("thermal80"));
    CreateDeviceInput {
        code: code.into(),
        name: format!("  现场{code}  "),
        kind: kind.into(),
        driver: driver.into(),
        config,
        is_default,
        is_mock: false,
        operator_id: Some(999), // 一律忽略，以会话为准
    }
}

fn verify(mode: &str, ok: bool, message: &str) -> PrintVerify {
    PrintVerify { mode: mode.into(), ok, at: "2026-09-12 08:00:00".into(), message: message.into() }
}

fn update_input(code: &str, verify: PrintVerify) -> UpdateDeviceConfigInput {
    let mut config = std::collections::HashMap::new();
    config.insert("vid".to_string(), serde_json::json!("0x0483"));
    UpdateDeviceConfigInput { code: code.into(), config, operator_id: Some(999), verify }
}

// ------------------------------------------------------------- 自检：只探真通道

#[test]
fn probe_plan_routes_only_drivers_with_a_real_channel() {
    let conn = db();
    insert_device(&conn, "prn_ticket", "printer", "escpos_usbprint", r#"{"vid":"0x0483","pid":"0x5720","paper":"thermal80"}"#);
    insert_device(&conn, "prn_main", "printer", "preview", r#"{"paper":"A4"}"#);
    insert_device(&conn, "prn_dot", "printer", "raw_escp", r#"{"paper":"dot241"}"#);
    insert_device(&conn, "idcard1", "idcard", "routon_sdtapi", r#"{"dll":"resources/sdtapi/Sdtapi.dll"}"#);
    insert_device(&conn, "scale1", "scale", "yaohua_xk3190", r#"{"port":"COM3","baud":9600}"#);

    assert_eq!(probe_plan(&conn, "prn_ticket").unwrap(), ProbePlan::Printer { vid: Some(0x0483), pid: Some(0x5720) });
    assert_eq!(probe_plan(&conn, "idcard1").unwrap(), ProbePlan::IdCard);
    for code in ["prn_main", "prn_dot"] {
        let plan = probe_plan(&conn, code).unwrap();
        let ProbePlan::NotWired { message } = plan else { panic!("{code} 没有本机探测通道，不该被派发到真设备：{plan:?}") };
        assert!(message.starts_with("该驱动（") && message.contains("暂未接入本机探测通道"), "{message}");
    }
    assert_eq!(probe_plan(&conn, "nope").unwrap(), ProbePlan::Missing);
}

/// 地磅的本机通道就是那条串口：启用的真机磅必须派发到 `Scale`（否则设备中心永远"未检测"，
/// 现场明明在收数却看不到绿灯）。
#[test]
fn probe_plan_routes_a_real_scale_to_the_serial_stream() {
    let conn = db();
    // 驱动名不认识也要照探：磅探的是端口，不是某个型号的私有握手
    insert_device(&conn, "scale_any", "scale", "tolodo_dl901", r#"{"port":"COM4","baud":1200}"#);
    insert_device(&conn, "scale1", "scale", "yaohua_xk3190", r#"{"port":"COM3","baud":9600}"#);
    assert_eq!(probe_plan(&conn, "scale1").unwrap(), ProbePlan::Scale);
    assert_eq!(probe_plan(&conn, "scale_any").unwrap(), ProbePlan::Scale);
}

/// 但 Mock 与停用这两台**绝不能去开口**：`resolve_template` 就是这么挡读线程的，自检绕过去
/// 占一次 COM 口，等于让演示磅把真磅的端口吃掉。
#[test]
fn probe_plan_refuses_to_open_a_port_for_mock_or_disabled_scale() {
    let conn = db();
    insert_device(&conn, "scale_mock", "scale", "mock", r#"{"port":"COM3"}"#);
    conn.execute("UPDATE device_config SET is_mock = 1 WHERE code = 'scale_mock'", []).unwrap();
    insert_device(&conn, "scale_off", "scale", "yaohua_xk3190", r#"{"port":"COM5"}"#);
    conn.execute("UPDATE device_config SET is_enabled = 0 WHERE code = 'scale_off'", []).unwrap();

    for (code, expect) in [("scale_mock", "Mock"), ("scale_off", "已停用")] {
        let plan = probe_plan(&conn, code).unwrap();
        let ProbePlan::NotWired { message } = plan else { panic!("{code} 不该被派发到串口：{plan:?}") };
        assert!(message.contains(expect), "{code} 的拒绝原因要说清「{expect}」：{message}");
    }
}

/// 摄像机的本机通道就是那条抓图 HTTP：配全了地址的必须派发到 `Camera`，
/// 且 `target` 要原样带上 host/port/path/口令与认证方式——自检抓不到图却报绿标，
/// 比"未接入探测通道"更坏（02 §M9：配置必须验过才存）。
#[test]
fn probe_plan_routes_a_network_camera_to_the_snapshot_channel() {
    use banghe_lib::camera::AuthKind;

    let conn = db();
    insert_device(
        &conn,
        "cam_hik",
        "camera",
        "hikvision_isapi",
        r#"{"host":"192.168.10.199","port":80,"path":"/ISAPI/Streaming/channels/101/picture","user":"admin","auth":"digest"}"#,
    );
    conn.execute("UPDATE device_config SET secret_json = ?1 WHERE code = 'cam_hik'", params![r#"{"password":"p@ss-word"}"#]).unwrap();

    let plan = probe_plan(&conn, "cam_hik").unwrap();
    let ProbePlan::Camera { target, max_bytes } = plan else {
        panic!("配全了地址的网络摄像机该走抓图通道，不该落到「未接入探测」：{plan:?}")
    };
    assert_eq!(target.host, "192.168.10.199");
    assert_eq!(target.port, 80);
    assert_eq!(target.path, "/ISAPI/Streaming/channels/101/picture");
    assert_eq!(target.user.as_deref(), Some("admin"));
    assert_eq!(target.password.as_deref(), Some("p@ss-word"), "口令得从 secret_json 取回来，否则 Digest 永远算不对");
    assert_eq!(target.auth, AuthKind::Digest);
    assert!((64 * 1024..=32 * 1024 * 1024).contains(&max_bytes), "帧大小上限该在合理量级：{max_bytes}");

    // Mock / 停用 / 本机 USB / 少填地址：一律不许去开 HTTP
    insert_device(&conn, "cam_mock", "camera", "mock", r#"{"host":"10.0.0.9","path":"/snap"}"#);
    conn.execute("UPDATE device_config SET is_mock = 1 WHERE code = 'cam_mock'", []).unwrap();
    insert_device(&conn, "cam_off", "camera", "hikvision_isapi", r#"{"host":"10.0.0.8","path":"/snap"}"#);
    conn.execute("UPDATE device_config SET is_enabled = 0 WHERE code = 'cam_off'", []).unwrap();
    insert_device(&conn, "cam_uvc", "camera", "local_uvc", r#"{"transport":"local","deviceId":"video0"}"#);
    insert_device(&conn, "cam_half", "camera", "hikvision_isapi", r#"{"path":"/ISAPI/Streaming/channels/101/picture"}"#);

    for (code, expect) in [("cam_mock", "Mock"), ("cam_off", "已停用"), ("cam_uvc", "本机"), ("cam_half", "地址")] {
        let plan = probe_plan(&conn, code).unwrap();
        let ProbePlan::NotWired { message } = plan else { panic!("{code} 不该被派发到抓图通道：{plan:?}") };
        assert!(message.contains(expect), "{code} 的拒绝原因要说清「{expect}」：{message}");
        assert!(!message.contains("p@ss-word"), "拒绝文案里不许带出口令：{message}");
    }
}

/// 地磅的"绿灯判据"：读数流正在收数（`LiveStatus::connected`）才算在线，
/// 且回的那句话要带上端口、帧数与读数——现场据此判断"软件看到的是哪条链路"。
#[test]
fn scale_verdict_turns_green_only_while_the_stream_is_parsing_frames() {
    let mut s = banghe_lib::scale::LiveStatus {
        running: true,
        connected: true,
        code: "scale1".into(),
        port: "COM3".into(),
        frame_count: 128,
        last_frame_at: Some("2026-09-12 23:16:43".into()),
        last: Some(banghe_lib::scale::ScaleEvent { weight_01kg: 620, ..Default::default() }),
        ..Default::default()
    };
    let (ok, msg) = scale_verdict_from_stream(&s);
    assert!(ok, "正在收数就该报在线：{msg}");
    for want in ["COM3", "128", "62.0"] {
        assert!(msg.contains(want), "回话里要能看到 {want}：{msg}");
    }

    // 端口还开着但 5 秒没帧：不能继续挂绿标，且要把读数流那句原因原样递给人
    s.connected = false;
    s.error = Some("串口 COM3 已 5 秒没有收到读数帧：仪表未上电、波特率不符或 COM 口被别的程序占着".into());
    let (ok, msg) = scale_verdict_from_stream(&s);
    assert!(!ok, "收不到数就不是在线");
    assert!(msg.contains("5 秒没有收到读数帧"), "要照抄读数流的原因：{msg}");
}

/// 没在流时的一次性试读：读到帧才算通，一帧没读到要把"打不开端口"和"读不到数"分开说。
#[test]
fn scale_verdict_from_probe_separates_open_port_from_reading_frames() {
    let out = banghe_lib::scale::ProbeOutcome {
        good_frames: 3,
        weight_01kg: Some(640),
        first_good_ms: Some(240),
        bad_frames: 1,
        error: None,
    };
    let (ok, msg) = scale_verdict_from_probe("COM3", &out);
    assert!(ok, "试读到 3 帧就是通了");
    assert!(msg.contains("64.0") && msg.contains("240 ms") && msg.contains("1 帧校验不过"), "{msg}");

    let (ok, msg) = scale_verdict_from_probe("COM3", &banghe_lib::scale::ProbeOutcome::default());
    assert!(!ok, "一帧都没读到不能报绿");
    assert!(msg.contains("一帧可解析读数都没读到"), "要给出下一步可查的原因：{msg}");

    let busy = banghe_lib::scale::ProbeOutcome { error: Some("端口不存在或已被占用（确认 COM 号与波特率）".into()), ..Default::default() };
    let (ok, msg) = scale_verdict_from_probe("COM3", &busy);
    assert!(!ok && msg.contains("已被占用"), "端口打不开要说打不开，不能混成「读不到数」：{msg}");
}

#[test]
fn probe_plan_survives_broken_config_json() {
    let conn = db();
    // 坏 JSON 既不能让自检崩，也不能凭空造出 vid；照样派发到真通道，由驱动取枚举第一台
    insert_device(&conn, "prn_x", "printer", "raw_escpos", "not-json");
    assert_eq!(probe_plan(&conn, "prn_x").unwrap(), ProbePlan::Printer { vid: None, pid: None });
    assert_eq!(device(&conn, "prn_x").config.len(), 0, "解析不出来按空配置读，整张台账不能打不开");
}

// ------------------------------------------------------------------ 登记与主键

#[test]
fn create_device_demotes_previous_default_of_same_kind_only() {
    let conn = db();
    let a = master(&conn);
    insert_device(&conn, "scale1", "scale", "yaohua_xk3190", "{}");
    conn.execute("UPDATE device_config SET is_default = 1 WHERE code = 'scale1'", []).unwrap();

    create_device(&conn, &a, create_input("prn_ticket", "printer", "escpos_usbprint", true))
        .unwrap()
        .into_result()
        .expect("首次登记默认小票机应成功");
    // 同类第二台设默认：旧的必须降级，且不能顺手把地磅的默认位也摘掉
    create_device(&conn, &a, create_input("prn_ticket2", "printer", "raw_escpos", true))
        .unwrap()
        .into_result()
        .expect("同类换默认机应成功");

    assert_eq!(device(&conn, "prn_ticket").is_default, 0);
    assert_eq!(device(&conn, "prn_ticket2").is_default, 1);
    assert_eq!(device(&conn, "scale1").is_default, 1, "跨类不得误伤");
    let bad: i64 = conn
        .query_row("SELECT COUNT(*) FROM (SELECT kind FROM device_config WHERE is_default = 1 GROUP BY kind HAVING COUNT(*) > 1)", [], |r| r.get(0))
        .unwrap();
    assert_eq!(bad, 0, "每类至多一台默认机（uk_dev_default）");

    let d = device(&conn, "prn_ticket2");
    assert_eq!(d.name, "现场prn_ticket2", "名称入库前去掉两端空白");
    assert_eq!(d.last_status, "unknown", "登记 ≠ 联机验证");
    assert_eq!(d.is_enabled, 1);
    assert_eq!(raw(&conn, "prn_ticket2", "secret_json"), "<NULL>", "当前无口令类字段");
    assert_eq!(raw(&conn, "prn_ticket2", "config_json"), r#"{"paper":"thermal80"}"#);
    let reason = audit_reason(&conn, "device.create", "prn_ticket2");
    assert!(reason.contains("驱动 raw_escpos") && reason.contains("状态未检测待联机测试"), "{reason}");
}

#[test]
fn duplicate_code_is_refused_with_mock_wording_and_leaves_a_trace() {
    let conn = db();
    let a = master(&conn);
    create_device(&conn, &a, create_input("prn1", "printer", "escpos_usbprint", false)).unwrap().into_result().unwrap();

    let out = create_device(&conn, &a, create_input("prn1", "printer", "escpos_usbprint", false))
        .expect("拒绝也要随事务提交，否则留痕会被回滚卷掉");
    assert_eq!(out.into_result().err(), Some("编码 prn1 已存在：编码是台账主键，不能重复".to_string()));
    assert_eq!(device_count(&conn), 1, "重复编码不得插入第二行");
    assert_eq!(audit_count(&conn, "device.create", "prn1"), 2, "成功一条 + 拒绝一条");
    assert_eq!(audit_reason(&conn, "device.create", "prn1"), "编码重复，已拒绝");
}

#[test]
fn blank_code_is_numbered_by_kind_and_out_of_range_inputs_are_refused() {
    let conn = db();
    let a = master(&conn);
    // 编码留空＝交给台账补号。前缀必须和前端 DEVICE_SPEC 一致（printer → prn，不是 printer1），
    // 否则建议号和补号在台账里长成两副样子。
    let first = create_device(&conn, &a, create_input("   ", "printer", "mock", false))
        .expect("补号登记应成功")
        .into_result()
        .expect("首次补号不该撞号");
    assert_eq!(first.code, "prn1");
    let second = create_device(&conn, &a, create_input("", "printer", "mock", false))
        .unwrap()
        .into_result()
        .unwrap();
    assert_eq!(second.code, "prn2", "同类型继续往后号");

    assert_eq!(
        create_device(&conn, &a, create_input("lif1", "forklift", "mock", false)).err().unwrap(),
        "设备类型「forklift」不在值域内"
    );
    assert_eq!(create_device(&conn, &a, create_input("lif1", "printer", "  ", false)).err().unwrap(), "驱动协议必填");
    assert_eq!(device_count(&conn), 2, "被拒的两次都不该落行");
}

// ------------------------------------------------------------------ 探测回写

fn report(conn: &Connection, code: &str, status: &str, error: Option<&str>, at: &str) -> DeviceConfig {
    let a = master(conn);
    report_device_probe(
        conn,
        &a,
        code,
        ProbeResult { status: status.into(), error: error.map(str::to_string), at: at.into() },
    )
    .expect("回写应成功")
}

#[test]
fn probe_report_online_clears_error_and_offline_counts_it() {
    let conn = db();
    insert_device(&conn, "prn1", "printer", "escpos_usbprint", r#"{"vid":"0x0483"}"#);
    conn.execute("UPDATE device_config SET last_status='error', last_error='纸将尽', err_count=3 WHERE code='prn1'", []).unwrap();

    let d = report(&conn, "prn1", "online", Some("残留文案"), "2026-09-12 09:00:00");
    assert_eq!(d.last_status, "online");
    assert_eq!(d.last_ok_at.as_deref(), Some("2026-09-12 09:00:00"));
    assert_eq!(d.last_error, None, "绿标旁边不许挂着红字");
    assert_eq!(d.err_count, 0);
    assert_eq!(raw(&conn, "prn1", "config_json"), r#"{"vid":"0x0483"}"#, "回写只动状态四字段");

    report(&conn, "prn1", "offline", Some("串口未连接"), "2026-09-12 09:05:00");
    let d = device(&conn, "prn1");
    assert_eq!(d.last_status, "offline");
    assert_eq!(d.last_error.as_deref(), Some("串口未连接"));
    assert_eq!(d.err_count, 1, "online 之后重新从 1 计");
    assert_eq!(raw(&conn, "prn1", "last_err_at"), "2026-09-12 09:05:00");
    assert_eq!(d.last_ok_at.as_deref(), Some("2026-09-12 09:00:00"), "上次成功时刻要留着");

    report(&conn, "prn1", "error", Some("缺纸"), "2026-09-12 09:06:00");
    assert_eq!(device(&conn, "prn1").err_count, 2);

    assert!(report_device_probe(&conn, &master(&conn), "prn1", ProbeResult { status: "broken".into(), error: None, at: String::new() }).is_err());
    assert!(report_device_probe(&conn, &master(&conn), "nope", ProbeResult { status: "online".into(), error: None, at: String::new() })
        .unwrap_err()
        .contains("设备不存在"));
}

#[test]
fn probe_report_unknown_is_not_counted_as_a_fault() {
    let conn = db();
    insert_device(&conn, "prn1", "printer", "escpos_usbprint", "{}");
    report(&conn, "prn1", "error", Some("缺纸"), "2026-09-12 09:00:00");
    let before = device(&conn, "prn1");
    let before_err_at = raw(&conn, "prn1", "last_err_at");

    // 浏览器预览问不到可信状态，多问几次也不该把设备刷成"故障 N 次"
    report(&conn, "prn1", "unknown", None, "");
    report(&conn, "prn1", "unknown", None, "");
    let d = device(&conn, "prn1");
    assert_eq!(d.last_status, "unknown");
    assert_eq!(d.err_count, before.err_count, "未检测不计入错误次数");
    assert_eq!(d.last_ok_at, before.last_ok_at);
    assert_eq!(raw(&conn, "prn1", "last_err_at"), before_err_at, "未检测不推进报错时刻");
    assert_eq!(d.last_error, None);
    assert!(audit_reason(&conn, "device.probe", "prn1").starts_with("联机回写 unknown"), "回写也要留痕");
}

// -------------------------------------------------------------------- 配置门禁

#[test]
fn unverified_config_saves_as_yellow_light_with_a_marked_audit() {
    let conn = db();
    let a = master(&conn);
    insert_device(&conn, "prn1", "printer", "escpos_usbprint", r#"{"cols":48,"vid":"0x0416"}"#);

    let saved = update_device_config(&conn, &a, update_input("prn1", verify("none", false, "浏览器预览没有原生通道，本次配置未经真机验证")))
        .expect("浏览器预览要改得动配置，否则开发期什么都改不动");
    assert_eq!(saved.config.get("cols").unwrap().as_i64().unwrap(), 48, "未提交的键保持原样");
    assert_eq!(saved.config.get("vid").unwrap().as_str().unwrap(), "0x0483", "提交的键覆盖旧值");
    assert_eq!(saved.last_status, "unknown");
    assert_eq!(saved.last_error.as_deref().unwrap(), "浏览器预览没有原生通道，本次配置未经真机验证");
    assert_eq!(raw(&conn, "prn1", "last_ok_at"), "<NULL>");
    let reason = audit_reason(&conn, "device.update", "prn1");
    assert!(reason.contains(" → ") && reason.ends_with("（未经真机验证）"), "{reason}");
    assert_eq!(reason, r#"{"cols":48,"vid":"0x0416"} → {"cols":48,"vid":"0x0483"}（未经真机验证）"#, "审计里的旧→新要能逐字比对");
}

#[test]
fn device_verified_config_flips_the_light_and_clears_counters() {
    let conn = db();
    let a = master(&conn);
    insert_device(&conn, "prn1", "printer", "escpos_usbprint", "{}");
    conn.execute("UPDATE device_config SET last_status='error', last_error='缺纸', err_count=5 WHERE code='prn1'", []).unwrap();

    let saved = update_device_config(&conn, &a, update_input("prn1", verify("device", true, "设备已应答（状态字节 0x18）")))
        .expect("真机验过就该存");
    assert_eq!(saved.last_status, "online");
    assert_eq!(saved.err_count, 0);
    assert_eq!(saved.last_error, None);
    assert!(saved.last_ok_at.is_some());
    assert!(!audit_reason(&conn, "device.update", "prn1").contains("未经真机验证"));
}

#[test]
fn failed_device_test_blocks_the_save_and_keeps_old_config() {
    let conn = db();
    let a = master(&conn);
    insert_device(&conn, "prn1", "printer", "escpos_usbprint", r#"{"vid":"0x0416"}"#);

    let e = update_device_config(&conn, &a, update_input("prn1", verify("device", false, "设备未应答状态查询（none）"))).unwrap_err();
    assert_eq!(e, "联机测试未通过，配置未保存：设备未应答状态查询（none）");
    assert_eq!(raw(&conn, "prn1", "config_json"), r#"{"vid":"0x0416"}"#);
    assert_eq!(audit_count(&conn, "device.update", "prn1"), 0, "没存成就不该有一条改配置的审计");

    // mode 缺了就是"没交验证结果"，不能当成浏览器预览默默放过
    assert_eq!(update_device_config(&conn, &a, update_input("prn1", verify("", false, ""))).unwrap_err(), "联机验证结果不完整，配置未保存");
    assert!(update_device_config(&conn, &a, update_input("nope", verify("none", false, "x"))).unwrap_err().contains("设备不存在"));
}

// ------------------------------------------------------------------ 两个开关

#[test]
fn enable_toggle_moves_the_light_and_mock_toggle_does_not() {
    let conn = db();
    let a = master(&conn);
    insert_device(&conn, "led1", "led", "mock", "{}");
    conn.execute("UPDATE device_config SET last_status='online' WHERE code='led1'", []).unwrap();

    let all = set_device_enabled(&conn, &a, "led1", false).unwrap();
    assert_eq!(all.len(), 1, "开关返回整张台账（与 mock 同签名）");
    assert_eq!(device(&conn, "led1").last_status, "offline", "停用就是关掉了，比未检测更贴近事实");
    assert_eq!(device(&conn, "led1").is_enabled, 0);
    assert!(audit_reason(&conn, "device.update", "led1").contains("停用"));

    set_device_enabled(&conn, &a, "led1", true).unwrap();
    assert_eq!(device(&conn, "led1").last_status, "unknown", "重新启用要等一次真机测试");

    set_device_mock(&conn, &a, "led1", true).unwrap();
    let d = device(&conn, "led1");
    assert_eq!(d.is_mock, 1);
    assert_eq!(d.last_status, "unknown", "切的是数据来源，不是通不通");
    assert!(audit_reason(&conn, "device.update", "led1").contains("真实设备 → Mock 模拟"));

    // 反向再切一次：新旧标签写反了这里就红
    set_device_mock(&conn, &a, "led1", false).unwrap();
    assert!(audit_reason(&conn, "device.update", "led1").contains("Mock 模拟 → 真实设备"));
    assert_eq!(device(&conn, "led1").is_mock, 0);

    assert_eq!(set_device_enabled(&conn, &a, "nope", true).unwrap_err(), "设备不存在");
    assert_eq!(set_device_mock(&conn, &a, "nope", true).unwrap_err(), "设备不存在");
}

// -------------------------------------------------- 口令：库里留真值，留痕必须掩码

/// 海康 / 大华的抓图口令就落在 `config_json.password`（`camera.rs::target_from_config` 的读取主路径），
/// 库里那份不能掩码——动了摄像机就抓不到图。但 `audit_log` 全岗位可筛看，两条写配置的
/// 留痕路径都必须把口令换成 `***`，否则一次改机等于把摄像机口令广播给全站。
#[test]
fn camera_password_stays_real_in_config_and_masked_in_audit() {
    let conn = db();
    let a = master(&conn);
    insert_device(&conn, "cam1", "camera", "hikvision_isapi", r#"{"host":"192.168.10.199","password":"old-pass"}"#);

    let mut cfg = std::collections::HashMap::new();
    cfg.insert("password".to_string(), serde_json::json!("new-pass"));
    let saved = update_device(
        &conn,
        &a,
        UpdateDeviceInput {
            code: "cam1".into(),
            name: "磅区相机".into(),
            kind: "camera".into(),
            driver: "hikvision_isapi".into(),
            config: cfg,
            is_default: false,
            operator_id: Some(999),
        },
    )
    .expect("编辑已登记的相机要存得动");
    assert_eq!(saved.config.get("password").unwrap().as_str().unwrap(), "new-pass", "抓图要用的真口令不能被掩码写进库");

    let reason = audit_reason(&conn, "device.update", "cam1");
    assert!(!reason.contains("old-pass") && !reason.contains("new-pass"), "审计里不许出现明文口令：{reason}");
    assert!(reason.contains(r#""password":"***""#), "口令键要留名换值，否则看不出改的是哪一栏：{reason}");
    assert!(reason.contains("192.168.10.199"), "非口令键照旧逐字可比对：{reason}");

    // 联机验证那条路同理：不掩码的话一次"保存配置"就把口令抄进审计
    let mut again = std::collections::HashMap::new();
    again.insert("password".to_string(), serde_json::json!("third-pass"));
    update_device_config(&conn, &a, UpdateDeviceConfigInput {
        code: "cam1".into(),
        config: again,
        operator_id: None,
        verify: verify("none", false, "浏览器预览没有原生通道，本次配置未经真机验证"),
    })
    .expect("浏览器预览该存得动配置");
    let reason = audit_reason(&conn, "device.update", "cam1");
    assert!(!reason.contains("new-pass") && !reason.contains("third-pass"), "改配置的留痕同样不许带口令：{reason}");
    assert_eq!(device(&conn, "cam1").config.get("password").unwrap().as_str().unwrap(), "third-pass");
}
