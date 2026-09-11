//! 斯普瑞特（SPRT）80 mm 小票机现场工装。
//!
//! 票面排版全部来自 `ticket-core`（与主程序同一份代码）——"工装能打对而软件打错"
//! 这种差异在本项目里不被允许，所以这里只做参数解析与设备选择。
//!
//! ```shell
//! cargo run -- --list                       # 看有哪些 usbprint 设备
//! cargo run -- --status                     # 只问状态，不出纸
//! cargo run --                              # 打自检票
//! cargo run -- --ticket                     # 打一张样例过磅码单
//! cargo run -- --out probe.bin              # 不出纸，导出字节流（无需设备）
//! cargo run -- --vid 0x0483 --pid 0x5720    # 指定设备
//! cargo run -- --paper p58                  # 换纸宽
//! ```

use std::process::ExitCode;

use escpos::driver::FileDriver;
use ticket_core::device;
use ticket_core::model::{Paper, WeighTicket};
use ticket_core::render::{new_printer, write_self_test, write_weigh_ticket};

fn main() -> ExitCode {
    let args = match Args::parse(std::env::args().skip(1)) {
        Ok(a) => a,
        Err(msg) => {
            eprintln!(
                "参数错误: {msg}\n可用参数: --list --status --ticket --out <file> --vid <hex> --pid <hex> --paper <p80|p58>"
            );
            return ExitCode::from(2);
        }
    };

    match run(args) {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("{e}");
            ExitCode::from(4)
        }
    }
}

fn run(args: Args) -> Result<u8, String> {
    let devices = device::list_devices()?;
    println!("usbprint.sys 枚举到 {} 个设备:", devices.len());
    for (i, d) in devices.iter().enumerate() {
        println!("  [{i}] {}  {}", d.label, d.device_path);
    }
    if args.list {
        return Ok(0);
    }

    // 导出字节流不碰设备，方便离线核对与留档
    if let Some(path) = &args.out {
        return write_to_file(path, &args).map(|_| 0);
    }

    let preferred = match (args.vid, args.pid) {
        (Some(v), Some(p)) => Some((v, p)),
        _ => None,
    };
    let (driver, info) = device::open(preferred)?;

    // 先问状态：现场最需要的是"它到底在不在"，不该被一次打印失败挡住
    let st = device::query_status(&driver);
    println!(
        "状态[{}]: 有应答={} online={} 纸量充足={} {}",
        info.label, st.responding, st.online, st.paper_adequate, st.note
    );
    if let Some(b) = st.raw_byte {
        println!("  ESC/POS 状态字节 = 0x{b:02X}");
    }
    if let Some(v) = st.ioctl {
        println!("  USBPRINT 状态字 = 0x{v:08X}（bit3 缺纸 / bit4 联机 / bit5 故障）");
    }
    if args.status {
        return Ok(0);
    }

    let mut printer = new_printer(driver.clone(), args.paper);
    let result = if args.ticket {
        write_weigh_ticket(&mut printer, &sample_ticket(args.paper))
    } else {
        write_self_test(&mut printer, args.paper, &info.label)
    };
    match result {
        Ok(()) => {
            println!("已提交 → {}", info.label);
            Ok(0)
        }
        Err(e) => Err(format!("写入失败: {e}")),
    }
}

fn write_to_file(path: &str, args: &Args) -> Result<u64, String> {
    // escpos 的 FileDriver 用 append 打开且不创建文件，先自己建好再交给它
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .map_err(|e| format!("创建 {path} 失败: {e}"))?;
    let driver = FileDriver::open(std::path::Path::new(path)).map_err(|e| e.to_string())?;
    let mut printer = new_printer(driver, args.paper);
    if args.ticket {
        write_weigh_ticket(&mut printer, &sample_ticket(args.paper)).map_err(|e| e.to_string())?;
    } else {
        write_self_test(&mut printer, args.paper, "字节流导出").map_err(|e| e.to_string())?;
    }
    let n = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    println!("已写入 {path}（{n} 字节）");
    Ok(n)
}

/// 一张真会出现在窗口里的样例票：字段与前端磅单一致，用于现场判断"版式对不对"。
fn sample_ticket(paper: Paper) -> WeighTicket {
    WeighTicket {
        station_name: "王庄粮站".into(),
        station_code: "WZ-001".into(),
        doc_no: "BD20260911-0032".into(),
        biz_date: "2026-09-11".into(),
        print_time: "2026-09-11 14:58:23".into(),
        scale_no: "1#".into(),
        farmer_name: "张三".into(),
        id_card_masked: "412827****1234".into(),
        plate_no: "豫A12345".into(),
        grain_name: "小麦".into(),
        grade_name: "二等".into(),
        gross_kg: 12345.0,
        tare_kg: 6165.0,
        net_kg: 6180.0,
        moisture: Some(12.5),
        impurity: Some(0.8),
        deduct_kg: 773.0,
        settle_net_kg: 5407.0,
        unit_price: 2.86,
        amount: 15464.02,
        amount_upper: "壹万伍仟肆佰陆拾肆元零贰分".into(),
        weigher: "李四".into(),
        qc_by: "王五".into(),
        cashier: "赵六".into(),
        copy_note: "第一联 客户联".into(),
        is_reprint: false,
        qr_text: "https://example.invalid/w/BD20260911-0032".into(),
        footer_note: "凭单领款，涂改无效".into(),
        paper,
        copies: 1,
        open_drawer: false,
    }
}

struct Args {
    list: bool,
    status: bool,
    ticket: bool,
    out: Option<String>,
    vid: Option<u16>,
    pid: Option<u16>,
    paper: Paper,
}

impl Args {
    fn parse<I: Iterator<Item = String>>(mut it: I) -> Result<Self, String> {
        let mut a = Args {
            list: false,
            status: false,
            ticket: false,
            out: None,
            vid: None,
            pid: None,
            paper: Paper::default(),
        };
        while let Some(k) = it.next() {
            match k.as_str() {
                "--list" => a.list = true,
                "--status" => a.status = true,
                "--ticket" => a.ticket = true,
                "--out" => a.out = Some(it.next().ok_or("--out 缺参数")?),
                "--vid" => a.vid = Some(parse_num(&it.next().ok_or("--vid 缺参数")?)?),
                "--pid" => a.pid = Some(parse_num(&it.next().ok_or("--pid 缺参数")?)?),
                "--paper" => {
                    a.paper = match it.next().ok_or("--paper 缺参数")?.as_str() {
                        "p80" | "80" => Paper::P80,
                        "p58" | "58" => Paper::P58,
                        other => return Err(format!("未知纸宽 {other}")),
                    }
                }
                other => return Err(format!("未知参数 {other}")),
            }
        }
        Ok(a)
    }
}

fn parse_num(s: &str) -> Result<u16, String> {
    let s = s.trim();
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        u16::from_str_radix(hex, 16).map_err(|e| e.to_string())
    } else {
        s.parse::<u16>().map_err(|e| e.to_string())
    }
}
