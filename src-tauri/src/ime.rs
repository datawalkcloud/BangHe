//! 窗口拿到焦点就把输入法切回英文态——扫码枪是一支键盘，中文输入法会吞它的按键。
//!
//! 现场证据（2026-10-07，磅房那台机）：票面印 `BH1:BD01202610000053`，枪打进来是
//! `BH：BD1202610000053`。开着中文输入法时，`B`、`H` 进了拼音合成串，紧跟的 `1` 被当成
//! **候选项序号键**吃掉，冒号被折成全角；合成没结束前落下的数字还会继续被当候选键吞。
//! 一支枪的按键就这样被系统改写了——而它根本不是人在打字。
//!
//! 前端已经做了两件事（`src/hooks/useScannerCapture.ts`）：看到合成事件当场说破"请切英文"，
//! 解析侧也只放宽了版本位那一格（`BH:` 也认）。但这两条都救不回被吞掉的**数字**，
//! 所以必须有一个不再复发的层次：窗口一拿到焦点，就把这个窗口的输入法置成关闭态
//! （英文态）。
//!
//! 三条边界：
//!  1. **只翻开关，不换输入法**。`ImmSetOpenStatus(FALSE)` 改的是"当前输入法处于中文还是英文"，
//!     操作员选的是微软拼音还是搜狗、系统里装了哪几种，一概不动。要中文照样按 Shift 切回去，
//!     本模块不抢这个方向盘，只在窗口聚焦这一刻给一个安全的初值。
//!  2. **只作用于本窗口的 IME 上下文**。`ImmGetContext(hwnd)` 拿的是这个窗口的上下文，
//!     不碰别的程序，也不 `ImmAssociateContext(NULL)` 那样把输入法整个解绑（那样会连
//!     手打中文都做不了——改价事由、农户姓名都要打字）。
//!  3. **失败一律不上屏**。没有输入法、老系统、上下文取不到，全都静默返回：
//!     切不动只是少了一道保护，票面码仍然能扫（前端那两条容错在），
//!     为这个给磅员弹错误框才是毛病。与 `titlebar.rs` 第 3 条同规。

/// 把 `window` 这个窗口的输入法置成英文（关闭）态。跨平台入口，非 Windows 上是空操作。
pub fn force_alphanumeric(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::Input::Ime::{ImmGetContext, ImmReleaseContext, ImmSetOpenStatus};

        let Ok(hwnd) = window.hwnd() else { return };
        unsafe {
            let ctx = ImmGetContext(hwnd);
            // 空句柄 = 这个窗口没有输入法上下文（没装中文输入法，或焦点还没落到可输入的宿主上）
            if !ctx.is_invalid() {
                // 两个 BOOL 都刻意丢弃：翻不动只是少一道保护（票面码仍能被前端那两条容错救回来），
                // 为这个给磅员弹错误框才是毛病——见文件头边界 3。
                let _ = ImmSetOpenStatus(ctx, false);
                let _ = ImmReleaseContext(hwnd, ctx);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}
