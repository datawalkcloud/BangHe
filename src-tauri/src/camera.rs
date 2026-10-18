//! 过磅抓拍取图 + 附件落库（04 §4 方案 A：内网 IP 摄像机 HTTP 抓图）
//!
//! 这一轮把 [`crate::orders`] 模块头欠下的那句"取帧通道还没接"接上了：捕获毛重/皮重时
//! 按设备台账里那台 `kind='camera'` 的配置向摄像机发一次明文 HTTP GET，拿回 JPEG，
//! 校验后写 `AppDataDir/attachments/YYYY-MM/*.jpg` 并插一行 `attachment`
//! （`biz_type='scale_capture'`、`biz_id`=称重记录 id）。调用方拿到附件 id 后
//! 自己写 `weigh_record.photo_attachment_id`——**本模块不碰业务表**（04 §2.4 的分工：
//! 设备层只交图与附件行，业务归属由服务层落），于是磅单上的"无抓拍"终于有了真依据。
//!
//! **认证**：Basic 一趟过；Digest（04 §4.1 说海康 ISAPI 走这个，现网那台 192.168.10.199
//! 实测对 Basic 只回 401）按"空认证撞质询 → 带应答重发"两趟走，MD5 手写不引依赖
//! （见 `md5` 与 [`digest_authorization`]）。台账里的 `auth` 键决定用哪种。
//!
//! **本轮没接的东西**（都是有意不做，不是漏了）：
//!  - **HTTPS**：抓图只走明文 HTTP。磅房里摄像机与磅房机同网段，厂商固件的 TLS 栈
//!    多半是过期证书；要接得先定证书校验策略（04 §4.1 未给结论），所以配置里出现
//!    `https://` 一律**明确拒绝**而不是退化成明文去试。
//!  - **RTSP 抽帧 / 录像回放**：方案 C（ffmpeg）与 NVR 回放都不在这里。常驻画面走
//!    [`crate::camera_stream`] 那条 RTSP + H.264 软解，与这里的"一次一张 JPEG"是两条路。
//!    （04 §4.2 的"长边 1600 px + 逐级降质"**已经接上**，见 [`fit_to_budget`]：解码用
//!    `jpeg-decoder`、编码复用预览那条路已在用的 `jpeg-encoder`，没引 `image` 全家桶。）
//!  - **EXIF 方向**：解码器只取像素，不看 `Orientation`。这里不亏：IP 机固定安装、
//!    ISAPI 出的图方向就是传感器方向，本机 USB 机的帧来自前端 canvas、压根没有 EXIF 段。
//!    真要接手机照片那一类，得连 [`crate::attachment`] 的上传通道一起判，别在这里半做。
//!  - **`width`/`height` 留 NULL**：解析 JPEG 的 SOF0/SOF2 段拿宽高属于过度设计——
//!    这两个字段在本系统里没有任何消费方（磅单只印缩略图，台账不按像素统计）。
//!    现在有了 JPEG 解码器，"顺手填上"看着变便宜了，但**只有超限走压缩的那几张才解得开码**，
//!    逐行填会变成半库有、半库没有，比全 NULL 更难解释；要填就得每张都解一遍，
//!    那是为一列没人读的数给每次过磅加一次解码。仍然不做。
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
/// 与 0031 抬过的种子值同数（500 → 2048）：主码流摄像机出图常在 500–900 KB，
/// 兜底值留在 500 就等于让"参数键丢了"的站点把每一张正常抓拍图都拖去重编一遍
/// （压缩链路补上之后不再是丢图，而是白降一档凭证质量），比"站点故意调小"糟得多。
const DEFAULT_MAX_KB: i64 = 2048;

/// 一次抓拍允许从摄像机拖进内存的最大字节。**与落库上限 [`max_snapshot_bytes`] 是两件事**：
/// 这一格防的是把几十 MB 拖进这台机器（网络与内存），`attachment_max_kb` 管的是
/// 走过 04 §4.2 的压缩链路之后**落盘**多大。4K 主码流一帧 JPEG 实测 2–4 MB，8 MB 留一倍余量。
/// 超限的图不再当场拒收，而是先进 [`fit_to_budget`]。
pub const SNAPSHOT_FETCH_MAX_BYTES: usize = 8 * 1024 * 1024;

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

/// 认证方式。`Digest` 需要两趟往返（先空认证拿 401 质询，再带应答重发），见 `grab`。
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
    let path = checked_path(&path, device_code, "抓图路径")?;

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

/// 取一个字符串键：只认非空字符串与数字（端口常写成数字），并一律 trim。
/// `camera_stream.rs` 推 RTSP 地址时读的是同一把尺子，两处不会一个认 `rtspUrl` 一个不认。
pub(crate) fn text(obj: &serde_json::Value, keys: &[&str]) -> Option<String> {
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

/// 路径直接进请求行，所以除"以 / 开头"外还要卡字符：控制字符能撕开 HTTP/RTSP 报文，
/// 非 ASCII 得先百分号编码（本轮不做，让现场在摄像机侧或配置里改好）。
/// `what` 只影响报错时怎么称呼这一栏——抓图与预览两条通道共用同一把尺子。
pub(crate) fn checked_path(raw: &str, code: &str, what: &str) -> Result<String, String> {
    if raw.contains(':') && raw.to_ascii_lowercase().contains("://") {
        return Err(format!("摄像机「{code}」的{what}里不要带协议前缀"));
    }
    if !raw.starts_with('/') {
        return Err(format!("摄像机「{code}」的{what}「{raw}」必须以 / 开头"));
    }
    if raw.chars().any(|c| (c as u32) < 0x21 || c == '"' || c == '\\' || (c as u32) > 0x7e) {
        return Err(format!(
            "摄像机「{code}」的{what}含空格、控制字符或非 ASCII 字符，请先在配置里改成 URL 编码形式"
        ));
    }
    if raw.len() > 2000 {
        return Err(format!("摄像机「{code}」的{what}过长"));
    }
    Ok(raw.to_string())
}

// ---------------------------------------------------------- MD5 与 Digest 认证

/// MD5（RFC 1321）。**只用于 HTTP Digest 的质询应答**——口令散列走 argon2（见 `auth.rs`），
/// 两件事绝不能混。手写而不引 crate，与 [`base64_standard`] 同一取舍：
/// 只为一次摘要就把磅房机的依赖树拉长一截不划算，且算法本身有 RFC 的官方测试向量可钉死。
fn md5(input: &[u8]) -> [u8; 16] {
    // 每轮左移位数与 K 表（K[i] = floor(2^32 × |sin(i+1)|)）都照 RFC 1321 的附录抄成常量，
    // 不在运行时用浮点现算：那样每次构建的位都可能不一样，测试向量就白钉了。
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
        5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
        4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
        6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ];

    // 填充：0x80 + 若干 0x00 补到 ≡56 (mod 64)，末尾挂 64 位小端长度
    let mut data = input.to_vec();
    let bit_len = (input.len() as u64).wrapping_mul(8);
    data.push(0x80);
    while data.len() % 64 != 56 {
        data.push(0x00);
    }
    data.extend_from_slice(&bit_len.to_le_bytes());

    let (mut a0, mut b0, mut c0, mut d0) = (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);
    for chunk in data.chunks(64) {
        let mut m = [0u32; 16];
        for (i, w) in m.iter_mut().enumerate() {
            let off = i * 4;
            *w = u32::from_le_bytes([
                chunk[off],
                chunk[off + 1],
                chunk[off + 2],
                chunk[off + 3],
            ]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            // 四轮各自的 F/G 索引式，照 RFC 1321 §3.4
            let (f, g) = match i / 16 {
                0 => ((b & c) | ((!b) & d), i),
                1 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let next = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                a.wrapping_add(f)
                    .wrapping_add(K[i])
                    .wrapping_add(m[g])
                    .rotate_left(S[i]),
            );
            a = next;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut out = [0u8; 16];
    for (i, w) in [a0, b0, c0, d0].iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&w.to_le_bytes());
    }
    out
}

/// MD5 的小写十六进制串——`Authorization` 里的 `response` 就是这个形状。
pub fn md5_hex(input: &[u8]) -> String {
    md5(input).iter().map(|b| format!("{b:02x}")).collect()
}

/// 一次 `WWW-Authenticate: Digest ...` 里真正要用的几个参数。
/// `qop` 只认 `auth`（`auth-int` 要连实体一起摘要，现网海康 / 大华都没这么配）；
/// 没回 `qop` 就按 RFC 2617 的老式无计数模式算，海康部分固件正是这种。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestChallenge {
    pub realm: String,
    pub nonce: String,
    pub opaque: Option<String>,
    pub qop: Option<String>,
    pub algorithm: String,
}

/// 拆 `Digest key="value", key2=value2, ...`。值可以带引号也可以不带，
/// 而带引号的值里真会出现逗号（`qop="auth,auth-int"`、realm 带地名），
/// 所以按引号状态扫一遍再切逗号，不能 `split(',')`。
pub fn parse_digest_challenge(header: &str) -> Result<DigestChallenge, String> {
    let body = header.trim();
    let body = match body.get(..6) {
        Some(p) if p.eq_ignore_ascii_case("digest") => &body[6..],
        _ => return Err(format!("摄像机回的认证头不是 Digest 质询：{header}")),
    };
    let mut params: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for ch in body.chars() {
        match ch {
            '"' => {
                quoted = !quoted;
                cur.push(ch);
            }
            ',' if !quoted => {
                params.push(cur);
                cur = String::new();
            }
            _ => cur.push(ch),
        }
    }
    params.push(cur);

    let mut realm = None;
    let mut nonce = None;
    let mut opaque = None;
    let mut qop = None;
    let mut algorithm = None;
    for kv in params {
        let Some((k, v)) = kv.split_once('=') else { continue };
        let value = {
            let v = v.trim();
            v.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(v).to_string()
        };
        match k.trim().to_ascii_lowercase().as_str() {
            "realm" => realm = Some(value),
            "nonce" => nonce = Some(value),
            "opaque" => opaque = Some(value),
            "algorithm" => algorithm = Some(value),
            // 只挑 auth；候选列表里是它就用它，不是就按无 qop 算（见上）
            "qop" => qop = value.split(',').map(|s| s.trim()).find(|s| s.eq_ignore_ascii_case("auth")).map(|s| s.to_string()),
            _ => {}
        }
    }
    let realm = realm.ok_or_else(|| format!("Digest 质询里没有 realm，无法算 HA1：{header}"))?;
    let nonce = nonce.ok_or_else(|| format!("Digest 质询里没有 nonce，无从应答：{header}"))?;
    let algorithm = algorithm.unwrap_or_else(|| "MD5".to_string());
    if !algorithm.eq_ignore_ascii_case("MD5") {
        return Err(format!("摄像机要求 {algorithm} 的 Digest 认证，本轮只实现 MD5：把认证方式改成 basic 试一次"));
    }
    Ok(DigestChallenge { realm, nonce, opaque, qop, algorithm })
}

/// 把值包成 `quoted-string`：转义 `\` 与 `"`，遇到 CR/LF 直接拒绝——
/// realm/nonce/opaque 是从摄像机回包里抄来的，照原样塞进请求头等于让对端决定我们发什么。
fn digest_quoted(key: &str, value: &str) -> Result<String, String> {
    let mut out = String::with_capacity(value.len() + 3);
    out.push('"');
    for ch in value.chars() {
        if matches!(ch, '\r' | '\n') {
            return Err(format!("Digest 参数 {key} 里带了换行，拒发这条应答"));
        }
        if ch == '\\' || ch == '"' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    Ok(out)
}

/// 客户端随机串。没有 `rand` 依赖，用"纳秒时钟 + 进程内计数 + 线程号"再过一道 MD5：
/// 它只要每次不同、不可预测到能撞就行，不承担密码学职责。
fn cnonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = format!("{nanos}:{}:{}", SEQ.fetch_add(1, Ordering::Relaxed), std::process::id());
    md5_hex(seed.as_bytes())[..16].to_string()
}

/// 组出第二趟的 `Authorization: Digest ...`（RFC 7616 §3.3）。
/// `uri` 用抓图路径本身、用户名与口令按 UTF-8 字节参与摘要（中文口令的摄像机现场真遇到过）。
pub fn digest_authorization(target: &SnapshotTarget, challenge: &DigestChallenge) -> Result<String, String> {
    digest_header(
        target.user.as_deref().unwrap_or_default(),
        target.password.as_deref().unwrap_or_default(),
        "GET",
        &target.path,
        challenge,
    )
}

/// Digest 应答的本体。HTTP 抓图与 RTSP 预览共用这一份算法，差别只在 `method` 与 `uri`：
/// RTSP 每趟请求的 URI 都是完整的 `rtsp://host:port/path`、方法也可能是 SETUP/PLAY，
/// 所以这两个入参必须由调用方给，不能从 [`SnapshotTarget`] 里抄。
/// 质询里的 realm/nonce/opaque 来自对端，一律过 [`digest_quoted`]（带换行就拒发）。
pub(crate) fn digest_header(
    user: &str,
    password: &str,
    method: &str,
    uri: &str,
    challenge: &DigestChallenge,
) -> Result<String, String> {
    let nc = "00000001";
    let cnonce = cnonce();

    let ha1 = md5_hex(format!("{user}:{}:{password}", challenge.realm).as_bytes());
    let ha2 = md5_hex(format!("{method}:{uri}").as_bytes());
    let response = match challenge.qop.as_deref() {
        Some(q) => md5_hex(format!("{ha1}:{}:{nc}:{cnonce}:{q}:{ha2}", challenge.nonce).as_bytes()),
        None => md5_hex(format!("{ha1}:{}:{ha2}", challenge.nonce).as_bytes()),
    };

    let mut parts = vec![
        format!("username={}", digest_quoted("username", user)?),
        format!("realm={}", digest_quoted("realm", &challenge.realm)?),
        format!("nonce={}", digest_quoted("nonce", &challenge.nonce)?),
        format!("uri={}", digest_quoted("uri", uri)?),
        "algorithm=MD5".to_string(),
    ];
    if let Some(q) = challenge.qop.as_deref() {
        parts.push(format!("qop={q}"));
        parts.push(format!("nc={nc}"));
        parts.push(format!("cnonce={}", digest_quoted("cnonce", &cnonce)?));
    }
    parts.push(format!("response={}", digest_quoted("response", &response)?));
    if let Some(op) = &challenge.opaque {
        parts.push(format!("opaque={}", digest_quoted("opaque", op)?));
    }
    Ok(format!("Digest {}", parts.join(", ")))
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
    build_get_request_with_auth(target, static_authorization(target).as_deref())
}

/// 与 [`build_get_request`] 同一条请求，只把 `Authorization` 那一行交给调用方：
/// Digest 要"先空认证拿 401、再带应答重发"，第二趟的头只能在往返途中才知道。
/// `authorization` 传 `None` 就是不带认证头（匿名，或 Digest 的第一趟质询）。
pub fn build_get_request_with_auth(target: &SnapshotTarget, authorization: Option<&str>) -> Vec<u8> {
    let host_header = if target.port == 80 {
        target.host.clone()
    } else {
        format!("{}:{}", target.host, target.port)
    };
    let mut lines = vec![
        format!("GET {} HTTP/1.1", target.path),
        format!("Host: {host_header}"),
    ];
    if let Some(auth) = authorization {
        lines.push(format!("Authorization: {auth}"));
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
/// `www_authenticate` 只在 Digest 那一趟用得上：401 没有它就没法应答质询。
///
/// **HTTP 与 RTSP 共用这一个解析器**：RFC 2326 §7.1 明说 RTSP 响应就是 HTTP/1.1 报文格式，
/// 分成两份只会让"哪边认 Content-Length、哪边认大小写"变成两套口径。
/// `headers` 是除上面几个已具名字段外的全部头（键小写），RTSP 的 `session:` /
/// `transport:` / `rtp-info:` 从这里取——加解析器不如加一个列表。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpHead {
    pub status: u16,
    pub reason: String,
    pub content_length: Option<usize>,
    pub content_type: Option<String>,
    pub chunked: bool,
    pub www_authenticate: Option<String>,
    /// 全部头字段（键转小写、值 trim），按出现顺序。已具名的那几个也在里面。
    pub headers: Vec<(String, String)>,
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
    if !version.starts_with("HTTP/") && !version.starts_with("RTSP/") {
        return Err(format!(
            "摄像机回的第一行不是 HTTP/RTSP 状态行（前 {} 字节：{}）",
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
        www_authenticate: None,
        headers: Vec::new(),
        body_start,
    };
    for line in lines {
        let Some((k, v)) = line.split_once(':') else { continue };
        let key = k.trim().to_ascii_lowercase();
        let value = v.trim();
        head.headers.push((key.clone(), value.to_string()));
        match key.as_str() {
            "content-length" => head.content_length = value.parse::<usize>().ok(),
            "content-type" => head.content_type = Some(value.to_string()),
            "www-authenticate" => head.www_authenticate = Some(value.to_string()),
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

/// 取一个头的值（大小写已归一）。RTSP 的 `Session: 1234;timeout=60` 这种带参数的
/// 头由调用方自己切分，这里只负责"有没有、原样是什么"。
impl HttpHead {
    pub fn header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }
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
        401 | 403 => "摄像机拒绝登录（HTTP 401/403）：核对 user 与登录密码；Digest 质询应答不过多半是口令错，Basic 不通可把认证方式改成 digest 再试".into(),
        404 => "抓图路径不存在（HTTP 404）：核对 snapshotUrl 的通道号与码流号".into(),
        408 => "摄像机自己超时（HTTP 408）：稍后再过磅，或降低主码流分辨率".into(),
        500..=599 => format!("摄像机内部错误（HTTP {status}）：多半是固件或通道配置问题"),
        other => format!("摄像机回了 HTTP {other}，不是图像数据"),
    }
}

/// 台账里静态配好的那一行 `Authorization`（Basic 才有；Digest 与匿名都是 `None`）。
/// 与 [`build_get_request`] 同源，抽出来是为了让 [`grab`] 的 Digest 两趟能复用同一套发送逻辑。
fn static_authorization(target: &SnapshotTarget) -> Option<String> {
    (target.auth == AuthKind::Basic).then(|| {
        let cred = format!(
            "{}:{}",
            target.user.clone().unwrap_or_default(),
            target.password.clone().unwrap_or_default()
        );
        format!("Basic {}", base64_standard(cred.as_bytes()))
    })
}

/// 一次完整的请求—收包：连接、发请求、按上限收完、解出响应头就返回。
/// 状态判定与 JPEG 校验留给调用方——Digest 得先看是不是 401 质询才能决定下一步。
///
/// 有界性靠三件事：连接与每次读写都带 3 秒超时、响应头上限 64 KB、
/// 整体字节上限（`max_bytes + 头部余量`）。任何一条超限就断开，绝不无界等下去。
fn exchange(target: &SnapshotTarget, authorization: Option<&str>, max_bytes: usize) -> Result<(HttpHead, Vec<u8>), String> {
    let mut stream = connect(target)?;
    let request = build_get_request_with_auth(target, authorization);
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
                                    "抓拍图有 {} KB，超过单次拉取上限 {} KB：摄像机回大了，检查主码流分辨率与质量设置",
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
    Ok((head, buf))
}

/// 200 → 取 body → JPEG 校验；非 200 一律按状态码回一句人话。
fn image_of(head: &HttpHead, buf: &[u8], max_bytes: usize) -> Result<Vec<u8>, String> {
    if head.status != 200 {
        return Err(http_status_reason(head.status));
    }
    let body = http_body(buf, head)?;
    check_jpeg(&body, max_bytes)?;
    Ok(body)
}

/// 一趟"空认证撞质询 → 带应答重发"的 GET，回**响应头 + 原始 body**（不校验图像）。
///
/// 从 [`grab`] 抽出来，是为了让海康 ISAPI 的自检探针（读 `deviceInfo` 那份 XML）走与抓拍、
/// 预览**同一条**认证通路：Digest 要两趟、Basic 一趟过、匿名直接收，判据只写一遍，
/// 免得自检认定的认证方式和真抓拍用的对不上。`auth != Digest` 或非 401 时第一趟即返回，
/// 由调用方按 `head.status` 决定下一步（抓拍看是不是 200 出图，自检看 200 收 XML、401 判口令错）。
pub(crate) fn authorized_get(target: &SnapshotTarget, max_bytes: usize) -> Result<(HttpHead, Vec<u8>), String> {
    let (head, buf) = exchange(target, static_authorization(target).as_deref(), max_bytes)?;
    if target.auth != AuthKind::Digest || head.status != 401 {
        return Ok((head, buf));
    }
    let challenge = head
        .www_authenticate
        .as_deref()
        .ok_or("摄像机回 401 却没带 WWW-Authenticate：无从应答质询，核对 user 与登录密码，或把认证方式改成 basic")?;
    let answer = digest_authorization(target, &parse_digest_challenge(challenge)?)?;
    exchange(target, Some(&answer), max_bytes)
}

/// 联网抓一张图（失败回中文短句，由调用方按 04 §4.2 降级）。
///
/// **Digest 要两趟**（04 §4.1：海康 ISAPI 只认 Digest）：认证往返收在 [`authorized_get`]，
/// 与自检探针同一套。第一趟就给 200 的固件（少数型号对抓图 CGI 直接放行）照单收下。
fn grab(target: &SnapshotTarget, max_bytes: usize) -> Result<Vec<u8>, String> {
    let (head, buf) = authorized_get(target, max_bytes)?;
    if head.status == 401 {
        return Err("摄像机拒收认证应答（HTTP 401）：多半是登录密码不对，其次 Digest 只实现 MD5、少数固件用了别的算法".into());
    }
    image_of(&head, &buf, max_bytes)
}

fn connect(target: &SnapshotTarget) -> Result<TcpStream, String> {
    let stream = connect_to(&target.host, target.port)?;
    stream
        .set_read_timeout(Some(SNAPSHOT_TIMEOUT))
        .and_then(|_| stream.set_write_timeout(Some(SNAPSHOT_TIMEOUT)))
        .map_err(|e| net_reason(&e, "设置抓图超时"))?;
    Ok(stream)
}

/// 解析 + 连接，一趟最多等 3 秒，**不设读写超时**（RTSP 预览要自己定节奏，抓拍用 [`connect`]）。
///
/// `to_socket_addrs` 对主机名走 getaddrinfo，**没有超时可言**（磅房网段常配 .local /
/// NetBIOS 名，DNS 不响应时能卡十几秒）。丢给一条一次性线程去解，主路径只等 3 秒：
/// 解不出来就降级，绝不让过磅陪着等。那条线程之后自己结束，不占任何锁与连接。
pub(crate) fn connect_to(host: &str, port: u16) -> Result<TcpStream, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let owned = host.to_string();
    std::thread::spawn(move || {
        let _ = tx.send(
            (owned.as_str(), port)
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
        .ok_or_else(|| format!("解析不到摄像机地址：{host}"))?;
    TcpStream::connect_timeout(&addr, SNAPSHOT_TIMEOUT).map_err(|e| net_reason(&e, "连接摄像机"))
}

// ------------------------------------------------------------------ JPEG 与文件名

/// JPEG 以 `FF D8 FF` 开头（SOI + 段起始）；只认这个，就别的内容一概不入库。
///
/// `max_bytes` 这一格传的是**拉取**上限（`SNAPSHOT_FETCH_MAX_BYTES`），不是落库上限：
/// 过了这道门还有 [`fit_to_budget`] 把超限的图压进 `attachment_max_kb`。所以这里拒的
/// 是"摄像机回得离谱地大"，不是"这张图太大我们不会压"。
pub fn check_jpeg(bytes: &[u8], max_bytes: usize) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("摄像机回了空包，没有图像数据".into());
    }
    if bytes.len() > max_bytes {
        return Err(format!(
            "抓拍图 {} KB 超过单次拉取上限 {} KB：摄像机回大了，检查主码流分辨率与质量设置",
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

// ------------------------------------------------------------ 抓拍压缩链路（04 §4.2）
//
// 这一节是 04 §4.2 那句「解码 → 长边限制 1600 px → JPEG 质量 80 → 若 > attachment_max_kb
// 逐级降质」的落地。它缺席了很久，代价在 2026-10-09 现场兑现过一次：主码流 2560×1440 的
// 出图正常就有 500–900 KB，而那时的代码是**超限直接拒收**，于是一张好端端的凭证图整张丢掉，
// 连续 5 次把设备压成"离线"（迁移 0031 抬上限只是把这道门先开大，门还在那儿）。
//
// 为什么不用 `image` 全家桶：那条路要为这一格捎上 png/webp/tiff 的解码门面与色彩管理，
// 而我们只需要 JPEG 进、JPEG 出。解码用零依赖的 `jpeg-decoder`，编码复用预览那条路
// 已经在用的 `jpeg-encoder`（`camera_stream.rs::to_jpeg`），缩放只有面积平均这一种——
// 与仓里"MD5/base64/XML 取标签都手写不引依赖"是同一个取向。

/// 压缩后允许的最大长边（04 §4.2）。2560×1440 缩到这里，车牌与人脸仍然认得出，
/// 字节数按面积比先降约 2.6 倍，再配合降质通常一发就进线。
pub const CAPTURE_MAX_EDGE: usize = 1600;

/// 逐级降质的阶梯（04 §4.2 的"若 > `attachment_max_kb` 逐级降质"），每项是（长边, 质量）。
/// **顺序即优先级**：先按文档那一档 1600/80，压不进才往下走。最后一档 1024/50 是
/// "再压就认不出人和车牌了"的底线——到它还压不进就拒收并降级，而不是无限压下去。
/// 最多 7 次编码。真值由 `compression_stays_inside_the_capture_time_budget` 打出来：
/// release 下 2560×1440 的 1.9 MB 图压到 494 KB 用 161 ms、8.7 MB 的最坏夹具用 208 ms
/// （阶梯第一档 1600/80 就进线了，走不满七档是常态），落在抓拍"3 秒取图 + 解析"的预算里。
const QUALITY_LADDER: [(usize, u8); 7] = [
    (CAPTURE_MAX_EDGE, 80),
    (CAPTURE_MAX_EDGE, 70),
    (CAPTURE_MAX_EDGE, 60),
    (CAPTURE_MAX_EDGE, 50),
    (CAPTURE_MAX_EDGE, 40),
    (1280, 60),
    (1024, 50),
];

/// 把一张抓拍图压进预算，返回**最终要落盘的字节**。三条口径都是取舍，改动前先读：
///
///  1. **没超限就一个字节都不动**。JPEG 重编是有损的二次量化，收粮凭证上"看得清车牌"
///     这件事不该因为走过一遍编码器而变差；而且绝大多数图本来就在线内，白烧一次 CPU。
///  2. 超限才解码 → 缩到长边 ≤[`CAPTURE_MAX_EDGE`] → 按 [`QUALITY_LADDER`] 逐级降质，
///     **第一个进线的档位就是结果**。
///  3. 解不开（截断、固件回了半个流）时**不新增失败**：图在线内照样原样入库，
///     只有超限又压不动才拒收。新增的能力读不懂一张本来能用的图，不该让它变成无抓拍。
pub fn fit_to_budget(jpeg: Vec<u8>, max_bytes: usize) -> Result<Vec<u8>, String> {
    if jpeg.len() <= max_bytes {
        return Ok(jpeg);
    }
    let over = jpeg.len();
    let Some((mut canvas, mut w, mut h)) = decode_rgb(&jpeg) else {
        return Err(format!(
            "抓拍图 {} KB 超过上限 {} KB，且这张图解不开、压不动：本轮按无抓拍处理",
            over / 1024,
            max_bytes / 1024
        ));
    };
    let mut smallest = over;
    let mut last_edge = (w, h);
    for (edge, quality) in QUALITY_LADDER {
        let target = fit_edge(w, h, edge);
        // 只在长边真的变了时重缩。阶梯后半段是从**已缩过**的那份再缩（1600→1280→1024），
        // 两次面积平均叠一次 1.25×/1.56× 的缩小，损失远小于同档 JPEG 量化本身，
        // 换来的是不必从原图反复扫 370 万像素。
        if target != (w, h) {
            canvas = shrink_area(&canvas, w, h, target.0, target.1);
            w = target.0;
            h = target.1;
        }
        last_edge = (w, h);
        let out = encode_rgb(&canvas, w, h, quality)?;
        smallest = smallest.min(out.len());
        if out.len() <= max_bytes {
            return Ok(out);
        }
    }
    Err(format!(
        "抓拍图 {} KB 超过上限 {} KB：已逐级压到 {}×{} 仍剩 {} KB，本轮按无抓拍处理——要么到「基础档案 › 站点参数」调大上限，要么到摄像机侧调低主码流分辨率与质量",
        over / 1024,
        max_bytes / 1024,
        last_edge.0,
        last_edge.1,
        smallest / 1024
    ))
}

/// 解码后允许占的字节数上限（**解压炸弹的闸门**）。JPEG 的 `Content-Length` 只有几 MB，
/// 声明的像素尺寸却是它自己说了算——不设这道门，一张 8 MB 的"20000×20000"就能让磅房机
/// 当场申请 1.2 GB。64 MB 够到 4K RGB（3840×2160×3 ≈ 25 MB）还有余量；
/// 真出到 8K 的抓拍机不在本系统的现场清单里，那种图会被判"解不开、压不动"而优雅降级。
const MAX_DECODED_BYTES: usize = 64 * 1024 * 1024;

/// 解一张 JPEG 成 RGB24 + 宽高。灰度复制成三通道（编码器只吃 RGB）；16 位灰度与 CMYK
/// 这类摄像机不会出的形状按"解不动"处理。回 `None` 不带原因——原因由 [`fit_to_budget`]
/// 那句统一说，这里再拼只会把 `last_error` 撑长（它只留 200 字）。
fn decode_rgb(bytes: &[u8]) -> Option<(Vec<u8>, usize, usize)> {
    let mut d = jpeg_decoder::Decoder::new(bytes);
    d.set_max_decoding_buffer_size(MAX_DECODED_BYTES);
    let pixels = d.decode().ok()?;
    let info = d.info()?;
    let (w, h) = (usize::from(info.width), usize::from(info.height));
    if w == 0 || h == 0 {
        return None;
    }
    match info.pixel_format {
        // 尺寸与像素数对不上（解码器与我们的理解有一边错了）宁可不压，别拿半张图去编码
        jpeg_decoder::PixelFormat::RGB24 if pixels.len() == w * h * 3 => Some((pixels, w, h)),
        jpeg_decoder::PixelFormat::L8 if pixels.len() == w * h => {
            let mut rgb = Vec::with_capacity(w * h * 3);
            for g in pixels {
                rgb.extend_from_slice(&[g, g, g]);
            }
            Some((rgb, w, h))
        }
        _ => None,
    }
}

/// RGB24 → JPEG。`jpeg-encoder` 的宽高是 `u16`，4K 以内够用，超出就明说而不是截断。
fn encode_rgb(rgb: &[u8], w: usize, h: usize, quality: u8) -> Result<Vec<u8>, String> {
    let (Ok(w), Ok(h)) = (u16::try_from(w), u16::try_from(h)) else {
        return Err(format!("抓拍图 {w}×{h} 超出 JPEG 编码支持范围，本轮按无抓拍处理"));
    };
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality)
        .encode(rgb, w, h, jpeg_encoder::ColorType::Rgb)
        .map_err(|e| format!("压缩抓拍图失败：{e}"))?;
    Ok(out)
}

/// 长边缩到 `edge` 以内的目标尺寸；已经在线内就原样返回——**绝不放大**，
/// 放大既不省字节也不多信息。
fn fit_edge(w: usize, h: usize, edge: usize) -> (usize, usize) {
    let long = w.max(h);
    if long <= edge || long == 0 {
        return (w, h);
    }
    let scale = edge as f64 / long as f64;
    (
        ((w as f64 * scale).round() as usize).max(1),
        ((h as f64 * scale).round() as usize).max(1),
    )
}

/// 面积平均（box filter）缩小。每个输出像素覆盖源图 `[ox·w/tw, (ox+1)·w/tw) ×
/// [oy·h/th, (oy+1)·h/th)` 这一块，按与源像素的**重叠面积**加权平均，权重每格归一。
/// 1.6× 这种非整数比例靠分数权重抹平，nearest 那种抽行抽列的锯齿不会出现在凭证图上。
/// 只做缩小（调用方 [`fit_edge`] 已经保证目标不大于源）。
fn shrink_area(rgb: &[u8], w: usize, h: usize, tw: usize, th: usize) -> Vec<u8> {
    let cols = cover(w, tw);
    let rows = cover(h, th);
    let mut out = vec![0u8; tw * th * 3];
    for (oy, ys) in rows.iter().enumerate() {
        for (ox, xs) in cols.iter().enumerate() {
            let mut acc = [0f32; 3];
            for (iy, wy) in ys {
                for (ix, wx) in xs {
                    let wgt = wy * wx;
                    let p = (iy * w + ix) * 3;
                    acc[0] += f32::from(rgb[p]) * wgt;
                    acc[1] += f32::from(rgb[p + 1]) * wgt;
                    acc[2] += f32::from(rgb[p + 2]) * wgt;
                }
            }
            let o = (oy * tw + ox) * 3;
            for c in 0..3 {
                out[o + c] = acc[c].round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

/// 每个输出格覆盖的 `(源索引, 权重)` 表。输出格 `o` 覆盖源区间 `[o·s, (o+1)·s)`，
/// 与源像素 `i`（覆盖 `[i, i+1)`）的权重就是重叠长度 ÷ 区间长度；边界那两格因为
/// 区间被裁短，归一后仍然和为 1，不会在图边上留暗线。
fn cover(n_src: usize, n_dst: usize) -> Vec<Vec<(usize, f32)>> {
    let s = n_src as f32 / n_dst as f32;
    (0..n_dst)
        .map(|o| {
            let a = o as f32 * s;
            let b = ((o + 1) as f32 * s).min(n_src as f32);
            let span = (b - a).max(f32::EPSILON);
            let i0 = a.floor() as usize;
            let i1 = (b.ceil() as usize).min(n_src.saturating_sub(1));
            (i0..=i1)
                .map(|i| {
                    let overlap = (b.min((i + 1) as f32) - a.max(i as f32)).max(0.0);
                    (i, overlap / span)
                })
                .filter(|(_, wt)| *wt > 0.0)
                .collect()
        })
        .collect()
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

    let store_max = max_snapshot_bytes(conn);
    let fail = |conn: &Connection, reason: String| -> Result<Option<i64>, String> {
        note_fail(conn, id, &reason);
        degrade(&reason)?;
        Ok(None)
    };
    // 先按编码长度拒收再解码：把几十 MB 的 base64 拖进内存再判超限是白给的攻击面。
    // 这一格量的是**拉取**（`SNAPSHOT_FETCH_MAX_BYTES`），不是落库上限——超限的图
    // 下面还有 [`fit_to_budget`] 那一跳可以压进去，本机这路没有（前端 canvas 已经
    // 长边 ≤1600、质量 0.85 压过一遍，出到 8 MB 只可能是帧被截错或改了码）。
    if photo_b64.len() > SNAPSHOT_FETCH_MAX_BYTES / 3 * 4 + HEAD_SLACK {
        return fail(
            conn,
            format!(
                "回传帧过大（base64 约 {} KB，单次拉取上限 {} KB）：本轮按无抓拍处理",
                photo_b64.len() / 1024 * 3 / 4,
                SNAPSHOT_FETCH_MAX_BYTES / 1024
            ),
        );
    }
    let jpeg = match base64_decode(photo_b64) {
        Some(bytes) => bytes,
        None => return fail(conn, "回传帧不是合法的 base64（疑似被截断或改码）：本轮按无抓拍处理".into()),
    };
    if let Err(e) = check_jpeg(&jpeg, SNAPSHOT_FETCH_MAX_BYTES) {
        return fail(conn, format!("回传帧校验失败：{e}"));
    }
    // 与 IP 那一路同一条压缩链路（04 §4.2）：本机帧通常已经在前端压过、一发就原样通过，
    // 但"通常"不是契约——有人改了 canvas 参数或换了 WebView2 版本，这里就是兜底。
    let jpeg = match fit_to_budget(jpeg, store_max) {
        Ok(bytes) => bytes,
        Err(reason) => return fail(conn, reason),
    };
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
///
/// 时刻格式两套并行，别混：`last_ok_at`/`last_err_at` 是设备卡上**原样渲染**的那一句
/// （`DevicesPage.tsx` 那句「最后成功 …」），走 [`crate::devices::now_display`]；
/// `updated_at` 是全库统一的 ISO 留痕，走 `now_iso()`。这里曾经两个都用 `now_iso()`，
/// 于是抓拍过的相机那一格显示成 `2026-10-09T15:11:08.592+08:00`，而同一页其它设备
/// 是 `2026-10-09 17:57:55`——`devices_contract` 只钉了联机回写那条路，抓拍这条路没人守。
fn note_ok(conn: &Connection, device_id: i64) {
    let _ = conn.execute(
        "UPDATE device_config SET last_status = 'online', last_ok_at = ?1, last_err_at = NULL,
                last_error = NULL, err_count = 0, updated_at = ?2
         WHERE id = ?3",
        params![
            crate::devices::now_display(),
            crate::db::migrate::now_iso(),
            device_id
        ],
    );
}

fn note_fail(conn: &Connection, device_id: i64, reason: &str) {
    let _ = conn.execute(
        "UPDATE device_config SET last_status = CASE WHEN err_count + 1 >= 5 THEN 'offline' ELSE 'error' END,
                last_err_at = ?1, last_error = ?2, err_count = err_count + 1, updated_at = ?3
         WHERE id = ?4",
        params![
            crate::devices::now_display(),
            clip(reason, 200),
            crate::db::migrate::now_iso(),
            device_id
        ],
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
/// 本函数**会阻塞**（最长 3 秒 + 解析 3 秒；图超限还要走压缩链路，release 实测最坏 0.2 秒——
/// 阶梯封顶 7 次编码，见 [`QUALITY_LADDER`] 与 04 §4.2，没超限的图一个字节都不动、不花这一笔）。
/// 副作用只有两处：写一行 `attachment`，
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

    // 拉取按硬顶、落库按上限，两件事两个数（见 `SNAPSHOT_FETCH_MAX_BYTES` 那一段）。
    let jpeg = match grab(&target, SNAPSHOT_FETCH_MAX_BYTES) {
        Ok(bytes) => bytes,
        Err(reason) => {
            note_fail(conn, id, &reason);
            degrade(&reason)?;
            return Ok(None);
        }
    };
    // 04 §4.2 的压缩链路：主码流 2560×1440 出图 500–900 KB 是常态，超限不再整张丢弃，
    // 而是缩到长边 ≤1600 逐级降质后入库。压完还是超限才会走到这个降级分支。
    let jpeg = match fit_to_budget(jpeg, max_snapshot_bytes(conn)) {
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
///
/// `pub` 只为契约测试能钉住「种子默认与 `DEFAULT_MAX_KB` 是同一个数」——
/// 这两处一份改漏另一处，缺键的库就会悄悄用回旧上限，而参数页上写着新值。
pub fn max_snapshot_bytes(conn: &Connection) -> usize {
    let kb = crate::orders::setting_int(conn, "attachment_max_kb", DEFAULT_MAX_KB);
    let kb = if (32..=20480).contains(&kb) { kb } else { DEFAULT_MAX_KB };
    kb as usize * 1024
}

// ------------------------------------------------- 工作台实时画面（RTSP 拉流，不落库）

/// 预览一行的台账读出的东西：一条**已校验**的端点 + 原始配置 JSON。
///
/// 为什么两个都给：host / 端口 / 路径 / 口令 / 认证方式这五件事的裁决权在
/// [`preview_target_from_config`]，RTSP 侧不能自己再拼一遍（拼出来就是第二条校验口径，
/// 迟早一条通过一条不通过）；但 `rtspUrl` / `rtspPort` 这两个只有预览认的键，
/// 又必须从配置里读，所以把 JSON 一起带回，让 `camera_stream` 只读这两个键。
pub(crate) struct LiveRow {
    pub target: SnapshotTarget,
    pub config_json: String,
}

/// 该不该去拉这一路的流，以及向哪儿拉。判据与抓拍、联机测试同源：Mock 档、已停用、
/// 本机 USB 机这三条**绝不能**去开 RTSP（本机机的画面在 WebView2 里，服务端去连只会
/// 拿一句"未配置 host"，把一台好机器报成故障）。
///
/// 失败一律 `Err(中文短句)`，由画面那一格显示在自己框里（04 §4.2 的失败降级）：
/// 摄像机掉线不弹框、更不打断称重。
pub(crate) fn live_preview_row(conn: &Connection, code: &str) -> Result<LiveRow, String> {
    let row = conn
        .query_row(
            "SELECT id, name, code, config_json, secret_json, is_mock, is_enabled
             FROM device_config WHERE code = ?1 AND kind = 'camera'",
            params![code],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| format!("读取摄像机配置失败：{e}"))?;
    let Some((id, name, code, config_json, secret_json, is_mock, is_enabled)) = row else {
        return Err(format!("台账里没有编码为「{code}」的摄像机（或它不是 camera 类型）"));
    };
    if is_mock == 1 {
        return Err(format!("摄像机「{name}」当前是 Mock 模拟档，不出真画面：到设备中心切回真实设备"));
    }
    if is_enabled == 0 {
        return Err(format!("摄像机「{name}」已停用：先在设备中心启用再看画面"));
    }
    if is_local_camera(&config_json) {
        return Err(format!("摄像机「{name}」是本机 USB 摄像头，画面由工作台直接开流显示，不走这条取帧通道"));
    }
    let target = preview_target_from_config(id, &code, &config_json, secret_json.as_deref())?;
    Ok(LiveRow { target, config_json })
}

/// 预览端点＝抓拍端点，只把路径换成 `previewUrl`（海康的子码流）。没填就照旧用
/// `snapshotUrl`。预览这条通道现在走 RTSP 拉流（见 `camera_stream.rs`），一台机一条
/// 会话、一秒十来帧全在子码流上跑——子码流是 768×432 量级，主码流是 2560×1440，
/// 拿主码流做常驻画面会把磅房那条网线和摄像机连接数吃满，所以预览必须能单独指路径。
/// host / 端口 / 口令 / 认证方式仍由 [`target_from_config`] 一处裁决，
/// 设备中心改一次两条通道同时生效。
pub fn preview_target_from_config(
    device_id: i64,
    device_code: &str,
    config_json: &str,
    secret_json: Option<&str>,
) -> Result<SnapshotTarget, String> {
    let mut cfg: serde_json::Value = match serde_json::from_str(config_json) {
        Ok(v) => v,
        // 坏 JSON 交给 target_from_config 说那句"配置不是合法 JSON"，这里不造第二种说法
        Err(_) => return target_from_config(device_id, device_code, config_json, secret_json),
    };
    let preview = ["previewUrl", "preview_url"]
        .iter()
        .filter_map(|k| cfg.get(*k))
        .find_map(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let (Some(p), Some(obj)) = (preview, cfg.as_object_mut()) {
        obj.insert("snapshotUrl".to_string(), serde_json::Value::String(p));
    }
    let rewritten = serde_json::to_string(&cfg).unwrap_or_else(|_| config_json.to_string());
    target_from_config(device_id, device_code, &rewritten, secret_json)
}

/// 设备中心「联机测试」的一探：走的就是抓拍那条 `grab` + `fit_to_budget`，只取图不落库。
/// 测过＝这台机此刻出得来图**而且压得进落库上限**（同一端点、同一套认证、同一条压缩链路），
/// 测不过把原因原样回给人看。只测"拉得回来"是不够的——拉回来压不进照样无抓拍，
/// 那一格在设备中心上就该是红的。
///
/// `max_bytes` 传的是**落库**上限（`attachment_max_kb`）；拉取按 `SNAPSHOT_FETCH_MAX_BYTES`。
/// 回显里的耗时含压缩，这是诚实的数：现场要看的本来就是"这一趟总共让磅队等了多久"。
pub fn probe_snapshot(target: &SnapshotTarget, max_bytes: usize) -> (bool, String) {
    let started = Instant::now();
    let verdict = grab(target, SNAPSHOT_FETCH_MAX_BYTES).and_then(|raw| {
        let pulled = raw.len();
        fit_to_budget(raw, max_bytes).map(|kept| (pulled, kept.len()))
    });
    match verdict {
        Ok((pulled, kept)) => (
            true,
            format!(
                "已抓到一帧 JPEG：{} KB{} · {} ms（{}:{}{}）",
                pulled / 1024,
                if kept == pulled {
                    "，未超限原样入库".to_string()
                } else {
                    format!("，压到 {} KB 入库", kept / 1024)
                },
                started.elapsed().as_millis(),
                target.host,
                target.port,
                target.path
            ),
        ),
        Err(reason) => (false, format!("{}（等了 {} ms）", reason, started.elapsed().as_millis())),
    }
}

// ------------------------------------------------- 内网摄像机自动检测（海康 ISAPI）
//
// 设备中心「添加海康相机」只让现场填 IP + 登录用户 + 口令，剩下的 HTTP 端口、认证方式
// （digest/basic/匿名）、抓拍/预览路径、RTSP 地址与端口全部由这里探出来。判据与抓拍、
// 预览同源（同一 `authorized_get`），所以自检认定的认证方式就是真抓拍要用的那一种。
// 探不到绝不编一组默认值糊上去——「登记 ≠ 验证」这条（02 §M9）在这里同样成立：
// 连不上、口令错都回中文短句，让界面停在「未检测」，而不是假装配好了。

/// deviceInfo 那份 XML 很小，给 1 MB 足够；抓拍整图另用一条上限探测。
const DETECT_BODY_MAX: usize = 1024 * 1024;
/// 自检探测抓拍图的上限：只为确认「这条路出得来图」，不入库，按拉取硬顶兜住异常大包。
/// 与抓拍同数不是巧合——探测判"出得来"所用的量必须与真抓拍拉图的那一条一致，
/// 否则会出现"自检绿了、过磅拒收"这种没法归因的分叉。
const DETECT_SNAP_MAX: usize = SNAPSHOT_FETCH_MAX_BYTES;
/// 海康 ISAPI 常见的两个 HTTP 端口：80 是标准 web/ISAPI 口，8000 是海康私有 http 口。
const HTTP_PORT_CANDIDATES: [u16; 2] = [80, 8000];
/// RTSP 常见端口：554 标准，8000 是海康在某些机型上把 RTSP 也放这个口的情况。
const RTSP_PORT_CANDIDATES: [u16; 2] = [554, 8000];

/// 探测到的完整配置 + 一句给人看的结论。`config` 的键与 [`target_from_config`] /
/// `camera_stream.rs` 读的键逐字对齐，落进台账 `config_json` 后两条通道直接可用。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraDetect {
    pub config: std::collections::BTreeMap<String, String>,
    pub message: String,
}

/// 现场常把浏览器地址栏整条粘进来，也可能只填 IP。这里统一收敛成裸主机名（去掉协议、
/// 路径、尾部斜杠），端口若写在 `host:port` 里且没另给 `explicit_port`，就顺带取出来。
pub fn normalize_host(raw: &str, explicit_port: Option<u16>) -> Result<(String, Option<u16>), String> {
    let s = raw.trim();
    let s = s.strip_prefix("http://").or_else(|| s.strip_prefix("HTTP://")).unwrap_or(s);
    let s = s.trim_end_matches('/');
    // 去掉可能粘进来的路径段（第一个 '/' 之后都不是 host）
    let authority = s.split('/').next().unwrap_or(s);
    if authority.is_empty() {
        return Err("地址为空：填摄像机的 IP，如 192.168.10.64".into());
    }
    let (host, port_from_host) = match authority.rsplit_once(':') {
        Some((h, p))
            if !h.is_empty()
                && !p.is_empty()
                && authority.matches(':').count() == 1
                && p.chars().all(|c| c.is_ascii_digit()) =>
        {
            (h.to_string(), Some(p.to_string()))
        }
        _ => (authority.to_string(), None),
    };
    let port = match (explicit_port, port_from_host) {
        (Some(p), _) => Some(p),
        (None, Some(p)) => p.parse::<u16>().ok(),
        (None, None) => None,
    };
    if !host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        || host.starts_with('-')
        || host.ends_with('-')
        || host.contains("..")
    {
        return Err(format!("「{host}」不是合法的 IP 或主机名"));
    }
    Ok((host, port))
}

/// 认证方式候选：现场不勾，全凭摄像机自己回的 `WWW-Authenticate` 决定。
/// 海康 ISAPI 默认 Digest，少数固件或被改过配置的走 Basic。
pub fn auth_from_www_authenticate(header: Option<&str>) -> AuthKind {
    match header.map(|h| h.to_ascii_lowercase()) {
        Some(h) if h.contains("digest") => AuthKind::Digest,
        Some(h) if h.contains("basic") => AuthKind::Basic,
        _ => AuthKind::None,
    }
}

/// 从 XML 里取第一个 `<tag>…</tag>` 的文本（deviceInfo 的 `<model>` / `<serialNumber>` 够用）。
/// 不引 XML 库：这几个标签都是单行纯文本，扫一对尖括号即可；找不到就 `None`，探测降级不致命。
pub fn xml_first_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}");
    let mut from = 0usize;
    // 找第一个「确实是这个标签」的开标签：`<model` 不能命中 `<modelVersion>`，
    // 所以紧跟其后的字符必须是 '>' 或空白，否则跳过这次命中继续往后找。
    loop {
        let i = xml[from..].find(&open).map(|p| from + p)?;
        let after_open = &xml[i + open.len()..];
        let next = after_open.chars().next()?;
        if !(next == '>' || next.is_whitespace()) {
            from = i + open.len();
            continue;
        }
        let gt = after_open.find('>')?;
        let body = &after_open[gt + 1..];
        let close = body.find(&format!("</{tag}>"))?;
        let text = body[..close].trim();
        return (!text.is_empty()).then(|| text.to_string());
    }
}

/// 一次海康探测用到的端点。deviceInfo 与抓拍共用 host/user/password，只差 path 与认证。
fn detect_target(host: &str, port: u16, path: &str, user: Option<&str>, password: Option<&str>, auth: AuthKind) -> SnapshotTarget {
    SnapshotTarget {
        device_id: 0,
        device_code: String::new(),
        host: host.to_string(),
        port,
        path: path.to_string(),
        user: user.map(|s| s.to_string()),
        password: password.map(|s| s.to_string()),
        auth,
    }
}

/// 用**已经学到的那份质询**直接签一条 `Authorization` 头，省掉"先空手撞 401 再应答"那一趟。
///  - `None` 认证 → 不带；
///  - Basic → 台账口令 base64（无需质询）；
///  - Digest → 按本请求自己的 method+URI 现签（URI 变了必须重签，否则海康当场 401），
///    但复用同一 nonce/opaque——这正是"探测多端点却只吃一次 401"的关键。
/// 缺质询又要 Digest 时明确报错，绝不退回空手撞（那等于把失败次数又交回给摄像机决定）。
fn build_auth_header(target: &SnapshotTarget, challenge: Option<&DigestChallenge>) -> Result<Option<String>, String> {
    match target.auth {
        AuthKind::None => Ok(None),
        AuthKind::Basic => Ok(static_authorization(target)),
        AuthKind::Digest => {
            let ch = challenge.ok_or_else(|| "Digest 认证缺少质询，无法预先签应答".to_string())?;
            Ok(Some(digest_authorization(target, ch)?))
        }
    }
}

/// TCP 探一下端口通不通（RTSP 口不做完整握手，只确认能连上）。带超时，别把添加表单卡死。
fn tcp_open(host: &str, port: u16) -> bool {
    match connect_to(host, port) {
        Ok(_) => true,
        Err(_) => false,
    }
}

/// 探测海康 ISAPI：先摸 HTTP 口与认证方式，验口令，确认主码流出得来图，再定 RTSP 口。
/// 任一步探不出来就回 `Err(中文短句)`，界面据此停在「未检测」。
pub fn detect_hikvision(raw_host: &str, port: Option<u16>, user: Option<&str>, password: Option<&str>) -> Result<CameraDetect, String> {
    let (host, host_port) = normalize_host(raw_host, port)?;
    let port = host_port.or(port);
    let user = user.map(str::trim).filter(|s| !s.is_empty());
    let password = password.map(|s| s.to_string()).filter(|s| !s.is_empty());
    let http_ports: Vec<u16> = match port {
        Some(p) => vec![p],
        None => HTTP_PORT_CANDIDATES.to_vec(),
    };

    let mut unreachable: Vec<String> = Vec::new();
    for p in http_ports {
        // 唯一一次"故意吃 401"就在这：匿名探 deviceInfo，只为认出认证方式并拿到 Digest 质询。
        // 后面所有带口令的请求都用这份质询**预先签好应答**直接发，不再空手撞一次——
        // 海康把每一次 401 都计进"登录失败次数"（默认约 7 次锁 30 分钟），一趟探测多撞的
        // 那几下（deviceInfo 再来一次、抓拍再来一次）叠上反复点「联机测试」，就足以把好账号锁死。
        let anon = detect_target(&host, p, "/ISAPI/System/deviceInfo", None, None, AuthKind::None);
        let (head, body) = match exchange(&anon, None, DETECT_BODY_MAX) {
            Ok(v) => v,
            Err(e) => {
                unreachable.push(format!("{host}:{p} —— {e}"));
                continue;
            }
        };
        let (auth, challenge) = match head.status {
            200 => (AuthKind::None, None),
            401 => {
                let raw = head.www_authenticate.as_deref().ok_or(format!(
                    "{host}:{p} 回 401 却没带 WWW-Authenticate：无从应答质询，核对地址与端口"
                ))?;
                let kind = auth_from_www_authenticate(Some(raw));
                let ch = if kind == AuthKind::Digest { Some(parse_digest_challenge(raw)?) } else { None };
                (kind, ch)
            }
            other => {
                unreachable.push(format!("{host}:{p} —— {}", http_status_reason(other)));
                continue;
            }
        };
        // 带口令验一次 deviceInfo（直接签好应答）：这次仍 401/403 就是口令/权限错，
        // **立刻判死**——不换端口重试、也不去试抓拍，免得把失败次数继续往上堆。
        let xml = if auth == AuthKind::None {
            String::from_utf8_lossy(&http_body_from(&head, &body)).to_string()
        } else {
            let authed = detect_target(&host, p, "/ISAPI/System/deviceInfo", user, password.as_deref(), auth);
            let header = build_auth_header(&authed, challenge.as_ref())?;
            let (h2, b2) = exchange(&authed, header.as_deref(), DETECT_BODY_MAX)?;
            match h2.status {
                200 => String::from_utf8_lossy(&http_body_from(&h2, &b2)).to_string(),
                401 | 403 => {
                    return Err(format!(
                        "{host}:{p} 能连上但拒绝登录：核对「登录用户」与「登录密码」（海康默认用户多为 admin）；账号若已被锁定，请等待锁定期或到相机网页端解锁"
                    ))
                }
                other => return Err(http_status_reason(other)),
            }
        };
        let model = xml_first_tag(&xml, "model");

        // 主码流整图：这是过磅抓拍真正要的端点，探它=确认「这条路出得来图」。通道号默认 1（101）。
        // 复用同一份质询按新 URI 现签应答，海康接受同一 nonce 覆盖多个请求，不再多撞一次 401。
        let snap_path = "/ISAPI/Streaming/channels/101/picture";
        let snap = detect_target(&host, p, snap_path, user, password.as_deref(), auth);
        let snap_header = build_auth_header(&snap, challenge.as_ref())?;
        let (head_snap, _) = exchange(&snap, snap_header.as_deref(), DETECT_SNAP_MAX)
            .map_err(|e| format!("{host}:{p} 抓图探测失败：{e}"))?;
        if head_snap.status == 401 || head_snap.status == 403 {
            return Err(format!("{host}:{p} 抓图被拒（HTTP {}）：口令或该账号的预览权限不对", head_snap.status));
        }
        if head_snap.status != 200 {
            return Err(format!(
                "{host}:{p} 已登录但主码流抓图回 {}：核对通道号（海康主码流是 channels/101）",
                head_snap.status
            ));
        }

        // RTSP：连得来的那个口；都连不上回退 554，并在结论里点一句"实时画面待联机测试确认"
        let rtsp_port = RTSP_PORT_CANDIDATES.into_iter().find(|rp| tcp_open(&host, *rp)).unwrap_or(RTSP_DEFAULT_PORT_HINT);
        let rtsp_reachable = RTSP_PORT_CANDIDATES.contains(&rtsp_port);

        let auth_name = match auth {
            AuthKind::Digest => "digest",
            AuthKind::Basic => "basic",
            AuthKind::None => "none",
        };
        let mut config = std::collections::BTreeMap::new();
        config.insert("host".to_string(), host.clone());
        config.insert("port".to_string(), p.to_string());
        config.insert("snapshotUrl".to_string(), snap_path.to_string());
        config.insert("previewUrl".to_string(), "/ISAPI/Streaming/channels/102/picture".to_string());
        config.insert("rtspUrl".to_string(), "/Streaming/Channels/102".to_string());
        config.insert("rtspPort".to_string(), rtsp_port.to_string());
        config.insert("auth".to_string(), auth_name.to_string());
        if let Some(u) = user {
            config.insert("user".to_string(), u.to_string());
        }
        if let Some(pwd) = password.as_deref() {
            config.insert("password".to_string(), pwd.to_string());
        }

        let mut message = format!(
            "海康{}：{host}:{p} 认证 {auth_name} · 抓拍 101 / 预览 102 · RTSP {rtsp_port}",
            model.map(|m| format!(" · 型号 {m}")).unwrap_or_default()
        );
        if !rtsp_reachable {
            message.push_str("（RTSP 端口未探到，实时画面需联机测试再确认）");
        }
        return Ok(CameraDetect { config, message });
    }
    Err(format!(
        "连不上海康摄像机：{}",
        if unreachable.is_empty() {
            format!("{host} 未响应，检查 IP、网线与电源")
        } else {
            unreachable.join("；")
        }
    ))
}

/// RTSP 探测失败时的兜底端口（与 `camera_stream.rs` 的默认口径一致）。
const RTSP_DEFAULT_PORT_HINT: u16 = 554;

/// `http_body` 的取 body 简化版：探测只吃 deviceInfo 这种带 Content-Length 的小 XML，
/// 不复制 chunked/截断判定那一整套（那些是抓拍入库的路径，这里不入库）。
fn http_body_from(head: &HttpHead, raw: &[u8]) -> Vec<u8> {
    let rest = raw.get(head.body_start..).unwrap_or_default();
    match head.content_length {
        Some(n) => rest[..n.min(rest.len())].to_vec(),
        None => rest.to_vec(),
    }
}

/// 探测本机之外的海康摄像机：只吃 IP + 用户 + 口令，其余自动判定。命令层丢给一次性线程，
/// 一次探测最多几秒（每端口连接 3 秒超时 + Digest 两趟），别占住 async 工作线程。
#[command]
pub async fn camera_detect(
    host: String,
    port: Option<u16>,
    user: Option<String>,
    password: Option<String>,
) -> Result<CameraDetect, String> {
    let host = host.trim().to_string();
    let user = user.filter(|s| !s.trim().is_empty());
    let password = password.filter(|s| !s.is_empty());
    if host.is_empty() {
        return Err("先填摄像机的 IP 地址".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        detect_hikvision(&host, port, user.as_deref(), password.as_deref())
    })
    .await
    .map_err(|e| format!("摄像机检测任务失败：{e}"))?
}

// ------------------------------------------------------------------- 错误话术
// 三条通道各一个：网络、磁盘、数据库。共同点是**绝不带文件路径**（附件里是农户人像）。
// RTSP 预览（`camera_stream.rs`）复用 `net_reason`：同一类网络故障不该有两套说法。

pub(crate) fn net_reason(e: &Error, what: &str) -> String {
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
