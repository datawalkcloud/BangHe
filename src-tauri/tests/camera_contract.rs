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
//!  7. **回写台账的两套时刻格式**与**体积上限的三处同源**（0031）：`last_ok_at`/
//!     `last_err_at` 是设备卡原样渲染的那一句，必须是 `yyyy-MM-dd HH:mm:ss`；
//!     `updated_at` 才是全库统一的 ISO。上限的种子值、站点自配、缺键兜底逐条钉死。
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
        "d174ab98d277d9f5a5611c2c9f419d9f",
        "62 字节：补位放不下，必须新开一块"
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

    assert_eq!(md5_hex(b"Mufasa:testrealm@host.com:Circle Of Life"), "939e7578ed9e3c518a452acee763bce9", "RFC 2617 §3.5 例子的 HA1");
    assert_eq!(md5_hex(b"GET:/dir/index.html"), "39aff3a2bab6126f332b942af96d3366", "同例的 HA2");
    // 拿标准自己的 cnonce 把上面两条串起来复算，必须等于 RFC 公布的那条 response
    assert_eq!(
        md5_hex(b"939e7578ed9e3c518a452acee763bce9:dcd98b7102dd2f0e8b11d0f600bfb0c093:00000001:0a4f113b:auth:39aff3a2bab6126f332b942af96d3366"),
        "6629fae49393a05397450978507c4ef1",
        "RFC 2617 §3.5 公布的 response"
    );
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

    // §9.15：file_path 存的是**相对 AppDataDir** 的路径，正斜杠。
    // 月份不钉字面量——原先写的是 `attachments/2026-09/`，而这一张是真机当前时间生成的，
    // 跨过 10 月 1 号这条断言必红：那是条会自己过期的断言。改成拿文件名自己的日期反推月份目录，
    // "目录月与文件名月对不上"这个真缺陷照样抓得住，且永不过时。
    let mut segs = path.splitn(3, '/');
    let (dir, month_seg, stamp) = (segs.next(), segs.next(), segs.next());
    assert_eq!(dir, Some("attachments"), "附件一律落在 attachments/ 下：{path}");
    let stamp = stamp.unwrap_or("");
    let derived = stamp.get(..6).map(|ym| format!("{}-{}", &ym[..4], &ym[4..6]));
    assert_eq!(
        Some(derived).flatten().as_deref(),
        month_seg,
        "月份目录必须由文件名里的日期推出，两处不能各算各的：{path}"
    );
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

    // 配置合法但对端连不上：设备层降级，不阻断过磅（Digest 已经接上，不再是"认证方式没接"）
    conn.execute("UPDATE device_config SET config_json = '{\"host\":\"127.0.0.1\",\"port\":1,\"user\":\"weigh\",\"password\":\"local-test\",\"auth\":\"digest\",\"snapshotUrl\":\"/snap.jpg\"}' WHERE id = ?1", params![dev]).unwrap();
    assert_eq!(banghe_lib::camera::capture_snapshot(&conn, &tmp.path, &ctx).unwrap(), None);
    let (status, count, last): (String, i64, Option<String>) = conn
        .query_row("SELECT last_status, err_count, last_error FROM device_config WHERE id = ?1", params![dev], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap();
    assert_eq!(count, 2, "降级同样计入设备错误数");
    assert_eq!(status, "error");
    assert!(last.unwrap().contains("连接摄像机"), "要说是这台连不上，别赖认证方式");
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

    // 坏 base64、解出来不是 JPEG、编码长度超过单次拉取硬顶——三种坏帧一律 Ok(None)，过磅照常
    assert_eq!(banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, "@@@not-base64@@@").unwrap(), None);
    assert_eq!(
        banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, &base64_standard(b"definitely not a jpeg")).unwrap(),
        None
    );
    // 拉取硬顶是 8 MB（`SNAPSHOT_FETCH_MAX_BYTES`），base64 后约 11 MB；这道门量的是
    // "别把几十 MB 拖进这台机器"，与落库上限是两件事，超限的图不再进压缩链路。
    let huge = "A".repeat(12 * 1024 * 1024);
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
    assert!(last.unwrap().contains("拉取上限"), "最后这句得说清为什么拒：超限在解码之前");
}

// ============================================================= 海康自动检测（纯函数离线钉）
//
// detect_hikvision 真要联网，测试里不跑（把测试挂在现场网络与一台不存在的 IP 上）。
// 这里钉它周围的三把尺子：地址收敛、认证方式判定、XML 取值——正是"检测填进去的端口/
// 认证/型号对不对"的判定源，网络那一半只保证把这三样的结论写进 config。

use banghe_lib::camera::{auth_from_www_authenticate, normalize_host, xml_first_tag};

#[test]
fn normalize_host_schemes_paths_and_inline_ports() {
    // 裸 IP：不猜端口，交给上层按候选试
    assert_eq!(normalize_host("192.168.10.64", None).unwrap(), ("192.168.10.64".to_string(), None));
    // 整条浏览器地址粘进来：切协议、丢路径、带出的端口要认
    assert_eq!(
        normalize_host("http://192.168.10.64:8080/ISAPI/System/deviceInfo", None).unwrap(),
        ("192.168.10.64".to_string(), Some(8080))
    );
    // 尾部斜杠与大小写前缀都收敛
    assert_eq!(normalize_host("HTTP://Cam-Local/", None).unwrap(), ("Cam-Local".to_string(), None));
    // 显式端口压过地址里内联的那个
    assert_eq!(normalize_host("1.2.3.4:80", Some(8000)).unwrap(), ("1.2.3.4".to_string(), Some(8000)));
    // 非法与空：回中文短句，绝不静默拼出一个坏端点
    assert!(normalize_host("", None).is_err());
    assert!(normalize_host("10.0.0..1", None).is_err());
}

#[test]
fn auth_kind_follows_the_challenge_the_camera_actually_sends() {
    assert_eq!(auth_from_www_authenticate(Some("Digest realm=\"IPCam\", qop=\"auth\", nonce=\"ab\"")), AuthKind::Digest);
    assert_eq!(auth_from_www_authenticate(Some("Basic realm=\"test\"")), AuthKind::Basic);
    // 没回认证头（比如直接 200 的匿名机）→ 不带认证
    assert_eq!(auth_from_www_authenticate(None), AuthKind::None);
    assert_eq!(auth_from_www_authenticate(Some("NTLM")), AuthKind::None);
}

#[test]
fn model_tag_is_read_from_device_info_without_an_xml_lib() {
    let xml = r#"<?xml version="1.0"?><DeviceDescription><model>DS-2CD2T47G2-L</model><serialNumber>12345</serialNumber></DeviceDescription>"#;
    assert_eq!(xml_first_tag(xml, "model").as_deref(), Some("DS-2CD2T47G2-L"));
    assert_eq!(xml_first_tag(xml, "serialNumber").as_deref(), Some("12345"));
    // 带属性的标签也能取（先跳过 '>'），认不出的标签回 None 让探测降级而不是崩
    assert_eq!(xml_first_tag(r#"<model lang="cn">X1"</model>"#, "model").as_deref(), Some("X1\""));
    assert_eq!(xml_first_tag(xml, "firmwareVersion"), None);
    // 前缀撞车：找 "model" 不能被更长的 "<modelVersion>" 抢先，得跳到真正那一个
    let collide = r#"<modelVersion>4.2</modelVersion><model>DS-2CD</model>"#;
    assert_eq!(xml_first_tag(collide, "model").as_deref(), Some("DS-2CD"));
    assert_eq!(xml_first_tag(collide, "modelVersion").as_deref(), Some("4.2"));
}

// ------------------------------------------------- 抓拍回写的时刻格式与体积上限（0031）

/// 设备卡上那句「最后成功 …」是**原样渲染** `device_config.last_ok_at`
/// （`src/pages/DevicesPage.tsx`），没有第二处格式化兜着，所以库里存什么就显什么。
/// 给人看的时刻一律 `yyyy-MM-dd HH:mm:ss`（`devices.rs::now_display`、前端
/// `print-guard.ts::stamp`、mock 三处同格式）。
fn assert_display_stamp(s: &str, what: &str) {
    assert_eq!(s.chars().count(), 19, "{what} 应是 `yyyy-MM-dd HH:mm:ss`，实际 {s}");
    assert_eq!(s.chars().nth(10), Some(' '), "{what} 日期与时间之间应是空格：{s}");
    assert!(!s.contains('T') && !s.contains('+') && !s.contains('.'), "{what} 漏出了 ISO 串：{s}");
}

/// 抓拍这条路（`note_ok`/`note_fail`）曾经拿 `now_iso()` 同时填三列，于是抓拍过的相机
/// 那一格显示 `2026-10-09T15:11:08.592+08:00`，而同一页其它设备是 `2026-10-09 17:57:55`。
/// `devices_contract` 只钉了联机回写那条路（`report_device_probe`），抓拍没人守——这里补上。
#[test]
fn capture_stamps_read_only_columns_and_keeps_updated_at_iso() {
    let conn = mem_db();
    let tmp = TempDir::new("stamps");
    let ctx = seed_fixture(&conn);
    let dev = seed_camera(&conn, "camuvc", r#"{"transport":"local","deviceName":"Integrated Camera"}"#, None);

    // 成功一次：last_ok_at 给人看，updated_at 是全库统一的 ISO 留痕，两列两种格式
    banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, &base64_standard(&fake_jpeg()))
        .unwrap()
        .expect("好帧必须落库");
    let (ok_at, updated_at): (String, String) = conn
        .query_row(
            "SELECT last_ok_at, updated_at FROM device_config WHERE id = ?1",
            params![dev],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_display_stamp(&ok_at, "last_ok_at");
    assert!(updated_at.contains('T') && updated_at.contains("+08:00"), "updated_at 仍走 now_iso：{updated_at}");

    // 失败一次：报错时刻同格式。last_err_at 不上卡片，但它与 last_ok_at 是同一张表的
    // 同一类列，格式漂了下次就漂到看得见的那一格上
    let degraded = banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, "!!!!not base64!!!!")
        .unwrap();
    assert!(degraded.is_none(), "坏帧按无抓拍降级（Ok(None)），不过磅照常");
    let err_at: String = conn
        .query_row("SELECT last_err_at FROM device_config WHERE id = ?1", params![dev], |r| r.get(0))
        .unwrap();
    assert_display_stamp(&err_at, "last_err_at");
}

/// 0031 把 `attachment_max_kb` 从 500 抬到 2048。500 是按"落库前会先压缩"定的，
/// 而压缩链路至今没有（全仓无 JPEG 解码依赖，见 04 §4.2），于是主码流摄像机
/// 2560×1440 的正常出图（500–900 KB）被整张拒收，现场那张 512 KB 就是这一格。
/// 这里钉四件事：种子值、站点自配值仍生效、离谱值与缺键都退到 `DEFAULT_MAX_KB`、
/// 而 `DEFAULT_MAX_KB` 与种子同数（改一处漏一处就会悄悄恢复那道拒收闸门）。
#[test]
fn the_snapshot_size_cap_is_the_one_the_migration_seeded() {
    let conn = mem_db();
    let seeded: String = conn
        .query_row("SELECT value_json FROM app_setting WHERE key = 'attachment_max_kb'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(seeded, "2048", "0031 之后种子默认应是 2048 KB");
    assert_eq!(banghe_lib::camera::max_snapshot_bytes(&conn), 2048 * 1024);

    // 现场那张 512 KB 的图现在**不必压缩**就该进线（这一条就是本次故障的复现；
    // 压缩链路兜的是更大那张，见下面 `over_budget_capture_is_rescaled_into_the_cap`）
    let mut field_frame = vec![0xFF, 0xD8, 0xFF, 0xE0];
    field_frame.extend(std::iter::repeat_n(0xAB, 512 * 1024));
    field_frame.extend_from_slice(&[0xFF, 0xD9]);
    check_jpeg(&field_frame, banghe_lib::camera::max_snapshot_bytes(&conn)).expect("512 KB 的主码流出图不该再被拒");

    // 站点自己调小要真生效（盘紧就调回 1024）
    conn.execute("UPDATE app_setting SET value_json = '1024' WHERE key = 'attachment_max_kb'", []).unwrap();
    assert_eq!(banghe_lib::camera::max_snapshot_bytes(&conn), 1024 * 1024, "站点自配值不得被默认顶掉");

    // 离谱值与缺键都按 DEFAULT_MAX_KB 兜，且那个默认必须与种子同数
    conn.execute("UPDATE app_setting SET value_json = '-1' WHERE key = 'attachment_max_kb'", []).unwrap();
    assert_eq!(banghe_lib::camera::max_snapshot_bytes(&conn), 2048 * 1024, "0 与负数不放行，按默认兜");
    conn.execute("DELETE FROM app_setting WHERE key = 'attachment_max_kb'", []).unwrap();
    assert_eq!(
        banghe_lib::camera::max_snapshot_bytes(&conn),
        2048 * 1024,
        "缺键兜底与 0031 的种子不是同一个数：`DEFAULT_MAX_KB` 与种子默认会各漂一头"
    );
}

// ------------------------------------------------ 抓拍压缩链路（04 §4.2，fit_to_budget）

/// 造一张**真解得开**的 JPEG：`jpeg-encoder` 编一段确定性伪噪声（LCG，跨机器逐字节可复现）。
/// 用噪声而不是渐变是故意的——渐变图压出来几十 KB，压根测不出"超限"这件事。
fn noisy_jpeg(w: usize, h: usize, quality: u8) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(w * h * 3);
    let mut s: u32 = 0x1234_5678;
    for _ in 0..(w * h * 3) {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        rgb.push((s >> 24) as u8);
    }
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality)
        .encode(&rgb, w as u16, h as u16, jpeg_encoder::ColorType::Rgb)
        .expect("合成 RGB 应能编码");
    out
}

/// 回读一张 JPEG 的宽高（测试侧自己解，不借生产代码的 `decode_rgb`，免得用被测者验被测者）。
fn decoded_dims(jpeg: &[u8]) -> (usize, usize) {
    let mut d = jpeg_decoder::Decoder::new(jpeg);
    d.decode().expect("压缩结果必须是解得开的 JPEG");
    let info = d.info().expect("decode 成功后应能读 info");
    (usize::from(info.width), usize::from(info.height))
}

/// 现场那一格的真实形状：主码流 2560×1440 出图 500–900 KB，撞 500 KB 上限。
/// 补上压缩链路之后它不该再被丢弃，而是缩到长边 ≤1600 入库（04 §4.2）。
#[test]
fn over_budget_capture_is_rescaled_into_the_cap() {
    let src = noisy_jpeg(2560, 1440, 95);
    let cap = 500 * 1024;
    assert!(src.len() > cap, "夹具本身要真的超限，否则这条测试是空转：{} KB", src.len() / 1024);

    let out = banghe_lib::camera::fit_to_budget(src, cap).expect("超限的图现在该压得进，而不是拒收");
    assert!(out.len() <= cap, "压完 {} KB 仍超 {} KB", out.len() / 1024, cap / 1024);
    let (w, h) = decoded_dims(&out);
    assert!(w <= banghe_lib::camera::CAPTURE_MAX_EDGE && h <= banghe_lib::camera::CAPTURE_MAX_EDGE, "长边要压到 {w}×{h}");
    assert_eq!(w * 9, h * 16, "16:9 的比例不许缩歪：{w}×{h}");
}

/// 没超限就一个字节都不动。JPEG 重编是有损的二次量化，凭证图不该白过一遍编码器；
/// 这一条守的是"补压缩"这件事不把 90% 正常图的质量顺手拉低。
#[test]
fn within_budget_capture_survives_byte_for_byte() {
    let src = noisy_jpeg(640, 480, 80);
    let cap = 500 * 1024;
    assert!(src.len() <= cap, "夹具要在线内：{} KB", src.len() / 1024);
    let out = banghe_lib::camera::fit_to_budget(src.clone(), cap).unwrap();
    assert_eq!(out, src, "线内的图必须原样返回，连重编都不许有");
}

/// 竖构图与本来就小的图：只许缩、不许放大（放大既不省字节也不多信息）。
#[test]
fn portrait_and_already_small_frames_are_never_upscaled() {
    // 竖构图：长边是 2560 那一头，缩完仍是竖的、比例不变
    let tall = noisy_jpeg(1440, 2560, 95);
    let out = banghe_lib::camera::fit_to_budget(tall, 500 * 1024).unwrap();
    let (w, h) = decoded_dims(&out);
    assert!(h > w, "竖图缩完还得是竖的：{w}×{h}");
    assert!(h <= banghe_lib::camera::CAPTURE_MAX_EDGE, "长边 {h} 没进 1600 那一档");
    assert_eq!(w * 16, h * 9, "9:16 的比例不许缩歪：{w}×{h}");

    // 长边本就在线内：只降质，尺寸一格都不动
    let small = noisy_jpeg(800, 600, 95);
    let cap = small.len() * 3 / 4;
    assert!(cap > 16 * 1024, "夹具太小，这条测不出降质档：{} KB", small.len() / 1024);
    let out = banghe_lib::camera::fit_to_budget(small, cap).expect("800×600 压掉四分之一该压得进");
    assert!(out.len() <= cap, "只降质也要进线：{} KB > {} KB", out.len() / 1024, cap / 1024);
    assert_eq!(decoded_dims(&out), (800, 600), "长边已在 1600 以内就不该再动尺寸");
}

/// 阶梯见底还压不进（极小预算 + 极密纹理）时，话术要带上"已经压到哪一档"，
/// 让人一眼判这是上限设得太狠，而不是摄像机坏了。
#[test]
fn the_ladder_gives_up_loudly_when_nothing_fits() {
    let src = noisy_jpeg(2560, 1440, 95);
    let err = banghe_lib::camera::fit_to_budget(src, 4 * 1024).expect_err("噪声图压不进 4 KB，必须明确失败");
    assert!(err.contains("1024×576"), "要说清最后压到了哪一档：{err}");
    assert!(err.contains("无抓拍"), "降级口径不能少：{err}");
    assert!(err.contains("站点参数") || err.contains("摄像机侧"), "要给下一步动作：{err}");
}

/// 灰度抓拍机（红外/老机型）走的是一条单独的像素分支：解出 L8、复制成三通道再编。
/// 忘了这一支的表现是"灰度机永远压不进"，所以单独钉一条。
#[test]
fn grayscale_frames_take_the_same_ladder() {
    let mut g = Vec::with_capacity(1280 * 720);
    let mut s: u32 = 0x9e37_79b9;
    for _ in 0..(1280 * 720) {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        g.push((s >> 24) as u8);
    }
    let mut src = Vec::new();
    jpeg_encoder::Encoder::new(&mut src, 95)
        .encode(&g, 1280, 720, jpeg_encoder::ColorType::Luma)
        .expect("灰度夹具应能编码");
    let cap = src.len() * 3 / 4;
    assert!(cap > 16 * 1024, "灰度夹具太小：{} KB", src.len() / 1024);
    let out = banghe_lib::camera::fit_to_budget(src, cap).expect("灰度图也要压得进");
    assert!(out.len() <= cap, "灰度阶梯没进线：{} KB > {} KB", out.len() / 1024, cap / 1024);
    assert_eq!(decoded_dims(&out), (1280, 720), "长边在线内，只降质不动尺寸");
}

/// 解不开的图**不新增失败**：线内照样入库（这一条守的是 fake_jpeg 那类历史形状），
/// 只有超限又压不动才拒收。缺了它，"补上压缩能力"本身会让一批原本能存的图变成无抓拍。
#[test]
fn undecodable_frames_are_stored_when_they_fit_and_only_refused_when_they_dont() {
    let junk = {
        let mut v = vec![0xFF, 0xD8, 0xFF, 0xE0];
        v.extend(std::iter::repeat_n(0xAB, 64 * 1024));
        v.extend_from_slice(&[0xFF, 0xD9]);
        v
    };
    assert_eq!(banghe_lib::camera::fit_to_budget(junk.clone(), 500 * 1024).unwrap(), junk);
    let err = banghe_lib::camera::fit_to_budget(junk, 32 * 1024).expect_err("超限且压不动就该拒");
    assert!(err.contains("解不开"), "{err}");
}

/// 端到端：本机回传帧这条路（`store_provided_frame`）超限之后落库的到底是压过的图，
/// 且 `attachment.file_size` 与盘上文件、与 SHA 对的是同一份字节。
/// 只测 `fit_to_budget` 挡不住这一层——接线接错（先算哈希后压缩）在单元测试里看不出来。
#[test]
fn an_over_budget_local_frame_lands_compressed_and_consistent() {
    let conn = mem_db();
    conn.execute("UPDATE app_setting SET value_json = '500' WHERE key = 'attachment_max_kb'", []).unwrap();
    let tmp = TempDir::new("compress");
    let ctx = seed_fixture(&conn);
    seed_camera(&conn, "camuvc", r#"{"transport":"local","deviceName":"Integrated Camera"}"#, None);

    // 夹具要落在"超限但拉得回来"那一段：比 500 KB 的落库上限大，比 8 MB 的拉取硬顶小。
    // （纯噪声按 q95 编会到 6 MB 以上，那是 JPEG 的最坏情况、不是相机的常态——主码流
    //  2560×1440 出图实际 500–900 KB。q60 的噪声图约 1–2 MB，两头都留得下。）
    let src = noisy_jpeg(2560, 1440, 60);
    assert!(src.len() > 500 * 1024, "夹具要真的超限：{} KB", src.len() / 1024);
    assert!(src.len() < banghe_lib::camera::SNAPSHOT_FETCH_MAX_BYTES, "夹具别撞上拉取硬顶：{} KB", src.len() / 1024);
    let att = banghe_lib::camera::store_provided_frame(&conn, &tmp.path, &ctx, &base64_standard(&src))
        .unwrap()
        .expect("超限不再是丢图的理由");

    let (size, sha, path): (i64, String, String) = conn
        .query_row("SELECT file_size, sha256, file_path FROM attachment WHERE id = ?1", params![att], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert!(size <= 500 * 1024 && size > 0, "落库大小应是压完的那份：{} KB", size / 1024);
    let on_disk = std::fs::read(tmp.path.join(&path)).expect("附件文件应在数据目录下");
    assert_eq!(on_disk.len() as i64, size, "file_size 与盘上字节必须是同一份");
    assert_eq!(sha256_hex_of(&on_disk), sha, "SHA 必须算在压缩之后的字节上，否则完整性校验是假的");
    let (w, h) = decoded_dims(&on_disk);
    assert!(w <= banghe_lib::camera::CAPTURE_MAX_EDGE && h <= banghe_lib::camera::CAPTURE_MAX_EDGE, "入库的应是缩过的那一张，实际 {w}×{h}");
    assert!(w < 2560, "源图是 2560 宽，落库还是 2560 就说明压缩没接上");
}

fn sha256_hex_of(bytes: &[u8]) -> String {
    use sha2::{Digest as _, Sha256};
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// 压缩这一跳的耗时预算（04 §1：宁可拿不到图，也不让磅队停下来等一台摄像头）。
/// 断言给的是**宽松**上限（5 秒），防的是"有人把面积平均换成一个慢十倍的东西"这种量级的
/// 倒退。真值靠 `--nocapture` 打出来，04 §4.2 里那句耗时是这么测的、不是拍脑袋写的：
/// `cargo test --test camera_contract -- compression_stays -- --nocapture`
/// （debug 与 release 差好几倍，打印行里带着是哪个构建，别拿 debug 的数当现场的数）
#[test]
fn compression_stays_inside_the_capture_time_budget() {
    let cap = 500 * 1024;

    // 典型：主码流 2560×1440 出图 1–2 MB（现场那台 512 KB 的根本不进这段，原样直存）
    let typical = noisy_jpeg(2560, 1440, 60);
    let t = std::time::Instant::now();
    let out = banghe_lib::camera::fit_to_budget(typical.clone(), cap).expect("该压得进");
    let typical_ms = t.elapsed().as_millis();

    // 最坏：纯噪声 q95，比任何真实相机都难压，阶梯要一路往下走
    let worst = noisy_jpeg(2560, 1440, 95);
    let t = std::time::Instant::now();
    let big = banghe_lib::camera::fit_to_budget(worst.clone(), cap).expect("该压得进");
    let worst_ms = t.elapsed().as_millis();

    println!(
        "[压缩预算·{}] 典型 {} KB→{} KB {typical_ms} ms · 最坏 {} KB→{} KB {worst_ms} ms",
        if cfg!(debug_assertions) { "debug" } else { "release" },
        typical.len() / 1024,
        out.len() / 1024,
        worst.len() / 1024,
        big.len() / 1024,
    );
    assert!(typical_ms < 5000, "典型档退化了：{typical_ms} ms");
    assert!(worst_ms < 5000, "最坏档退化了（阶梯 7 次编码 + 全图缩放）：{worst_ms} ms");
}
