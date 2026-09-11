//! 小票机的 Tauri 命令层（04 文档 §5.2 通道 C 的落地入口）。
//!
//! 三条硬性约定：
//! 1. 所有设备访问都跑在 `spawn_blocking` 上——USB 写与状态读可能阻塞数秒，
//!    绝不能占住 IPC/异步运行时线程把窗口卡住；
//! 2. 返回里一定带 `status` 与人类可读的 `error`，否则前端说不清"为什么没出纸"；
//! 3. 打印失败**不抛错**，只回 `ok=false`：过磅业务允许先完成后补打，
//!    打印永远不能成为磅队的堵点（04 §5.2、05 §6.5）。

use std::time::Instant;

use serde::Serialize;
use tauri::command;
use ticket_core::device::{self, DeviceInfo, DeviceStatus};
use ticket_core::model::{Paper, WeighTicket};
use ticket_core::render::{new_printer, write_self_test, write_weigh_ticket};

/// 一次打印的完整回执，可直接作为 print_log 的留痕内容。
#[derive(Serialize)]
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
    fn failed(started: Instant, reason: String) -> Self {
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
