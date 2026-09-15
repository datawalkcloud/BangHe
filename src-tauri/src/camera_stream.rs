//! ③′ 工作台「过磅画面」的第二条通道：Rust 拉 RTSP/H.264 → 软解 → 一帧一张 JPEG 推给界面。
//!
//! 为什么不是"一秒 HTTP 抓一张图"（这一版先前正是那么写的）：
//!  1. 抓图端点出的是**主码流**整图（现场那台是 2560×1440、几百 KB），一秒一张等于让摄像机
//!     每秒重做一次整图编码，也把磅房那条网线当视频线用；
//!  2. 它是"截图"不是"视频"。磅员要判的是压边、不上全磅、中途换货、车厢夹带——都是**动作**，
//!     一秒一跳看不出来；
//!  3. 每帧一次 TCP 连接 + Digest 两趟往返，握手开销比像素还多。
//!
//! 现在这条路：一台机**一条** RTSP/TCP 会话、只订**子码流**（768×432 量级、H.264），
//! DESCRIBE/SETUP/PLAY 一次握手之后连续收 RTP，openh264 软解成 YUV，再压一张 JPEG 推屏。
//! 摄像机侧的负担从"每秒一次整图编码"变回"它本来就在发的码流"，界面看到的是真正的连续画面。
//!
//! 为什么不把 H.264 直接丢给 WebView：WebView2 播 RTSP 要引 ffmpeg 或厂商 SDK，而
//! `<video>`/WebCodecs 吃的是 fMP4，得再加一条容器封装与时序工程。Rust 解 + JPEG 上屏
//! 复用的是本项目已经验过的三样东西（Digest 认证、JPEG、事件推送），不新增运行时依赖。
//!
//! 三条边界与抓拍同源，一条都不松：
//!  1. **只降级不报错**：连不上、401、不是 H.264、等不到关键帧——都在这一格里回一句人话
//!     （04 §4.2、H6），不弹框、不拦称重与结算；
//!  2. **不落库、不刷台账**：预览帧没有 `weigh_order` 可挂，落库既无处归类也白占磁盘配额；
//!     一秒十来帧去刷 `last_ok_at`/`updated_at` 更会把台账的"最近变更"刷成噪音。
//!     画面里是农户人像与车牌：只在本机内存与本机 IPC 里过一遍，不外传、不上传云端；
//!     通不通的权威结论仍由设备中心联机测试与过磅抓拍回写；
//!  3. **端点只从台账来**：`rtsp://` 地址与口令一律由 `device_config` 拼（见 [`rtsp_target`]），
//!     前端只能给一个 `code`——否则任何人都能借这个应用去访问内网任意地址。

use std::collections::{HashMap, VecDeque};
use std::io::{ErrorKind, Read, Write};
use std::net::TcpStream;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{command, AppHandle, Emitter, Manager};

use crate::camera::{self, DigestChallenge, HttpHead};

/// 帧事件名。载荷 [`CameraFrame`]：一帧 JPEG 的 dataURL + 尺寸与序号。
pub const CAMERA_FRAME_EVENT: &str = "device://camera-frame";
/// 状态事件名。**只在看得见的问题变了时**发一次（连上 / 掉了 / 换阶段 / 报错），载荷 [`StreamStatus`]。
/// 一秒十来帧的流量不走它，避免把 IPC 挤满。
pub const CAMERA_STATUS_EVENT: &str = "device://camera-status";

/// 状态机的四个阶段。前端按这个出中文，不在这里堆文案。
pub const PHASE_CONNECTING: &str = "connecting";
pub const PHASE_KEYFRAME: &str = "waiting-keyframe";
pub const PHASE_STREAMING: &str = "streaming";
pub const PHASE_ERROR: &str = "error";

/// RTSP 默认端口（RFC 2326 §2）。
const RTSP_DEFAULT_PORT: u16 = 554;
/// 一次握手（DESCRIBE/SETUP/PLAY 每一趟）最多等多久。
const HANDSHAKE_GAP: Duration = Duration::from_secs(3);
/// 收包节奏：500 ms 醒一次，好及时看停止位与保活钟。
/// 太短是白转 CPU，太长会让"界面已经关了"到几秒后才被线程发现。
const POLL_GAP: Duration = Duration::from_millis(500);
/// 摄像机侧会话超时通常 60 秒；空闲到点就自己发一趟保活（GET_PARAMETER/OPTIONS）。
const KEEPALIVE_GAP: Duration = Duration::from_secs(20);
/// 播起来之后连续这么多秒没出一帧，就当你偷偷掉了重连一次。
/// 子码流 I 帧间隔 50（≈5 秒），所以这个值必须明显大于一个 GOP，否则每次都在等关键帧路上被打断。
const FRAME_STARVE: Duration = Duration::from_secs(15);
/// 一趟失败后的重连间隔（连续失败会退到 RETRY_MAX）。
const RETRY_GAP: Duration = Duration::from_secs(2);
const RETRY_MAX: Duration = Duration::from_secs(15);
/// 一次读最多搬这么多字节。768×432 的一帧约 30 KB，分片到达时这里就是"一趟能攒多少"。
const READ_CHUNK: usize = 64 * 1024;
/// 收包缓冲上限：超过它还没凑出一条消息，说明对端回的不是 RTSP。
const MAX_BUF_BYTES: usize = 4 * 1024 * 1024;
/// 单个 NAL / 单个访问单元的字节上限。坏流不许把内存吃掉。
const MAX_AU_BYTES: usize = 4 * 1024 * 1024;
/// 预览 JPEG 质量。<90 时 jpeg-encoder 自动用 4:2:0 采样，一帧约 40–70 KB。
const JPEG_QUALITY: u8 = 82;

// ============================================================ 台账 → RTSP 端点

/// 一路预览的完整寻址。**只能**由台账拼出来（[`rtsp_target`]），前端给不了 URL。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RtspTarget {
    pub code: String,
    pub host: String,
    pub port: u16,
    /// 不含 host 的路径，如 `/Streaming/Channels/102`（可以带查询串）
    pub path: String,
    pub user: Option<String>,
    pub password: Option<String>,
}

impl RtspTarget {
    /// 请求行与会话 URI 都用绝对地址：RTSP 的 Digest 必须按**完整 URI** 签，
    /// 少一段就会算出对不上的 response（真机实测：同一条请求换 URI 写法，401 立刻回来）。
    pub fn uri(&self) -> String {
        format!("rtsp://{}:{}{}", self.host, self.port, self.path)
    }
}

/// 从预览那一行的台账拼 RTSP 端点。
///
/// host / 端口 / 路径 / 口令 / 认证方式的合法性**已经在 [`camera::preview_target_from_config`]
/// 那趟判过了**，这里只做两件事：把 HTTP 的抓图路径换成 RTSP 的轨道路径，以及读
/// `rtspUrl` / `rtspPort` 这两个只有预览认的键。
///
/// 推导规则（海康现场最常见，所以让它零配置就能跑）：
///  - 台账填了 `rtspUrl` → 用它（可以整条 `rtsp://host:554/...`，也可以只写 `/Streaming/Channels/102`）；
///  - 否则从预览/抓图路径里的 `channels/<数字>` 推 `/Streaming/Channels/<数字>`——
///    主码流 `101` 就推 `101`、子码流 `102` 就推 `102`，两条通道各归各的；
///  - 推不出来（大华那类 `/cgi-bin/snapshot.cgi`）→ 明确要人填 `rtspUrl`，不猜。
pub(crate) fn rtsp_target(row: &camera::LiveRow) -> Result<RtspTarget, String> {
    let t = &row.target;
    let cfg: serde_json::Value = serde_json::from_str(&row.config_json).unwrap_or_default();
    let code = t.device_code.as_str();

    let port = match camera::text(&cfg, &["rtspPort", "rtsp_port"]) {
        Some(raw) => raw.parse::<u16>().map_err(|_| {
            format!("摄像机「{code}」的 RTSP 端口「{raw}」不是 1–65535 的整数")
        })?,
        None => RTSP_DEFAULT_PORT,
    };
    if port == 0 {
        return Err(format!("摄像机「{code}」的 RTSP 端口不能为 0"));
    }

    let path = match camera::text(&cfg, &["rtspUrl", "rtsp_url"]) {
        Some(raw) => rtsp_path_from_url(&raw, code)?,
        None => derive_rtsp_path(&t.path, code)?,
    };

    Ok(RtspTarget {
        code: code.to_string(),
        host: t.host.clone(),
        port,
        path,
        user: t.user.clone(),
        password: t.password.clone(),
    })
}

/// `rtspUrl` 的两种写法都收：整条 URL（丢掉协议与 host，因为 host 只认台账那个）或纯路径。
///
/// 公开是为了能被契约测试钉住：这段决定"往哪个路径发请求"，而整条 RTSP 通道在本机编不了，
/// 离线钉它是唯一的验证手段。
pub fn rtsp_path_from_url(raw: &str, code: &str) -> Result<String, String> {
    let raw = raw.trim();
    let lower = raw.to_ascii_lowercase();
    let rest = match lower.strip_prefix("rtsp://") {
        Some(_) => {
            // 小写副本只用来认协议，路径要从原文切：RTSP 路径区分大小写，
            // `/Streaming/Channels/102` 被写成小写后现场就是一条 404。
            let url = &raw["rtsp://".len()..];
            if url.contains('@') {
                return Err(format!(
                    "摄像机「{code}」的 RTSP 地址里不要带用户名口令：口令只放在登录口令那一栏"
                ));
            }
            // 只取 path 段；host 以台账为准，绝不照着这里填的地址去连（那是 SSRF 的入口）
            match url.find('/') {
                Some(i) => url[i..].to_string(),
                None => String::new(),
            }
        }
        None if lower.contains("://") => {
            return Err(format!("摄像机「{code}」的 RTSP 地址只支持 rtsp:// 前缀"))
        }
        None => raw.to_string(),
    };
    if rest.is_empty() {
        return Err(format!(
            "摄像机「{code}」的 RTSP 地址只有主机名没有路径：填成 rtsp://主机:554/Streaming/Channels/102 或直接 /Streaming/Channels/102"
        ));
    }
    camera::checked_path(&rest, code, "RTSP 路径")
}

/// 从 HTTP 抓图/预览路径推 RTSP 轨道路径（海康 ISAPI `/ISAPI/Streaming/channels/102/picture` → `/Streaming/Channels/102`）。
///
/// 与 [`rtsp_path_from_url`] 同理公开：它决定预览往哪儿发请求，只能离线钉。
pub fn derive_rtsp_path(snapshot_path: &str, code: &str) -> Result<String, String> {
    let digits = after_marker(snapshot_path, "channels/");
    if let Some(n) = digits {
        return Ok(format!("/Streaming/Channels/{n}"));
    }
    if snapshot_path.starts_with("/Streaming/") {
        return camera::checked_path(snapshot_path, code, "RTSP 路径");
    }
    Err(format!(
        "摄像机「{code}」认不出该怎么拉流：请在台账里填「RTSP 地址」（海康形如 /Streaming/Channels/102，大华形如 /cam/realmonitor?channel=1&subtype=1）"
    ))
}

/// `marker` 后面紧跟的那一串十进制数字（没有就 `None`）。
fn after_marker<'a>(s: &'a str, marker: &str) -> Option<&'a str> {
    let i = s.to_ascii_lowercase().find(marker)? + marker.len();
    let rest = s.get(i..)?;
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    let digits = &rest[..end];
    (!digits.is_empty()).then_some(digits)
}

// ============================================================ RTSP 报文（纯函数）

/// 一条 RTSP 请求的字节。纯函数，所以方法、URI、CSeq、Session、认证头都能离线钉死。
/// 版本用 1.0：RTSP/1.1 没有实现上的好处，而部分固件只按 1.0 解析请求行。
pub fn rtsp_request(
    method: &str,
    uri: &str,
    cseq: u32,
    session: Option<&str>,
    authorization: Option<&str>,
    extra: &[(&str, &str)],
) -> Vec<u8> {
    let mut lines = vec![
        format!("{method} {uri} RTSP/1.0"),
        format!("CSeq: {cseq}"),
    ];
    if let Some(s) = session {
        lines.push(format!("Session: {s}"));
    }
    for (k, v) in extra {
        lines.push(format!("{k}: {v}"));
    }
    if let Some(a) = authorization {
        lines.push(format!("Authorization: {a}"));
    }
    lines.push(format!(
        "User-Agent: banghe/{} (weighbridge-preview)",
        env!("CARGO_PKG_VERSION")
    ));
    let mut buf = lines.join("\r\n").into_bytes();
    buf.extend_from_slice(b"\r\n\r\n");
    buf
}

/// 收流方向上的一条完整消息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RtspMsg {
    /// 一条响应 + 它的 body（SDP 就在里面）。
    Response(HttpHead, Vec<u8>),
    /// `$` 帧：RTP 走偶通道、RTCP 走奇通道（RFC 2326 §10.12）。
    Interleaved { channel: u8, packet: Vec<u8> },
}

/// 从收包缓冲里取**一条**消息；没收全就回 `Ok(None)`（真机分片到达是常态）。
///
/// 顺手吃掉开头那些裸 CRLF：RTSP 的保活就是 `\r\n\r\n` 四个字节，不剥掉会被
/// 当成"看不出协议"而误判成一次掉线。
pub fn next_msg(buf: &mut Vec<u8>) -> Result<Option<RtspMsg>, String> {
    while buf.first().is_some_and(|b| *b == b'\r' || *b == b'\n') {
        buf.remove(0);
    }
    if buf.is_empty() {
        return Ok(None);
    }
    if buf[0] == 0x24 {
        if buf.len() < 4 {
            return Ok(None);
        }
        let channel = buf[1];
        let len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
        if buf.len() < 4 + len {
            return Ok(None);
        }
        // 一次 drain 搬走「4 字节帧头 + 包体」：分两次挪会白挪一遍缓冲
        let packet = buf.drain(..4 + len).skip(4).collect();
        return Ok(Some(RtspMsg::Interleaved { channel, packet }));
    }
    let head_end = match buf.windows(4).position(|w| w == b"\r\n\r\n") {
        Some(i) => i + 4,
        None => {
            if buf.len() > MAX_BUF_BYTES {
                return Err("缓冲涨到 4 MB 还没收到完整的响应头：这台机回的不是标准 RTSP".into());
            }
            return Ok(None);
        }
    };
    // 头已经收齐了才解它：`content_length` 是"这条消息总共多少字节"的唯一依据，
    // 而 body_start 就是这里的 head_end，不用等 body 到齐再算第二遍。
    let head = camera::parse_http_head(&buf[..head_end])?;
    let need = head_end + head.content_length.unwrap_or(0);
    if need > MAX_BUF_BYTES {
        return Err(format!("摄像机声明了一条 {need} 字节的 RTSP 响应，超出可接受范围"));
    }
    if buf.len() < need {
        return Ok(None);
    }
    let body = buf.drain(..need).skip(head_end).collect();
    Ok(Some(RtspMsg::Response(head, body)))
}

/// 从 `Session: 12345678;timeout=60` 里取会话号（分号前那段）。
pub fn session_id(value: &str) -> Option<&str> {
    let v = value.split(';').next()?.trim();
    (!v.is_empty()).then_some(v)
}

/// 从 `Session: 12345678;timeout=60` 里取秒数。
///
/// 只认键叫 `timeout` 的那个参数：`Session` 头后面还会跟别的参数，见数就拿来当超时
/// 会把保活钟算到错误的点上（保活发晚了就是摄像机单方面断会话）。
pub fn session_timeout_secs(value: &str) -> Option<u64> {
    value.split(';').find_map(|p| {
        let (k, v) = p.trim().split_once('=')?;
        k.trim().eq_ignore_ascii_case("timeout")
            .then(|| v.trim().parse::<u64>().ok())
            .flatten()
    })
}

/// 从 `Transport: RTP/AVP/TCP;unicast;interleaved=2-3` 里取这对通道号。
pub fn interleaved_channels(value: &str) -> Option<(u8, u8)> {
    value.split(';').find_map(|p| {
        let p = p.trim();
        let rest = p.strip_prefix("interleaved=")?;
        let (a, b) = rest.split_once('-')?;
        Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
    })
}

// ============================================================ SDP

/// 要订的那条视频轨。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct VideoTrack {
    /// SETUP/PLAY 用的完整 URI（相对 control 已按 base 拼好）
    pub uri: String,
    /// 这路 H.264 的 payload type（现场那台是 96，但绝不能写死）
    pub payload_type: u8,
    /// SDP `sprop-parameter-sets` 预带的 SPS/PPS（裸 NAL，不含起始码）
    pub parameter_sets: Vec<Vec<u8>>,
}

/// SDP → **第一条 H.264 视频轨**。
///
/// 为什么要按媒体段切着找：音频轨也带 `a=control`，整份文本抓最后一个 control
/// 就会订到音频上去（真机这么踩过一次，画面永远等不来帧）。
pub fn video_track(base_uri: &str, sdp: &str) -> Result<VideoTrack, String> {
    let mut session_control: Option<String> = None;
    let mut sections: Vec<(bool, Vec<String>)> = Vec::new();
    for raw in sdp.lines() {
        let line = raw.trim();
        if let Some(rest) = line.strip_prefix("m=") {
            let video = rest
                .split_whitespace()
                .next()
                .is_some_and(|kind| kind.eq_ignore_ascii_case("video"));
            sections.push((video, vec![line.to_string()]));
        } else if sections.is_empty() {
            // 会话级的 `a=control:*` 只出现在第一条 `m=` 之前；进了媒体段之后
            // 这种行一律归那一段，否则轨道地址会被段外的行盖掉。
            if let Some(v) = line.strip_prefix("a=control:") {
                session_control = Some(v.trim().to_string());
            }
        } else if let Some(last) = sections.last_mut() {
            last.1.push(line.to_string());
        }
    }
    let mut rejected: Option<String> = None;
    for (video, lines) in &sections {
        if !*video {
            continue;
        }
        match video_section(base_uri, session_control.as_deref(), lines) {
            Ok(Some(track)) => return Ok(track),
            // 这一段不是 H.264 视频轨：接着找下一段
            Ok(None) => {}
            // 段有问题但原因得留着：没有可用轨道时，报的就是这句，而不是
            // "没有 H.264 轨"——那会把人引到视频参数页上去，而真问题是地址。
            Err(why) => {
                rejected.get_or_insert(why);
            }
        }
    }
    Err(rejected.unwrap_or_else(|| {
        "这台机的码流里没有 H.264 视频轨：预览只解 H.264，请到摄像机 web 界面把**子码流**的编码从 H.265 改成 H.264（主码流留着给抓拍/录像）".to_string()
    }))
}

fn video_section(
    base_uri: &str,
    session_control: Option<&str>,
    lines: &[String],
) -> Result<Option<VideoTrack>, String> {
    let Some(m) = lines.first().and_then(|l| l.strip_prefix("m=video")) else {
        return Ok(None);
    };
    // m=video <port> <proto> <fmt>…：前两项不是 payload type
    if !m.split_whitespace().skip(2).any(|f| f.parse::<u8>().is_ok()) {
        return Ok(None);
    }
    let mut control: Option<String> = None;
    let mut fmtp: Option<(u8, String)> = None;
    let mut h264_pt: Option<u8> = None;
    for line in lines.iter().skip(1) {
        if let Some(v) = line.strip_prefix("a=rtpmap:") {
            let Some((pt, encoding)) = v.split_once(' ') else { continue };
            if encoding
                .split('/')
                .next()
                .is_some_and(|e| e.eq_ignore_ascii_case("H264"))
            {
                h264_pt = pt.trim().parse().ok();
            }
        } else if let Some(v) = line.strip_prefix("a=fmtp:") {
            if let Some((pt, rest)) = v.split_once(' ') {
                if let Ok(p) = pt.trim().parse::<u8>() {
                    fmtp = Some((p, rest.to_string()));
                }
            }
        } else if let Some(v) = line.strip_prefix("a=control:") {
            control = Some(v.trim().to_string());
        }
    }
    let Some(payload_type) = h264_pt else {
        return Ok(None);
    };
    let parameter_sets = match fmtp {
        Some((p, f)) if p == payload_type => sprop_parameter_sets(&f),
        _ => Vec::new(),
    };
    let uri = match control.as_deref().or(session_control) {
        Some(c) => join_control(base_uri, c)?,
        None => base_uri.trim_end_matches('/').to_string(),
    };
    Ok(Some(VideoTrack {
        uri,
        payload_type,
        parameter_sets,
    }))
}

/// `profile-level-id=42001f;packetization-mode=1;sprop-parameter-sets=Z…` → 解码后的参数集。
fn sprop_parameter_sets(fmtp: &str) -> Vec<Vec<u8>> {
    fmtp.split(';')
        .find_map(|kv| match kv.split_once('=') {
            Some((k, v)) if k.trim().eq_ignore_ascii_case("sprop-parameter-sets") => Some(v),
            _ => None,
        })
        .map(|v| {
            v.split(',')
                .filter_map(|b64| {
                    let t = b64.trim();
                    (!t.is_empty())
                        .then(|| camera::base64_decode(t))
                        .flatten()
                        .filter(|b| !b.is_empty())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 把 SDP 的 `a=control` 拼成请求 URI。
///
/// 两条硬规矩：绝对的 `rtsp://` 只准指**同一台机**（否则台账里这台好机器就会被拿去
/// 拉别人的地址），以及任何形式都不准带 `user:pass@`——口令只从台账来，绝不从对端
/// 回的报文里捡。字符校验与 [`camera::checked_path`] 同一把尺子：控制字符能撕开请求行。
pub fn join_control(base_uri: &str, control: &str) -> Result<String, String> {
    let c = control.trim();
    if c.is_empty() {
        return Err("SDP 里的轨道地址是空的".into());
    }
    // RFC 2326 §6.2 的通配符：`*` 说的是"整条会话可控"，SETUP 就打这条会话 URI 本身。
    // 当成相对路径拼就会得到 `<uri>/*`，海康对此回 404/461，现场只看到"连上了又没画面"。
    if c == "*" {
        return Ok(base_uri.trim_end_matches('/').to_string());
    }
    if c.chars().any(|ch| (ch as u32) < 0x21 || ch == '"' || ch == '\\' || (ch as u32) > 0x7e) {
        return Err("SDP 的轨道地址含空格、控制字符或非 ASCII 字符".into());
    }
    if c.contains("://") {
        let scheme_ok = c
            .split_once("://")
            .is_some_and(|(s, _)| s.eq_ignore_ascii_case("rtsp"));
        if !scheme_ok {
            return Err(format!("SDP 指向了非 rtsp 协议的地址：{c}"));
        }
        if authority_of(c).contains('@') {
            return Err("SDP 的轨道地址里带了登录口令，预览不接受".into());
        }
        if authority_of(c) != authority_of(base_uri) {
            return Err(format!(
                "SDP 指向另一台主机「{}」，预览只拉台账里那台",
                authority_of(c)
            ));
        }
        return Ok(c.to_string());
    }
    if c.contains('@') {
        return Err("SDP 的轨道地址里带了登录口令，预览不接受".into());
    }
    // 以 `/` 开头的是**从根算起**的路径（RFC 3986 §5.3）：只留 base 的协议与主机，路径整个换掉。
    // 当成相对路径拼会得到 `<会话路径>/xxx`，海康回 404，现场只表现为"连上了却没画面"。
    if let Some(rest) = c.strip_prefix('/') {
        if let Some((scheme, after)) = base_uri.split_once("://") {
            let origin = format!("{}://{}", scheme, after.split('/').next().unwrap_or(after));
            return Ok(format!("{origin}/{rest}"));
        }
    }
    Ok(format!("{}/{}", base_uri.trim_end_matches('/'), c))
}

/// `rtsp://host:554/a/b` → `host:554`。
fn authority_of(uri: &str) -> &str {
    let rest = uri.split_once("://").map(|(_, x)| x).unwrap_or(uri);
    &rest[..rest.find('/').unwrap_or(rest.len())]
}

// ============================================================ RTP → NAL

/// 一个 RTP 包的关键字段（RFC 3550 §5.1）。`payload` 是去掉头/填充后的裸载荷。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rtp<'a> {
    pub payload_type: u8,
    pub seq: u16,
    pub timestamp: u32,
    pub marker: bool,
    pub payload: &'a [u8],
}

/// 解 RTP 头。版本不对、CSRC/扩展越界、填充长度造假——一律 `None`。
///
/// 回 `None` 而不是 panic 是刻意的：坏包在现网是常态（交换机丢一段、固件凑数），
/// 为它停掉一路画面不值得，丢掉这一个包就行。
pub fn parse_rtp(buf: &[u8]) -> Option<Rtp<'_>> {
    let first = *buf.first()?;
    if first >> 6 != 2 {
        return None;
    }
    let padding = (first >> 5) & 1 == 1;
    let extension = (first >> 4) & 1 == 1;
    let csrc = (first & 0x0F) as usize;
    let mut at = 12 + csrc * 4;
    if buf.len() < at {
        return None;
    }
    let marker = buf[1] >> 7 == 1;
    let payload_type = buf[1] & 0x7F;
    let seq = u16::from_be_bytes([buf[2], buf[3]]);
    let timestamp = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
    if extension {
        if buf.len() < at + 4 {
            return None;
        }
        let words = u16::from_be_bytes([buf[at + 2], buf[at + 3]]) as usize;
        at += 4 + words * 4;
        if buf.len() < at {
            return None;
        }
    }
    let mut end = buf.len();
    if padding {
        let pad = *buf.last()? as usize;
        if pad == 0 || pad > end - at {
            return None;
        }
        end -= pad;
    }
    Some(Rtp {
        payload_type,
        seq,
        timestamp,
        marker,
        payload: buf.get(at..end)?,
    })
}

/// NAL 类型（去掉 fgc 位）。空 NAL 当 0 处理，调用方按"不是关键帧"看。
pub fn nal_type(nal: &[u8]) -> u8 {
    nal.first().map(|b| b & 0x1F).unwrap_or(0)
}

/// IDR 切片：解码器有了它才谈得上"这一帧是干净的"。
pub const NAL_IDR: u8 = 5;

/// RTP 载荷 → H.264 访问单元（RFC 6184 §5.7/§5.8：单 NAL / STAP-A / FU-A）。
///
/// 一帧结束有两条线索，哪条先到用哪条：RTP 的 marker 位，或时间戳跳到了下一帧。
/// 中途接入一条正在跑的流时，第一帧常常是从中间截断的 FU-A——起点丢了就整片丢掉，
/// 绝不把半截 NAL 塞给解码器（那只会解出一屏马赛克，比黑屏更坏）。
#[derive(Debug, Default)]
pub struct H264Stream {
    au: Vec<Vec<u8>>,
    au_bytes: usize,
    au_ts: Option<u32>,
    fu: Vec<u8>,
    fu_ts: u32,
    in_fu: bool,
    /// 因超限、类型不认或换帧时半截作废而丢弃的分片数（只作诊断，界面不单独显示）
    pub dropped: u64,
}

impl H264Stream {
    /// 吃一个 RTP 载荷，返回**已凑齐**的访问单元（每个是一批裸 NAL，不含起始码）。
    pub fn feed(&mut self, payload: &[u8], ts: u32, marker: bool) -> Vec<Vec<Vec<u8>>> {
        let mut out: Vec<Vec<Vec<u8>>> = Vec::new();
        if payload.is_empty() {
            return out;
        }
        // 换帧点上半截 FU-A 已无意义：整片作废（半截 NAL 喂解码器就是一屏马赛克），
        // 并计入 dropped——不然现场看"丢包 0"却永远等不来画面，无从下手。
        if self.in_fu && self.fu_ts != ts {
            self.dropped += 1;
            self.in_fu = false;
            self.fu.clear();
        }
        // 时间戳跳了：上一帧到此为止（marker 位丢了也能靠这条收尾）
        if !self.au.is_empty() && self.au_ts != Some(ts) {
            out.push(self.flush());
        }
        match payload[0] & 0x1F {
            1..=23 => self.push_nal(payload.to_vec(), ts),
            // STAP-A：1 字节头之后是 [2 字节长度][NAL] 若干段
            24 => {
                let mut i = 1usize;
                while i + 2 <= payload.len() {
                    let n = u16::from_be_bytes([payload[i], payload[i + 1]]) as usize;
                    i += 2;
                    if n == 0 || i + n > payload.len() {
                        self.dropped += 1;
                        break;
                    }
                    self.push_nal(payload[i..i + n].to_vec(), ts);
                    i += n;
                }
            }
            // FU-A：分片头第 2 字节的 S/E 位定起止，NAL 头由两个字节拼回来
            28 => {
                if payload.len() < 3 {
                    self.dropped += 1;
                } else {
                    let start = payload[1] & 0x80 != 0;
                    let end = payload[1] & 0x40 != 0;
                    if start {
                        self.fu.clear();
                        self.fu.push((payload[0] & 0xE0) | (payload[1] & 0x1F));
                        self.fu.extend_from_slice(&payload[2..]);
                        self.fu_ts = ts;
                        self.in_fu = true;
                    } else if self.in_fu && self.fu_ts == ts {
                        self.fu.extend_from_slice(&payload[2..]);
                    } else {
                        self.dropped += 1;
                        self.in_fu = false;
                    }
                    if end && self.in_fu && self.fu_ts == ts {
                        let nal = std::mem::take(&mut self.fu);
                        self.in_fu = false;
                        self.push_nal(nal, ts);
                    }
                }
            }
            // 25/26（STAP-B/FU-B）与 27、29–31 现网海康不发：认不出来就明确丢掉，
            // 而不是当单 NAL 塞给解码器——那会把错误扩散到整帧。
            _ => self.dropped += 1,
        }
        if marker && !self.au.is_empty() {
            out.push(self.flush());
        }
        out
    }

    fn push_nal(&mut self, nal: Vec<u8>, ts: u32) {
        if nal.len() > MAX_AU_BYTES || self.au_bytes + nal.len() > MAX_AU_BYTES {
            self.dropped += 1;
            self.reset();
            return;
        }
        self.au_bytes += nal.len();
        self.au_ts = Some(ts);
        self.au.push(nal);
    }

    fn flush(&mut self) -> Vec<Vec<u8>> {
        let au = std::mem::take(&mut self.au);
        self.au_bytes = 0;
        self.au_ts = None;
        self.in_fu = false;
        self.fu.clear();
        au
    }

    fn reset(&mut self) {
        self.au.clear();
        self.au_bytes = 0;
        self.au_ts = None;
        self.in_fu = false;
        self.fu.clear();
    }
}

// ============================================================ 解码与压 JPEG

/// 一帧的画面：JPEG 字节 + 真实尺寸。
pub struct JpegFrame {
    pub jpeg: Vec<u8>,
    pub width: u16,
    pub height: u16,
}

/// openh264 解码器 + 关键帧闸门 + JPEG 缓冲。一台机一份，跑在那台机的读线程上。
struct Renderer {
    decoder: openh264::decoder::Decoder,
    /// SDP 预带的参数集。解码器重建之后还要再喂一次——有些固件的关键帧不带内联
    /// SPS/PPS，重建后手上没有参数集就等于从此解不开。
    parameter_sets: Vec<Vec<u8>>,
    /// 每次 `decode` 的入参缓冲：攒出「起始码 + NAL」的 Annex-B 形态再交出去。
    scratch: Vec<u8>,
    /// 手上有没有见过 IDR。没见过之前不往界面推。
    keyframe: bool,
}

/// Annex-B 起始码。喂给 `decode` 的切片带它：openh264 自己的示例就是把 `nal_units()`
/// 切出来的、**保留起始码**的那些切片直接送进解码器，这里照抄它的用法。
const NAL_START: [u8; 3] = [0, 0, 1];

/// 关掉这次 decode 之后的 flush。
///
/// `Decoder::new()` 用的默认配置是 `Flush::Flush`：出不了图的那次调用会去翻解码器内部
/// 缓冲，可能把**上一帧**再冲出来一遍（屏上就是重复帧），也可能回一句
/// "failed to flush them" 的错——而在预览这里，错等于重建解码器 + 再等一个关键帧
/// （现场那台 I 帧间隔 50，一等就是几秒）。`decode_frame_no_delay` 出图时当场就回
/// `Some`，连续画面根本不需要 flush；断流收尾要的那点延迟由重连时重建解码器兜掉。
fn no_flush() -> openh264::decoder::DecodeOptions {
    openh264::decoder::DecodeOptions::new().flush_after_decode(openh264::decoder::Flush::NoFlush)
}

/// 这批 NAL 里有没有 IDR。**关键帧闸门看的就是这个**：中途接入一条正在跑的流，
/// 没有 IDR 之前解出来的是花屏，宁可不推。单独拎出来是为了能被契约测试钉住。
pub fn has_idr(au: &[Vec<u8>]) -> bool {
    au.iter().any(|n| nal_type(n) == NAL_IDR)
}

impl Renderer {
    fn new() -> Result<Self, String> {
        let decoder = openh264::decoder::Decoder::new()
            .map_err(|e| format!("起不了 H.264 解码器：{e}"))?;
        Ok(Self {
            decoder,
            parameter_sets: Vec::new(),
            scratch: Vec::new(),
            keyframe: false,
        })
    }

    fn set_parameter_sets(&mut self, parameter_sets: &[Vec<u8>]) {
        self.parameter_sets = parameter_sets.to_vec();
    }

    /// 解码器重建（解坏了之后用）：参数集留下，帧计数与关键帧闸门清零，从头等一个 IDR。
    fn rebuild(&mut self) -> Result<(), String> {
        let ps = self.parameter_sets.clone();
        let mut fresh = Renderer::new()?;
        fresh.set_parameter_sets(&ps);
        fresh.prime(&ps);
        *self = fresh;
        Ok(())
    }

    /// 先把 SDP 预带的 SPS/PPS 喂一次：中途接入时不带参数集，解码器连这张图多大都不知道。
    /// 这一步出不了画面（`decode` 回 `None`），失败也不致命——带内还会再来一次。
    fn prime(&mut self, parameter_sets: &[Vec<u8>]) {
        for ps in parameter_sets {
            self.scratch.clear();
            self.scratch.extend_from_slice(&NAL_START);
            self.scratch.extend_from_slice(ps);
            let _ = self.decoder.decode_with_options(&self.scratch, no_flush());
        }
    }

    /// 喂一个访问单元。出一帧回 `Some`；还在等关键帧或只到了参数集回 `None`。
    ///
    /// RGB 缓冲由调用方给：解出来的 `DecodedYUV` 借用了 `self.decoder`，它还在的时候
    /// 这个 Renderer 不能再被借第二次——把 scratch 放在外面是唯一不改语义的写法。
    fn push(&mut self, au: Vec<Vec<u8>>, rgb: &mut Vec<u8>) -> Result<Option<JpegFrame>, String> {
        if au.is_empty() {
            return Ok(None);
        }
        if has_idr(&au) {
            self.keyframe = true;
        }
        if !self.keyframe {
            return Ok(None);
        }
        let mut out: Option<JpegFrame> = None;
        // 失败原因先记下来、跳出循环之后再重建解码器：`img` 借着 `self.decoder`，
        // 而它要到整条 `for` 的 match 结束才还——在分支里动 self 就是借两次。
        let mut failed: Option<String> = None;
        for nal in &au {
            self.scratch.clear();
            self.scratch.extend_from_slice(&NAL_START);
            self.scratch.extend_from_slice(nal);
            match self.decoder.decode_with_options(&self.scratch, no_flush()) {
                Ok(Some(img)) => match to_jpeg(&img, rgb) {
                    Ok(frame) => out = Some(frame),
                    Err(why) => {
                        failed = Some(why);
                        break;
                    }
                },
                Ok(None) => {}
                Err(e) => {
                    // 解坏了就当这条流从此不可信：重建解码器、回到"等下一个关键帧"。
                    // 半花屏留在屏上比什么都没有更坏——磅员会拿它判断压边。
                    failed = Some(format!("H.264 解码失败（{e}）：重新等一个关键帧"));
                    break;
                }
            }
        }
        if let Some(why) = failed {
            self.rebuild()?;
            return Err(why);
        }
        Ok(out)
    }
}

/// YUV → RGB → JPEG。质量 82 时 jpeg-encoder 自己走 4:2:0 采样，一帧约 40–70 KB。
fn to_jpeg(img: &openh264::decoder::DecodedYUV<'_>, rgb: &mut Vec<u8>) -> Result<JpegFrame, String> {
    use openh264::formats::YUVSource as _;
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err("解出来是一张零尺寸的图".into());
    }
    if w > u16::MAX as usize || h > u16::MAX as usize {
        return Err(format!("{w}×{h} 超出预览支持范围：请到摄像机侧改小**子码流**分辨率"));
    }
    let (w, h) = (w as u16, h as u16);
    // write_rgb8 里有 assert：长度必须正好是 w*h*3，差一个字节都算调用方失职。
    rgb.resize(usize::from(w) * usize::from(h) * 3, 0);
    img.write_rgb8(rgb);
    let mut jpeg = Vec::new();
    jpeg_encoder::Encoder::new(&mut jpeg, JPEG_QUALITY)
        .encode(rgb, w, h, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| format!("压 JPEG 失败：{e}"))?;
    Ok(JpegFrame {
        jpeg,
        width: w,
        height: h,
    })
}

// ============================================================ 会话

/// 一条已经握手完成（DESCRIBE→SETUP→PLAY）的 RTSP/TCP 会话。
struct Session {
    sock: TcpStream,
    buf: Vec<u8>,
    /// 握手期间抢先到的消息（`$` 帧居多）先排队，`poll` 先取这里——
    /// 一帧的开头被丢掉，后面整帧就都解不开了。
    pending: VecDeque<RtspMsg>,
    cseq: u32,
    target: RtspTarget,
    /// 401 质询。有了它，后面每一趟请求都按自己的 method+URI 现算一条应答。
    challenge: Option<DigestChallenge>,
    session_id: Option<String>,
    track_uri: String,
    video_pt: u8,
    video_channel: u8,
    /// 最后一次"线上有动静"的时间，保活按它计时
    last_activity: Instant,
    keepalive_gap: Duration,
    /// 501 之后自动换 OPTIONS（有的固件不实现 GET_PARAMETER）
    keepalive_method: &'static str,
    stop: Arc<AtomicBool>,
}

impl Session {
    fn new(target: RtspTarget, stop: Arc<AtomicBool>) -> Result<Self, String> {
        let sock = camera::connect_to(&target.host, target.port)?;
        sock.set_read_timeout(Some(POLL_GAP))
            .and_then(|_| sock.set_write_timeout(Some(POLL_GAP)))
            .map_err(|e| camera::net_reason(&e, "设置预览超时"))?;
        Ok(Self {
            sock,
            buf: Vec::with_capacity(READ_CHUNK * 4),
            pending: VecDeque::new(),
            cseq: 0,
            target,
            challenge: None,
            session_id: None,
            track_uri: String::new(),
            video_pt: 96,
            video_channel: 0,
            last_activity: Instant::now(),
            keepalive_gap: KEEPALIVE_GAP,
            keepalive_method: "GET_PARAMETER",
            stop,
        })
    }

    /// 该不该给摄像机递个话，让它别把会话超时掉。
    fn keepalive_due(&self) -> bool {
        self.last_activity.elapsed() >= self.keepalive_gap
    }

    /// 按 method + URI 现算一条 Digest 应答。RTSP 不像 HTTP 能复用同一条头：
    /// 每一趟请求的 URI 都不同（DESCRIBE 用会话 URI，SETUP 用轨道 URI），签错了必 401。
    fn auth_for(&self, method: &str, uri: &str) -> Option<String> {
        let ch = self.challenge.as_ref()?;
        let user = self.target.user.as_deref().unwrap_or_default();
        let password = self.target.password.as_deref().unwrap_or_default();
        camera::digest_header(user, password, method, uri, ch).ok()
    }

    fn send_raw(&mut self, method: &str, uri: &str, extra: &[(&str, &str)]) -> Result<(), String> {
        self.cseq = self.cseq.wrapping_add(1);
        let auth = self.auth_for(method, uri);
        let req = rtsp_request(
            method,
            uri,
            self.cseq,
            self.session_id.as_deref(),
            auth.as_deref(),
            extra,
        );
        self.sock.write_all(&req).map_err(|e| camera::net_reason(&e, "发 RTSP 请求"))?;
        self.last_activity = Instant::now();
        Ok(())
    }

    /// 一趟请求-响应（不带认证重试）。
    fn call_once(
        &mut self,
        method: &str,
        uri: &str,
        extra: &[(&str, &str)],
    ) -> Result<(HttpHead, Vec<u8>), String> {
        self.send_raw(method, uri, extra)?;
        let deadline = Instant::now() + HANDSHAKE_GAP;
        loop {
            match self.poll(deadline)? {
                Some(RtspMsg::Response(head, body)) => return Ok((head, body)),
                // 握手路上抢先到的媒体包不丢：排队，播起来之后照序解
                Some(other) => self.pending.push_back(other),
                None => {
                    return Err(format!(
                        "等摄像机回 {method} 响应超时（{} 秒）",
                        HANDSHAKE_GAP.as_secs()
                    ))
                }
            }
        }
    }

    /// 一趟握手请求，带上"第一次 401 就学质询、换一条连接重打一遍"这一手。
    ///
    /// 为什么每次都判：海康要认证时是**每一趟**都可能先回 401，不只是 DESCRIBE——
    /// 台账把匿名读开着但 SETUP 要口令的机器，只处理 DESCRIBE 就会永远卡在"SETUP 被拒绝"。
    /// 而 401 之后这条 TCP 往往当场被对端关掉（真机实测），所以重试必须换连接，
    /// 换连接又要把手上已经拿到的 Session 号/轨道号带过去。
    fn call(
        &mut self,
        method: &str,
        uri: &str,
        extra: &[(&str, &str)],
    ) -> Result<(HttpHead, Vec<u8>), String> {
        let (head, body) = self.call_once(method, uri, extra)?;
        if head.status != 401 || self.challenge.is_some() {
            return Ok((head, body));
        }
        let Some(raw) = head.www_authenticate.as_deref() else {
            return Ok((head, body));
        };
        let challenge = camera::parse_digest_challenge(raw)?;
        let mut fresh = Session::new(self.target.clone(), self.stop.clone())?;
        // 换连接等于换一条会话，手上有的东西得逐项搬过去——包括刚学到的质询，
        // 否则重打的那一趟还是裸的，第二个 401 立刻回来。
        fresh.challenge = Some(challenge);
        fresh.session_id = self.session_id.clone();
        fresh.track_uri = self.track_uri.clone();
        fresh.video_pt = self.video_pt;
        fresh.video_channel = self.video_channel;
        fresh.keepalive_gap = self.keepalive_gap;
        fresh.keepalive_method = self.keepalive_method;
        // 交换之后 `fresh`（旧那条连接）出作用域就被丢弃；401 之后对端多半已经关了它
        std::mem::swap(self, &mut fresh);
        // 第二次还不 200 就别再兜圈子：状态码原样交出去，由 rtsp_failure 说人话
        self.call_once(method, uri, extra)
    }

    /// 收一条消息；`deadline` 到了还没有就回 `Ok(None)`（调用方借此查停止位与保活钟）。
    fn poll(&mut self, deadline: Instant) -> Result<Option<RtspMsg>, String> {
        if let Some(msg) = self.pending.pop_front() {
            return Ok(Some(msg));
        }
        let mut tmp = [0u8; READ_CHUNK];
        loop {
            if self.stop.load(Ordering::SeqCst) {
                return Err("界面已经不要这一路画面了".into());
            }
            if let Some(msg) = next_msg(&mut self.buf)? {
                return Ok(Some(msg));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            match self.sock.read(&mut tmp) {
                Ok(0) => return Err("摄像机关掉了这条 RTSP 连接".into()),
                Ok(n) => {
                    self.last_activity = Instant::now();
                    self.buf.extend_from_slice(&tmp[..n]);
                }
                Err(ref e)
                    if matches!(
                        e.kind(),
                        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(camera::net_reason(&e, "读摄像机")),
            }
        }
    }

    /// 保活。响应不在这儿等（等就会把收包节奏卡住），回到播放循环里当一条 Response 处理。
    fn keepalive(&mut self) -> Result<(), String> {
        // 先抄成局部量：`send_raw(&mut self)` 与从 self 读字段挤在同一个表达式里，
        // 借用检查只会看到"整体可变借用 + 整体读借用"这一种最保守的解释。
        let method = self.keepalive_method;
        let uri = self.track_uri.clone();
        self.send_raw(method, &uri, &[])
    }

    /// 尽力告个别。摄像机掉的时候发不出去也无所谓，别拿它盖住真正的原因。
    fn teardown(&mut self) {
        let uri = self.track_uri.clone();
        let _ = self.send_raw("TEARDOWN", &uri, &[]);
    }
}

/// 建立一条会话：DESCRIBE → SETUP → PLAY。每一趟都由 [`Session::call`] 兜着，
/// 第一次 401 会自动学质询、换一条连接重打一遍。
fn open_session(target: &RtspTarget, stop: &Arc<AtomicBool>) -> Result<(Session, VideoTrack), String> {
    let uri = target.uri();
    let mut session = Session::new(target.clone(), stop.clone())?;
    // 认证由 `Session::call` 负责（第一次 401 → 学质询 → 换连接重打），这里只看结果。
    let (head, sdp) = session.call("DESCRIBE", &uri, &[("Accept", "application/sdp")])?;
    if head.status != 200 {
        return Err(rtsp_failure("DESCRIBE", &head));
    }

    let text = String::from_utf8_lossy(&sdp).to_string();
    let track = video_track(&uri, &text)?;

    let track_uri = track.uri.clone();
    let (head, _) = session.call(
        "SETUP",
        &track_uri,
        &[("Transport", "RTP/AVP/TCP;unicast;interleaved=0-1")],
    )?;
    if head.status != 200 {
        return Err(rtsp_failure("SETUP", &head));
    }
    let session_header = head
        .header("session")
        .ok_or("SETUP 回了 200 却没给 Session 头：这台机的 RTSP 实现不合规")?;
    session.session_id = session_id(session_header).map(str::to_string);
    if let Some(secs) = session_timeout_secs(session_header) {
        // 三分之一的余量：网络抖一下也不至于刚好卡在超时点上
        session.keepalive_gap = Duration::from_secs(secs / 3).clamp(Duration::from_secs(5), KEEPALIVE_GAP);
    }
    match head
        .header("transport")
        .and_then(interleaved_channels)
    {
        // 只取视频那一路：奇数那路是 RTCP，收上来也不解（见 Player::on_packet 的通道过滤）。
        // 设备可以回我们没要的那对号（0-1 之外），照它回的用，别照我们自己填的用。
        Some((video, _rtcp)) => session.video_channel = video,
        // 没回 interleaved 就是选了 UDP：本轮只实现 TCP 收流，不假装能播
        None => {
            return Err(
                "这台机不肯走 TCP 交织通道（SETUP 的 Transport 里没回 interleaved）：本轮只实现 TCP 收流"
                    .into(),
            )
        }
    }
    session.track_uri = track_uri;
    session.video_pt = track.payload_type;

    let play_uri = session.track_uri.clone();
    let (head, _) = session.call("PLAY", &play_uri, &[("Range", "npt=0.000-")])?;
    if head.status != 200 {
        return Err(rtsp_failure("PLAY", &head));
    }
    Ok((session, track))
}

/// 状态码 → 人话。与抓拍那条通道同一套说法：现场只看一句话，不该有两份词典。
fn rtsp_failure(method: &str, head: &HttpHead) -> String {
    match head.status {
        401 | 403 => format!(
            "{method} 被拒绝（RTSP {}）：核对台账里的登录用户名与口令；口令对但仍被拒，多半是这台机要求 digest 之外的算法",
            head.status
        ),
        404 => format!(
            "{method} 找不到这条流（RTSP 404）：核对「RTSP 地址」的通道号与码流号（海康子码流是 /Streaming/Channels/102）"
        ),
        454 => format!("{method} 被拒（RTSP 454）：会话号已失效，重连即可；频繁出现说明这台机在偷偷断流"),
        461 => format!("{method} 不支持（RTSP 461）：这台机的 RTSP 实现不认我们用的传输方式"),
        s => format!(
            "{method} 失败（RTSP {s}{}）",
            if head.reason.is_empty() { String::new() } else { format!(" {}", head.reason) }
        ),
    }
}

// ============================================================ 推流线程

/// 一台机的一条流的线程内状态。
struct Player {
    stream: H264Stream,
    renderer: Renderer,
    /// YUV→RGB 的中转缓冲。放在这里而不是 `Renderer` 里：解码出来的那一帧还借着
    /// 解码器，同一时刻不能再从 `Renderer` 借一块 scratch 出来（见 [`Renderer::push`]）。
    rgb: Vec<u8>,
    last_frame: Instant,
    seq: u64,
}

impl Player {
    fn new(track: &VideoTrack) -> Result<Self, String> {
        let mut renderer = Renderer::new()?;
        renderer.set_parameter_sets(&track.parameter_sets);
        renderer.prime(&track.parameter_sets);
        Ok(Self {
            stream: H264Stream::default(),
            renderer,
            rgb: Vec::new(),
            last_frame: Instant::now(),
            seq: 0,
        })
    }

    /// 一个 `$` 包 → 可能出若干帧。RTCP 与音频通道直接忽略。
    fn on_packet(
        &mut self,
        channel: u8,
        video_channel: u8,
        packet: &[u8],
        pt: u8,
    ) -> Result<Vec<JpegFrame>, String> {
        let mut out = Vec::new();
        if channel != video_channel {
            return Ok(out);
        }
        let Some(rtp) = parse_rtp(packet) else {
            self.stream.dropped += 1;
            return Ok(out);
        };
        if rtp.payload_type != pt {
            return Ok(out);
        }
        for au in self.stream.feed(rtp.payload, rtp.timestamp, rtp.marker) {
            if let Some(frame) = self.renderer.push(au, &mut self.rgb)? {
                out.push(frame);
            }
        }
        Ok(out)
    }
}

/// 跑一趟完整的会话：握手 → 收流 → 推帧。回 `Err` 表示"这一趟废了，该重连"。
fn run_once(
    app: &AppHandle,
    live: &Arc<Mutex<StreamStatus>>,
    stop: &Arc<AtomicBool>,
    target: &RtspTarget,
) -> Result<(), String> {
    // 所有失败出口都过这里一次：漏一条，那一格就会停在"还在连"这种半截状态上——
    // 磅员看到的是一格不动的画面加一句过时的话。
    let why = match drive(app, live, stop, target) {
        Ok(()) => return Ok(()),
        Err(why) => why,
    };
    if !stop.load(Ordering::SeqCst) {
        publish_error(app, live, &why);
    }
    Err(why)
}

fn drive(
    app: &AppHandle,
    live: &Arc<Mutex<StreamStatus>>,
    stop: &Arc<AtomicBool>,
    target: &RtspTarget,
) -> Result<(), String> {
    touch(live, |s| {
        s.connected = false;
        s.phase = PHASE_CONNECTING.to_string();
        s.error = None;
    });
    let (mut session, track) = open_session(target, stop)?;
    let mut player = Player::new(&track)?;
    touch(live, |s| {
        s.connected = true;
        // 中途接入一条正在跑的流，手上没有 IDR 之前解出来的是花屏：明说在等关键帧，
        // 比给磅员一屏马赛克诚实。子码流 I 帧间隔 50，最多等几秒。
        s.phase = PHASE_KEYFRAME.to_string();
        s.error = None;
    });
    publish_status(live);

    let code = target.code.clone();
    // generation 由 acquire 在起线程之前写好，这一趟里不会再变（换了它 = 换了新的一路）。
    let generation = lock(live).generation;
    loop {
        if stop.load(Ordering::SeqCst) {
            session.teardown();
            return Ok(());
        }
        // 会话里这几项握手后就固定了，先抄成局部量再进 deliver：deliver 只要这两个
        // 数字，整条路径上 `session` 保持只读，收包与解帧之间就不会有借用冲突。
        let (video_channel, video_pt) = (session.video_channel, session.video_pt);
        let deadline = Instant::now() + POLL_GAP;
        match session.poll(deadline)? {
            Some(RtspMsg::Interleaved { channel, packet }) => {
                deliver(
                    app,
                    live,
                    &code,
                    generation,
                    &mut player,
                    video_channel,
                    video_pt,
                    channel,
                    &packet,
                )?;
            }
            Some(RtspMsg::Response(head, _)) => {
                // 保活的响应。4xx/5xx 说明会话号已经不认了，重连一次比继续等有用。
                if head.status >= 400 {
                    if matches!(head.status, 501 | 405) && session.keepalive_method != "OPTIONS" {
                        session.keepalive_method = "OPTIONS";
                        continue;
                    }
                    return Err(rtsp_failure("保活", &head));
                }
            }
            // 半秒没人说话：什么都不做，让下面的钟去判"是真闲还是坏了"
            None => {}
        }
        // 这两件事每轮都查，不能只写在"没收到包"那一支里：包一直在来、但一帧都解不出来
        // （这台机不再发关键帧）的时候，那一支永远不响，那格就是一张冻住的画面。
        if session.keepalive_due() {
            session.keepalive()?;
        }
        if player.last_frame.elapsed() >= FRAME_STARVE {
            return Err(format!(
                "{} 秒没出一帧：可能掉线，或这台机的子码流停了",
                FRAME_STARVE.as_secs()
            ));
        }
    }
}

/// 解出来的帧交给界面。阶段从"等关键帧"跳到"在流"的那一帧顺多发一次状态事件，
/// 其余帧只闷头累加计数——一秒十来帧全去惊动 IPC 会把通道挤满。
fn deliver(
    app: &AppHandle,
    live: &Arc<Mutex<StreamStatus>>,
    code: &str,
    generation: u64,
    player: &mut Player,
    video_channel: u8,
    video_pt: u8,
    channel: u8,
    packet: &[u8],
) -> Result<(), String> {
    let frames = player.on_packet(channel, video_channel, packet, video_pt)?;
    for f in frames {
        player.seq += 1;
        player.last_frame = Instant::now();
        let seq = player.seq;
        let at = crate::db::migrate::now_iso();
        let bytes = f.jpeg.len();
        let payload = CameraFrame {
            code: code.to_string(),
            data_url: format!("data:image/jpeg;base64,{}", camera::base64_standard(&f.jpeg)),
            width: f.width,
            height: f.height,
            seq,
            generation,
            bytes,
            at,
        };
        let _ = app.emit(CAMERA_FRAME_EVENT, &payload);
        let (w, h) = (f.width, f.height);
        let mut streaming = false;
        touch(live, |s| {
            s.frame_count = s.frame_count.saturating_add(1);
            s.width = w;
            s.height = h;
            s.last_frame_at = Some(payload.at.clone());
            if s.phase != PHASE_STREAMING {
                s.phase = PHASE_STREAMING.to_string();
                // 上一趟留下的错（例如刚重连回来）到这里就该收掉：画面都在动了，
                // 还挂着"连接失败"比什么都不写更坏。
                s.error = None;
                streaming = true;
            }
        });
        if streaming {
            publish_status(live);
        }
    }
    Ok(())
}

// ============================================================ 状态与托管

/// 一帧的推送载荷。`dataUrl` 直接喂 `<img>`，不接 asset 协议、不动 CSP。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraFrame {
    pub code: String,
    pub data_url: String,
    pub width: u16,
    pub height: u16,
    /// 本**趟会话**内的序号，从 1 开始。重连一次就换一个 generation，
    /// 所以界面要比的是 (generation, seq)——只比 seq 会把自己冻在重连前那一帧上。
    pub seq: u64,
    pub generation: u64,
    pub bytes: usize,
    pub at: String,
}

/// 一路流的实时状态：`camera_stream_status` 的数据源，也是那一格右下角那行小字的数据源。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatus {
    pub code: String,
    /// 线程在跑（还没被最后一次 release 收走）
    pub running: bool,
    /// 此刻会话是否连着
    pub connected: bool,
    /// [`PHASE_CONNECTING`] / [`PHASE_KEYFRAME`] / [`PHASE_STREAMING`] / [`PHASE_ERROR`]
    pub phase: String,
    pub generation: u64,
    pub started_at: String,
    pub frame_count: u64,
    pub width: u16,
    pub height: u16,
    pub last_frame_at: Option<String>,
    pub error: Option<String>,
    /// 有几个界面在订这一路（工作台一格 + 放大弹窗 = 2）。归零才真停线程。
    pub refs: u32,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 改状态，**不发事件**（发不发由调用方看是不是"看得见的问题"变了）。
/// 一秒十来帧的 frame_count 累加就走这条路，别每次都惊动 IPC。
fn touch(live: &Arc<Mutex<StreamStatus>>, f: impl FnOnce(&mut StreamStatus)) {
    let mut g = lock(live);
    f(&mut g);
}

fn publish_status(live: &Arc<Mutex<StreamStatus>>) {
    let snap = lock(live).clone();
    // 事件在锁外发：持锁 emit 等于让 JS 侧的同步回调有机会反过来抢同一把锁
    if let Some(app) = APP.with(|slot| slot.borrow().clone()) {
        let _ = app.emit(CAMERA_STATUS_EVENT, &snap);
    }
}

/// 出错时的一次推送：阶段、connected、error 一起改完再发，界面不会看见
/// "phase=error 而 connected 还是 true"那种半截状态。
fn publish_error(app: &AppHandle, live: &Arc<Mutex<StreamStatus>>, why: &str) {
    touch(live, |s| {
        s.connected = false;
        s.phase = PHASE_ERROR.to_string();
        s.error = Some(why.to_string());
    });
    let snap = lock(live).clone();
    let _ = app.emit(CAMERA_STATUS_EVENT, &snap);
}

thread_local! {
    /// `publish_status` 只要一个 AppHandle 就能发事件；流线程起手时存一份，
    /// 免得给每个内部函数都多挂一个 app 参数。
    static APP: std::cell::RefCell<Option<AppHandle>> = const { std::cell::RefCell::new(None) };
}

/// 一路活的会话（线程 + 停止位 + 引用计数）。
struct Entry {
    stop: Arc<AtomicBool>,
    joiner: Option<JoinHandle<()>>,
    refs: u32,
    live: Arc<Mutex<StreamStatus>>,
}

/// Tauri 托管状态：`app.manage(camera_stream::CameraStreamHub::default())`。
/// 应用退出前调 [`CameraStreamHub::shutdown`] 收线程（见 `lib.rs` 的 `RunEvent::Exit` 分支）。
#[derive(Clone, Default)]
pub struct CameraStreamHub {
    inner: Arc<Mutex<HubState>>,
}

#[derive(Default)]
struct HubState {
    entries: HashMap<String, Entry>,
    generation: u64,
}

impl CameraStreamHub {
    pub fn snapshot(&self, code: &str) -> Option<StreamStatus> {
        let g = lock(&self.inner);
        let entry = g.entries.get(code)?;
        let mut s = lock(&entry.live).clone();
        s.refs = entry.refs;
        Some(s)
    }

    /// 订一路流：已经在跑就只是引用 +1，否则起线程。
    ///
    /// 引用计数是 React 那侧的现实逼出来的：工作台一格 + 放大弹窗两处同看一台机，
    /// 关弹窗不该把工作台那一格的画面也停掉。
    fn acquire(
        &self,
        app: &AppHandle,
        target: RtspTarget,
    ) -> Result<StreamStatus, String> {
        let mut guard = lock(&self.inner);
        let code = target.code.clone();
        // `running` 由线程自己在退出前置假，所以它是"这条会话还活着"的唯一凭据。
        let alive = guard
            .entries
            .get(&code)
            .is_some_and(|e| lock(&e.live).running);
        if alive {
            if let Some(entry) = guard.entries.get_mut(&code) {
                entry.refs = entry.refs.saturating_add(1);
                // 先抄成局部量：闭包借的是 `entry.live`，再在闭包里读 `entry.refs`
                // 就等于同一时刻把整个 entry 借两遍。
                let refs = entry.refs;
                // 存进 live 里那份：状态事件由流线程自己发，它读的是这一份。
                touch(&entry.live, |s| s.refs = refs);
                let mut s = lock(&entry.live).clone();
                s.refs = refs;
                return Ok(s);
            }
        }
        if let Some(dead) = guard.entries.remove(&code) {
            // 线程已经不在了却还占着一路（解码器崩过一次被兜住）：不摘掉它，
            // 下面根本不会起重建的那条，这一格就永远停在"报错"直到重启程序。
            dead.stop.store(true, Ordering::SeqCst);
            if let Some(j) = dead.joiner {
                let _ = j.join();
            }
        }
        guard.generation = guard.generation.wrapping_add(1);
        let generation = guard.generation;
        let started_at = crate::db::migrate::now_iso();
        let live = Arc::new(Mutex::new(StreamStatus {
            code: code.clone(),
            running: true,
            connected: false,
            phase: PHASE_CONNECTING.to_string(),
            generation,
            started_at,
            refs: 1,
            ..StreamStatus::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = stop.clone();
        let thread_live = live.clone();
        // 线程要的是一个**自己owns**的 AppHandle：直接把 `&app` 带进 `move` 闭包，
        // 闭包捕获的就是那个借用，过不了 spawn 要求的 'static。
        let thread_app = app.clone();
        let joiner = std::thread::Builder::new()
            .name(format!("camera-rtsp-{code}"))
            .spawn(move || stream_loop(thread_app, &thread_live, &thread_stop, &target))
            .map_err(|_| "起不了画面线程（系统线程资源不足，重启程序再试）".to_string())?;
        guard.entries.insert(
            code.clone(),
            Entry {
                stop,
                joiner: Some(joiner),
                refs: 1,
                live: live.clone(),
            },
        );
        let snap = lock(&live).clone();
        Ok(snap)
    }

    /// 退订一路。引用归零才停线程并**等它退出**：RTSP 会话留在摄像机侧不管，
    /// 几次开关之后就是"这台机的连接数满了"。
    fn release(&self, code: &str) -> Option<StreamStatus> {
        let mut guard = lock(&self.inner);
        let refs = match guard.entries.get_mut(code) {
            None => return None,
            Some(e) => {
                e.refs = e.refs.saturating_sub(1);
                e.refs
            }
        };
        if refs > 0 {
            let entry = guard.entries.get(code)?;
            touch(&entry.live, |s| s.refs = refs);
            let mut s = lock(&entry.live).clone();
            s.refs = refs;
            return Some(s);
        }
        let entry = guard.entries.remove(code)?;
        entry.stop.store(true, Ordering::SeqCst);
        // 读线程只锁自己那一份 live、不锁 inner，所以这里可以持着 inner 直接 join
        if let Some(j) = entry.joiner {
            let _ = j.join();
        }
        // 状态在 join 之后才取：线程收尾时写的 running/connected=false 要带回去，
        // 否则界面拿到的是"还在流"，而这一路其实已经停了。
        let mut status = lock(&entry.live).clone();
        status.running = false;
        status.connected = false;
        status.refs = 0;
        Some(status)
    }

    /// 应用退出时调用：所有流一起收。
    pub fn shutdown(&self) {
        let mut guard = lock(&self.inner);
        let codes: Vec<String> = guard.entries.keys().cloned().collect();
        for code in codes {
            if let Some(entry) = guard.entries.remove(&code) {
                entry.stop.store(true, Ordering::SeqCst);
                if let Some(j) = entry.joiner {
                    let _ = j.join();
                }
            }
        }
    }
}

/// 线程主体：失败就退避重连，直到被要求停止。
fn stream_loop(
    app: AppHandle,
    live: &Arc<Mutex<StreamStatus>>,
    stop: &Arc<AtomicBool>,
    target: &RtspTarget,
) {
    APP.with(|slot| *slot.borrow_mut() = Some(app.clone()));
    let mut streak = 0u32;
    while !stop.load(Ordering::SeqCst) {
        let held = Instant::now();
        // 第三方解码库的转换函数里有 assert（尺寸、色彩格式对不上就 panic）。崩了
        // 只能带走这一路画面，不能让它连状态都不落——那一格会一直显示"在流"。
        match catch_unwind(AssertUnwindSafe(|| run_once(&app, live, stop, target))) {
            Ok(Ok(())) => break,
            Ok(Err(_)) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                // 撑过 30 秒说明这台机平时是好的，这次只是抖了一下：退避重新算起，
                // 否则连着开几天之后任何一次掉线都要等满 15 秒。
                if held.elapsed() >= Duration::from_secs(30) {
                    streak = 0;
                }
                streak = streak.saturating_add(1);
                // 退避：连着失败就越等越久。磅员盯着的那格已经写着原因了，
                // 这里只决定"什么时候再试一次"，不额外刷屏。
                let gap = RETRY_GAP.saturating_mul(streak.min(8)).min(RETRY_MAX);
                let deadline = Instant::now() + gap;
                while Instant::now() < deadline && !stop.load(Ordering::SeqCst) {
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
            Err(_) => {
                publish_error(
                    &app,
                    live,
                    "解画面时崩了一次，已停掉这一路（称重与开票不受影响）：重新打开这一格即可再试",
                );
                break;
            }
        }
    }
    touch(live, |s| {
        s.running = false;
        s.connected = false;
    });
    APP.with(|slot| *slot.borrow_mut() = None);
}

fn hub_of(app: &AppHandle) -> Result<CameraStreamHub, String> {
    app.try_state::<CameraStreamHub>()
        .map(|h| (*h).clone())
        .ok_or_else(|| "画面通道未托管：lib.rs 里缺 app.manage(camera_stream::CameraStreamHub::default())".to_string())
}

// ============================================================ 命令层

/// 打开一路预览：**一条 RTSP 会话 + 一个解码线程**，之后画面靠事件推，前端不再轮询。
///
/// 重复调用是安全的：同一个 `code` 只有一条会话，多出来的订阅只把引用计数加一。
/// 台账非法（Mock 档 / 已停用 / 本机 USB 机 / 认不出该怎么拉流）一律 `Err(中文短句)`，
/// 由那一格显示在自己的框里——不弹框、不拦称重（04 §4.2 失败降级）。
#[command]
pub async fn camera_stream_start(app: AppHandle, code: String) -> Result<StreamStatus, String> {
    let row = crate::orders::read_only(&app, move |conn| {
        camera::live_preview_row(conn, &code)
    }, "摄像机预览配置")
        .await?;
    let target = rtsp_target(&row)?;
    hub_of(&app)?.acquire(&app, target)
}

/// 退订一路（引用归零才真停线程并等它退出）。没在流时回 `None`，不报错。
#[command]
pub async fn camera_stream_stop(app: AppHandle, code: String) -> Result<Option<StreamStatus>, String> {
    let hub = hub_of(&app)?;
    Ok(hub.release(&code))
}

/// 纯内存快照，不碰网络、不碰库：界面重挂载时用它把"这一路现在怎么样"捡回来。
#[command]
pub fn camera_stream_status(app: AppHandle, code: String) -> Result<Option<StreamStatus>, String> {
    Ok(hub_of(&app)?.snapshot(&code))
}
