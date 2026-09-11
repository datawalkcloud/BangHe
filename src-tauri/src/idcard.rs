//! 身份证 / IC 卡读卡器的 Tauri 命令层（精伦 Routon iDR 系列，走 `routon-idr` 封装）。
//!
//! 与 `printer.rs` 同一套硬性约定：
//! 1. 所有设备访问都跑在 `spawn_blocking` 上——寻卡/读卡可能阻塞数百毫秒到数秒，
//!    绝不能占住 IPC/异步运行时线程把窗口卡住；
//! 2. 返回里带 `ok` 与人类可读的 `error`，前端才能说清"为什么没读到"；
//! 3. 读卡失败**不 panic**，只回 `ok=false` + 原因。
//!
//! 架构：BangHe 是 64 位应用，加载 `resources/sdtapi/` 下的 **64 位** Sdtapi.dll，in-process 直调。
//! 设备是**进程内单实例且非线程安全**，用 `DEV_LOCK` 串行化，避免并发打开互相打架。

use std::path::PathBuf;
use std::sync::Mutex;

use routon_idr::{port, KeyType, Sdt, Session};
use serde::Serialize;
use tauri::{command, AppHandle, Manager};

/// 全局串行化：同一时刻只允许一个读卡操作占用设备。
static DEV_LOCK: Mutex<()> = Mutex::new(());

/// 运行时定位 Sdtapi.dll：环境变量 → exe 目录 → 打包资源目录 → dev 工作目录。
/// 依赖 DLL（Dewlt/SavePhoto）与 Sdtapi.dll 同目录，由封装的
/// LOAD_WITH_ALTERED_SEARCH_PATH 一并解析。
fn locate_dll(app: &AppHandle) -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("SDTAPI_DLL") {
        if !p.is_empty() {
            cands.push(PathBuf::from(p));
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            cands.push(dir.join("Sdtapi.dll"));
            cands.push(dir.join("resources").join("sdtapi").join("Sdtapi.dll"));
            cands.push(dir.join("sdtapi").join("Sdtapi.dll"));
        }
    }
    if let Ok(rd) = app.path().resource_dir() {
        cands.push(rd.join("sdtapi").join("Sdtapi.dll"));
        cands.push(rd.join("resources").join("sdtapi").join("Sdtapi.dll"));
        cands.push(rd.join("Sdtapi.dll"));
    }
    // tauri dev 的工作目录是 src-tauri/
    cands.push(PathBuf::from("resources/sdtapi/Sdtapi.dll"));
    cands.into_iter().find(|p| p.exists())
}

/// 打开设备会话：优先免驱 USB-HID 时序，失败退回常规端口。
/// 调用方需已持有 `DEV_LOCK`；返回的 `Session` 借用 `sdt`，二者须在同一作用域内
/// 按“先 sdt 后 session”的顺序声明（session 先于 sdt 析构）。
fn open_session<'a>(sdt: &'a Sdt) -> Result<Session<'a>, String> {
    sdt.open_driverfree(port::DRIVER_FREE_HID, false)
        .or_else(|_| sdt.open_any(&[port::USB_HID, port::AUTO, 1, 2]))
        .map_err(|e| format!("打开读卡器失败: {e}"))
}

/// 读卡器连接状态（设备中心状态灯用）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReaderStatus {
    pub connected: bool,
    /// 安全模块 SAM 序列号
    pub sam_id: Option<String>,
    /// 是否支持指纹读取
    pub fingerprint: bool,
    pub error: Option<String>,
}

#[command]
pub async fn idcard_status(app: AppHandle) -> Result<ReaderStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = DEV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dll = match locate_dll(&app) {
            Some(d) => d,
            None => {
                return Ok(ReaderStatus {
                    connected: false,
                    sam_id: None,
                    fingerprint: false,
                    error: Some("未找到 Sdtapi.dll（请确认已随包安装读卡器运行库）".into()),
                })
            }
        };
        match Sdt::load(&dll).map_err(|e| e.to_string()).and_then(|sdt| {
            open_session(&sdt).map(|session| {
                (
                    session.sam_id().ok(),
                    session.is_fingerprint_device(),
                )
            })
        }) {
            Ok((sam_id, fingerprint)) => Ok(ReaderStatus {
                connected: true,
                sam_id,
                fingerprint,
                error: None,
            }),
            Err(e) => Ok(ReaderStatus {
                connected: false,
                sam_id: None,
                fingerprint: false,
                error: Some(e),
            }),
        }
    })
    .await
    .map_err(|e| format!("状态查询任务失败: {e}"))?
}

/// 一张身份证的结构化信息 + 可选照片路径。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdCardInfo {
    pub ok: bool,
    pub name: String,
    pub gender: String,
    pub nation: String,
    pub birth: String,
    pub id_number: String,
    pub address: String,
    pub agency: String,
    pub valid_from: String,
    pub valid_to: String,
    pub photo_path: Option<String>,
    pub error: Option<String>,
}

impl IdCardInfo {
    fn failed(err: String) -> Self {
        Self {
            ok: false,
            name: String::new(),
            gender: String::new(),
            nation: String::new(),
            birth: String::new(),
            id_number: String::new(),
            address: String::new(),
            agency: String::new(),
            valid_from: String::new(),
            valid_to: String::new(),
            photo_path: None,
            error: Some(err),
        }
    }
}

/// 读身份证。`with_photo=true` 时把照片写到应用缓存目录并回传路径。
/// 免驱版需先 `authenticate()` 触发射频再读，这里重试若干次。
#[command]
pub async fn idcard_read(app: AppHandle, with_photo: Option<bool>) -> Result<IdCardInfo, String> {
    let want_photo = with_photo.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = DEV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dll = match locate_dll(&app) {
            Some(d) => d,
            None => return Ok(IdCardInfo::failed("未找到 Sdtapi.dll".into())),
        };
        let sdt = match Sdt::load(&dll) {
            Ok(s) => s,
            Err(e) => return Ok(IdCardInfo::failed(format!("加载 Sdtapi.dll 失败: {e}"))),
        };
        let session = match open_session(&sdt) {
            Ok(s) => s,
            Err(e) => return Ok(IdCardInfo::failed(e)),
        };

        let photo_dir = if want_photo {
            let dir = app
                .path()
                .app_cache_dir()
                .unwrap_or_else(|_| std::env::temp_dir())
                .join("idcard");
            let _ = std::fs::create_dir_all(&dir);
            Some(dir)
        } else {
            None
        };

        for _ in 0..5 {
            if session.authenticate().unwrap_or(false) {
                let res = match &photo_dir {
                    Some(d) => session
                        .read_id_card_with_photo(&d.display().to_string())
                        .map_err(|e| e.to_string()),
                    None => session.read_id_card().map_err(|e| e.to_string()),
                };
                if let Ok(id) = res {
                    return Ok(IdCardInfo {
                        ok: true,
                        name: id.name,
                        gender: id.gender,
                        nation: id.nation,
                        birth: id.birth,
                        id_number: id.id_number,
                        address: id.address,
                        agency: id.agency,
                        valid_from: id.valid_from,
                        valid_to: id.valid_to,
                        photo_path: id.photo_path,
                        error: None,
                    });
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        Ok(IdCardInfo::failed(
            "未检测到身份证，请把卡贴紧感应区后重试".into(),
        ))
    })
    .await
    .map_err(|e| format!("读卡任务失败: {e}"))?
}

/// 一个 Mifare 数据块。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IcBlock {
    pub sector: i32,
    pub block: i32,
    pub ok: bool,
    pub hex: String,
    pub error: Option<String>,
}

/// IC（Mifare）卡读取结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IcCardInfo {
    pub ok: bool,
    pub kind_code: i32,
    pub kind_label: String,
    pub sn: String,
    pub blocks: Vec<IcBlock>,
    pub error: Option<String>,
}

/// 读 Mifare IC 卡：寻卡 + 卡号 + 用给定密钥读若干块。
/// `key_hex` 为 12 位十六进制(6 字节)密钥，默认 FFFFFFFFFFFF；
/// `blocks` 为 (扇区, 块) 列表，默认读扇区0 的块 0/1/2。
#[command]
pub async fn ic_read(
    app: AppHandle,
    key_hex: Option<String>,
    blocks: Option<Vec<[i32; 2]>>,
) -> Result<IcCardInfo, String> {
    let key_hex = key_hex.unwrap_or_else(|| "FFFFFFFFFFFF".into());
    let blocks = blocks.unwrap_or_else(|| vec![[0, 0], [0, 1], [0, 2]]);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = DEV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let fail = |e: String| IcCardInfo {
            ok: false,
            kind_code: 0,
            kind_label: String::new(),
            sn: String::new(),
            blocks: vec![],
            error: Some(e),
        };

        let key = match parse_key(&key_hex) {
            Ok(k) => k,
            Err(e) => return Ok(fail(e)),
        };
        let dll = match locate_dll(&app) {
            Some(d) => d,
            None => return Ok(fail("未找到 Sdtapi.dll".into())),
        };
        let sdt = match Sdt::load(&dll) {
            Ok(s) => s,
            Err(e) => return Ok(fail(format!("加载 Sdtapi.dll 失败: {e}"))),
        };
        let session = match open_session(&sdt) {
            Ok(s) => s,
            Err(e) => return Ok(fail(e)),
        };

        match session.ic_find() {
            Ok(Some(card)) => {
                let mut out = Vec::new();
                for [sec, blk] in blocks {
                    let _ = session.ic_request(); // 读块前只寻卡激活，避免 halt
                    match session.ic_read_block(sec, blk, KeyType::KeyA, &key) {
                        Ok(data) => out.push(IcBlock {
                            sector: sec,
                            block: blk,
                            ok: true,
                            hex: hex_str(&data),
                            error: None,
                        }),
                        Err(e) => out.push(IcBlock {
                            sector: sec,
                            block: blk,
                            ok: false,
                            hex: String::new(),
                            error: Some(e.to_string()),
                        }),
                    }
                }
                Ok(IcCardInfo {
                    ok: true,
                    kind_code: card.kind_code,
                    kind_label: card.kind_label().to_string(),
                    sn: card.sn,
                    blocks: out,
                    error: None,
                })
            }
            Ok(None) => Ok(fail("未找到 IC 卡（放一张 13.56MHz Mifare 卡贴紧）".into())),
            Err(e) => Ok(fail(format!("寻卡失败: {e}"))),
        }
    })
    .await
    .map_err(|e| format!("IC 卡任务失败: {e}"))?
}

fn parse_key(s: &str) -> Result<[u8; 6], String> {
    let s = s.trim();
    if s.len() != 12 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("密钥需为 12 位十六进制(6 字节)，如 FFFFFFFFFFFF".into());
    }
    let mut k = [0u8; 6];
    for i in 0..6 {
        k[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|e| e.to_string())?;
    }
    Ok(k)
}

fn hex_str(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect::<Vec<_>>().join(" ")
}
