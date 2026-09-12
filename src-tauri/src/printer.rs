//! 小票机的 Tauri 命令层（04 文档 §5.2 通道 C 的落地入口）。
//!
//! 三条硬性约定：
//! 1. 所有设备访问都跑在 `spawn_blocking` 上——USB 写与状态读可能阻塞数秒，
//!    绝不能占住 IPC/异步运行时线程把窗口卡住；
//! 2. 返回里一定带 `status` 与人类可读的 `error`，否则前端说不清"为什么没出纸"；
//! 3. 打印失败**不抛错**，只回 `ok=false`：过磅业务允许先完成后补打，
//!    打印永远不能成为磅队的堵点（04 §5.2、05 §6.5）。

use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::command;
use ticket_core::device::{self, DeviceInfo, DeviceStatus};
use ticket_core::model::{Paper, PrintLine, WeighTicket};
use ticket_core::render::{new_printer, write_lines, write_self_test, write_weigh_ticket};

/// 一次打印的完整回执，可直接作为 print_log 的留痕内容。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintOutcome {
    pub ok: bool,
    /// 实际打到哪台设备（label）：换 USB 口 / 换机器时这是定位的第一线索
    pub device: String,
    pub status: DeviceStatus,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

impl PrintOutcome {
    pub(crate) fn failed(started: Instant, reason: String) -> Self {
        Self {
            ok: false,
            device: String::new(),
            status: DeviceStatus {
                source: "none".into(),
                note: reason.clone(),
                ..Default::default()
            },
            elapsed_ms: started.elapsed().as_millis() as u64,
            error: Some(reason),
        }
    }

    /// 写成功但设备自报未联机/缺纸时同样标红：避免"提示提交成功、纸上什么都没有"。
    fn from_write(
        started: Instant,
        device: String,
        status: DeviceStatus,
        write: Result<(), String>,
    ) -> Self {
        let error = write.err().or_else(|| {
            if status.source == "escpos" && !status.online {
                Some("打印机未处于联机状态（字节已发送，可能没出纸）".to_string())
            } else if status.source == "escpos" && !status.paper_adequate {
                Some("纸将尽或缺纸".to_string())
            } else {
                None
            }
        });
        Self {
            ok: error.is_none(),
            device,
            status,
            elapsed_ms: started.elapsed().as_millis() as u64,
            error,
        }
    }
}

/// 列出可直连的小票机。设备中心下拉的数据源由这里下发，不在前端抄常量。
#[command]
pub async fn printer_list() -> Result<Vec<DeviceInfo>, String> {
    tauri::async_runtime::spawn_blocking(device::list_devices)
        .await
        .map_err(|e| format!("枚举设备任务失败: {e}"))?
}

/// 本机已安装的一台打印队列打印机（A4 / 针式这类走 Windows 假脱机的设备）。
///
/// 与 [`printer_list`] 的 usbprint 直连枚举互补：热敏小票机拿 VID/PID 直达字节，
/// 而窗口预览 / 针式套打这两条通道靠「打印机名」寻址，所以这里回的是名字 + 端口 +
/// 是否默认，供添加设备表单按名字挑机、把台账里的设备名对上现场真机。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsPrinter {
    pub name: String,
    pub driver: String,
    pub port: String,
    pub share: String,
    pub is_default: bool,
    pub network: bool,
}

/// 枚举本机打印队列。设备中心「扫描本机打印机」的系统队列部分的数据源。
#[command]
pub async fn printer_list_queues() -> Result<Vec<WindowsPrinter>, String> {
    tauri::async_runtime::spawn_blocking(list_queues_blocking)
        .await
        .map_err(|e| format!("枚举打印机任务失败: {e}"))?
}

/// Windows：EnumPrintersW(level 2) 两段式取回全部本地/连接打印机。
/// `queue_print` 解析「默认打印机」时也走这里，枚举口径全项目只有一份。
#[cfg(target_os = "windows")]
pub(crate) fn list_queues_blocking() -> Result<Vec<WindowsPrinter>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Printing::{
        EnumPrintersW, PRINTER_ATTRIBUTE_DEFAULT, PRINTER_ATTRIBUTE_NETWORK,
        PRINTER_ENUM_CONNECTIONS, PRINTER_ENUM_LOCAL, PRINTER_INFO_2W,
    };

    const LEVEL2: u32 = 2;
    let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;

    unsafe {
        // 第一段只要缓冲大小：首调必回 ERROR_INSUFFICIENT_BUFFER 并把 needed 写好，忽略这个 Err。
        let mut needed: u32 = 0;
        let mut returned: u32 = 0;
        let _ = EnumPrintersW(flags, PCWSTR::null(), LEVEL2, None, &mut needed, &mut returned);
        if needed == 0 {
            return Ok(Vec::new());
        }
        // 第二段真正取回；needed 会被系统改写为实际用量，以 returned 决定读几台。
        let mut buf: Vec<u8> = vec![0u8; needed as usize];
        EnumPrintersW(flags, PCWSTR::null(), LEVEL2, Some(&mut buf), &mut needed, &mut returned)
            .map_err(|e| format!("枚举本机打印机失败: {e}"))?;

        let base = buf.as_ptr() as *const PRINTER_INFO_2W;
        let infos = std::slice::from_raw_parts(base, returned as usize);
        Ok(infos
            .iter()
            .map(|i| WindowsPrinter {
                name: wide_to_string(i.pPrinterName),
                driver: wide_to_string(i.pDriverName),
                port: wide_to_string(i.pPortName),
                share: wide_to_string(i.pShareName),
                is_default: i.Attributes & PRINTER_ATTRIBUTE_DEFAULT != 0,
                network: i.Attributes & PRINTER_ATTRIBUTE_NETWORK != 0,
            })
            .collect())
    }
}

/// `PWSTR` 是以 NUL 结尾的 UTF-16。各版本 windows-core 的 `to_string()` 可用性不一，
/// 这里版本无关地自己走到结束符，读到异常长度即止，绝不让一次扫描把界面卡死。
#[cfg(target_os = "windows")]
pub(crate) fn wide_to_string(p: windows::core::PWSTR) -> String {
    let ptr = p.0 as *const u16;
    if ptr.is_null() {
        return String::new();
    }
    let mut units = Vec::new();
    unsafe {
        let mut i = 0usize;
        while i < 65_536 {
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

/// 非 Windows：没有 Windows 假脱机可枚举，回一句人话（添加表单据此提示改用桌面端）。
#[cfg(not(target_os = "windows"))]
fn list_queues_blocking() -> Result<Vec<WindowsPrinter>, String> {
    Err("枚举本机打印队列仅支持 Windows".to_string())
}

/// 查设备状态（不出纸）。设备中心的状态灯与缺纸告警走这条。
#[command]
pub async fn printer_status(vid: Option<u16>, pid: Option<u16>) -> Result<PrinterProbe, String> {
    tauri::async_runtime::spawn_blocking(move || match device::open(pair_of(vid, pid)) {
        Ok((driver, info)) => Ok(PrinterProbe {
            device: info,
            status: device::query_status(&driver),
        }),
        Err(e) => Err(e),
    })
    .await
    .map_err(|e| format!("状态查询任务失败: {e}"))?
}

/// 打自检票：一次判读"通道 / 中文字库 / 栅格列数 / 切刀"，与 tools/escpos-probe 同一份票面。
#[command]
pub async fn printer_self_test(
    vid: Option<u16>,
    pid: Option<u16>,
    paper: Option<Paper>,
) -> Result<PrintOutcome, String> {
    let paper = paper.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let (driver, info) = match device::open(pair_of(vid, pid)) {
            Ok(v) => v,
            Err(e) => return Ok(PrintOutcome::failed(started, e)),
        };
        let status = device::query_status(&driver);
        let mut printer = new_printer(driver, paper);
        let write = write_self_test(&mut printer, paper, &info.label).map_err(|e| e.to_string());
        Ok(PrintOutcome::from_write(started, info.label, status, write))
    })
    .await
    .map_err(|e| format!("打印任务失败: {e}"))?
}

/// 打过磅码单（热敏小票）。票面数据由前端快照传过来，Rust 不回头查库。
#[command]
pub async fn print_weigh_ticket(ticket: WeighTicket) -> Result<PrintOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let paper = ticket.paper;
        let (driver, info) = match device::open(None) {
            Ok(v) => v,
            Err(e) => return Ok(PrintOutcome::failed(started, e)),
        };
        let status = device::query_status(&driver);
        let mut printer = new_printer(driver, paper);
        let write = write_weigh_ticket(&mut printer, &ticket).map_err(|e| e.to_string());
        Ok(PrintOutcome::from_write(started, info.label, status, write))
    })
    .await
    .map_err(|e| format!("打印任务失败: {e}"))?
}

/// 前端按用户模板排好版的通用小票（自定义模板的打印出口）。
///
/// 与 [`print_weigh_ticket`] 的分工：那张票的版式写死在 `ticket-core`（热敏码单标准版），
/// 这里的票面完全由前端当前模板决定——加一种票据、勾掉一个字段都不必改这一侧。
/// 载荷用单词字段名的 `input` 包裹，与 `backup_run` / `restore_apply` 的入参约定一致，
/// 免得前后端在 camelCase / snake_case 上互相猜。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptPrintInput {
    /// 行序列（票头 / 字段区 / 表格 / 署名 / 票尾），顺序由前端模板决定
    pub lines: Vec<PrintLine>,
    /// 纸型；缺省 80 热敏
    #[serde(default)]
    pub paper: Option<Paper>,
    /// 直连小票机的 VID/PID；缺省交给 `device::open(None)` 自动挑一台
    #[serde(default)]
    pub vid: Option<u16>,
    #[serde(default)]
    pub pid: Option<u16>,
    /// 份数；缺省 1（0 与超限由 `write_lines` 兜底）
    #[serde(default)]
    pub copies: Option<u8>,
    /// 现场实测列数（汉字占 2 列）；缺省按纸宽标称（80 → 48 / 58 → 32）。
    /// 票面折行的头号原因是这个数比实机大，实测入口在「小票模板 → 小票机列数」，
    /// 值由自检票上的标尺读出来。
    #[serde(default)]
    pub cols: Option<u8>,
    /// 打印后弹钱箱（结算小票）
    #[serde(default)]
    pub open_drawer: bool,
}

/// 打通用小票：票面由前端模板决定，Rust 只负责编码与送达。
#[command]
pub async fn print_receipt(input: ReceiptPrintInput) -> Result<PrintOutcome, String> {
    let paper = input.paper.unwrap_or_default();
    let cols = paper.cols_with(input.cols);
    let copies = input.copies.unwrap_or(1);
    let pair = pair_of(input.vid, input.pid);
    let lines = input.lines;
    let open_drawer = input.open_drawer;
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let (driver, info) = match device::open(pair) {
            Ok(v) => v,
            Err(e) => return Ok(PrintOutcome::failed(started, e)),
        };
        let status = device::query_status(&driver);
        let mut printer = new_printer(driver, paper);
        let write =
            write_lines(&mut printer, cols, &lines, copies, open_drawer).map_err(|e| e.to_string());
        Ok(PrintOutcome::from_write(started, info.label, status, write))
    })
    .await
    .map_err(|e| format!("打印任务失败: {e}"))?
}

/// 设备 + 状态，给设备中心一张状态卡需要的最小集合。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterProbe {
    pub device: DeviceInfo,
    pub status: DeviceStatus,
}

fn pair_of(vid: Option<u16>, pid: Option<u16>) -> Option<(u16, u16)> {
    match (vid, pid) {
        (Some(v), Some(p)) => Some((v, p)),
        _ => None,
    }
}
