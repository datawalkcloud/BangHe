//! 主窗口「点 ✕ 之后干什么」：退出程序，还是藏进系统托盘（通知区）。
//!
//! 磅房这台机器一开就是一整天。窗口右上角的 ✕ 被顺手点到、或者只是想腾一下桌面，
//! 程序就跟着退了——地磅线程要重起、登录要重来、录到一半的单停在半路。所以把
//! "点 ✕ 干什么"做成一项**个人偏好**（`user_preference`，键 [`CLOSE_BEHAVIOR_KEY`]），
//! 由 Rust 在窗口真被关掉之前拦一次：选了隐藏就 `prevent_close` 再 `hide`。
//!
//! 三条边界是刻意的：
//!  1. **只认主窗口**。外接展示窗（`display`，在 `src/lib/display-window.ts` 里另起）
//!     关了就是关了，拦下来只会留一个没画面的空窗口。按 label 分流写在 `lib.rs` 里——
//!     进到本模块的请求已经确定是主窗口的。
//!  2. **读不到就按退出**。库没就绪、会话已失效、值不是这两个之一，一律退出：
//!     "想退退不掉"比"想留没留住"严重得多，前者只能去任务管理器杀进程。
//!  3. **托盘建不起来也按退出**（[`TRAY_READY`]）。隐藏之后托盘是**唯一**的回路，
//!     图标没建成就把窗口藏掉，等于把这个进程弄丢——宁可那天 ✕ 还是退出。
//!
//! 托盘上另挂了「显示主窗口」与「退出程序」两项：前者是隐藏后的回路，后者是收工的出口
//! （设成隐藏之后 ✕ 就退不掉了，界面上的「退出程序」按钮与这里各留一个）。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::auth;
use crate::db::{locked, Db};
use crate::prefs;

/// 主窗口的 label。Tauri 默认主窗口就叫 `main`，外接展示窗另起一个，不归本模块管。
pub const MAIN_LABEL: &str = "main";

/// 托盘图标的 id，与它服务的窗口共用"主"这个身份。
const TRAY_ID: &str = "main";

/// 偏好键，与前端 `src/lib/window-native.ts` 的 `CLOSE_BEHAVIOR_KEY` 同源
/// （`tests/window_contract.rs` 钉着两边一致）。值是 JSON 字符串：`"exit"` / `"hide"`。
pub const CLOSE_BEHAVIOR_KEY: &str = "window.close-behavior";

/// 托盘是否真的建起来了。建不起来就绝不允许隐藏——见模块头第 3 条。
static TRAY_READY: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseBehavior {
    /// 直接退出程序。历史默认行为，也是读不到偏好时的回落。
    Exit,
    /// 藏进系统托盘：窗口与任务栏按钮都收起来，只在右下角留个图标，点它回来。
    Hide,
}

impl CloseBehavior {
    /// 库里**没存过**这一行时的行为：藏进托盘。
    ///
    /// 这是产品口径而不是安全口径——磅房那台机器本来就该一直开着。它与下面两类
    /// "读不到"是两回事，别混：
    ///  - 没登录 / 库没就绪 / 读失败 → 仍回 [`CloseBehavior::Exit`]（见 [`close_behavior`]）；
    ///  - 存了但值认不出来 → 也回 `Exit`（见 [`CloseBehavior::parse`]）。
    /// 只有"这个人从没设过"才用默认值，那时藏起来是可预期的：托盘上有图标，回得来。
    pub const DEFAULT: Self = Self::Hide;

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Exit => "exit",
            Self::Hide => "hide",
        }
    }

    /// 从偏好原文解析。库里那行是 JSON 文本（`"hide"` 带引号），认不出的一律回落
    /// [`CloseBehavior::Exit`]——不认识的写法宁可退回"能退得掉"，也不猜。
    ///
    /// `"minimize"` 也认：那是上一版（收进任务栏）存下的名字，语义同为"不退出程序"，
    /// 一并按隐藏处理，免得改过设置的人第二天发现自己的偏好失效了。
    pub fn parse(raw: &str) -> Self {
        match serde_json::from_str::<String>(raw).as_deref() {
            Ok("hide") | Ok("minimize") => Self::Hide,
            _ => Self::Exit,
        }
    }
}

/// 当前登录人对主窗口 ✕ 的偏好。任何一环拿不到（库没就绪 / 没登录 / 读失败）都回
/// [`CloseBehavior::Exit`]；偏好是隐藏但托盘没建起来时同样回它。
pub fn close_behavior(app: &AppHandle) -> CloseBehavior {
    let Some(database) = app.try_state::<Db>() else {
        return CloseBehavior::Exit;
    };
    // 没登录就谈不上"本人偏好"。这条同时保证了老老实实的退路：退出登录后点 ✕ 一定退得掉。
    let Some(actor) = auth::current_actor(app) else {
        return CloseBehavior::Exit;
    };
    let pool = database.shared();
    let stored = match locked(&pool, |conn| prefs::read(conn, actor.id, CLOSE_BEHAVIOR_KEY)) {
        Ok(Some(raw)) => CloseBehavior::parse(&raw),
        // 没存过 → 用默认值；读失败 → 退出（读失败意味着库有问题，宁可让人退得掉）
        Ok(None) => CloseBehavior::DEFAULT,
        Err(_) => CloseBehavior::Exit,
    };
    if stored == CloseBehavior::Hide && !TRAY_READY.load(Ordering::SeqCst) {
        return CloseBehavior::Exit;
    }
    stored
}

/// 主窗口的关闭请求落到这儿。**先拦后判**：`prevent_close` 由 `lib.rs` 在调用前就调了，
/// 判定（要读一次库）放到后台线程，判完再决定是 `hide` 还是 `app.exit`。
///
/// 顺序不能反过来：自动备份正拿着库锁做 `VACUUM INTO` 的那几秒，同步读会把界面卡成
/// "未响应"——而那几秒恰恰是用户最以为没关掉、想再点一次 ✕ 的时候。拦下来之后
/// 窗口只是多留一瞬，不会假死，也不会在判定出来前就把程序退掉。
pub fn on_main_close_requested(app: AppHandle) {
    std::thread::spawn(move || match close_behavior(&app) {
        CloseBehavior::Exit => app.exit(0),
        CloseBehavior::Hide => {
            if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                let _ = window.hide();
            }
        }
    });
}

/// 把主窗口叫回来：先解最小化再显示，最后抢一次焦点——藏在托盘里的时候用户点图标
/// 就是要它出现在最前面，不抢焦点会变成"点了没反应"。
pub fn show_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_LABEL) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// 建托盘图标。失败只回 `Err`、不拦启动（由调用方决定怎么办）：建不出托盘的后果仅仅是
/// "隐藏"这一项不可用，[`close_behavior`] 会自动回落到退出，程序照常能用。
///
/// 图标取 `default_window_icon`（由 `tauri.conf.json` 的 `bundle.icon` 生成并内嵌），
/// 这样开发态与装机后都是同一份位图，不必再为托盘单独带一个资源文件。
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let icon = app
        .default_window_icon()
        .cloned()
        .map(|image| image.to_owned())
        .ok_or_else(|| "取不到默认窗口图标，托盘没有可显示的图标".to_string())?;

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)
        .map_err(|e| format!("托盘菜单项创建失败：{e}"))?;
    let quit = MenuItem::with_id(app, "quit", "退出程序", true, None::<&str>)
        .map_err(|e| format!("托盘菜单项创建失败：{e}"))?;
    let menu = MenuBuilder::new(app)
        .items(&[&show, &quit])
        .build()
        .map_err(|e| format!("托盘菜单创建失败：{e}"))?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("磅禾粮站收粮系统")
        .menu(&menu)
        // 左键单击 = 唤回主窗口，右键才弹菜单：与"点一下图标就该回来"的直觉一致
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| format!("托盘图标创建失败：{e}"))?;

    TRAY_READY.store(true, Ordering::SeqCst);
    Ok(())
}
