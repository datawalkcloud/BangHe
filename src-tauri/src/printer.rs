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
    /// `PRINTER_INFO_2W.Status` 原值，供 [`queue_verdict`] 解读。
    /// 前端那份（`NativeWindowsPrinter`）刻意不收：一个位图数字进了 TS 只会被当成状态自己翻译一遍。
    #[serde(skip)]
    pub status: u32,
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
                status: i.Status,
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

/* ------------------------------------------------------- 队列机的联机探测 */

/// 一次队列探测的结论，直接被 `devices.rs` 的 `ProbePlan::PrinterQueue` 换成设备中心那张结果卡。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueVerdict {
    pub ok: bool,
    pub message: String,
}

/// 队列 `Status` 位里**判故障**的那几档 → 现场看得懂的说法。数值照 windi.h 的
/// `PRINTER_STATUS_*` 写死（`Status` 是 `u32`，windows crate 的同名常量要 `cfg(windows)` 才拿得到，
/// 而下面这套解读规则得在任何平台都单测得动）；`status_bits_match_windi` 那条测试在 Windows
/// 上逐位对一遍，防止抄错一位就把正常机器报成故障。
///
/// 刻意不收 `PRINTING`/`BUSY`/`IO_ACTIVE`/`WAITING`/`PROCESSING`/`INITIALIZING`/`WARMING_UP`/
/// `POWER_SAVE`/`TONER_LOW`：连打、进省电休眠、粉将尽都是照常出纸的正常态，置红等于把一次
/// 正常作业报成"打印机不可用"，它们只作为补充说明附在绿标后面（[`NEUTRAL_QUEUE_BITS`]）。
const BAD_QUEUE_BITS: &[(u32, &str)] = &[
    (1, "已暂停"),                    // PAUSED
    (2, "驱动报错"),                  // ERROR
    (4, "正在删除"),                  // PENDING_DELETION
    (8, "卡纸"),                      // PAPER_JAM
    (16, "缺纸"),                     // PAPER_OUT
    (32, "等待手动进纸"),             // MANUAL_FEED
    (64, "纸路异常"),                 // PAPER_PROBLEM
    (128, "脱机"),                    // OFFLINE
    (2048, "出纸盒已满"),             // OUTPUT_BIN_FULL
    (4096, "不可用"),                 // NOT_AVAILABLE
    (262144, "缺粉"),                 // NO_TONER
    (524288, "无法处理当前页"),       // PAGE_PUNT
    (1048576, "需要人工处理"),        // USER_INTERVENTION
    (2097152, "内存不足"),            // OUT_OF_MEMORY
    (4194304, "舱门打开"),            // DOOR_OPEN
    (8388608, "打印服务器状态未知"),  // SERVER_UNKNOWN
    (33554432, "打印服务器离线"),     // SERVER_OFFLINE
    (67108864, "驱动需要更新"),       // DRIVER_UPDATE_NEEDED
];

/// 绿标里附一句的"此刻在忙什么"，不参与成败判定。
const NEUTRAL_QUEUE_BITS: &[(u32, &str)] = &[
    (256, "正在收数据"),   // IO_ACTIVE
    (512, "正忙"),         // BUSY
    (1024, "正在打印"),    // PRINTING
    (8192, "等待中"),      // WAITING
    (16384, "正在处理"),   // PROCESSING
    (32768, "正在初始化"), // INITIALIZING
    (65536, "正在预热"),   // WARMING_UP
    (131072, "粉将尽"),    // TONER_LOW
    (16777216, "省电模式"), // POWER_SAVE
];

fn status_labels<'a>(status: u32, table: &[(u32, &'a str)]) -> Vec<&'a str> {
    table.iter().filter(|(bit, _)| status & bit != 0).map(|(_, label)| *label).collect()
}

/// 按台账点名的队列给出一次真结论。**纯函数**：枚举由调用方做，这里只解读，
/// 于是判据在任何平台都能单测（`Status` 位是 Win32 才有，但解读规则与调用无关）。
///
/// 点名匹配是**逐字**的（只忽略大小写），不做模糊匹配：队列名与系统里的名字差一个字时，
/// 直打会把作业投到另一台上去，现场见到的是"这台没出纸、那台出了一沓"——正是要在这里拦住的错。
pub(crate) fn queue_verdict(queues: &[WindowsPrinter], wanted: Option<&str>) -> QueueVerdict {
    let want = wanted.map(str::trim).filter(|s| !s.is_empty());
    let no_queue = "先在 Windows「设置 → 蓝牙和其他设备 → 打印机和扫描仪」里装好打印机并记进台账";

    let (picked, via): (&WindowsPrinter, String) = match want {
        Some(w) => match queues.iter().find(|p| p.name.eq_ignore_ascii_case(w)) {
            Some(p) => (p, String::new()),
            None => {
                let named: Vec<&str> = queues.iter().take(3).map(|p| p.name.as_str()).collect();
                let more = if queues.len() > named.len() { "…" } else { "" };
                let tail = if named.is_empty() { no_queue.to_string() } else { format!("本机现有队列：{}{more}", named.join("、")) };
                return QueueVerdict {
                    ok: false,
                    message: format!("本机打印队列里没有「{w}」，打印会投不到这台机。{tail}"),
                };
            }
        },
        None => {
            // 台账没填队列名（手打的设备名不算队列名）：退到本机默认队列，并把这条退让说在结论里
            match queues.iter().find(|p| p.is_default).or_else(|| queues.first()) {
                Some(p) => {
                    let via = if p.is_default {
                        "（台账未填队列名，探的是本机默认队列）"
                    } else {
                        "（台账未填队列名，本机也没有默认队列，探的是枚举到的第一台）"
                    };
                    (p, via.to_string())
                }
                None => return QueueVerdict { ok: false, message: format!("本机没有已安装的打印队列：{no_queue}") },
            }
        }
    };

    let port = if picked.port.trim().is_empty() { "端口未知" } else { picked.port.trim() };
    let bad = status_labels(picked.status, BAD_QUEUE_BITS);
    if !bad.is_empty() {
        // 回话按"下一步去哪儿点"分组：纸路的、暂停的、脱机的，现场照着做就行，不必读状态位
        let hint = if bad.iter().any(|l| ["卡纸", "缺纸", "纸路异常", "等待手动进纸", "出纸盒已满"].contains(l)) {
            "先查纸路、纸盒与上盖，处理完再测一次"
        } else if bad.contains(&"已暂停") {
            "在「设置 → 蓝牙和其他设备 → 打印机和扫描仪 → 打开队列」里取消暂停后再测"
        } else {
            "检查电源、联机键与打印服务器，处理完再测一次"
        };
        return QueueVerdict {
            ok: false,
            message: format!("打印队列「{}」报异常：{}（端口 {port}）。{hint}", picked.name, bad.join(" / ")),
        };
    }

    let busy = status_labels(picked.status, NEUTRAL_QUEUE_BITS);
    let mut message = format!("打印队列「{}」就绪（端口 {port}）{via}", picked.name);
    if !busy.is_empty() {
        message.push_str(&format!("，当前：{}", busy.join(" / ")));
    }
    // 判据的边界必须写在结论里：假脱机只保证收得下作业，不保证设备通着电
    message.push_str("。队列接受作业即算通过，不代表设备已通电出纸");
    QueueVerdict { ok: true, message }
}

/// 设备中心「联机测试」的队列机分支：只枚举并解读队列状态，**不提交作业**。
/// 打一张测试页要占纸，与"改配置不该浪费一张票"（前端 `verifyReceiptPrinter` 只发状态查询）同一条纪律。
pub async fn probe_queue(wanted: Option<String>) -> Result<QueueVerdict, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(queue_verdict(&list_queues_blocking()?, wanted.as_deref())))
        .await
        .map_err(|e| format!("队列探测任务失败: {e}"))?
}

/// 按标签反查状态位（只给下面那条 Windows 对表测试用）
#[cfg(all(test, target_os = "windows"))]
fn bit_of_label(label: &str) -> Option<u32> {
    BAD_QUEUE_BITS
        .iter()
        .chain(NEUTRAL_QUEUE_BITS)
        .find(|(_, l)| *l == label)
        .map(|(bit, _)| *bit)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(name: &str, port: &str, status: u32, is_default: bool) -> WindowsPrinter {
        WindowsPrinter {
            name: name.into(),
            driver: "Test Driver".into(),
            port: port.into(),
            share: String::new(),
            is_default,
            network: false,
            status,
        }
    }

    /// 现场最常见的那一档：队列在、没报错 → 绿，且结论里必须把"不代表已通电"说出来，
    /// 否则操作员拿绿标当"纸出得来"的证据，反而比红标更误导。
    #[test]
    fn a_healthy_named_queue_greens_with_its_port_and_the_honest_caveat() {
        let v = queue_verdict(&[queue("HP LaserJet 1020", "USB001", 0, false)], Some("HP LaserJet 1020"));
        assert!(v.ok, "{:?}", v);
        assert!(v.message.contains("HP LaserJet 1020") && v.message.contains("USB001"), "{}", v.message);
        assert!(v.message.contains("不代表设备已通电出纸"), "绿标要写清判据边界：{}", v.message);
        assert!(!v.message.contains("默认队列"), "点名探到的不该声称是默认队列：{}", v.message);
    }

    /// 队列名逐字匹配、大小写不敏感：差一个字就是另一台机器，必须拦下来并把本机现有的列出来
    #[test]
    fn an_unknown_queue_name_fails_and_lists_what_this_machine_actually_has() {
        let queues = [queue("HP LaserJet 1020", "USB001", 0, true), queue("EPSON LQ-630K", "LPT1:", 0, false)];
        let v = queue_verdict(&queues, Some("hP laserjet 1020"));
        assert!(v.ok, "大小写不该影响命中：{:?}", v);

        let v = queue_verdict(&queues, Some("HP LaserJet M403d"));
        assert!(!v.ok, "本机没有这台队列不能报绿");
        assert!(v.message.contains("HP LaserJet M403d") && v.message.contains("EPSON LQ-630K"), "{}", v.message);

        let v = queue_verdict(&[], Some("任意"));
        assert!(!v.ok && v.message.contains("装好打印机"), "一台队列都没有时要给出下一步：{}", v.message);
    }

    /// 台账没填队列名（手打的设备名不是队列名）时退到默认队列，但这条退让必须写在结论里
    #[test]
    fn an_unnamed_device_falls_back_to_the_default_queue_and_says_so() {
        let queues = [queue("First One", "USB001", 0, false), queue("Default One", "PORTPROMPT:", 0, true)];
        let v = queue_verdict(&queues, None);
        assert!(v.ok && v.message.contains("Default One") && v.message.contains("未填队列名"), "{}", v.message);

        let v = queue_verdict(&queues[..1], Some("   "));
        assert!(v.ok && v.message.contains("First One") && v.message.contains("没有默认队列"), "空白队列名按未填处理：{}", v.message);
    }

    /// 故障位要说清是哪一种，并给出"下一步去哪儿点"：纸路的、暂停的、脱机的各说各的
    #[test]
    fn fault_bits_turn_red_and_name_the_specific_condition() {
        let v = queue_verdict(&[queue("P", "USB002", 16 | 8, false)], Some("P"));
        assert!(!v.ok, "缺纸加卡纸不能报绿：{:?}", v);
        assert!(v.message.contains("缺纸") && v.message.contains("卡纸") && v.message.contains("纸路"), "{}", v.message);

        let v = queue_verdict(&[queue("P", "USB002", 1, false)], Some("P"));
        assert!(!v.ok && v.message.contains("已暂停") && v.message.contains("取消暂停"), "{}", v.message);

        let v = queue_verdict(&[queue("P", "USB002", 128, false)], Some("P"));
        assert!(!v.ok && v.message.contains("脱机") && v.message.contains("电源"), "{}", v.message);
    }

    /// 正在打印 / 省电休眠不是故障：绿标，但那一句要附出来，免得现场以为程序看错了机器
    #[test]
    fn busy_and_power_save_stay_green_with_a_note() {
        let v = queue_verdict(&[queue("P", "USB003", 1024, false)], Some("P"));
        assert!(v.ok && v.message.contains("正在打印"), "正常连打不能报红：{}", v.message);

        let v = queue_verdict(&[queue("P", "USB003", 16777216, false)], Some("P"));
        assert!(v.ok && v.message.contains("省电模式"), "休眠不是故障，但要说明：{}", v.message);

        let v = queue_verdict(&[queue("P", "", 0, false)], Some("P"));
        assert!(v.ok && v.message.contains("端口未知"), "端口为空也不能编出一个端口：{}", v.message);
    }

    /// 状态位照 windi.h 写死，这里在 Windows 上与 windows crate 的同名常量逐位对一遍。
    /// 抄错一位的后果是"好机器报故障"或"故障机器报绿"，肉眼读表看不出来。
    #[cfg(target_os = "windows")]
    #[test]
    fn queue_status_bits_match_the_windows_constants() {
        use windows::Win32::Graphics::Printing as w;
        let pairs: &[(&str, u32)] = &[
            ("已暂停", w::PRINTER_STATUS_PAUSED),
            ("驱动报错", w::PRINTER_STATUS_ERROR),
            ("正在删除", w::PRINTER_STATUS_PENDING_DELETION),
            ("卡纸", w::PRINTER_STATUS_PAPER_JAM),
            ("缺纸", w::PRINTER_STATUS_PAPER_OUT),
            ("等待手动进纸", w::PRINTER_STATUS_MANUAL_FEED),
            ("纸路异常", w::PRINTER_STATUS_PAPER_PROBLEM),
            ("脱机", w::PRINTER_STATUS_OFFLINE),
            ("出纸盒已满", w::PRINTER_STATUS_OUTPUT_BIN_FULL),
            ("不可用", w::PRINTER_STATUS_NOT_AVAILABLE),
            ("缺粉", w::PRINTER_STATUS_NO_TONER),
            ("无法处理当前页", w::PRINTER_STATUS_PAGE_PUNT),
            ("需要人工处理", w::PRINTER_STATUS_USER_INTERVENTION),
            ("内存不足", w::PRINTER_STATUS_OUT_OF_MEMORY),
            ("舱门打开", w::PRINTER_STATUS_DOOR_OPEN),
            ("打印服务器状态未知", w::PRINTER_STATUS_SERVER_UNKNOWN),
            ("打印服务器离线", w::PRINTER_STATUS_SERVER_OFFLINE),
            ("驱动需要更新", w::PRINTER_STATUS_DRIVER_UPDATE_NEEDED),
            ("正在收数据", w::PRINTER_STATUS_IO_ACTIVE),
            ("正忙", w::PRINTER_STATUS_BUSY),
            ("正在打印", w::PRINTER_STATUS_PRINTING),
            ("等待中", w::PRINTER_STATUS_WAITING),
            ("正在处理", w::PRINTER_STATUS_PROCESSING),
            ("正在初始化", w::PRINTER_STATUS_INITIALIZING),
            ("正在预热", w::PRINTER_STATUS_WARMING_UP),
            ("粉将尽", w::PRINTER_STATUS_TONER_LOW),
            ("省电模式", w::PRINTER_STATUS_POWER_SAVE),
        ];
        for (label, expect) in pairs {
            let got = bit_of_label(label).unwrap_or_else(|| panic!("状态表里没有「{label}」这一档"));
            assert_eq!(got, *expect, "「{label}」的状态位与 windows crate 不一致");
        }
        let bad: u32 = BAD_QUEUE_BITS.iter().map(|(b, _)| b).fold(0, |a, b| a | b);
        let neutral: u32 = NEUTRAL_QUEUE_BITS.iter().map(|(b, _)| b).fold(0, |a, b| a | b);
        assert_eq!(bad & neutral, 0, "同一位不能既算故障又算正常态");
    }

    /// 真机冒烟：枚举本机打印队列，逐台按「点名」口径给一次结论（只读状态，不提交作业、不打纸）。
    /// 自动化环境不跑；装机现场要核对"台账里的队列名对不对得上真机"时手动执行：
    /// `cargo test --lib printer::tests::verdict_on_every_real_queue -- --ignored --nocapture`
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "要读真机打印队列，只在装了打印机的机器上手动跑"]
    fn verdict_on_every_real_queue() {
        let queues = list_queues_blocking().expect("应能枚举本机打印队列");
        assert!(!queues.is_empty(), "这台机器一个打印队列都没有");
        for q in &queues {
            let v = queue_verdict(&queues, Some(&q.name));
            println!("{} [端口 {}{} · 状态位 0x{:X}] → ok={} {}", q.name, q.port, if q.is_default { " · 默认" } else { "" }, q.status, v.ok, v.message);
        }
    }
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
    /// 票面折行的头号原因是这个数比实机大，实测入口在「打印模板 → 小票机列数」，
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
