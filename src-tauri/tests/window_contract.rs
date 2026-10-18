//! 主窗口关闭行为（`src-tauri/src/window.rs`）的守卫。
//!
//! 这个功能跨了三处：**偏好键名**（前端 `src/lib/window-native.ts` 的常量）、
//! **Rust 的解析口径**、**窗口 label**。任一对不上都不会报错，只会静悄悄地失效——
//! 键名分叉的表现是"设了隐藏，第二天又变回退出"；label 分叉更糟：展示窗要是也叫
//! `main`，关掉外屏就等于关掉整个程序。这两类问题 `cargo check` 与 `tsc` 都抓不到，
//! 所以在这里把三边拉平对账。

use std::fs;
use std::path::{Path, PathBuf};

use banghe_lib::prefs::check_key;
use banghe_lib::window::{CloseBehavior, CLOSE_BEHAVIOR_KEY, MAIN_LABEL};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .expect("src-tauri 的上一级就是仓库根")
}

/// 前端 `window-native.ts` 里 `export const CLOSE_BEHAVIOR_KEY = "..."` 的字面量。
fn frontend_key() -> String {
    let text = fs::read_to_string(repo_root().join("src").join("lib").join("window-native.ts"))
        .expect("读 src/lib/window-native.ts");
    let marker = "CLOSE_BEHAVIOR_KEY = \"";
    let start = text
        .find(marker)
        .unwrap_or_else(|| panic!("前端必须导出 CLOSE_BEHAVIOR_KEY（形如 {marker}...\"）"))
        + marker.len();
    let end = text[start..]
        .find('"')
        .expect("键名有收尾引号")
        + start;
    text[start..end].to_string()
}

/// 前端 `window-native.ts` 里 `DEFAULT_CLOSE_BEHAVIOR` 的字面量。
///
/// 不按带类型注解的完整声明去匹配（`: CloseBehavior` 哪天删了会让测试假失败），
/// 只认 `const DEFAULT_CLOSE_BEHAVIOR` 之后的第一对引号。
fn frontend_default() -> String {
    let text = fs::read_to_string(repo_root().join("src").join("lib").join("window-native.ts"))
        .expect("读 src/lib/window-native.ts");
    let marker = "const DEFAULT_CLOSE_BEHAVIOR";
    let start = text
        .find(marker)
        .unwrap_or_else(|| panic!("前端必须导出 {marker}"))
        + marker.len();
    let open = text[start..].find('"').expect("默认值有起始引号") + start;
    let close = text[open + 1..].find('"').expect("默认值有收尾引号") + open + 1;
    text[open + 1..close].to_string()
}

/// 前端 `display-window.ts` 里展示窗的 label。
fn display_label() -> String {
    let text = fs::read_to_string(repo_root().join("src").join("lib").join("display-window.ts"))
        .expect("读 src/lib/display-window.ts");
    let marker = "DISPLAY_WINDOW_LABEL = \"";
    let start = text
        .find(marker)
        .unwrap_or_else(|| panic!("前端必须导出 DISPLAY_WINDOW_LABEL（形如 {marker}...\"）"))
        + marker.len();
    let end = text[start..].find('"').expect("label 有收尾引号") + start;
    text[start..end].to_string()
}

#[test]
fn close_behavior_key_is_the_same_on_both_sides() {
    let frontend = frontend_key();
    assert_eq!(
        CLOSE_BEHAVIOR_KEY, frontend,
        "前后端键名分叉：偏好会存到一边、读到另一边，设过的隐藏第二天就丢了"
    );
    check_key(CLOSE_BEHAVIOR_KEY).expect("键名要能过 user_preference 的字符集闸门，否则存不进去");
}

#[test]
fn only_hide_is_recognized_everything_else_exits() {
    // 存的是 JSON 字符串，所以带引号
    assert_eq!(CloseBehavior::parse("\"hide\""), CloseBehavior::Hide);
    assert_eq!(CloseBehavior::parse("\"exit\""), CloseBehavior::Exit);
    // 上一版（收进任务栏）存下的名字仍按隐藏处理：改过设置的人不该因为改名就丢掉偏好
    assert_eq!(CloseBehavior::parse("\"minimize\""), CloseBehavior::Hide);
    // 认不出的写法一律回退出：宁可让人退得掉，也不猜一个看不见的进程
    for junk in ["hide", "", "{}", "\"HIDE\"", "\"hide \"", "null", "\"minimize2\""] {
        assert_eq!(
            CloseBehavior::parse(junk),
            CloseBehavior::Exit,
            "偏好原文 {junk:?} 不该被当成隐藏"
        );
    }
}

#[test]
fn out_of_the_box_the_window_hides_to_the_tray() {
    // 出厂口径：没设过的人点 ✕ 是藏进托盘，磅房那台机器本来就该一直开着。
    // 要改这个口径就得连这条一起改——它是产品决定，不是随手可挪的实现细节。
    assert_eq!(
        CloseBehavior::DEFAULT,
        CloseBehavior::Hide,
        "出厂默认被改了：确认这是有意的口径调整，并把前端默认值与界面说明一起改掉"
    );

    let frontend = frontend_default();
    assert_eq!(
        CloseBehavior::DEFAULT.as_str(),
        frontend,
        "前后端默认值分叉：设置页高亮的选项与实际关窗行为会不一致"
    );
    // 默认值还得是一个"写回库里仍认得出来"的写法，否则 Rust 会把它当垃圾退回退出，
    // 界面上却显示成默认——两头对不上，且只在没存过的情况下暴露，很难查
    assert_eq!(
        CloseBehavior::parse(&format!("\"{frontend}\"")),
        CloseBehavior::DEFAULT,
    );
}

#[test]
fn display_window_never_shares_the_main_label() {
    assert_ne!(
        MAIN_LABEL,
        display_label(),
        "展示窗不能叫 main：关闭行为只按 label 分流，同名的后果是关外屏等于退出程序"
    );
}
