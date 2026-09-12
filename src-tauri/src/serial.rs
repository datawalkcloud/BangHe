//! 本机串口枚举（地磅、钱箱等 RS-232 设备登记表单用）
//!
//! 只在 Windows 桌面端真正有设备；浏览器预览没有原生通道，前端据此回退到手动输入，
//! 而不是编一组假 COM 号欺骗现场。

/// 枚举本机可用的串口名称（如 `COM3`、`COM4`）。
///
/// Windows 下按 COM 序号升序排列，方便现场快速找到已接线的那一台。
#[tauri::command]
pub fn serial_list() -> Result<Vec<String>, String> {
    match serialport::available_ports() {
        Ok(ports) => {
            let mut names: Vec<String> = ports.into_iter().map(|p| p.port_name).collect();
            names.sort_by(|a, b| {
                fn com_index(s: &str) -> Option<u32> {
                    s.strip_prefix("COM").or_else(|| s.strip_prefix("com")).and_then(|n| n.parse().ok())
                }
                match (com_index(a), com_index(b)) {
                    (Some(ai), Some(bi)) => ai.cmp(&bi),
                    (Some(_), None) => std::cmp::Ordering::Less,
                    (None, Some(_)) => std::cmp::Ordering::Greater,
                    _ => a.to_lowercase().cmp(&b.to_lowercase()),
                }
            });
            Ok(names)
        }
        Err(e) => Err(format!("枚举串口失败：{}", e)),
    }
}
