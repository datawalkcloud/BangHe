//! 过磅抓拍取图与附件落库的契约守卫（04 §4 方案 A）
//!
//! 这里守的是**不联网也验得足**的那一半：
//!  1. **端点拼装**：键名与现场录入那份（`src/mock/masters.ts` 的 cam1/cam2、
//!     `DevicesPage.tsx` 的 camera 表单）逐字对齐，端口/path/查询串都不能被改坏。
//!  2. **请求字节**：GET 行、Host（80 不带端口）、`Connection: close`、
//!     Basic 认证串是钉死的——认证错了现场只会看到 401，看不出为什么。
//!  3. **明确拒绝**：HTTPS 回中文短句（不假装能取图）；非法配置逐条回人话。
//!  4. **收包解析**：Content-Length / 连接关闭两种收法、截断、非 HTTP 回包、
//!     chunked、JPEG magic 与体积上限，全部离线用合成字节验。
//!  5. **落盘与落库**：文件真的写进 `AppDataDir/attachments/YYYY-MM/`（临时目录），
//!     `attachment` 行字段逐列对，`file_path` 是相对路径；**路径穿越跑不出数据目录**；
//!     写库失败时不留没归属的"野图"。
//!  6. **本机摄像头回传帧**（`store_provided_frame`，04 §4 方案 A 前端半边）：base64 与
//!     编码器成对往返、dataURL 前缀与换行的容错；好帧落附件并把抓拍机刷回在线，
//!     坏码/非 JPEG/超限一律降级 + 回写设备台账，过磅照常、盘上不留半个字节。
//!
//! 真实发网络请求那条路（`grab`/`http_get`/`connect`）**不在这里跑**：没有摄像头，
//! 跑一次就是把测试挂在现场网络与一台不存在的 IP 上。它的外壳由 `capture_snapshot`
//! 的降级分支守住——没摄像头 / 模拟模式 / 本机 USB 机都在碰 socket 之前返回。
//! 认证本身（Digest 要两趟往返）离线钉：MD5 用 RFC 1321 标准向量，应答用 RFC 2617 §3.5
//! 那个例子逐字段核对 + 独立复算，详见下面"MD5 与 Digest 认证"一节。

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection};

use banghe_lib::camera::{
    attachment_rel_path, base64_decode, base64_standard, build_get_request, check_jpeg, digest_authorization,
    hex_preview, http_body, http_status_reason, md5_hex, parse_digest_challenge, parse_http_head, preview_target_from_config,
    safe_stem, store_snapshot, target_from_config, AuthKind, AttachmentMeta, CaptureContext, DigestChallenge,
    HTTPS_UNSUPPORTED,
};
use banghe_lib::db::{in_memory_migrated, MIGRATIONS};

/// 合成一张"够真"的 JPEG：以 FF D8 FF 开头、带 JFIF 字样、以 FF D9 收尾。
/// 它的 sha256 被钉在下面常量里——改了字节就得一起改哈希，防的是"算错对象还能过"。
fn fake_jpeg() -> Vec<u8> {
    let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0];
    v.extend_from_slice(b"JFIF-fake-snapshot");
    v.extend_from_slice(&[0xFF, 0xD9]);
    v
}

const FAKE_JPEG_SHA256: &str = "113364700de9772faea5010f95ff3bf41209342b38ce9e454551ae952bfc55df";

// ------------------------------------------------------------------ 临时目录守卫

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(tag: &str) -> Self {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("banghe-cam-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&path).expect("临时目录应可创建");
        Self { path }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn mem_db() -> Connection {
    in_memory_migrated("0.1.0", MIGRATIONS).expect("内存库应能跑完全部迁移脚本")
}

fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
}

/// 磅单 + 称重记录 + 抓拍机：`attachment` 的三列外键（order / device / user）都得有真行。
/// user_account id=1 与 station id=1、grain_variety id=1 由种子给（0002/0003）。
fn seed_fixture(conn: &Connection) -> CaptureContext {
    conn.execute(
        "INSERT INTO party (name, party_type, created_at, created_by) VALUES ('测试农户', 'farmer', ?1, 1)",
        params![now_iso()],
    )
    .unwrap();
    let party = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO weigh_order (order_no, station_id, business_date, status, party_id, variety_id,
                                  weight_source, registered_by, registered_at, created_at, created_by)
         VALUES ('BD01202609000001', 1, '2026-09-12', 'gross_weighed', ?1, 1, 'scale', 1, ?2, ?2, 1)",
        params![party, now_iso()],
    )
    .unwrap();
    let order_id = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO weigh_record (order_id, seq, weigh_type, weight_01kg, aligned_weight_01kg,
                                   source, captured_at, operator_id)
         VALUES (?1, 1, 'gross', 300000, 300000, 'scale', ?2, 1)",
        params![order_id, now_iso()],
    )
    .unwrap();
    CaptureContext {
        order_id,
        weigh_record_id: conn.last_insert_rowid(),
        operator_id: 1,
    }
}

/// 抓拍机一行。`config_json` 用现场录的形状，`secret_json` 放口令（04 §4.1）。
fn seed_camera(conn: &Connection, code: &str, config_json: &str, secret_json: Option<&str>) -> i64 {
    conn.execute(
        "INSERT INTO device_config (code, name, kind, driver, config_json, secret_json,
                                    is_enabled, is_default, is_mock, err_count, last_status, created_at)
         VALUES (?1, '磅区抓拍', 'camera', 'hikvision_isapi', ?2, ?3, 1, 1, 0, 0, 'unknown', ?4)",
        params![code, config_json, secret_json, now_iso()],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn meta(device_id: Option<i64>, code: &str, ctx: &CaptureContext) -> AttachmentMeta {
    AttachmentMeta {
        order_id: ctx.order_id,
        weigh_record_id: ctx.weigh_record_id,
        operator_id: ctx.operator_id,
        device_id,
        device_code: code.to_string(),
    }
}

fn count_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(count_files(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}

// ---------------------------------------------------------------- 端点拼装与拒绝

#[test]
fn mock_masters_key_names_build_a_working_endpoint() {
    // cam1：逐字抄 src/mock/masters.ts 的 config，只有 host/user/snapshotUrl/triggerOn
    let t = target_from_config(
        4,
        "cam1",
        r#"{"host":"192.168.1.64","user":"weigh","snapshotUrl":"/ISAPI/Streaming/channels/101/picture","triggerOn":"capture"}"#,
        None,
    )
    .expect("mock 里那台海康的配置应能拼出端点");
    assert_eq!(t.host, "192.168.1.64");
    assert_eq!(t.port, 80, "没填 port 就是 80，不能凭空猜 8080");
    assert_eq!(t.path, "/ISAPI/Streaming/channels/101/picture");
    assert_eq!(t.user.as_deref(), Some("weigh"));
    assert_eq!(t.auth, AuthKind::Basic);

    // cam2：大华 CGI 的路径带查询串，拼装时必须一字不改地留着（channel=1 是通道号）
    let t = target_from_config(
        5,
        "cam2",
        r#"{"host":"192.168.1.65","user":"admin","snapshotUrl":"/cgi-bin/snapshot.cgi?channel=1"}"#,
        Some(r#"{"password":"bp@ssw0rd"}"#),
    )
    .expect("大华 CGI 路径应能拼出端点");
    assert_eq!(t.path, "/cgi-bin/snapshot.cgi?channel=1");
    assert_eq!(t.password.as_deref(), Some("bp@ssw0rd"), "口令从 secret_json 读");

    // 端口可配；地址栏整条粘进来也要能拆
    let t = target_from_config(
        6,
        "cam3",
        r#"{"snapshotUrl":"http://10.1.2.3:8080/tmp/snap.cgi","user":"admin"}"#,
        None,
    )
    .unwrap_or_else(|e| panic!("整条 http:// 地址也应可解析：{e}"));
    assert_eq!((t.host.as_str(), t.port, t.path.as_str()), ("10.1.2.3", 8080, "/tmp/snap.cgi"));

    // 没配 user 就是匿名抓图，不多发 Authorization
    let t = target_from_config(7, "cam4", r#"{"host":"192.168.1.70","snapshotUrl":"/snap.jpg"}"#, None).unwrap();
    assert_eq!(t.auth, AuthKind::None);
    assert!(t.user.is_none());
}

#[test]
fn https_is_refused_in_chinese_instead_of_pretending() {
    for url in [
        "https://192.168.1.64/ISAPI/Streaming/channels/101/picture",
        "HTTPS://10.0.0.9/cgi-bin/snapshot.cgi",
    ] {
        let err = target_from_config(1, "cam1", &format!(r#"{{"host":"192.168.1.64","snapshotUrl":"{url}"}}"#), None)
            .expect_err("HTTPS 必须被拒绝，不能退化成明文去试");
        assert!(err.contains(HTTPS_UNSUPPORTED), "话术要说明为什么不行：{err}");
        assert!(err.contains("HTTP"), "应是中文短句而非 Debug 串：{err}");
    }
}

#[test]
fn illegal_config_is_refused_line_by_line() {
    let cases: &[(&str, &str, &str)] = &[
        ("host 为空", r#"{"host":"","snapshotUrl":"/snap.jpg"}"#, "地址"),
        ("缺 snapshotUrl", r#"{"host":"192.168.1.64","user":"weigh"}"#, "snapshotUrl"),
        ("路径不以 / 开头", r#"{"host":"192.168.1.64","snapshotUrl":"ISAPI/snap"}"#, "以 / 开头"),
        ("端口为 0", r#"{"host":"192.168.1.64","port":0,"snapshotUrl":"/snap.jpg"}"#, "端口"),
        ("端口越界", r#"{"host":"192.168.1.64","port":70000,"snapshotUrl":"/snap.jpg"}"#, "端口"),
        ("端口两处各说一套", r#"{"snapshotUrl":"http://10.1.2.3:8080/snap.jpg","port":80}"#, "端口"),
        ("端口不是数", r#"{"host":"192.168.1.64","port":"http","snapshotUrl":"/snap.jpg"}"#, "端口"),
        ("host 想穿越", r#"{"host":"../etc","snapshotUrl":"/snap.jpg"}"#, "合法"),
        ("host 带协议", r#"{"host":"http://192.168.1.64","snapshotUrl":"/snap.jpg"}"#, "合法"),
        ("路径藏 CR/LF", "{\"host\":\"192.168.1.64\",\"snapshotUrl\":\"/a\\r\\nX: 1\"}", "控制字符"),
        ("路径带空格", r#"{"host":"192.168.1.64","snapshotUrl":"/a b.jpg"}"#, "控制字符"),
        ("配置不是 JSON", "{host: 1.2.3.4", "JSON"),
        ("配置是数组", "[1,2,3]", "对象"),
    ];
    for (what, config, needle) in cases {
        let err = target_from_config(1, "cam1", config, None)
            .expect_err(&format!("{what} 应当被拒绝"));
        assert!(
            err.chars().any(|c| c as u32 >= 0x4e00) && err.contains(needle),
            "{what} 的拒绝要中文且说到点上（要含「{needle}」）：{err}"
        );
        assert!(err.contains("cam1"), "{what} 的拒绝要带上设备编号：{err}");
    }
}

#[test]
fn auth_kind_follows_the_ledger_keys() {
    // 04 §4.1：海康 ISAPI 要 Digest。台账里 `auth` 明说 digest 才走那条两趟的路，
    // 只给 user 的按 Basic（老固件与大华常见），什么都不给就是匿名——猜不得。
    let t = target_from_config(
        1,
        "cam1",
        r#"{"host":"192.168.1.64","user":"weigh","auth":"digest","snapshotUrl":"/ISAPI/Streaming/channels/101/picture"}"#,
        None,
    )
    .expect("digest 是合法配置");
    assert_eq!(t.auth, AuthKind::Digest);

    let t = target_from_config(1, "cam2", r#"{"host":"192.168.1.64","user":"weigh","password":"s" , "snapshotUrl":"/snap.jpg"}"#, None).unwrap();
    assert_eq!(t.auth, AuthKind::Basic, "只给 user 就按 Basic，别悄悄升级成两趟往返");

    let t = target_from_config(1, "cam3", r#"{"host":"192.168.1.64","snapshotUrl":"/snap.jpg"}"#, None).unwrap();
    assert_eq!(t.auth, AuthKind::None);
}

// ------------------------------------------------------------------ 请求字节

#[test]
fn request_bytes_are_pinned() {
    let t = target_from_config(
        1,
        "cam1",
        r#"{"host":"192.168.1.64","port":"8080","user":"weigh","password":"secret","snapshotUrl":"/ISAPI/Streaming/channels/101/picture"}"#,
        None,
    )
    .unwrap();
    let req = String::from_utf8(build_get_request(&t)).expect("请求必须是 ASCII");
    assert!(req.starts_with("GET /ISAPI/Streaming/channels/101/picture HTTP/1.1\r\n"), "{req}");
    assert!(req.contains("Host: 192.168.1.64:8080\r\n"), "非 80 端口要写进 Host");
    assert!(req.contains("Authorization: Basic d2VpZ2g6c2VjcmV0\r\n"), "weigh:secret 的 Basic 串");
    assert!(req.contains("Connection: close\r\n"), "一次抓图一条连接");
    assert!(req.ends_with("\r\n\r\n"), "{req}");

    // 80 端口不写进 Host（RFC 9110 §7.2，摄像机固件也照这个判虚拟主机）
    let t = target_from_config(1, "cam1", r#"{"host":"192.168.1.64","snapshotUrl":"/snap.jpg"}"#, None).unwrap();
    let req = String::from_utf8(build_get_request(&t)).unwrap();
    assert!(req.contains("Host: 192.168.1.64\r\n"), "{req}");
    assert!(!req.contains("Authorization"), "匿名配置不该带认证头");
}

#[test]
fn base64_matches_the_standard_alphabet() {
    let cases = [
        ("", ""),
        ("f", "Zg=="),
        ("fo", "Zm8="),
        ("foo", "Zm9v"),
        ("foob", "Zm9vYg=="),
        ("fooba", "Zm9vYmE="),
        ("foobar", "Zm9vYmFy"),
        ("weigh:secret", "d2VpZ2g6c2VjcmV0"),
    ];
    for (raw, want) in cases {
        assert_eq!(base64_standard(raw.as_bytes()), want, "输入 {raw:?}");
    }
    // 非 ASCII 口令（现场真有人用中文口令）按 UTF-8 字节编
    assert_eq!(base64_standard("磅:1".as_bytes()), "56OFOjE=");
}

// ---------------------------------------------------------------- MD5 与 Digest 认证

/// MD5 在本系统只有一个用途：HTTP Digest 的 `response`（RFC 7616）。登录口令走
/// `auth.rs` 的 argon2，两者不许混。这几条是 RFC 1321 附录的标准向量，特意覆盖
/// "空输入 / 正好一个 64 字节块 / 跨两块"这三种补位形态——补位写错只有第一块之后的数据会悄悄变味。
#[test]
fn md5_matches_the_rfc_1321_suite() {
    assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
    assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
    assert_eq!(md5_hex(b"message digest"), "f96b697d7cb7938d525a2f31aaf161d0");
    assert_eq!(
        md5_hex(b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"),
        "d174ab98d277d9f102245b4c78068b07",
        "正好 64 字节：补位必须新开一块"
    );
    assert_eq!(
        md5_hex(b"12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
        "57edf4a22be3c955ac49da2e2107b67a",
        "80 字节：跨两块再加补位"
    );
}

/// 从组好的 `Authorization` 头里取一个带引号参数的值。测试侧自己写一遍解析，
/// 不复用生产代码——否则实现与断言是同一段逻辑，错了也一起错。
fn digest_field(header: &str, key: &str) -> String {
    let at = header
        .find(&format!("{key}=\""))
        .unwrap_or_else(|| panic!("应答里没有 {key}：{header}"));
    let rest = &header[at + key.len() + 2..];
    rest[..rest.find('"').expect("引号必须闭合")].to_string()
}

#[test]
fn digest_challenge_parsing_keeps_quoted_commas_and_rejects_other_algorithms() {
    // 现网海康就是这么回的：qop 是个候选列表，realm 里可能带逗号
    let ch = parse_digest_challenge(
        r#"Digest realm="Test realm at HQ, 3F", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41", stale=FALSE, algorithm=MD5"#,
    )
    .expect("带引号的逗号不是分隔符");
    assert_eq!(ch.realm, "Test realm at HQ, 3F");
    assert_eq!(ch.nonce, "dcd98b7102dd2f0e8b11d0f600bfb0c093");
    assert_eq!(ch.qop.as_deref(), Some("auth"), "只挑 auth：auth-int 要连实体一起摘要，现网没这么配");
    assert_eq!(ch.opaque.as_deref(), Some("5ccc069c403ebaf9f0171e9517f40e41"));

    // 没回 qop / algorithm：按 RFC 2617 的老式无计数模式，算法默认 MD5
    let ch = parse_digest_challenge(r#"Digest realm="cam", nonce="n1""#).unwrap();
    assert_eq!(ch.qop, None);
    assert_eq!(ch.algorithm, "MD5");

    // 非 MD5 要明说做不到（算出来必然 401，比"不知道行不行"更坏），并给出现场能照做的下一步
    let err = parse_digest_challenge(r#"Digest realm="r", nonce="n", algorithm=SHA-256"#).unwrap_err();
    assert!(err.contains("SHA-256") && err.contains("basic"), "{err}");
    assert!(parse_digest_challenge(r#"Basic realm="cam""#).is_err(), "不是 Digest 质询就别硬解");
    assert!(parse_digest_challenge(r#"Digest realm="cam""#).unwrap_err().contains("nonce"), "缺 nonce 无从应答要说清是谁缺");
}

/// 整条应答钉在 RFC 2617 §3.5 的例子上：HA1/HA2 用标准里那两条常量核对，
/// `response` 再按公式独立复算一遍（cnonce 从组好的头里取回来），避免实现与断言同源。
#[test]
fn digest_answer_reproduces_the_rfc_2617_example() {
    let t = target_from_config(
        1,
        "cam1",
        r#"{"host":"10.0.0.8","user":"Mufasa","password":"Circle Of Life","auth":"digest","snapshotUrl":"/dir/index.html"}"#,
        None,
    )
    .unwrap();
    let ch = parse_digest_challenge(
        r#"Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41""#,
    )
    .unwrap();
    let h = digest_authorization(&t, &ch).expect("应答组得出来");

    assert_eq!(md5_hex(b"Mufasa:testrealm@host.com:Circle Of Life"), "939e7578ed9e3c518a452effe46c3c14", "RFC 钉死的 HA1");
    assert_eq!(md5_hex(b"GET:/dir/index.html"), "39aff3a2bab6126f332b942af96d3366", "RFC 钉死的 HA2");
    for want in [
        "username=\"Mufasa\"",
        "realm=\"testrealm@host.com\"",
        "nonce=\"dcd98b7102dd2f0e8b11d0f600bfb0c093\"",
        "uri=\"/dir/index.html\"",
        "algorithm=MD5",
        "qop=auth",
        "nc=00000001",
        "opaque=\"5ccc069c403ebaf9f0171e9517f40e41\"",
    ] {
        assert!(h.starts_with("Digest ") && h.contains(want), "应答里少了 {want}：{h}");
    }

    let cnonce = digest_field(&h, "cnonce");
    let ha1 = md5_hex(b"Mufasa:testrealm@host.com:Circle Of Life");
    let ha2 = md5_hex(b"GET:/dir/index.html");
    let want = md5_hex(format!("{ha1}:dcd98b7102dd2f0e8b11d0f600bfb0c093:00000001:{cnonce}:auth:{ha2}").as_bytes());
    assert_eq!(digest_field(&h, "response"), want, "response 必须等于 RFC 公式的独立复算值");
    // 同一 nonce 下连着两次应答不能一模一样（否则第二次就是重放），cnonce 得跟着换
    assert_ne!(digest_field(&digest_authorization(&t, &ch).unwrap(), "cnonce"), cnonce);
    assert!(!h.contains("Circle Of Life"), "口令绝不进头，进的只有摘要：{h}");

    // 中文口令按 UTF-8 字节参与摘要（现场真有这种机），值里的引号也不会把 header 扯断
    let t = target_from_config(1, "cam2", r#"{"host":"10.0.0.8","user":"磅","password":"房\"1","auth":"digest","snapshotUrl":"/s"}"#, None).unwrap();
    let h = digest_authorization(&t, &ch).unwrap();
    assert_eq!(digest_field(&h, "username"), "磅");
    assert!(!h.contains("房"), "口令绝不进头：{h}");
}

#[test]
fn digest_answer_without_qop_uses_the_legacy_formula() {
    // 部分海康固件只回 realm+nonce：那一趟按 RFC 2617 的无计数模式算，别塞 nc/cnonce
    let t = target_from_config(
        1,
        "cam1",
        r#"{"host":"10.0.0.8","user":"admin","password":"pass1234","auth":"digest","snapshotUrl":"/ISAPI/Streaming/channels/102/picture"}"#,
        None,
    )
    .unwrap();
    let ch = parse_digest_challenge(r#"Digest realm="cam401", nonce="abcdef""#).unwrap();
    let h = digest_authorization(&t, &ch).unwrap();
    assert!(!h.contains("qop") && !h.contains("cnonce") && !h.contains("nc="), "无 qop 模式不该带这些参数：{h}");
    let ha1 = md5_hex(b"admin:cam401:pass1234");
    let ha2 = md5_hex(b"GET:/ISAPI/Streaming/channels/102/picture");
    assert_eq!(digest_field(&h, "response"), md5_hex(format!("{ha1}:abcdef:{ha2}").as_bytes()));
}

/// realm / nonce / opaque 是从摄像机回包里抄来的，照原样插进请求头就等于让对端决定我们发什么。
/// 带 CR/LF 的一律拒发——这是防"一次抓图顺手多写一条头"的唯一一道闸。
#[test]
fn camera_supplied_digest_params_cannot_add_a_header_line() {
    let t = target_from_config(1, "cam1", r#"{"host":"10.0.0.8","user":"a","password":"b","auth":"digest","snapshotUrl":"/s"}"#, None).unwrap();

    // 质询值里带真换行：解析阶段照原样收下来，组应答那一步必须拒发
    let ch = parse_digest_challenge("Digest realm=\"r\", nonce=\"n\r\nX-Evil: 1\"").expect("解析只拆参数，不判字符");
    assert!(ch.nonce.contains('\r'), "换行确实带进了 nonce，下面那道闸才有得测");
    let err = digest_authorization(&t, &ch).expect_err("对端给的参数里带换行就拒发");
    assert!(err.contains("换行"), "{err}");

    // 值里的引号与反斜杠要转义：不转义就等于让对端提前收尾、把后面的参数扯断
    let ch = DigestChallenge {
        realm: r#"a"b\c"#.to_string(),
        nonce: "n".to_string(),
        opaque: None,
        qop: None,
        algorithm: "MD5".to_string(),
    };
    let h = digest_authorization(&t, &ch).unwrap();
    assert!(h.contains(r#"realm="a\"b\\c""#), "引号与反斜杠都要转义：{h}");
    assert_eq!(digest_field(&h, "nonce"), "n", "realm 里那对引号不该把后面的参数吃掉");
}

// -------------------------------------------------------------- 预览端点（工作台实时画面）

/// 工作台那一格与过磅抓拍共用端点拼装，只把路径换成子码流 `previewUrl`：
/// 一秒一张时主码流的几百 KB 会把磅房那条网线占满。没填就退回抓拍路径，
/// 而不是"预览不了"——现场十台里有八台没人记得填第二行。
#[test]
fn preview_endpoint_prefers_the_substream_path() {
    let cfg = r#"{"host":"192.168.10.199","port":"8080","user":"admin","password":"pass1234","auth":"digest",
                 "snapshotUrl":"/ISAPI/Streaming/channels/101/picture","previewUrl":"/ISAPI/Streaming/channels/102/picture"}"#;
    let t = preview_target_from_config(1, "cam1", cfg, None).unwrap();
    assert_eq!(t.path, "/ISAPI/Streaming/channels/102/picture", "预览走子码流");
    assert_eq!((t.host.as_str(), t.port), ("192.168.10.199", 8080), "host/端口照台账，别被路径带跑");
    assert_eq!((t.user.as_deref(), t.auth), (Some("admin"), AuthKind::Digest), "认证与口令跟着抓拍那套走");

    // 没配 previewUrl（或配了空串）→ 退回主码流路径
    let t = preview_target_from_config(1, "cam1", r#"{"host":"h","snapshotUrl":"/snap.jpg","previewUrl":"  "}"#, None).unwrap();
    assert_eq!(t.path, "/snap.jpg");

    // 坏 JSON 的说法只留 target_from_config 那一句，这里不另造一种
    let a = preview_target_from_config(1, "cam1", "{not json", None).unwrap_err();
    let b = target_from_config(1, "cam1", "{not json", None).unwrap_err();
    assert_eq!(a, b);
}

// ---------------------------------------------------------------- 收包与解析

#[test]
fn head_parsing_covers_both_body_framings() {
    let jpeg = fake_jpeg();
    let mut raw = b"HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: 24\r\nConnection: close\r\n\r\n".to_vec();
    raw.extend_from_slice(&jpeg);
    let head = parse_http_head(&raw).expect("正常响应应能解出头");
    assert_eq!(head.status, 200);
    assert_eq!(head.content_length, Some(24));
    assert_eq!(head.content_type.as_deref(), Some("image/jpeg"));
    let body = http_body(&raw, &head).unwrap();
    assert_eq!(body, jpeg);

    // 没有 Content-Length：收到连接关闭为止，全当 body
    let mut raw = b"HTTP/1.0 200 OK\r\nContent-Type: image/jpeg\r\n\r\n".to_vec();
    raw.extend_from_slice(&jpeg);
    let head = parse_http_head(&raw).unwrap();
    assert_eq!(head.content_length, None);
    assert_eq!(http_body(&raw, &head).unwrap(), jpeg);

    // 头字段大小写与空白都不该影响判定
    let raw = b"HTTP/1.1 200 OK\r\ncontent-LENGTH:  2\r\n\r\nab".to_vec();
    let head = parse_http_head(&raw).unwrap();
    assert_eq!(head.content_length, Some(2));
    assert_eq!(http_body(&raw, &head).unwrap(), b"ab");
}

#[test]
fn truncated_chunked_and_non_http_replies_are_explained() {
    // 截断：Content-Length 说 24 字节只给了 10 字节
    let mut raw = b"HTTP/1.1 200 OK\r\nContent-Length: 24\r\n\r\n".to_vec();
    raw.extend_from_slice(&fake_jpeg()[..10]);
    let head = parse_http_head(&raw).unwrap();
    let err = http_body(&raw, &head).expect_err("截断必须报出来，不然入库半张图");
    assert!(err.contains("截断"), "{err}");
    assert!(err.contains("24") && err.contains("10"), "要把期望/实收字节数说清：{err}");

    // chunked：本轮明说不支持，而不是把分块标记当图存进去
    let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n18\r\n".to_vec();
    let head = parse_http_head(&raw).unwrap();
    assert!(head.chunked);
    let err = http_body(&raw, &head).expect_err("chunked 要拒绝");
    assert!(err.contains("chunked") || err.contains("分块"), "{err}");

    // 不像 HTTP 回包：给原始前若干字节做诊断（只在返回值里，不落库）
    let raw = b"Hello from a device that is not a web server".to_vec();
    let err = parse_http_head(&raw).expect_err("无 HTTP 头必须失败");
    assert!(err.contains("48 65 6C 6C 6F"), "诊断里要带 hex 前缀：{err}");
    assert!(!err.contains("Path"), "诊断里不该出现 Rust 类型名：{err}");
    let raw = b"HTTP/1.1 STATUS?\r\n\r\n".to_vec();
    assert!(parse_http_head(&raw).is_err(), "状态码解析不出来要失败");
    assert_eq!(hex_preview(b"\x00\x01\xff", 8), "00 01 FF");
}

#[test]
fn http_status_reasons_point_at_the_next_action() {
    for (status, needle) in [
        (401, "Basic"),
        (403, "口令"),
        (404, "snapshotUrl"),
        (408, "408"),
        (503, "HTTP 503"),
    ] {
        let msg = http_status_reason(status);
        assert!(msg.contains(needle), "{status} 的建议要指向 {needle}：{msg}");
        assert!(msg.chars().any(|c| c as u32 >= 0x4e00), "{status} 要中文：{msg}");
    }
}

#[test]
fn only_real_jpegs_within_the_size_cap_get_through() {
    let cap = 64 * 1024;
    check_jpeg(&fake_jpeg(), cap).expect("FF D8 FF 开头的小图应通过");

    let png: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6];
    let err = check_jpeg(&png, cap).expect_err("PNG 不是我们要的图");
    assert!(err.contains("不是 JPEG") && err.contains("PNG"), "{err}");

    let html = b"<html><head><title>Login</title></head><body>x</body></html>".to_vec();
    let err = check_jpeg(&html, cap).expect_err("401 的 HTML 页不能当图入库");
    assert!(err.contains("HTML"), "{err}");

    assert!(check_jpeg(&[], cap).is_err(), "空包要拒");
    assert!(check_jpeg(&[0xFF, 0xD8, 0xFF], cap).is_err(), "三个字节不成图");

    let mut big = vec![0xFF, 0xD8, 0xFF];
    big.extend(std::iter::repeat(0xAB).take(4000));
    let err = check_jpeg(&big, 1024).expect_err("超限要拒");
    assert!(err.contains("KB"), "要说清体积：{err}");
    assert!(err.contains("摄像机"), "要给下一步动作：{err}");
}

#[test]
fn file_names_are_built_locally_and_never_camera_controlled() {
    assert_eq!(safe_stem("cam1"), "cam1");
    assert_eq!(safe_stem("../../etc/passwd"), "etc_passwd");
    assert_eq!(safe_stem("..\\..\\Windows\\System32\\config"), "windows_system32_config");
    assert_eq!(safe_stem("磅区抓拍"), "camera", "非 ASCII 一律不留，退到通用片段");
    assert_eq!(safe_stem("磅区-2 号"), "2", "留下的只有 ASCII 字母数字");
    assert_eq!(safe_stem("---"), "camera");
    assert_eq!(safe_stem(&"x".repeat(99)).chars().count(), 24, "长度要有上限");

    let at = chrono::DateTime::parse_from_rfc3339("2026-09-12T01:23:45.678+08:00")
        .expect("合成时间应能解析")
        .with_timezone(&chrono::Local);
    let rel = attachment_rel_path(&at, "cam1", FAKE_JPEG_SHA256);
    assert!(rel.starts_with("attachments/2026-09/"), "{rel}");
    assert!(rel.contains("-cam1-"), "文件名里带设备片段便于排障：{rel}");
    assert!(rel.ends_with("-11336470.jpg"), "结尾是内容哈希前 8 位：{rel}");
    assert!(!rel.contains("..") && !rel.contains('\\'), "相对路径不得含穿越或反斜杠：{rel}");
    assert!(!rel.contains("192.168"), "文件名里不带摄像机地址：{rel}");
}

// --------------------------------------------------------------- 落盘与落库

#[test]
fn snapshot_lands_in_app_dir_and_the_attachment_row_is_right() {
    let conn = mem_db();
    let tmp = TempDir::new("store");
    let ctx = seed_fixture(&conn);
    let dev = seed_camera(&conn, "cam1", r#"{"host":"192.168.1.64","user":"weigh"}"#, None);
    let jpeg = fake_jpeg();

    let id = store_snapshot(&conn, &tmp.path, &jpeg, &meta(Some(dev), "cam1", &ctx))
        .expect("落盘 + 落库应成功");

    let row: (String, i64, i64, i64, String, String, i64, Option<i64>, Option<i64>, Option<i64>, i64, String, String) = conn
        .query_row(
            "SELECT file_path, file_size, biz_id, order_id, biz_type, mime, encrypted,
                    width, height, source_device_id, created_by, sha256, captured_at
             FROM attachment WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?,
                    r.get(7)?, r.get(8)?, r.get(9)?, r.get(10)?, r.get(11)?, r.get(12)?)),
        )
        .unwrap();
    let (path, size, biz_id, order_id, biz_type, mime, encrypted, width, height, device, by, sha, captured) = row;

    assert_eq!(biz_type, "scale_capture");
    assert_eq!(biz_id, ctx.weigh_record_id, "biz_id 是称重记录 id，不是磅单 id");
    assert_eq!(order_id, ctx.order_id);
    assert_eq!(mime, "image/jpeg");
    assert_eq!(size, jpeg.len() as i64);
    assert_eq!(encrypted, 0, "身份证照/签字才加密；抓拍按明图存（04 §3.2 的 encrypted=1 不适用于这里）");
    assert_eq!((width, height), (None, None), "本轮不解析 SOF 段，宽高必须留 NULL");
    assert_eq!(device, Some(dev));
    assert_eq!(by, ctx.operator_id);
    assert_eq!(sha, FAKE_JPEG_SHA256, "sha256 必须是图像字节的，不能算错对象");
    assert!(!captured.is_empty());

    // §9.15：file_path 存的是**相对 AppDataDir** 的路径，正斜杠
    assert!(path.starts_with("attachments/2026-09/"), "{path}");
    assert!(!path.starts_with('/') && !path.contains('\\') && !path.contains(".."), "不能是绝对路径：{path}");

    let on_disk = tmp.path.join(&path);
    assert_eq!(std::fs::read(&on_disk).expect("文件应真实存在"), jpeg);
    let files = count_files(&tmp.path);
    assert_eq!(files.len(), 1, "只该写一个文件，且没有别的残留：{files:?}");
    assert!(files[0].starts_with(&tmp.path));
}

#[test]
fn two_captures_in_the_same_millisecond_do_not_overwrite_each_other() {
    let conn = mem_db();
    let tmp = TempDir::new("dup");
    let ctx = seed_fixture(&conn);
    let dev = seed_camera(&conn, "cam1", r#"{"host":"192.168.1.64"}"#, None);
    let jpeg = fake_jpeg();

    let a = store_snapshot(&conn, &tmp.path, &jpeg, &meta(Some(dev), "cam1", &ctx)).unwrap();
    let b = store_snapshot(&conn, &tmp.path, &jpeg, &meta(Some(dev), "cam1", &ctx)).unwrap();
    assert_ne!(a, b, "同一张内容连拍两次也要各有其行");
    let paths: Vec<String> = conn
        .query_row::<String, _, _>("SELECT group_concat(file_path, '|') FROM attachment", [], |r| r.get(0))
        .unwrap()
        .split('|')
        .map(str::to_string)
        .collect();
    assert_eq!(paths.len(), 2);
    assert_ne!(paths[0], paths[1], "重名时加序号，不覆盖前一张：{paths:?}");
    assert_eq!(count_files(&tmp.path).len(), 2);
    for p in &paths {
        assert_eq!(std::fs::read(tmp.path.join(p)).unwrap(), jpeg);
    }
}

#[test]
fn traversal_in_configured_names_cannot_escape_the_data_dir() {
    let conn = mem_db();
    let tmp = TempDir::new("traversal");
    let ctx = seed_fixture(&conn);
    // 设备 code 是磅房自己录的，但"自己录的"不等于可信：把 ../ 塞进去
    let dev = seed_camera(&conn, "../../../escape", r#"{"host":"192.168.1.64","snapshotUrl":"/snap.jpg"}"#, None);
    let id = store_snapshot(&conn, &tmp.path, &fake_jpeg(), &meta(Some(dev), "../../../escape", &ctx))
        .expect("穿越名应被清洗而不是失败");

    let path: String = conn
        .query_row("SELECT file_path FROM attachment WHERE id = ?1", params![id], |r| r.get(0))
        .unwrap();
    let file = tmp.path.join(&path);
    let root = std::fs::canonicalize(&tmp.path).expect("临时根目录应存在");
    let real = std::fs::canonicalize(&file).expect("抓拍文件应写在数据目录里");
    assert!(real.starts_with(&root), "文件必须落在 AppDataDir 之内：{} 不在 {}", real.display(), root.display());
    assert_eq!(
        std::fs::read_dir(&tmp.path).map(|e| e.count()).unwrap_or(0),
        1,
        "数据目录顶层只该多出一个 attachments/"
    );
    assert_eq!(count_files(&tmp.path).len(), 1, "穿越名清洗后只写进数据目录里那一份");
    let file_name = Path::new(&path).file_name().map(|s| s.to_string_lossy().to_string()).unwrap();
    assert!(!file_name.contains('.') || file_name.ends_with(".jpg"), "文件名段里不该有穿越：{file_name}");
    assert!(file_name.contains("escape"), "设备片段仍可用于排障：{file_name}");
}

#[test]
fn a_failed_insert_does_not_leave_an_orphan_photo() {
    let conn = mem_db();
    let tmp = TempDir::new("orphan");
    let ctx = seed_fixture(&conn);
    // order_id 指向不存在的单：外键必拦（§9.15 的 order_id 是 REFERENCES weigh_order）
    let broken = CaptureContext { order_id: 999_999, ..ctx };
    let err = store_snapshot(&conn, &tmp.path, &fake_jpeg(), &meta(None, "cam1", &broken))
        .expect_err("库写不进去时必须报错");
    assert!(err.chars().any(|c| c as u32 >= 0x4e00), "业务失败要中文：{err}");
    assert!(!err.contains(&tmp.path.display().to_string()), "错误里不得泄漏数据目录路径：{err}");
    assert_eq!(count_files(&tmp.path).len(), 0, "库没记上就不能把农户照片孤零零留在盘上");
    assert_eq!(
        conn.query_row("SELECT count(*) FROM attachment", [], |r| r.get::<_, i64>(0)).unwrap(),
        0
    );
}

// ------------------------------------------------------- capture_snapshot 分支

#[test]
fn missing_or_mock_camera_degrades_without_touching_the_network() {
    let conn = mem_db();
    let tmp = TempDir::new("nocam");
    let ctx = seed_fixture(&conn);

    // 一台摄像机都没配：这是常态（有的站点就是没装），必须降级而不是拦过磅
    assert_eq!(
        banghe_lib::camera::capture_snapshot(&conn, &tmp.path, &ctx).unwrap(),
        None,
        "没有抓拍摄像机时回 Ok(None)，磅单显示无抓拍"
    );
    assert_eq!(count_files(&tmp.path).len(), 0, "降级不该留下任何文件");

    // 模拟模式同理：设备中心勾了 mock 就不该往外发请求
    seed_camera(&conn, "cammock", r#"{"host":"192.168.1.64","snapshotUrl":"/snap.jpg"}"#, None);
    conn.execute("UPDATE device_config SET is_mock = 1 WHERE code = 'cammock'", []).unwrap();
    assert_eq!(banghe_lib::camera::capture_snapshot(&conn, &tmp.path, &ctx).unwrap(), None);

    // 本机回传帧通道吃同一套 mock 闸门（"没配摄像机"那半由上面的 capture_snapshot 钉，两条共用同一句查询）
    let ok_b64 = base64_standard(&fake_jpeg());
    assert_eq!(banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, &ok_b64).unwrap(), None);
    conn.execute("DELETE FROM device_config WHERE code = 'cammock'", []).unwrap();
    let dev = seed_camera(&conn, "cammock2", r#"{"transport":"local"}"#, None);
    conn.execute("UPDATE device_config SET is_mock = 1 WHERE id = ?1", params![dev]).unwrap();
    assert_eq!(banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, &ok_b64).unwrap(), None);
    let err_count: i64 = conn
        .query_row("SELECT err_count FROM device_config WHERE id = ?1", params![dev], |r| r.get(0))
        .unwrap();
    assert_eq!(err_count, 0, "mock 是配置态不是故障，不该计入设备错误数");
}

#[test]
fn bad_config_surfaces_as_error_and_is_written_back_to_the_device() {
    let conn = mem_db();
    let tmp = TempDir::new("badcfg");
    let ctx = seed_fixture(&conn);
    let dev = seed_camera(&conn, "cam1", r#"{"user":"weigh","snapshotUrl":"snap.jpg"}"#, None);

    let err = banghe_lib::camera::capture_snapshot(&conn, &tmp.path, &ctx)
        .expect_err("配置非法值得单独上报，让站长去改");
    assert!(err.chars().any(|c| c as u32 >= 0x4e00), "要中文短句：{err}");

    let (status, count, last): (String, i64, Option<String>) = conn
        .query_row(
            "SELECT last_status, err_count, last_error FROM device_config WHERE id = ?1",
            params![dev],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((status.as_str(), count), ("error", 1), "04 §1：失败累加 err_count 与 last_error");
    assert_eq!(last.as_deref(), Some(err.as_str()), "设备中心里要看到同一句话");
    assert_eq!(count_files(&tmp.path).len(), 0);

    // Digest 是"配置合法但本轮做不到"：降级，不阻断过磅
    conn.execute("UPDATE device_config SET config_json = '{\"host\":\"192.168.1.64\",\"user\":\"weigh\",\"auth\":\"digest\",\"snapshotUrl\":\"/snap.jpg\"}' WHERE id = ?1", params![dev]).unwrap();
    assert_eq!(banghe_lib::camera::capture_snapshot(&conn, &tmp.path, &ctx).unwrap(), None);
    let (status, count, last): (String, i64, Option<String>) = conn
        .query_row("SELECT last_status, err_count, last_error FROM device_config WHERE id = ?1", params![dev], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    assert_eq!(count, 2, "降级同样计入设备错误数");
    assert_eq!(status, "error");
    assert!(last.unwrap().contains("Digest"), "要说明是认证方式没接");
}

#[test]
fn five_straight_failures_flip_the_device_offline() {
    let conn = mem_db();
    let dev = seed_camera(&conn, "cam1", r#"{"user":"weigh","snapshotUrl":"snap.jpg"}"#, None);
    let tmp = TempDir::new("offline");
    let ctx = seed_fixture(&conn);
    for _ in 0..5 {
        let _ = banghe_lib::camera::capture_snapshot(&conn, &tmp.path, &ctx);
    }
    let (status, count): (String, i64) = conn
        .query_row("SELECT last_status, err_count FROM device_config WHERE id = ?1", params![dev], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap();
    assert_eq!((status.as_str(), count), ("offline", 5), "04 §1：连续失败 5 次转离线，别再刷屏");
    // 转离线之后仍然只是降级，不过磅不会因为"这台已判死"就抛异常
    assert_eq!(banghe_lib::camera::capture_snapshot(&conn, &tmp.path, &ctx).unwrap_or_default(), None);
}

/// 抓图超时是设备层的硬约束（04 §1）。这里只钉常量与请求内容，
/// 真的"3 秒后放弃"要接摄像头才验得出——见报告里的未验项。
#[test]
fn the_timeout_constant_is_the_one_the_design_doc_promised() {
    assert_eq!(banghe_lib::camera::SNAPSHOT_TIMEOUT, std::time::Duration::from_secs(3));
    let t = target_from_config(1, "cam1", r#"{"host":"192.168.1.64","snapshotUrl":"/snap.jpg"}"#, None).unwrap();
    assert_eq!((t.device_id, t.device_code.as_str()), (1, "cam1"));
}

// ---------------------------------------------------- 本机摄像头回传帧（store_provided_frame）

#[test]
fn base64_decode_pairs_with_the_encoder_and_tolerates_the_dataurl_shapes() {
    for bytes in [Vec::new(), b"J".to_vec(), fake_jpeg(), vec![0u8; 300]] {
        assert_eq!(
            base64_decode(&base64_standard(&bytes)).as_deref(),
            Some(bytes.as_slice()),
            "与编码器逐字节成对：任何长度都不得错一个位"
        );
    }
    let plain = base64_standard(&fake_jpeg());
    // canvas 的真实产出带 dataURL 前缀；有人会在 76 列折行——两种都得吃
    assert_eq!(
        base64_decode(&format!("data:image/jpeg;base64,{plain}")).as_deref(),
        Some(fake_jpeg().as_slice())
    );
    let folded = plain.replace("AA", "AA\n");
    assert_eq!(base64_decode(&folded).as_deref(), Some(fake_jpeg().as_slice()), "换行按空白跳过");
    // 字母表外字符＝数据已坏，明确回 None 让调用方降级，而不是"解出什么算什么"
    assert!(base64_decode("!!!!not base64!!!!").is_none());
}

#[test]
fn a_local_frame_is_stored_and_flips_the_camera_online() {
    let conn = mem_db();
    let tmp = TempDir::new("localframe");
    let ctx = seed_fixture(&conn);
    let dev = seed_camera(&conn, "camuvc", r#"{"transport":"local","deviceName":"Integrated Camera"}"#, None);

    let att = banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, &base64_standard(&fake_jpeg()))
        .unwrap()
        .expect("本机取到的好帧必须落库");
    let (path, biz, mime): (String, Option<i64>, String) = conn
        .query_row(
            "SELECT file_path, biz_id, mime FROM attachment WHERE id = ?1",
            params![att],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(biz, Some(ctx.weigh_record_id), "抓拍附件归属那条称重记录（与 IP 通道同式）");
    assert_eq!(mime, "image/jpeg");
    let written = count_files(&tmp.path);
    assert_eq!(written.len(), 1, "盘上就一张，路径进库的是相对路径");
    assert!(written[0].ends_with(path.rsplit('/').next().unwrap()), "文件名对得上：{} vs {path}", written[0].display());
    let status: String = conn
        .query_row("SELECT last_status FROM device_config WHERE id = ?1", params![dev], |r| r.get(0))
        .unwrap();
    assert_eq!(status, "online", "回传帧成功一次就把这台抓拍机刷回在线（04 §1 状态口径）");
}

#[test]
fn broken_local_frames_degrade_and_blame_the_device_not_the_weighing() {
    let conn = mem_db();
    let tmp = TempDir::new("badframe");
    let ctx = seed_fixture(&conn);
    let dev = seed_camera(&conn, "camuvc", r#"{"transport":"local"}"#, None);

    // 坏 base64、解出来不是 JPEG、编码长度先超限——三种坏帧一律 Ok(None)，过磅照常
    assert_eq!(banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, "@@@not-base64@@@").unwrap(), None);
    assert_eq!(
        banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, &base64_standard(b"definitely not a jpeg")).unwrap(),
        None
    );
    let huge = "A".repeat(4 * 1024 * 1024); // 远超默认 500KB 的编码长度：解码前就该拒
    assert_eq!(banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, &huge).unwrap(), None);
    assert_eq!(count_files(&tmp.path).len(), 0, "坏帧不得在盘上留下半个字节");
    assert_eq!(
        conn.query_row("SELECT count(*) FROM attachment", [], |r| r.get::<_, i64>(0)).unwrap(),
        0
    );
    let (status, count, last): (String, i64, Option<String>) = conn
        .query_row("SELECT last_status, err_count, last_error FROM device_config WHERE id = ?1", params![dev], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    assert_eq!((status.as_str(), count), ("error", 3), "坏帧计入设备状态，现场在设备中心看得见");
    assert!(last.unwrap().contains("上限"), "最后这句得说清为什么拒：超限在解码前");
}
