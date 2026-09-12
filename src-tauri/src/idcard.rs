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

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

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

/// 旧照片的存活时间。建档路径是"刷一张卡 → 保存这张档案"，几分钟内走完；
/// 留到 24 小时是给"读卡后先去补别的字段、晚点再保存"这类现场节奏留余量。
const PHOTO_STALE_TTL: Duration = Duration::from_secs(24 * 3600);

/// DLL 落照片的工作目录名：一个、复用，读到卡就把里面的照片搬走（见 [`archive_photo`]）。
const PHOTO_WORK_DIR: &str = "_current";

/// 身份证照片在缓存里的根目录。建不出来（缓存路径异常）回 `None`，调用方按"本轮不取照片"处理。
fn staging_root(app: &AppHandle) -> Option<PathBuf> {
    let root = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("idcard");
    if std::fs::create_dir_all(&root).is_err() {
        return None;
    }
    prune_stale_photos(&root);
    Some(root)
}

/// 交给 `SavePhoto.dll` 的落图目录：**固定一个复用目录**，不是每次新建。
///
/// 监听循环每 350 ms 就调一次 `idcard_read`（`store/device` 的 `watch`），一次读卡内部还要重试
/// 5 轮——按次建目录的话，一个营业日能在缓存里堆出上万个空目录，清理本身都会变成负担。
/// 目录串以 GBK 写入且有 300 字节上限（`routon-idr` 的 `BUF_DIR`），这里再挡一道长度。
fn work_photo_dir(root: &Path) -> Option<PathBuf> {
    let dir = root.join(PHOTO_WORK_DIR);
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    if dir.display().to_string().len() > 250 {
        return None;
    }
    // 上一张卡没搬干净的话（读卡中途失败），先清掉，免得把别人的脸搬给下一个人
    let _ = std::fs::remove_file(dir.join("photo.bmp"));
    Some(dir)
}

/// 把 DLL 刚落的照片**搬**进一个以本次读卡时刻命名的目录，回它的绝对路径。
///
/// 为什么非搬不可：`SavePhoto.dll` 只认固定文件名 `photo.bmp`，下一个文件同名就覆盖。
/// 磅员刷完张三、表单还开着又替李四刷一次，若不搬走，存进张三档案的就是李四的脸
/// （02 §F3.1「卡面照片即档案人像」唯一的正确性前提）。搬过一次，这个路径在整个表单
/// 生命周期里指向的就是**这次读卡**的那个人；搬完工作目录就干净了，缓存里不留多余人像。
fn archive_photo(root: &Path, work_dir: &Path) -> Option<String> {
    let src = work_dir.join("photo.bmp");
    let md = std::fs::metadata(&src).ok()?;
    if !md.is_file() || md.len() == 0 {
        return None;
    }
    let now = chrono::Local::now();
    let stamp = format!("{}-{:03}", now.format("%Y%m%d-%H%M%S"), now.timestamp_subsec_millis());
    // 同毫秒内连着搬两张（测试里就会）也不能撞进同一个目录：撞了就加序号，各留各的
    let mut dest_dir = root.join(&stamp);
    let mut n = 1;
    while dest_dir.exists() {
        dest_dir = root.join(format!("{stamp}-{n}"));
        n += 1;
    }
    std::fs::create_dir_all(&dest_dir).ok()?;
    let dest = dest_dir.join("photo.bmp");
    match std::fs::rename(&src, &dest) {
        // 同一分区内 rename 是原子的；跨分区（缓存目录被重定向）才退回拷贝
        Ok(()) => Some(dest),
        Err(_) => {
            std::fs::copy(&src, &dest).ok()?;
            let _ = std::fs::remove_file(&src);
            Some(dest)
        }
    }
    .map(|p| p.display().to_string())
}

/// 清掉过期的照片目录。人像属 PII，不能指望操作系统"哪天顺手把缓存清了"；
/// 删除失败（正被占用等）一律忽略——清理是附带好处，不是读卡的前置条件。
///
/// 只扫根目录下一层，且**跳过工作目录**：它要被复用，删了下次读卡又得重建。
fn prune_stale_photos(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        if entry.file_name() == PHOTO_WORK_DIR {
            continue;
        }
        let Ok(md) = entry.metadata() else { continue };
        if !md.is_dir() {
            continue;
        }
        let Ok(modified) = md.modified() else { continue };
        if now.duration_since(modified).unwrap_or(Duration::ZERO) > PHOTO_STALE_TTL {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// 校验 SDK 声称写出的照片：**存在、是普通文件、且非空**才算有照片。
///
/// `routon-idr` 的 `read_id_card_with_photo` 无论落盘成功与否都把 `<目录>/photo.bmp` 原样
/// 返回（它自己两个分支都 `Some(...)`），所以不能拿"返回了路径"当"取到了照片"——
/// 否则解码 DLL 版本不配套时会往档案里挂一个指向空文件的附件（04 §3.5-3）。
fn photo_file_ok(path: Option<&str>) -> Option<String> {
    let p = path?;
    let md = std::fs::metadata(p).ok()?;
    (md.is_file() && md.len() > 0).then(|| p.to_string())
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
    /// 卡面照片的**暂存路径**（本次读卡独占目录里的 `photo.bmp`）。缓存目录里的东西 24 小时
    /// 后被清理，只有被 `party_photo_set` 导入成 `attachment` 才算真正落定（03 §9.6）。
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

/// 读身份证。`with_photo=true` 时让 DLL 把照片落进复用的工作目录，读到卡后由 [`archive_photo`]
/// **搬**进本次读卡专属的目录再回传路径（24 小时后被清理）；取照失败一律降级成"这张卡没照片"，
/// 读卡本身照常成功。免驱版需先 `authenticate()` 触发射频再读，这里重试若干次。
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

        let photo_dirs = if want_photo {
            match staging_root(&app).and_then(|root| work_photo_dir(&root).map(|w| (root, w))) {
                Some(d) => Some(d),
                None => {
                    eprintln!("[身份证] 照片暂存目录不可用，本轮按不取照片处理（读卡照常）");
                    None
                }
            }
        } else {
            None
        };

        for _ in 0..5 {
            if session.authenticate().unwrap_or(false) {
                // 带照与不带照是**同一次读卡的两种取法**，不是两种结果：`ReadBaseInfosPhoto`
                // 走的是照片解码 DLL（04 §3.5-3 版本不配套就失败），一旦它出错就退回
                // `ReadBaseInfos` 把文字信息读全。取不到照片只是少一张档案人像，
                // 读卡本身该成的绝不能被它带崩。
                let mut photo_degraded: Option<String> = None;
                let res = match &photo_dirs {
                    Some((_, work)) => session
                        .read_id_card_with_photo(&work.display().to_string())
                        .or_else(|e| {
                            photo_degraded = Some(e.to_string());
                            session.read_id_card().map_err(|e2| e2.to_string())
                        }),
                    None => session.read_id_card().map_err(|e| e.to_string()),
                };
                if let Some(e) = photo_degraded {
                    eprintln!("[身份证] 本轮未取到卡面照片（读卡照常）: {e}");
                }
                if let Ok(id) = res {
                    // 照片必须先离开复用目录：留在原地就会被下一个人的证件照覆盖掉
                    let archived = match &photo_dirs {
                        Some((root, work)) => archive_photo(root, work),
                        None => None,
                    };
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
                        photo_path: archived.or_else(|| photo_file_ok(id.photo_path.as_deref())),
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 一个用完即删的临时根目录
    struct Root(PathBuf);
    impl Root {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("banghe-idcard-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn work_dir_is_reused_and_wiped_of_the_previous_face() {
        let root = Root::new("work");
        let first = work_photo_dir(&root.0).expect("工作目录应能建出来");
        // 上一次读卡残留的照片（读卡中途失败时才会留下），下次读卡前必须清掉
        std::fs::write(first.join("photo.bmp"), b"BM somebody-else").unwrap();
        let second = work_photo_dir(&root.0).unwrap();
        assert_eq!(first, second, "工作目录是复用同一个，不是每次新建——监听循环每 350 ms 一次");
        assert!(!second.join("photo.bmp").exists(), "上一张脸必须清干净，否则会被搬给下一个人");
    }

    #[test]
    fn two_consecutive_cards_keep_two_distinct_photos() {
        let root = Root::new("two-cards");
        let work = work_photo_dir(&root.0).unwrap();

        // 张三：DLL 落图 → 搬走 → 表单拿着这个路径去保存
        std::fs::write(work.join("photo.bmp"), b"BM zhangsan-face").unwrap();
        let a = archive_photo(&root.0, &work).expect("第一张卡的照片应搬走");
        // 李四：同一个工作目录被同名覆盖，绝不能把张三档案里那个路径跟着换了脸
        std::fs::write(work.join("photo.bmp"), b"BM lisi-face").unwrap();
        let b = archive_photo(&root.0, &work).unwrap();

        assert_ne!(a, b, "两次读卡必须各自一个路径，否则档案照片会张冠李戴");
        assert_eq!(std::fs::read(&a).unwrap(), b"BM zhangsan-face");
        assert_eq!(std::fs::read(&b).unwrap(), b"BM lisi-face");
        assert!(!work.join("photo.bmp").exists(), "搬完工作目录就该空着，缓存里不留第二份人像");
    }

    #[test]
    fn archive_refuses_a_photo_that_never_landed() {
        let root = Root::new("no-photo");
        let work = work_photo_dir(&root.0).unwrap();
        // 解码 DLL 没装/版本不配套时，封装层照样回一个 <目录>/photo.bmp 的路径
        assert!(archive_photo(&root.0, &work).is_none(), "文件根本不存在就不算取到照片");
        std::fs::write(work.join("photo.bmp"), b"").unwrap();
        assert!(archive_photo(&root.0, &work).is_none(), "空文件同样不算");
        assert_eq!(photo_file_ok(Some(work.join("photo.bmp").to_str().unwrap())), None);
        assert_eq!(photo_file_ok(None), None);
        assert_eq!(photo_file_ok(Some(root.0.join("nothing.bmp").to_str().unwrap())), None);
    }
}
