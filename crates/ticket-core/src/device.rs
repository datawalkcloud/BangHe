//! Windows 小票机设备访问：枚举 / 打开 / 取状态。
//!
//! 通道选择说明（04 文档 §5.2 通道 C）：这里**不走打印队列**，而是直接打开
//! Windows 自带的 `usbprint.sys` 类驱动设备接口。好处是驱动不参与渲染、RAW 字节
//! 一定直达打印机，也不会排在别人的打印任务后面；代价是拿不到队列名，
//! 所以"系统里那张 80mm Series Printer 队列"只能作为安装是否到位的旁证。
//!
//! 类型（`DeviceInfo` / `DeviceStatus`）在所有平台可见，函数只有 Windows 有实现：
//! 这样 Tauri 命令层不必为非 Windows 再抄一份返回结构。

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    /// usbprint.sys 设备接口路径，打开设备用它
    pub device_path: String,
    pub vendor_id: Option<u16>,
    pub product_id: Option<u16>,
    /// 现场可读的名字：VID/PID + 机身序列号
    pub label: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    /// 是否拿到合法的 ESC/POS 状态应答
    pub responding: bool,
    pub online: bool,
    pub paper_adequate: bool,
    /// 状态来源：escpos（DLE EOT 有应答）/ ioctl（仅类驱动状态字）/ none
    pub source: String,
    pub raw_byte: Option<u8>,
    pub ioctl: Option<u32>,
    /// 给人看的下一步提示，设备中心直接展示
    pub note: String,
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{DeviceInfo, DeviceStatus};
    use std::collections::HashMap;
    use std::time::{Duration, Instant};

    use escpos::driver::{Driver, WindowsUsbPrintDriver};
    use escpos::utils::{RealTimeStatusRequest, RealTimeStatusResponse, DLE, EOT};

    /// 枚举当前挂在 usbprint.sys 上的打印机（不含网络打印机与用厂商私有驱动的设备）。
    pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
        let raw =
            WindowsUsbPrintDriver::list().map_err(|e| format!("枚举 usbprint 设备失败: {e}"))?;
        Ok(raw
            .into_iter()
            .map(|d| DeviceInfo {
                label: describe(&d),
                device_path: d.device_path,
                vendor_id: d.vendor_id,
                product_id: d.product_id,
            })
            .collect())
    }

    /// 打开设备：优先用配置里记住的 VID/PID，失配时退回第一台并把实际设备名回传，
    /// 这样换 USB 口 / 换机器时"打印测试"仍出票，而不是瘫在一条旧配置上。
    pub fn open(
        preferred: Option<(u16, u16)>,
    ) -> Result<(WindowsUsbPrintDriver, DeviceInfo), String> {
        let devices = list_devices()?;
        if devices.is_empty() {
            return Err(
                "未发现 usbprint.sys 设备：确认打印机已开机、USB 线插好，且设备管理器里是「USB 打印支持」而非厂商私有驱动"
                    .to_string(),
            );
        }
        let hit = match preferred {
            Some((vid, pid)) => devices
                .iter()
                .find(|d| d.vendor_id == Some(vid) && d.product_id == Some(pid)),
            None => devices.first(),
        };
        let info = hit.cloned().unwrap_or_else(|| devices[0].clone());
        let driver = WindowsUsbPrintDriver::open(&info.device_path)
            .map_err(|e| format!("打开小票机失败（被占用或已掉线？）: {e}"))?;
        Ok((driver, info))
    }

    /// 一次 `DLE EOT n` 实时状态查询：发命令后在超时窗口内反复读，只接受能被 ESC/POS
    /// 认出的合法应答字节（形如 `0xx1xx10`）。读不到返回 `None`，由调用方决定退路。
    ///
    /// 三个实测坑都压在这里：
    /// 1. `DLE EOT n` 只有三字节。escpos 的 `(n, a)` 里 `a` 只给 Ink/Peeler/Interface 这类
    ///    双操作数请求使用，给 Printer 也补一个 `0x00` 会被打印机当成数据吐到票面上；
    /// 2. 打开设备后第一次 bulk-IN 读到的常是脏字节（实测 0x2B），读一次就下结论必然误判；
    /// 3. `ReadFile` 在这条栈上可能返回 0 字节或直接报错（escpos 已在文档里承认这点），
    ///    所以要轮询到超时为止，而不是把"这次没读到"当成"这台机不回状态"。
    fn ask_realtime(
        driver: &WindowsUsbPrintDriver,
        req: RealTimeStatusRequest,
    ) -> Option<(u8, HashMap<RealTimeStatusResponse, bool>)> {
        let (n, second): (u8, u8) = req.into();
        let mut cmd = vec![DLE, EOT, n];
        if second != 0 {
            cmd.push(second);
        }
        // 一轮 250 ms 没读到就重发一次：兼容机首条查询常被上电后的握手吃掉
        for _ in 0..2 {
            if driver.write(&cmd).is_err() {
                return None;
            }
            let deadline = Instant::now() + Duration::from_millis(250);
            while Instant::now() < deadline {
                let mut b = [0u8; 1];
                match driver.read(&mut b) {
                    Ok(1) => {
                        if let Ok(flags) = RealTimeStatusResponse::parse(req, b[0]) {
                            return Some((b[0], flags));
                        }
                        // 脏字节：丢掉继续读，绝不拿它当状态用
                    }
                    // 没数据 / 读失败：让出 CPU 再试，别立刻判定设备不回话
                    Ok(_) => std::thread::sleep(Duration::from_millis(5)),
                    Err(_) => std::thread::sleep(Duration::from_millis(5)),
                }
            }
        }
        None
    }

    /// 用 `DLE EOT` 问实时状态；问不到才退回 usbprint 类驱动状态字。
    ///
    /// 退路只用来回答"设备在不在"，**不用来断言纸量**：IEEE-1284 那几位在不同厂商的
    /// 兼容机上定义并不一致（本机实测 0x18 时纸是满的），拿它报"缺纸"等于让现场对着
    /// 假告警拆纸仓。纸量没有 ESC/POS 应答时一律标成未确认，由人工判断。
    pub fn query_status(driver: &WindowsUsbPrintDriver) -> DeviceStatus {
        let mut st = DeviceStatus::default();

        let printer = ask_realtime(driver, RealTimeStatusRequest::Printer);
        let paper = ask_realtime(driver, RealTimeStatusRequest::RollPaperSensor);

        if let Some((byte, flags)) = &printer {
            st.responding = true;
            st.source = "escpos".into();
            st.raw_byte = Some(*byte);
            st.online = *flags.get(&RealTimeStatusResponse::Online).unwrap_or(&false);
        }
        if let Some((_, flags)) = &paper {
            st.paper_adequate = *flags
                .get(&RealTimeStatusResponse::RollPaperNearEndSensorPaperAdequate)
                .unwrap_or(&true);
        }

        if st.responding {
            if paper.is_none() {
                st.note = "纸卷传感器无应答（部分兼容机不支持），纸量以人工确认为准".into();
            } else if !st.online {
                st.note = "设备已应答但报告未联机：检查脱机键、上盖与纸卷".into();
            }
            return st;
        }

        match driver.lpt_status() {
            Ok(v) => {
                st.source = "ioctl".into();
                st.ioctl = Some(v);
                // bit4 联机位：本机实测与真实状态一致，可以拿来说"设备在不在"
                st.online = v & 0x10 != 0;
                // 纸量位不可信 → 不告警，界面据 source != escpos 显示"未确认"
                st.paper_adequate = true;
                st.note = if st.online {
                    "打印机未按 ESC/POS 回状态，改用 usbprint 类驱动状态字：设备在且联机位为 1；纸量该位不可信，以人工确认为准".into()
                } else {
                    "打印机未按 ESC/POS 回状态，类驱动联机位为 0：可能真脱机，也可能是该机位定义不同".into()
                };
            }
            Err(e) => {
                st.source = "none".into();
                st.note = format!("设备未回状态且 IOCTL 失败: {e}");
            }
        }
        st
    }

    fn describe(d: &escpos::driver::WindowsUsbPrintInfo) -> String {
        let vid = d
            .vendor_id
            .map(|v| format!("0x{v:04X}"))
            .unwrap_or_else(|| "VID-?".into());
        let pid = d
            .product_id
            .map(|v| format!("0x{v:04X}"))
            .unwrap_or_else(|| "PID-?".into());
        match serial_of(&d.device_path) {
            Some(s) => format!("{vid}:{pid} #{s}"),
            None => format!("{vid}:{pid}"),
        }
    }

    /// 设备路径形如 `\\?\usb#vid_0483&pid_5720#11101800002#{guid}`，第三段是机身序列号。
    fn serial_of(path: &str) -> Option<String> {
        let mut it = path.split('#');
        it.next(); // "\\?\usb"
        it.next(); // "vid_0483&pid_5720"
        it.next()
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    }
}

#[cfg(target_os = "windows")]
pub use imp::{list_devices, open, query_status};

/// Windows 打印机的驱动句柄类型；非 Windows 用 ConsoleDriver 占位，只为让类型统一可编译。
#[cfg(target_os = "windows")]
pub type UsbDriver = escpos::driver::WindowsUsbPrintDriver;
#[cfg(not(target_os = "windows"))]
pub type UsbDriver = escpos::driver::ConsoleDriver;

#[cfg(not(target_os = "windows"))]
pub fn list_devices() -> Result<Vec<DeviceInfo>, String> {
    Err("小票机通道仅支持 Windows（依赖系统自带 usbprint.sys）".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn open(_preferred: Option<(u16, u16)>) -> Result<(UsbDriver, DeviceInfo), String> {
    Err("小票机通道仅支持 Windows（依赖系统自带 usbprint.sys）".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn query_status(_driver: &UsbDriver) -> DeviceStatus {
    DeviceStatus {
        source: "none".into(),
        note: "当前平台不支持 usbprint 通道".into(),
        ..Default::default()
    }
}
