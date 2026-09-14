//! 过磅抓拍取图 + 附件落库（04 §4 方案 A：内网 IP 摄像机 HTTP 抓图）
//!
//! 这一轮把 [`crate::orders`] 模块头欠下的那句"取帧通道还没接"接上了：捕获毛重/皮重时
//! 按设备台账里那台 `kind='camera'` 的配置向摄像机发一次明文 HTTP GET，拿回 JPEG，
//! 校验后写 `AppDataDir/attachments/YYYY-MM/*.jpg` 并插一行 `attachment`
//! （`biz_type='scale_capture'`、`biz_id`=称重记录 id）。调用方拿到附件 id 后
//! 自己写 `weigh_record.photo_attachment_id`——**本模块不碰业务表**（04 §2.4 的分工：
//! 设备层只交图与附件行，业务归属由服务层落），于是磅单上的"无抓拍"终于有了真依据。
//!
//! **本轮没接的东西**（都是有意不做，不是漏了）：
//!  - **HTTPS**：抓图只走明文 HTTP。磅房里摄像机与磅房机同网段，厂商固件的 TLS 栈
//!    多半是过期证书；要接得先定证书校验策略（04 §4.1 未给结论），所以配置里出现
//!    `https://` 一律**明确拒绝**而不是退化成明文去试。
//!  - **Digest 认证**：04 §4.1 说海康 ISAPI 走 Digest。Challenge 往返要维护第二次
//!    请求与 nonce，本轮只做 Basic（现网多数固件的抓图 CGI 同时收 Basic）；
//!    配置写了 `auth:"digest"` 的摄像机按降级处理，回一句人话而不是假装取到图。
//!  - **RTSP 抽帧 / 录像回放 / 转码压缩**：方案 C（ffmpeg）与 NVR 回放都不在这里；
//!    04 §4.2 的"长边 1600 px + 逐级降质"需要 `image` crate，本轮不加依赖，
//!    原图超限就降级并把"去摄像机侧调低主码流"写进原因里。
//!  - **`width`/`height` 留 NULL**：解析 JPEG 的 SOF0/SOF2 段拿宽高属于过度设计——
//!    这两个字段在本系统里没有任何消费方（磅单只印缩略图，台账不按像素统计），
//!    写一段二进制解析换来的是无人读的数。等真接上图像解码那轮再一并填。
//!  - **`accessed_at`/`accessed_by` 这条抓拍自己不写**：读图的通道与 `pii.read` 审计
//!    收在 [`crate::attachment::read_for_display`]。04 §4.3 的前端附件展示那轮已接上——
//!    详情页/工作台按**称重记录 id** 走 [`crate::orders::capture_photo_view`] 读回原图，
//!    由那条通道刷 `accessed_*` 并落 `pii.read`。本模块只管落图，读图留痕不归它，
//!    所以这里既不写也不该写这两列（写了反而像"抓拍自己看过自己"）。
//!
//! **PII**：抓拍画面含农户人像与车牌（04 §4.3）。因此本模块**不把文件路径写进任何
//! 日志或返回值**——`attachment.file_path` 是库里唯一一处，取用时按岗位判权限；
//! 失败原因只说"哪一步、为什么"，不说落在哪个文件上。
//!
//! **失败降级优于报错**（04 §4.2、H6）：过磅是生产动作，摄像头掉线/改密码/回 HTML
//! 错误页都拦不住收粮。除"配置本身非法"外一律 `Ok(None)`，同时把原因按 04 §1 的
//! 状态上报口径写回 `device_config`（`last_error`/`err_count`/`last_status`），
//! 现场在设备中心看得见，磅房那边照常出一张标着"无抓拍"的磅单。

use std::io::{Error, ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

use crate::attachment::ImageKind;

/// 04 §1 的超时约定：抓图 3 秒。宁可拿不到图，也不让磅队停下来等一台摄像头。
pub const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(3);

/// 响应头之外的读取余量（有些固件头很长）；也是"回包明显超限"的判定缓冲。
const HEAD_SLACK: usize = 64 * 1024;
/// 头部本身的上限：超过它就不是"头长"而是有人在吐数据了。
const MAX_HEAD_BYTES: usize = 64 * 1024;
/// 04 §4.2 的默认上限；`attachment_max_kb` 缺键或配得离谱时按它兜底。
const DEFAULT_MAX_KB: i64 = 500;

/// HTTPS 的拒绝话术（配置里出现 https 时原样回给调用方，不假装能取图）。
pub const HTTPS_UNSUPPORTED: &str = "本轮只支持内网 HTTP 抓图，HTTPS 摄像机需另接 TLS 通道";

// ------------------------------------------ 本机 USB 摄像头（枚举供添加设备表单；回传帧收口见 [`store_provided_frame`]）

use serde::Serialize;
use tauri::command;

#[cfg(target_os = "windows")]
use windows::core::{GUID, PWSTR};

/// 本机接的一个视频输入设备（内置 / USB 摄像头）。由 Media Foundation 枚举而来。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCamera {
    /// 设备友好名（如 "Integrated Camera" / "USB Camera"）
    pub name: String,
    /// 稳定设备标识（MF 符号链接，含 vid/pid/实例）。**注意**：Chromium 的 deviceId 是
    /// 另一套哈希，本机取帧走 WebView2 `getUserMedia`，前端只能按 `name` 认机器
    /// （`src/lib/local-camera.ts`），这个串留作台账侧的稳定指纹与排障线索。
    pub device_id: String,
}

/// 枚举本机 USB / 内置摄像头。添加设备表单「扫描本机摄像头」的数据源。
#[command]
pub async fn camera_list_local() -> Result<Vec<LocalCamera>, String> {
    tauri::async_runtime::spawn_blocking(list_local_cameras)
        .await
        .map_err(|e| format!("枚举摄像头任务失败: {e}"))?
}

/// Windows：走 Media Foundation 的 VIDCAP 源枚举，拿每台摄像头的友好名 + 符号链接。
#[cfg(target_os = "windows")]
fn list_local_cameras() -> Result<Vec<LocalCamera>, String> {
    use windows::Win32::Media::MediaFoundation as mf;
    use windows::Win32::System::Com::CoTaskMemFree;

    unsafe {
        mf::MFStartup(mf::MF_VERSION, mf::MFSTARTUP_FULL).map_err(|e| format!("初始化 Media Foundation 失败: {e}"))?;
        // 下面任一步失败也要 MFShutdown，否则 COM 库挂着；这里用闭包收敛，最后统一 shutdown。
        let result = (|| -> Result<Vec<LocalCamera>, String> {
            let mut attrs: Option<mf::IMFAttributes> = None;
            mf::MFCreateAttributes(&mut attrs, 0).map_err(|e| format!("创建枚举属性失败: {e}"))?;
            let attrs = attrs.ok_or_else(|| "创建枚举属性返回空".to_string())?;
            attrs
                .SetGUID(&mf::MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE, &mf::MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID)
                .map_err(|e| format!("设置视频采集类型失败: {e}"))?;

            let mut devices: *mut Option<mf::IMFActivate> = std::ptr::null_mut();
            let mut count: u32 = 0;
            mf::MFEnumDeviceSources(&attrs, &mut devices, &mut count).map_err(|e| format!("枚举视频输入设备失败: {e}"))?;

            let mut out = Vec::new();
            if !devices.is_null() {
                for i in 0..count as usize {
                    // 从数组里按值搬出一个 IMFActivate（其 Drop 会 Release 引用），读完即释放，避免二次释放。
                    let activate: Option<mf::IMFActivate> = std::ptr::read(devices.add(i));
                    if let Some(activate) = activate {
                        let name = allocated_string(&activate, &mf::MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME);
                        let device_id = allocated_string(&activate, &mf::MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK);
                        if !name.is_empty() || !device_id.is_empty() {
                            out.push(LocalCamera { name, device_id });
                        }
                    }
                }
                // 数组缓冲区本身由 MF 用 CoTaskMemAlloc 分配，用完还给系统。
                CoTaskMemFree(Some(devices as *const core::ffi::c_void));
            }
            Ok(out)
        })();
        mf::MFShutdown().ok();
        result
    }
}

/// 读一个 MF 字符串属性（GetAllocatedString 出来的是 CoTaskMem 分配的宽字符串，读完必须释放）。
#[cfg(target_os = "windows")]
unsafe fn allocated_string(activate: &windows::Win32::Media::MediaFoundation::IMFActivate, key: &GUID) -> String {
    use windows::Win32::System::Com::CoTaskMemFree;
    let mut pwstr = PWSTR::null();
    let mut len = 0u32;
    if activate.GetAllocatedString(key, &mut pwstr, &mut len).is_err() {
        return String::new();
    }
    let value = pwstr_to_string(pwstr);
    CoTaskMemFree(Some(pwstr.0 as *const core::ffi::c_void));
    value
}

/// PWSTR 走到 NUL 为止，版本无关地解码 UTF-16（不依赖 windows-core 各版本不一的 to_string）。
#[cfg(target_os = "windows")]
fn pwstr_to_string(p: windows::core::PWSTR) -> String {
    let ptr = p.0 as *const u16;
    if ptr.is_null() {
        return String::new();
    }
    let mut units = Vec::new();
    unsafe {
        let mut i = 0usize;
        while i < 4096 {
            let c = *ptr.add(i);
            if c == 0 {
                break;
            }
            units.push(c);
            i += 1;
        }
    }
    String::from_utf16_lossy(&units)
}

/// 非 Windows：没有本机摄像头枚举通道（本项目目标是 Windows 磅房，其它平台回一句人话即可）。
#[cfg(not(target_os = "windows"))]
fn list_local_cameras() -> Result<Vec<LocalCamera>, String> {
    Err("枚举本机摄像头仅支持 Windows".to_string())
}

// ---------------------------------------------------------------------- 抓图端点

/// 认证方式。`Digest` 是"配置里写了但本轮做不到"，不是非法值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthKind {
    /// 不带头（匿名抓图的摄像机/录像机）
    None,
    Basic,
    Digest,
}

/// 一次抓图的完整目标。**只能**由 `device_config` 拼出来，绝不接受前端传 URL；
/// 拼出来的一律过字符校验，所以后续直接插进请求行/头里也不会撕包。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotTarget {
    pub device_id: i64,
    pub device_code: String,
    pub host: String,
    pub port: u16,
    /// 以 `/` 开头的路径（含查询串，如 `/cgi-bin/snapshot.cgi?channel=1`）
    pub path: String,
    pub user: Option<String>,
    pub password: Option<String>,
    pub auth: AuthKind,
}

/// 附件归属与署名。设备两项由 [`capture_snapshot`] 自己填，调用方用 [`CaptureContext`]。
#[derive(Debug, Clone)]
pub struct AttachmentMeta {
    pub order_id: i64,
    pub weigh_record_id: i64,
    pub operator_id: i64,
    pub device_id: Option<i64>,
    /// 只用于生成文件名片段（先过 [`safe_stem`]），原始值既不落库也不打日志。
    pub device_code: String,
}

/// [`capture_snapshot`] 的入参：过磅当场已经确定的三件事。
///
/// 用结构体而不是三个连着的 `i64`，是因为 `order_id` 与 `weigh_record_id` 传反了
/// 编译器一句话也不会提示，而错误要到半年后翻照片时才看得出来。
#[derive(Debug, Clone, Copy)]
pub struct CaptureContext {
    /// `weigh_order.id`——附件按单归集与按单清理要用
    pub order_id: i64,
    /// `weigh_record.id`——`attachment.biz_id`，也是调用方要回填 `photo_attachment_id` 的那行
    pub weigh_record_id: i64,
    /// 操作人 `user_account.id`（`attachment.created_by` 非空且是外键）
    pub operator_id: i64,
}

// ------------------------------------------------------------------ 配置 → 端点

/// 从 `device_config` 的一行拼出抓图端点。**配置非法一律 `Err`（中文短句）**：
/// 这类问题是站长录错了，重试一百次也一样，值得被调用方单独显示。
///
/// 读的键名与现场录入那份逐字对齐（`src/mock/masters.ts` 的 cam1/cam2、
/// `src/pages/DevicesPage.tsx` 的 camera 表单、`src/components/workstation/CameraPanel.tsx`
/// 显示的 `config.host + config.snapshotUrl`）：
/// `host` / `port` / `snapshotUrl` / `user` / `password`，口令另可放 `secret_json.password`
/// （04 §4.1 要求密码进 `secret_json`，等加密基建落地后只有这一处要改）。
pub fn target_from_config(
    device_id: i64,
    device_code: &str,
    config_json: &str,
    secret_json: Option<&str>,
) -> Result<SnapshotTarget, String> {
    let cfg: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|_| format!("摄像机「{device_code}」的配置不是合法 JSON，无法拼抓图地址"))?;
    if !cfg.is_object() {
        return Err(format!("摄像机「{device_code}」的配置不是一个对象，无法拼抓图地址"));
    }

    let raw_url = text(&cfg, &["snapshotUrl", "snapshot_url", "url", "path"])
        .unwrap_or_default();
    if raw_url.is_empty() {
        return Err(format!(
            "摄像机「{device_code}」未配置抓图路径 snapshotUrl（海康填 /ISAPI/Streaming/channels/101/picture，大华填 /cgi-bin/snapshot.cgi?channel=1）"
        ));
    }
    let lower = raw_url.to_ascii_lowercase();
    if lower.starts_with("https") {
        return Err(HTTPS_UNSUPPORTED.into());
    }

    // 现场常把浏览器地址栏整条粘进来，所以允许 http://host:port/path 这种写法。
    // `lower` 与 `raw_url` 字节对齐（ASCII 小写化不改长度），切 7 个字节是安全的。
    let (authority, path) = if lower.starts_with("http://") {
        let rest = &raw_url["http://".len()..];
        match rest.find('/') {
            Some(i) => (Some(rest[..i].to_string()), rest[i..].to_string()),
            None => (Some(rest.to_string()), "/".to_string()),
        }
    } else {
        (None, raw_url.clone())
    };

    let host = match &authority {
        Some(auth) => auth.clone(),
        None => text(&cfg, &["host", "ip", "address"]).unwrap_or_default(),
    };
    let (host, port) = split_host_port(&host, &cfg, device_code)?;
    let path = checked_path(&path, device_code)?;

    let user = text(&cfg, &["user", "username", "account"]);
    let secret = secret_json.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
    let password = text(&cfg, &["password", "pass", "pwd"]).or_else(|| {
        secret
            .as_ref()
            .filter(|v| v.is_object())
            .and_then(|s| text(s, &["password", "pass", "pwd", "secret"]))
    });
    let want_digest = matches!(
        text(&cfg, &["auth", "authType", "auth_type"]).map(|v| v.to_ascii_lowercase())
            .as_deref(),
        Some("digest")
    );
    let auth = match (&user, want_digest) {
        (_, true) => AuthKind::Digest,
        (Some(_), false) => AuthKind::Basic,
        (None, false) => AuthKind::None,
    };

    Ok(SnapshotTarget {
        device_id,
        device_code: device_code.to_string(),
        host,
        port,
        path,
        user,
        password,
        auth,
    })
}

fn text(obj: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|k| obj.get(*k)).and_then(|v| match v {
        serde_json::Value::String(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

/// host[:port] 与配置里的 `port` 收敛成一个合法端口。
fn split_host_port(raw: &str, cfg: &serde_json::Value, code: &str) -> Result<(String, u16), String> {
    let (host, port_from_host) = match raw.rsplit_once(':') {
        // 冒号后必须是纯数字才当端口用；整体只允许一个冒号（IPv6 字面量本轮不支持：
        // 现网没有，且要处理方括号与 zone id，收益为零）。
        // 不把 "http://ip" 拆成 host="http" + 怪端口，否则报出来的错在说端口，误导现场。
        Some((h, p))
            if !h.is_empty() && !p.is_empty() && raw.matches(':').count() == 1
                && p.chars().all(|c| c.is_ascii_digit()) =>
        {
            (h.to_string(), Some(p.to_string()))
        }
        _ => (raw.to_string(), None),
    };
    let host = host.trim().to_string();
    if host.is_empty() {
        return Err(format!("摄像机「{code}」未配置地址 host"));
    }
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        || host.starts_with('-')
        || host.ends_with('-')
        || host.contains("..")
    {
        return Err(format!("摄像机「{code}」的地址「{host}」不是合法的 IP 或主机名"));
    }

    let port = match (port_from_host, text(cfg, &["port"])) {
        (Some(_), Some(_)) => {
            return Err(format!("摄像机「{code}」的地址里已带端口，不要再单独填 port"))
        }
        (Some(p), None) | (None, Some(p)) => p,
        (None, None) => "80".to_string(),
    };
    let port: u16 = port.trim().parse().map_err(|_| {
        format!("摄像机「{code}」的端口「{}」不是 1–65535 的整数", port.trim())
    })?;
    if port == 0 {
        return Err(format!("摄像机「{code}」的端口不能为 0"));
    }
    Ok((host, port))
}

/// 路径直接进请求行，所以除"以 / 开头"外还要卡字符：控制字符能撕开 HTTP 报文，
/// 非 ASCII 得先百分号编码（本轮不做，让现场在摄像机侧或配置里改好）。
fn checked_path(raw: &str, code: &str) -> Result<String, String> {
    if raw.contains(':') && raw.to_ascii_lowercase().contains("://") {
        return Err(format!("摄像机「{code}」的抓图路径里不要带协议前缀"));
    }
    if !raw.starts_with('/') {
        return Err(format!(
            "摄像机「{code}」的抓图路径「{raw}」必须以 / 开头"
        ));
    }
    if raw.chars().any(|c| (c as u32) < 0x21 || c == '"' || c == '\\' || (c as u32) > 0x7e) {
        return Err(format!(
            "摄像机「{code}」的抓图路径含空格、控制字符或非 ASCII 字符，请先在配置里改成 URL 编码形式"
        ));
    }
    if raw.len() > 2000 {
        return Err(format!("摄像机「{code}」的抓图路径过长"));
    }
    Ok(raw.to_string())
}

// ------------------------------------------------------------------- 极简 HTTP/1.1

/// Base64（标准字母表 + `=` 补位）。不为一个 20 行的编码引 `base64` 依赖。
pub fn base64_standard(input: &[u8]) -> String {
    const TBL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TBL[(n >> 18 & 63) as usize] as char);
        out.push(TBL[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TBL[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TBL[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Base64 解码（标准字母表，与 [`base64_standard`] 配对）。喂进来的是前端 canvas 的产物，
/// 容忍两种真实形状：`data:image/jpeg;base64,` 前缀与 `=` 补位/换行空白（一律跳过）；
/// 出现其它字母表外字符就判定数据已坏回 `None`，由调用方按"坏帧"降级，不做 URL 安全字母表猜谜。
pub fn base64_decode(input: &str) -> Option<Vec<u8>> {
    let body = match input.find(";base64,") {
        Some(i) => &input[i + ";base64,".len()..],
        None => input,
    };
    let mut out = Vec::with_capacity(body.len().div_ceil(4) * 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for b in body.bytes() {
        if b == b'=' || b.is_ascii_whitespace() {
            continue;
        }
        let v: u32 = match b {
            b'A'..=b'Z' => (b - b'A') as u32,
            b'a'..=b'z' => (b - b'a') as u32 + 26,
            b'0'..=b'9' => (b + 52 - b'0') as u32,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// 组一次 `GET` 的请求字节。纯函数，所以认证串、Host、端口、路径都能离线钉死。
pub fn build_get_request(target: &SnapshotTarget) -> Vec<u8> {
    let host_header = if target.port == 80 {
        target.host.clone()
    } else {
        format!("{}:{}", target.host, target.port)
    };
    let mut lines = vec![
        format!("GET {} HTTP/1.1", target.path),
        format!("Host: {host_header}"),
    ];
    if target.auth == AuthKind::Basic {
        let cred = format!(
            "{}:{}",
            target.user.clone().unwrap_or_default(),
            target.password.clone().unwrap_or_default()
        );
        lines.push(format!("Authorization: Basic {}", base64_standard(cred.as_bytes())));
    }
    // 一次抓图一条连接：keep-alive 要管连接池，而摄像机端常主动掐，反而更难判定
    lines.push("Connection: close".to_string());
    lines.push("Accept: image/jpeg,image/*;q=0.8,*/*;q=0.1".to_string());
    lines.push(format!(
        "User-Agent: banghe/{} (weighbridge-capture)",
        env!("CARGO_PKG_VERSION")
    ));
    let mut buf = lines.join("\r\n").into_bytes();
    buf.extend_from_slice(b"\r\n\r\n");
    buf
}

/// 响应头。`body_start` 是 body 在原始字节里的起点，省掉调用方各算一遍偏移。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpHead {
    pub status: u16,
    pub reason: String,
    pub content_length: Option<usize>,
    pub content_type: Option<String>,
    pub chunked: bool,
    pub body_start: usize,
}

fn find_head_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|i| i + 4)
}

/// 解析响应头（纯函数，不碰网络）。解析不出来时带上原始前若干字节的 hex 便于排障，
/// 但**只回给调用方/日志，绝不入库**。
pub fn parse_http_head(raw: &[u8]) -> Result<HttpHead, String> {
    let Some(body_start) = find_head_end(raw) else {
        return Err(format!(
            "摄像机回包看不出 HTTP 头（前 {} 字节：{}）",
            raw.len().min(32),
            hex_preview(raw, 32)
        ));
    };
    let head = String::from_utf8_lossy(&raw[..body_start - 4]).replace('\n', "");
    let mut lines = head.split("\r").filter(|l| !l.trim().is_empty());
    let status_line = lines.next().unwrap_or_default();
    let mut parts = status_line.splitn(3, ' ');
    let version = parts.next().unwrap_or_default();
    if !version.starts_with("HTTP/") {
        return Err(format!(
            "摄像机回的第一行不是 HTTP 状态行（前 {} 字节：{}）",
            raw.len().min(32),
            hex_preview(raw, 32)
        ));
    }
    let status: u16 = parts
        .next()
        .and_then(|s| s.trim().parse().ok())
        .ok_or_else(|| format!("HTTP 状态码解析不出来：{status_line}"))?;
    let mut head = HttpHead {
        status,
        reason: parts.next().unwrap_or_default().trim().to_string(),
        content_length: None,
        content_type: None,
        chunked: false,
        body_start,
    };
    for line in lines {
        let Some((k, v)) = line.split_once(':') else { continue };
        let key = k.trim().to_ascii_lowercase();
        let value = v.trim();
        match key.as_str() {
            "content-length" => head.content_length = value.parse::<usize>().ok(),
            "content-type" => head.content_type = Some(value.to_string()),
            "transfer-encoding" => {
                if value.to_ascii_lowercase().contains("chunked") {
                    head.chunked = true;
                }
            }
            _ => {}
        }
    }
    Ok(head)
}

/// 按 `Content-Length` 或"收到连接关闭为止"取 body。
pub fn http_body(raw: &[u8], head: &HttpHead) -> Result<Vec<u8>, String> {
    if head.chunked {
        return Err("摄像机用分块传输（chunked）回包，本轮只按 Content-Length 或连接关闭收图".into());
    }
    let rest = raw.get(head.body_start..).unwrap_or_default();
    match head.content_length {
        Some(n) if rest.len() < n => Err(format!(
            "抓拍图被截断：声明 {n} 字节，只收到 {} 字节",
            rest.len()
        )),
        Some(n) => Ok(rest[..n].to_vec()),
        None => Ok(rest.to_vec()),
    }
}

/// 状态码 → 人话（04 §6 要求故障建议能指到下一步动作）。
pub fn http_status_reason(status: u16) -> String {
    match status {
        401 | 403 => "摄像机拒绝登录（HTTP 401/403）：核对 user 与口令，本轮只支持 Basic 认证".into(),
        404 => "抓图路径不存在（HTTP 404）：核对 snapshotUrl 的通道号与码流号".into(),
        408 => "摄像机自己超时（HTTP 408）：稍后再过磅，或降低主码流分辨率".into(),
        500..=599 => format!("摄像机内部错误（HTTP {status}）：多半是固件或通道配置问题"),
        other => format!("摄像机回了 HTTP {other}，不是图像数据"),
    }
}

/// 联网抓一张图：连接、发请求、收包、状态判定、JPEG 校验。失败回中文短句。
///
/// 有界性靠三件事：连接与每次读写都带 3 秒超时、响应头上限 64 KB、
/// 整体字节上限（`max_bytes + 头部余量`）。任何一条超限就断开，绝不无界等下去。
fn grab(target: &SnapshotTarget, max_bytes: usize) -> Result<Vec<u8>, String> {
    let mut stream = connect(target)?;
    let request = build_get_request(target);
    stream
        .write_all(&request)
        .and_then(|_| stream.flush())
        .map_err(|e| net_reason(&e, "向摄像机发请求"))?;

    let cap = max_bytes.saturating_add(HEAD_SLACK);
    let mut buf: Vec<u8> = Vec::with_capacity(8 * 1024);
    let mut chunk = [0u8; 8 * 1024];
    // 整轮预算：单次 read 有 SNAPSHOT_TIMEOUT 秒超时，但慢速滴包（每次刚好回一点）永不触发单次超时；
    // 且 orders::attach_weigh_photos 全程持有单连接 Mutex——一台半死的摄像机会把整个数据路径钉住。
    let deadline = Instant::now() + SNAPSHOT_TIMEOUT * 4;
    loop {
        if Instant::now() > deadline {
            return Err(format!(
                "抓图整轮超过 {} 秒仍未收完，摄像机疑似半死（缓慢滴包）：本轮按无抓拍处理",
                (SNAPSHOT_TIMEOUT * 4).as_secs()
            ));
        }
        match stream.read(&mut chunk) {
            Ok(0) => break, // 对端关闭：Connection: close 的正常收完方式
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if let Some(head_end) = find_head_end(&buf) {
                    if head_end > MAX_HEAD_BYTES {
                        return Err("摄像机响应头超过 64 KB，判定为异常回包".into());
                    }
                    if let Ok(head) = parse_http_head(&buf) {
                        if let Some(cl) = head.content_length {
                            // 先按声明值拒绝，省掉把几十 MB 拖进内存再判一次
                            if cl > max_bytes {
                                return Err(format!(
                                    "抓拍图有 {} KB，超过上限 {} KB：本轮不做缩放压缩，请到摄像机侧调低主码流分辨率与质量",
                                    cl / 1024,
                                    max_bytes / 1024
                                ));
                            }
                            if buf.len() >= head.body_start + cl {
                                break;
                            }
                        }
                    }
                }
                if buf.len() > cap {
                    return Err(format!(
                        "摄像机回包超过 {} KB 上限，已断开",
                        max_bytes / 1024
                    ));
                }
            }
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                return Err(format!(
                    "抓图超时（{} 秒内没回完）：检查网线、IP 与摄像头是否在线",
                    SNAPSHOT_TIMEOUT.as_secs()
                ));
            }
            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(net_reason(&e, "读摄像机")),
        }
    }

    if buf.is_empty() {
        return Err("摄像机没回任何字节：IP 或端口不对，或摄像头已掉线".into());
    }
    let head = parse_http_head(&buf)?;
    if head.status != 200 {
        return Err(http_status_reason(head.status));
    }
    let body = http_body(&buf, &head)?;
    check_jpeg(&body, max_bytes)?;
    Ok(body)
}

fn connect(target: &SnapshotTarget) -> Result<TcpStream, String> {
    // `to_socket_addrs` 对主机名走 getaddrinfo，**没有超时可言**（磅房网段常配 .local /
    //  NetBIOS 名，DNS 不响应时能卡十几秒）。丢给一条一次性线程去解，主路径只等 3 秒：
    // 解不出来就降级，绝不让过磅陪着等。那条线程之后自己结束，不占任何锁与连接。
    let (tx, rx) = std::sync::mpsc::channel();
    let (host, port) = (target.host.clone(), target.port);
    std::thread::spawn(move || {
        let _ = tx.send(
            (host.as_str(), port)
                .to_socket_addrs()
                .map(|it| it.collect::<Vec<_>>())
                .map_err(|e| net_reason(&e, "解析摄像机地址")),
        );
    });
    let addr = rx
        .recv_timeout(SNAPSHOT_TIMEOUT)
        .map_err(|_| format!(
            "解析摄像机地址超时（{} 秒）：把 host 改成 IP 更稳",
            SNAPSHOT_TIMEOUT.as_secs()
        ))??
        .into_iter()
        .next()
        .ok_or_else(|| format!("解析不到摄像机地址：{}", target.host))?;
    let stream = TcpStream::connect_timeout(&addr, SNAPSHOT_TIMEOUT)
        .map_err(|e| net_reason(&e, "连接摄像机"))?;
    stream
        .set_read_timeout(Some(SNAPSHOT_TIMEOUT))
        .and_then(|_| stream.set_write_timeout(Some(SNAPSHOT_TIMEOUT)))
        .map_err(|e| net_reason(&e, "设置抓图超时"))?;
    Ok(stream)
}

// ------------------------------------------------------------------ JPEG 与文件名

/// JPEG 以 `FF D8 FF` 开头（SOI + 段起始）；只认这个，就别的内容一概不入库。
pub fn check_jpeg(bytes: &[u8], max_bytes: usize) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("摄像机回了空包，没有图像数据".into());
    }
    if bytes.len() > max_bytes {
        return Err(format!(
            "抓拍图 {} KB 超过上限 {} KB：本轮不做缩放压缩，请到摄像机侧调低主码流",
            bytes.len() / 1024,
            max_bytes / 1024
        ));
    }
    if !bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        let kind = match bytes.first().copied() {
            Some(0x89) => "像是 PNG，摄像机没按 JPEG 出图",
            Some(b'<') => "像是 HTML 错误页",
            Some(0x25) => "像是 PDF",
            _ => "未知类型",
        };
        return Err(format!(
            "回包不是 JPEG（{kind}；前 {} 字节：{}）",
            bytes.len().min(16),
            hex_preview(bytes, 16)
        ));
    }
    if bytes.len() < 16 {
        return Err("回包的 JPEG 短得不像一张照片".into());
    }
    Ok(())
}

/// 诊断用的 hex 预览。**只上日志/返回值，不进库**，也不含文件路径。
pub fn hex_preview(bytes: &[u8], max: usize) -> String {
    let take = bytes.len().min(max);
    let mut out = String::with_capacity(take * 3 + 8);
    for b in &bytes[..take] {
        out.push_str(&format!("{b:02X} "));
    }
    if bytes.len() > take {
        out.push_str("…");
    }
    out.trim_end().to_string()
}

/// 文件名片段：**只留 ASCII 字母数字**，其余折成一个 `_`。
/// 设备 `code` 是磅房自己录的，但"自己录的"不等于可信——路径穿越多半就藏在这种字段里。
pub fn safe_stem(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(24));
    let mut pending_sep = false;
    for c in raw.chars() {
        if c.is_ascii_alphanumeric() {
            if pending_sep && !out.is_empty() {
                out.push('_');
            }
            out.push(c);
            pending_sep = false;
        } else {
            pending_sep = true;
        }
    }
    while out.ends_with('_') {
        out.pop();
    }
    out.make_ascii_lowercase();
    let mut out: String = out.chars().take(24).collect();
    if out.is_empty() {
        out = "camera".to_string();
    }
    out
}

/// 附件相对路径：`attachments/YYYY-MM/<时间戳>-<毫秒>-<设备片段>-<sha 前 8 位>.jpg`。
/// 每段都由本机生成（时间、哈希、清洗过的 code），**没有任何一段来自摄像机侧**；
/// 存进 `attachment.file_path` 的就是这一串相对 `AppDataDir` 的路径（§9.15 列注释）。
pub fn attachment_rel_path(at: &DateTime<Local>, device_code: &str, sha256_hex: &str) -> String {
    attachment_rel_path_ext(at, device_code, sha256_hex, "jpg")
}

/// 同上，但扩展名由调用方给（身份证照片是 `.bmp`、上传的 PNG 是 `.png`）。
/// 扩展名与 `attachment.mime` 必须同批判定，见 [`crate::attachment::image_kind`]。
pub(crate) fn attachment_rel_path_ext(
    at: &DateTime<Local>,
    device_code: &str,
    sha256_hex: &str,
    ext: &str,
) -> String {
    let sha = sha256_hex.get(..8).unwrap_or(sha256_hex);
    format!(
        "attachments/{}/{}-{:03}-{}-{}.{}",
        at.format("%Y-%m"),
        at.format("%Y%m%d-%H%M%S"),
        at.timestamp_subsec_millis(),
        safe_stem(device_code),
        sha,
        ext
    )
}

/// 把相对路径拼到数据目录下。任一段不安全（空、`.`、`..`、反斜杠、非白名单字符）
/// 就回 `None`——这是最后一道闸，正常输入永远不会撞上它。
pub(crate) fn join_under(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        let ok = !part.is_empty()
            && part != "."
            && !part.contains("..")
            && !part.contains('\\')
            && part.chars().all(|c| {
                c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':')
            });
        if !ok {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

// ------------------------------------------------------------------------ 落库

/// 一次「写文件 + 插一行 `attachment`」所需的全部归属。
///
/// 本模块原先只服务过磅抓拍，于是这些归属散在 SQL 字面量里（`'scale_capture'`、
/// `'image/jpeg'`）。档案人像、留样照片、签字都要落同一张表、走同一套"盘上有图、
/// 库里有行、失败不能留孤本"的规矩——两处各写一遍的话，将来补漏的那一处永远不是全部。
#[derive(Debug, Clone)]
pub struct ImageMeta<'a> {
    /// `attachment.biz_type`（值域见 §9.15 的 CHECK）
    pub biz_type: &'a str,
    /// `attachment.biz_id`：多态归属——抓拍是称重记录 id，档案人像是 `party.id`
    pub biz_id: Option<i64>,
    /// 便于按单归集与清理；不属于任何单据的附件为 `None`
    pub order_id: Option<i64>,
    /// `attachment.mime` 与文件扩展名，成对给出，不让调用方各写一半
    pub kind: ImageKind,
    /// 只用于生成文件名片段（先过 [`safe_stem`]），原始值既不落库也不打日志。
    /// 抓拍传设备 `code`，档案人像传 `party{id}` 这类系统自己拼的标签。
    pub tag: &'a str,
    pub source_device_id: Option<i64>,
    /// `attachment.created_by` 非空且是外键
    pub operator_id: i64,
}

/// 写文件 + 插 `attachment` 行。**不碰任何业务表**：附件 id 回给调用方去挂。
///
/// 目录不存在就建；同名（同毫秒同内容）就加序号重试，绝不覆盖已有图片。
/// 写完 `sync_all` 再插库：磅房机是直接拔电的，库里有一行而盘上没这张图是 worst case。
/// 反过来若插库失败，就把刚写的文件删掉——留下"野图"比丢掉一张图更糟（04 §4.3 的
/// 附件只能有单据归属，不然留存与清理都对不上账）。
pub fn store_image(
    conn: &Connection,
    app_dir: &Path,
    bytes: &[u8],
    meta: &ImageMeta<'_>,
) -> Result<i64, String> {
    if bytes.is_empty() {
        return Err("没有图像数据可落库".into());
    }
    let now = Local::now();
    let sha = sha256_hex(bytes);
    let rel = attachment_rel_path_ext(&now, meta.tag, &sha, meta.kind.ext);
    let path = join_under(app_dir, &rel).ok_or_else(|| "附件文件路径不合法，已放弃落盘".to_string())?;
    let parent = path.parent().ok_or_else(|| "附件文件路径不合法，已放弃落盘".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| file_reason(&e, "创建附件目录"))?;

    let candidate = path.clone();
    let mut written: Option<(PathBuf, std::fs::File)> = None;
    for n in 0..32u32 {
        let target = if n == 0 {
            candidate.clone()
        } else {
            with_suffix(&candidate, n)
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
        {
            Ok(f) => {
                written = Some((target, f));
                break;
            }
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(file_reason(&e, "创建抓拍文件")),
        }
    }
    let (written_path, mut file) =
        written.ok_or_else(|| "同一毫秒内抓拍文件重名过多，已放弃落盘".to_string())?;
    let io = file
        .write_all(bytes)
        .and_then(|_| file.flush())
        .and_then(|_| file.sync_all());
    drop(file);
    if let Err(e) = io {
        let _ = std::fs::remove_file(&written_path);
        return Err(file_reason(&e, "写入抓拍文件"));
    }

    let captured_at = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, false);
    let inserted = conn.execute(
        "INSERT INTO attachment (biz_type, biz_id, order_id, file_path, file_size, mime,
                                 width, height, sha256, encrypted, captured_at,
                                 source_device_id, created_at, created_by)
         VALUES (?9, ?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, 0, ?7, ?8, ?7, ?10)",
        params![
            meta.biz_id,
            meta.order_id,
            rel,
            bytes.len() as i64,
            meta.kind.mime,
            sha,
            captured_at,
            meta.source_device_id,
            meta.biz_type,
            meta.operator_id,
        ],
    );
    if let Err(e) = inserted {
        // 文件先落了、库没记上 → 补删，不给磁盘留没人认领的农户照片
        let _ = std::fs::remove_file(&written_path);
        return Err(format!("写附件记录失败：{}", db_reason(e)));
    }
    Ok(conn.last_insert_rowid())
}

/// 过磅抓拍落库：把抓拍侧的归属形状换算成通用的 [`ImageMeta`]。
/// 行为（`biz_type`、mime、文件名形状、失败补删）与泛化前逐字一致，camera 契约测试钉着它。
pub fn store_snapshot(
    conn: &Connection,
    app_dir: &Path,
    jpeg: &[u8],
    meta: &AttachmentMeta,
) -> Result<i64, String> {
    store_image(
        conn,
        app_dir,
        jpeg,
        &ImageMeta {
            biz_type: "scale_capture",
            biz_id: Some(meta.weigh_record_id),
            order_id: Some(meta.order_id),
            kind: ImageKind::Jpeg,
            tag: &meta.device_code,
            source_device_id: meta.device_id,
            operator_id: meta.operator_id,
        },
    )
}

// ----------------------------------------------------------- 过磅抓拍相机（多路，≤3）
//
// 04 §4：每次过磅（毛重一捕、皮重一捕）最多由 3 台相机各拍一张。哪几台参与，是设备中心
// 相机台账里的 `config.captureOnWeigh` 勾选决定的（本机 USB 与内网 IP 机可混着勾），
// 上限硬卡在 [`MAX_CAPTURE_CAMERAS`]——这是需求本身要的数，不是又一道擅自加的闸门。
// 勾选与 `is_enabled` 是两个轴：停用（`is_enabled=0`）的相机即便勾了也不过磅，和读卡器
// 「未登记就压根不开设备」同口径。

/// 单次过磅最多几台相机抓拍（需求：「支持最多三个摄像头抓拍」）。
pub const MAX_CAPTURE_CAMERAS: usize = 3;

/// 一台参与过磅抓拍的相机（`device_config` 的一行裁剪，够拼端点与判通道/降级用）。
#[derive(Debug, Clone)]
pub struct CamRow {
    pub id: i64,
    pub code: String,
    pub config_json: String,
    pub secret_json: Option<String>,
    pub is_mock: i64,
}

/// 这台相机的配置有没有勾「过磅抓拍」。驼峰 `captureOnWeigh` 与蛇形 `capture_on_weigh`
/// 都认（与仓内其它 config 键一样容忍手输），非布尔真值一律当没勾。
pub fn capture_on_weigh_enabled(config_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(config_json)
        .ok()
        .and_then(|v| {
            ["captureOnWeigh", "capture_on_weigh"]
                .iter()
                .find_map(|k| v.get(*k))
                .map(|x| matches!(x, serde_json::Value::Bool(true) | serde_json::Value::Number(_)))
        })
        .unwrap_or(false)
}

/// 本次过磅该由哪几台相机抓拍：`kind='camera' AND is_enabled=1` 且勾了 `captureOnWeigh`，
/// 按 `is_default DESC, id` 排序、截到 [`MAX_CAPTURE_CAMERAS`]。没勾任何一台就是空表——
/// 老站点靠迁移 0018 把原来那台默认相机勾上，不会静默丢掉抓拍。
pub fn list_capture_cameras(conn: &Connection) -> Result<Vec<CamRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, code, config_json, secret_json, is_mock FROM device_config
             WHERE kind = 'camera' AND is_enabled = 1
             ORDER BY is_default DESC, id",
        )
        .map_err(|e| format!("读取摄像机配置失败：{e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok(CamRow {
                id: r.get(0)?,
                code: r.get(1)?,
                config_json: r.get(2)?,
                secret_json: r.get(3)?,
                is_mock: r.get(4)?,
            })
        })
        .map_err(|e| format!("读取摄像机配置失败：{e}"))?;
    let mut out = Vec::new();
    for row in rows {
        let cam = row.map_err(|e| format!("读取摄像机配置失败：{e}"))?;
        if capture_on_weigh_enabled(&cam.config_json) {
            out.push(cam);
            if out.len() >= MAX_CAPTURE_CAMERAS {
                break;
            }
        }
    }
    Ok(out)
}

/// 本机 USB 摄像头的回传帧收口（04 §4 方案 A 的前端半边）：画面由工作台在 WebView2 里
/// `getUserMedia` 打开，捕获毛/皮重时就地取一帧 JPEG、base64 回传；本函数只做
/// 「解码 → 校验 → 落库 → 台账状态回写」，**不开任何设备**。
///
/// 为什么不在 Rust 侧同样开设备：Media Foundation 采集栈（source reader + NV12→JPEG 转码）
/// 比复用 Edge 已解码上屏的那帧画面贵得多；且台账 `deviceId` 是 MF 符号链接，Chromium
/// 根本不认——认机器只能靠 webview 里按名字匹配（`src/lib/local-camera.ts`）。
///
/// 失败口径与 [`capture_snapshot`] 一致：坏码/非 JPEG/超上限都不否定这次过磅，原因写进
/// `device_config.last_error` 后回 `Ok(None)` 按「无抓拍」处理。
pub fn store_provided_frame(
    conn: &Connection,
    app_dir: &Path,
    ctx: &CaptureContext,
    photo_b64: &str,
) -> Result<Option<i64>, String> {
    // 单台入口（旧调用方与契约测试走这条）：解析出「默认/启用」那台相机后交给逐台核心。
    // 多路过磅抓拍的生产路径是 orders.rs 遍历 [`list_capture_cameras`] 逐台调 [`store_frame_for`]，
    // 不再靠这里 LIMIT 1 猜那台。
    let row: Option<CamRow> = conn
        .query_row(
            "SELECT id, code, config_json, secret_json, is_mock FROM device_config
             WHERE kind = 'camera' AND is_enabled = 1
             ORDER BY is_default DESC, id LIMIT 1",
            [],
            |r| {
                Ok(CamRow {
                    id: r.get(0)?,
                    code: r.get(1)?,
                    config_json: r.get(2)?,
                    secret_json: r.get(3)?,
                    is_mock: r.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("读取摄像机配置失败：{e}"))?;
    let Some(cam) = row else {
        degrade("本机未启用抓拍摄像机（设备中心里加一台 kind=camera 并勾选启用）")?;
        return Ok(None);
    };
    store_frame_for(conn, app_dir, ctx, &cam, photo_b64)
}

/// 逐台本机摄像头回传帧落库的核心（[`store_provided_frame`] 的下半段，相机由调用方给）。
/// 多路抓拍时 orders.rs 对每台勾了「过磅抓拍」的本机相机各调一次，各落一张 attachment。
pub fn store_frame_for(
    conn: &Connection,
    app_dir: &Path,
    ctx: &CaptureContext,
    cam: &CamRow,
    photo_b64: &str,
) -> Result<Option<i64>, String> {
    let (id, code) = (cam.id, cam.code.as_str());
    if cam.is_mock == 1 {
        degrade(&format!("摄像机「{code}」当前为模拟模式，本轮不出真图"))?;
        return Ok(None);
    }

    let max_bytes = max_snapshot_bytes(conn);
    let fail = |conn: &Connection, reason: String| -> Result<Option<i64>, String> {
        note_fail(conn, id, &reason);
        degrade(&reason)?;
        Ok(None)
    };
    // 先按编码长度拒收再解码：把几十 MB 的 base64 拖进内存再判超限是白给的攻击面
    if photo_b64.len() > max_bytes / 3 * 4 + HEAD_SLACK {
        return fail(
            conn,
            format!(
                "回传帧过大（base64 约 {} KB，图像上限 {} KB）：到摄像机侧调低分辨率与质量，本轮按无抓拍处理",
                photo_b64.len() / 1024 * 3 / 4,
                max_bytes / 1024
            ),
        );
    }
    let jpeg = match base64_decode(photo_b64) {
        Some(bytes) => bytes,
        None => return fail(conn, "回传帧不是合法的 base64（疑似被截断或改码）：本轮按无抓拍处理".into()),
    };
    if let Err(e) = check_jpeg(&jpeg, max_bytes) {
        return fail(conn, format!("回传帧校验失败：{e}"));
    }
    let attached = store_snapshot(
        conn,
        app_dir,
        &jpeg,
        &AttachmentMeta {
            order_id: ctx.order_id,
            weigh_record_id: ctx.weigh_record_id,
            operator_id: ctx.operator_id,
            device_id: Some(id),
            device_code: code.to_string(),
        },
    );
    match attached {
        Ok(att) => {
            note_ok(conn, id);
            Ok(Some(att))
        }
        Err(reason) => fail(conn, reason),
    }
}

pub(crate) fn with_suffix(path: &Path, n: u32) -> PathBuf {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("shot");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("jpg");
    path.with_file_name(format!("{stem}-{n}.{ext}"))
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    h.finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

// ---------------------------------------------------------------- 设备状态上报

/// 04 §1 的状态口径：成功刷 `last_ok_at`、失败累加 `err_count` 并连续 5 次转离线。
/// 写不进去就算了——设备台账不能被一次抓拍写坏，且这条 UPDATE 不在抓拍的关键路径上。
fn note_ok(conn: &Connection, device_id: i64) {
    let _ = conn.execute(
        "UPDATE device_config SET last_status = 'online', last_ok_at = ?1, last_err_at = NULL,
                last_error = NULL, err_count = 0, updated_at = ?1
         WHERE id = ?2",
        params![crate::db::migrate::now_iso(), device_id],
    );
}

fn note_fail(conn: &Connection, device_id: i64, reason: &str) {
    let _ = conn.execute(
        "UPDATE device_config SET last_status = CASE WHEN err_count + 1 >= 5 THEN 'offline' ELSE 'error' END,
                last_err_at = ?1, last_error = ?2, err_count = err_count + 1, updated_at = ?1
         WHERE id = ?3",
        params![crate::db::migrate::now_iso(), clip(reason, 200), device_id],
    );
}

fn clip(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if out.chars().count() < s.chars().count() {
        out.push('…');
    }
    out
}

// ------------------------------------------------------------------------ 入口

/// 过磅抓拍：取一张图并落成附件行。返回新 `attachment.id`。
///
/// **约定（调用方照这个写就行）**：
///  - `Ok(Some(id))`：图已落盘并入库，调用方把 id 挂到 `weigh_record.photo_attachment_id`。
///  - `Ok(None)`：**降级**，按"无抓拍"继续过磅。原因已写进 `device_config.last_error`
///    并打到 stderr，不需要调用方处理，也绝不该打断称重（04 §4.2、H6）。
///  - `Err(中文短句)`：配置本身非法（host 空、端口不合法、路径不以 `/` 开头、HTTPS、
///    JSON 坏掉）。重试无意义，应当显示给站长去设备中心改；调用方若只想让过磅继续，
///    把它当 `Ok(None)` 用也安全。
///
/// 本函数**会阻塞**（最长 3 秒 + 解析 3 秒）。副作用只有两处：写一行 `attachment`，
/// 以及按 04 §1 回写 `device_config` 的状态列（`last_ok_at`/`last_error`/`err_count`/
/// `last_status`）。**不碰 `weigh_record`/`weigh_order`**，所以放在称重事务里也能跑；
/// 但事务里等 3 秒会把单连接的写事务开足，建议调用方在事务外取图、拿到 id 后再挂记录。
pub fn capture_snapshot(
    conn: &Connection,
    app_dir: &Path,
    ctx: &CaptureContext,
) -> Result<Option<i64>, String> {
    // 单台入口（旧调用方与契约测试走这条）：解析出「默认/启用」那台相机后交给逐台核心。
    // 多路过磅抓拍的生产路径是 orders.rs 遍历 [`list_capture_cameras`] 逐台调 [`snapshot_for`]。
    let row: Option<CamRow> = conn
        .query_row(
            "SELECT id, code, config_json, secret_json, is_mock FROM device_config
             WHERE kind = 'camera' AND is_enabled = 1
             ORDER BY is_default DESC, id LIMIT 1",
            [],
            |r| {
                Ok(CamRow {
                    id: r.get(0)?,
                    code: r.get(1)?,
                    config_json: r.get(2)?,
                    secret_json: r.get(3)?,
                    is_mock: r.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|e| format!("读取摄像机配置失败：{e}"))?;
    let Some(cam) = row else {
        degrade("本机未启用抓拍摄像机（设备中心里加一台 kind=camera 并勾选启用）")?;
        return Ok(None);
    };
    snapshot_for(conn, app_dir, ctx, &cam)
}

/// 这台相机是不是本机 USB 摄像头（`config.transport === "local"`）。orders.rs 用它分叉：
/// 本机走前端回传帧 [`store_frame_for`]，网络机走这里 HTTP 抓图 [`snapshot_for`]。
pub fn is_local_camera(config_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(config_json)
        .ok()
        .and_then(|v| {
            v.get("transport")
                .and_then(|t| t.as_str())
                .map(|s| s.eq_ignore_ascii_case("local"))
        })
        .unwrap_or(false)
}

/// 逐台 HTTP 抓图的核心（[`capture_snapshot`] 的下半段，相机由调用方给）。
pub fn snapshot_for(
    conn: &Connection,
    app_dir: &Path,
    ctx: &CaptureContext,
    cam: &CamRow,
) -> Result<Option<i64>, String> {
    let (id, code) = (cam.id, cam.code.as_str());
    if cam.is_mock == 1 {
        degrade(&format!("摄像机「{code}」当前为模拟模式，本轮不出真图"))?;
        return Ok(None);
    }

    // 本机 USB 摄像头的正常取帧通道是「前端画面就地取一帧回传」（[`store_frame_for`]，
    // 04 §4 方案 A 的前端半边）。走到这里还没带帧＝预览此刻没开成/取帧失败：明确按无抓拍降级，
    // 而不是掉进下面 target_from_config 的「未配置 host / 抓图路径」误报。
    if is_local_camera(&cam.config_json) {
        degrade(&format!(
            "摄像机「{code}」是本机 USB 摄像头，这一轮没拿到回传帧（工作台画面未打开或取帧失败）：按无抓拍处理"
        ))?;
        return Ok(None);
    }

    let target = match target_from_config(id, code, &cam.config_json, cam.secret_json.as_deref()) {
        Ok(t) => t,
        Err(reason) => {
            note_fail(conn, id, &reason);
            return Err(reason);
        }
    };
    if target.auth == AuthKind::Digest {
        let reason = "该摄像机要求 Digest 认证，本轮抓图只支持 Basic：把 auth 改成 basic 或在摄像机侧启用 Basic";
        note_fail(conn, id, reason);
        degrade(reason)?;
        return Ok(None);
    }

    let max_bytes = max_snapshot_bytes(conn);
    let jpeg = match grab(&target, max_bytes) {
        Ok(bytes) => bytes,
        Err(reason) => {
            note_fail(conn, id, &reason);
            degrade(&reason)?;
            return Ok(None);
        }
    };
    let attachment_id = match store_snapshot(
        conn,
        app_dir,
        &jpeg,
        &AttachmentMeta {
            order_id: ctx.order_id,
            weigh_record_id: ctx.weigh_record_id,
            operator_id: ctx.operator_id,
            device_id: Some(id),
            device_code: code.to_string(),
        },
    ) {
        Ok(att) => att,
        Err(reason) => {
            note_fail(conn, id, &reason);
            degrade(&reason)?;
            return Ok(None);
        }
    };
    note_ok(conn, id);
    Ok(Some(attachment_id))
}

/// 降级留痕：stderr 一句人话（不含文件路径，PII 规则），返回值只给 `Ok(None)`。
fn degrade(reason: &str) -> Result<(), String> {
    eprintln!("[banghe] 过磅抓拍降级：{reason}");
    Ok(())
}

/// `attachment_max_kb`（04 §4.2）→ 字节上限。离谱值按默认兜，不给 0 或负数放行。
fn max_snapshot_bytes(conn: &Connection) -> usize {
    let kb = crate::orders::setting_int(conn, "attachment_max_kb", DEFAULT_MAX_KB);
    let kb = if (32..=20480).contains(&kb) { kb } else { DEFAULT_MAX_KB };
    kb as usize * 1024
}

// ------------------------------------------------------------------- 错误话术
// 三条通道各一个：网络、磁盘、数据库。共同点是**绝不带文件路径**（附件里是农户人像）。

fn net_reason(e: &Error, what: &str) -> String {
    match e.kind() {
        ErrorKind::TimedOut | ErrorKind::WouldBlock => {
            format!("{what}超时（{} 秒）：检查网线与摄像头是否在线", SNAPSHOT_TIMEOUT.as_secs())
        }
        ErrorKind::ConnectionRefused => format!("{what}被拒绝：摄像机端口没开，或端口填错了"),
        ErrorKind::ConnectionReset => format!("{what}被对端中断：摄像头可能正在重启"),
        _ => format!("{what}失败：{}（系统错误码 {code}）", e, code = e.raw_os_error().unwrap_or(0)),
    }
}

fn file_reason(e: &Error, what: &str) -> String {
    let why = match e.kind() {
        ErrorKind::PermissionDenied => "数据目录不可写（权限或杀毒软件拦截）",
        ErrorKind::NotFound => "数据目录不存在或已被移动",
        ErrorKind::StorageFull => "磁盘已满",
        ErrorKind::WriteZero => "写入被拒（磁盘或配额）",
        ErrorKind::TimedOut => "磁盘写入超时",
        _ => "磁盘写入失败",
    };
    // 只带错误码，不带 Display：io 错误的具体消息里可能出现我们拼出来的路径
    format!("{what}失败：{why}（系统错误码 {code}）", code = e.raw_os_error().unwrap_or(0))
}

fn db_reason(e: rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqliteFailure(_, Some(msg)) => msg,
        rusqlite::Error::SqliteFailure(_, None) => "SQLite 未给出原因".to_string(),
        _ => "数据库调用异常".to_string(),
    }
}
