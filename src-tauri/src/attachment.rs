//! 图片附件的「读进来 / 摆出去 / 删干净」（03 §9.15、04 §4.3）
//!
//! [`camera`] 把过磅抓拍落进 `attachment` 时说过：本模块只管交图与落行，业务归属由服务层落。
//! 这个模块就是它对面那半边——**把库里的图安全地送回界面**，以及换/清时把旧的删干净。
//! 之前全仓没有任何一条读图通道（抓拍墙只回"有/无抓拍"就是因为它），所以这里一并把
//! camera 模块头欠下的那句 `pii.read` 审计补上：谁在什么时候看过哪张人像，库里要有痕迹。
//!
//! **格式判定只认文件头**：`mime`、扩展名、文件名全部由本机按内容算出来。上传框里
//! 那个 `.jpg` 是给人看的，不是给机器信的——改名成 .jpg 的 exe 进不了这张表。
//!
//! **绝对路径的边界**（本 crate 唯一一处入参带本机路径的地方）：导入收的是**操作员自己
//! 用系统文件框选中的路径**（与 `system.rs::import_backup` 同一口径：插件只给选路，
//! 校验与落盘全在 Rust）。因此三道闸缺一不可：
//!  1. 扩展名白名单（`.jpg/.jpeg/.png/.bmp`）——先把可被读的文件压到图片；
//!  2. 大小上限——先看 `metadata.len()` 再读，避免一个超大文件把磅房机顶死；
//!  3. 文件头判定——不认识的字节一律拒绝，落盘的文件名与 MIME 都由这里重新生成。
//! 输出侧反过来：`file_path` 一律不回前端（库里唯一一处，见 [`camera`] 模块头的 PII 约定），
//! 界面拿到的只有 `data:` URL。

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::camera::{self, base64_standard};

/// 一种可入库的图片格式：文件头特征 + 落库 `mime` + 落盘扩展名，三者一处定死。
///
/// 用带常量实例的结构体而不是枚举，是因为调用方要的就是 `mime`/`ext` 这两个字符串本身，
/// 枚举还得再写一个 `match` 把它们取出来——那是同一条判据写两遍。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageKind {
    /// 写进 `attachment.mime`
    pub mime: &'static str,
    /// 写进 `attachment.file_path` 的后缀（[`camera::attachment_rel_path_ext`] 使用）
    pub ext: &'static str,
    /// 给人看的名字，出现在拒绝理由里
    pub label: &'static str,
    /// 文件头特征字节
    magic: &'static [u8],
}

impl ImageKind {
    // 允许 PascalCase：这三个常量表达的是"哪一种格式"，读起来该像 `db_enum` 的变体
    // （`ScaleCapture`/`IdCardPhoto`），而不是像全大写的配置项 —— 它们旁边就是 "jpeg"/"png"
    // 这些真正的小写字面量，全大写反而分不清谁是谁。
    #![allow(non_upper_case_globals)]

    pub const Jpeg: ImageKind =
        ImageKind { mime: "image/jpeg", ext: "jpg", label: "JPG", magic: &[0xFF, 0xD8, 0xFF] };
    pub const Png: ImageKind = ImageKind {
        mime: "image/png",
        ext: "png",
        label: "PNG",
        magic: &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A],
    };
    /// 身份证芯片照就是 `SavePhoto.dll` 落出来的 BMP（102×126），所以它是这条链路的常规格式。
    pub const Bmp: ImageKind = ImageKind { mime: "image/bmp", ext: "bmp", label: "BMP", magic: b"BM" };

    pub const ALL: &'static [ImageKind] = &[ImageKind::Jpeg, ImageKind::Png, ImageKind::Bmp];

    /// 按文件头判定。认不出来就 `None`——不做"先当 JPEG 试试"这种猜。
    pub fn detect(bytes: &[u8]) -> Option<ImageKind> {
        ImageKind::ALL
            .iter()
            .find(|k| bytes.len() > k.magic.len() && bytes.starts_with(k.magic))
            .copied()
    }
}

/// 单张图片的大小上限。身份证芯片照 ~38 KB，手机拍的证件照 2–4 MB；
/// 4 MB 之上再大的图对"认出这个人"没有任何增益，只会把库与 IPC 撑大。
///
/// 与摄像机抓拍那条 `attachment_max_kb`（站点参数，默认 500 KB）**不是同一个数**：
/// 那个约束的是"摄像机一帧回多大"，改它不该顺手放宽人来上传的图，反之亦然。
pub const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

/// 允许被读进来的扩展名。**是闸不是格式判定**：真正的判定在 [`ImageKind::detect`]。
const ALLOWED_EXTS: &[&str] = &["jpg", "jpeg", "png", "bmp"];

fn rejected(reason: impl std::fmt::Display) -> String {
    format!("照片不可用：{reason}")
}

/// 读一个本机图片文件：扩展名 → 大小 → 内容，三道闸按成本从低到高排。
///
/// 错误文案里**不带路径**（04 §4.3：文件路径只在库里留一处），但要说清"该改什么"。
pub fn load_image_file(path: &str) -> Result<(Vec<u8>, ImageKind), String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err(rejected("没有选中文件"));
    }
    if raw.len() > 1000 || raw.contains('\0') {
        return Err(rejected("文件路径过长或含非法字符"));
    }
    let p = Path::new(raw);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !ALLOWED_EXTS.contains(&ext.as_str()) {
        return Err(rejected("只支持 JPG / PNG / BMP 图片，请重新选择文件"));
    }
    let md = std::fs::metadata(p).map_err(|_| rejected("选中的文件读不到了，请重新选择"))?;
    if !md.is_file() {
        return Err(rejected("选中的不是文件"));
    }
    if md.len() > MAX_IMAGE_BYTES {
        return Err(rejected(format!(
            "图片 {} MB 超过上限 {} MB，请先用看图软件缩小再传",
            md.len() / 1024 / 1024,
            MAX_IMAGE_BYTES / 1024 / 1024
        )));
    }
    let bytes = std::fs::read(p).map_err(|_| rejected("文件读取失败，可能被其它程序占用"))?;
    if bytes.len() <= 16 {
        return Err(rejected("图片小得不像一张照片"));
    }
    let kind = ImageKind::detect(&bytes).ok_or_else(|| rejected("文件内容不是可识别的 JPG / PNG / BMP 图片"))?;
    Ok((bytes, kind))
}

/// 一张要摆到界面上的图片。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageForDisplay {
    /// `data:<mime>;base64,...`——界面直接进 `img src`，不拼文件路径
    pub data_url: String,
    pub size: i64,
    pub captured_at: String,
}

/// 按附件 id 把图片读回给界面，并记一次访问（04 §4.3 的 `pii.read` 半边）。
///
/// `file_path` 出库之后仍然要过 [`camera::join_under`]：库里存的是相对路径，
/// 万一这行被手工改成 `/etc/passwd` 或 `..\..\x`，读图这条通道就该拒绝而不是照办。
pub fn read_for_display(
    conn: &Connection,
    app_dir: &Path,
    attachment_id: i64,
    actor_id: i64,
) -> Result<ImageForDisplay, String> {
    let row = conn
        .query_row(
            "SELECT file_path, mime, file_size, captured_at FROM attachment WHERE id = ?1",
            params![attachment_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?)),
        )
        .optional()
        .map_err(|e| format!("读取附件记录失败：{e}"))?;
    let Some((rel, mime, declared_size, captured_at)) = row else {
        return Err("附件记录不存在，可能已被清理".into());
    };
    if declared_size > MAX_IMAGE_BYTES as i64 {
        return Err("附件超过可读上限，已拒绝显示".into());
    }
    let path = camera::join_under(app_dir, &rel).ok_or_else(|| "附件路径不合法，已拒绝读取".to_string())?;
    // 库里有行、盘上没图：拷库不拷附件、手动清了缓存、备份只还原了 .db 都会造成这一种。
    // 说人话，别让界面挂一张碎图标。
    let bytes = std::fs::read(&path).map_err(|_| rejected("图片文件已丢失，请重新上传或读卡补一张"))?;
    if bytes.is_empty() {
        return Err(rejected("图片文件是空的，请重新上传或读卡补一张"));
    }

    // 访问留痕：`accessed_at`/`accessed_by` 这两列存在的意义就是"谁看过这张人像"。
    // 写失败（库被占、列被 constraint 挡住）不挡看图——留痕是治理，不是这张图能不能显示的前提。
    let _ = conn.execute(
        "UPDATE attachment SET accessed_at = ?1, accessed_by = ?2 WHERE id = ?3",
        params![crate::db::migrate::now_iso(), actor_id, attachment_id],
    );

    Ok(ImageForDisplay {
        data_url: format!("data:{};base64,{}", display_mime(&mime, &bytes), base64_standard(&bytes)),
        size: bytes.len() as i64,
        captured_at,
    })
}

/// 拼 `data:` URL 用的 MIME。
///
/// 不直接信库里那一列：写侧只可能写 [`ImageKind::ALL`] 三种，但"还原一个别人拷来的 .db"
/// 或手工改行都能把它变成任意字符串，而 `data:` 前缀是要交给界面解释的。库里这个值不认识时，
/// 就按文件头重新判一次；还判不出来退到 JPEG（本表里绝大多数的既有行都是它）。
fn display_mime(stored: &str, bytes: &[u8]) -> String {
    if ImageKind::ALL.iter().any(|k| k.mime == stored) {
        return stored.to_string();
    }
    ImageKind::detect(bytes)
        .map(|k| k.mime.to_string())
        .unwrap_or_else(|| ImageKind::Jpeg.mime.to_string())
}

/// 删掉一行附件连同盘上的文件。**只在替换/清除档案照片时调用**（PII 最小化：
/// 旧人像不该因为"换了一张"就继续留在盘上）。
///
/// 顺序是**先删库再删文件**：反过来一旦文件删了而库没删成，就留下一个永远点不开的
/// 死引用；现在这个顺序最坏是多留一个没人引用的文件。文件删除失败只打日志——
/// 档案照片已经换对了，不该因为一个删不掉的旧文件把整笔业务回滚。
pub fn delete_image(conn: &Connection, app_dir: &Path, attachment_id: i64) -> Result<(), String> {
    let rel = conn
        .query_row("SELECT file_path FROM attachment WHERE id = ?1", params![attachment_id], |r| r.get::<_, String>(0))
        .optional()
        .map_err(|e| format!("读取附件记录失败：{e}"))?;
    let Some(rel) = rel else { return Ok(()) };
    conn.execute("DELETE FROM attachment WHERE id = ?1", params![attachment_id])
        .map_err(|e| format!("删除旧照片记录失败：{e}"))?;
    if let Some(path) = camera::join_under(app_dir, &rel) {
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!("[附件] 旧照片文件未能删除（记录已删，不影响业务）: {e}");
            }
        }
    }
    Ok(())
}
