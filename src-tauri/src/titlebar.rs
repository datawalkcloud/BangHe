//! 原生标题栏跟着界面深浅走。
//!
//! 界面本身早就有深色了（`.dark` 类 + 色板令牌，见 05 §7.4），但窗口上沿那条 Windows 自绘的
//! 标题栏一直留着系统浅色：在 Win11「应用模式=浅色、任务栏=深色」这类混搭下尤其割裂——
//! 用户已经把界面调暗了，头顶却顶着一块白板。
//!
//! **为什么不能用 Tauri 自带的 `window.set_theme()`**（核过本地依赖源码，不是猜的）：
//! Windows 上它的实现只有一句 `Profile.SetPreferredColorScheme`
//! （`wry-0.55.1/src/webview2/mod.rs` 的 `set_theme`），影响的是 WebView2 里的
//! `prefers-color-scheme` 与网页控件配色，整个 tauri / tauri-runtime-wry 里根本没有
//! `DwmSetWindowAttribute`。标题栏的深浅归 DWM 管，只能自己涂。
//!
//! 四条边界：
//!  1. **谁调用就涂谁的标题栏**。命令参数收 `WebviewWindow`，Tauri 按 invoke 来源注入窗口，
//!     所以主窗口与对外大屏窗（单屏时带标题栏）都零接线地各自生效。
//!  2. **深浅的唯一真相在界面侧**。是页面深色还是浅色只有前端知道（模式还可能是"跟随系统"，
//!     值存在本机 localStorage 的 next-themes 里，不在站点库）。所以这里只提供"涂成深/浅"
//!     这一个动作，判定留给 `src/lib/titlebar-native.ts`。
//!  3. **做成装饰性，失败绝不上屏**。`DWMWA_USE_IMMERSIVE_DARK_MODE` 要 Win10 1809+；
//!     这里先按标准值 20 试，报错再按早期实现的 19 试一次（Win10 1809 之前的 SDK 用的就是 19），
//!     两个都失败（老系统、无桌面合成）只回一句 `Err`，前端吞掉——标题栏白着不影响收粮，
//!     为一个颜色弹错误框才是毛病。
//!  4. **不做精确同色**。Win11 还有 `DWMWA_CAPTION_COLOR`/`BORDER_COLOR`/`TEXT_COLOR` 能把
//!     标题栏配成 `--background`，但 Win10 不支持，装了 Win10 的磅房会看到"另一套东西才生效"。
//!     先只要深/浅两态，两边表现一致。

use tauri::WebviewWindow;

/// 把调用方窗口的标题栏涂成深色（`true`）或浅色（`false`）。
#[tauri::command]
pub fn titlebar_set_dark(window: WebviewWindow, dark: bool) -> Result<(), String> {
    apply(window, dark)
}

#[cfg(target_os = "windows")]
fn apply(window: WebviewWindow, dark: bool) -> Result<(), String> {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWINDOWATTRIBUTE,
    };

    let hwnd = window.hwnd().map_err(|e| format!("取窗口句柄失败：{e}"))?;
    // 属性值是一个 BOOL（i32，4 字节）：1 深色、0 浅色。传 u32/BOOL 之外的宽度 DWM 会直接拒。
    let value: i32 = i32::from(dark);
    let mut last = String::new();
    for attribute in [
        DWMWA_USE_IMMERSIVE_DARK_MODE,
        // Win10 1809 之前的非官方值，同一属性的前身
        DWMWINDOWATTRIBUTE(19),
    ] {
        let result = unsafe {
            DwmSetWindowAttribute(
                hwnd,
                attribute,
                &value as *const i32 as *const core::ffi::c_void,
                4,
            )
        };
        match result {
            Ok(()) => return Ok(()),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("系统不允许改标题栏深浅（不影响使用）：{last}"))
}

/// 非 Windows：本产物只出 NSIS 安装包，其它平台没有"标题栏深浅"这个可涂的东西，空操作即可
/// （macOS 的对应做法是 `window.set_theme()`，那条路会连带翻动 WebView2/WKWebView 的
/// `prefers-color-scheme`，与前端自己管的 `.dark` 类打架，不在这里顺手做）。
#[cfg(not(target_os = "windows"))]
fn apply(_window: WebviewWindow, _dark: bool) -> Result<(), String> {
    Ok(())
}
