// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 诊断入口：`banghe.exe --update-channel` 只打印分发通道回值就退出——不进事件循环、
    // 不抢单实例互斥、不碰数据库。MSIX 打包验证就是解包后用它在**包内 exe**上断言
    // store-build feature 确实编进了这个二进制（常规双击永远碰不到这个参数）。
    if std::env::args().nth(1).as_deref() == Some("--update-channel") {
        println!("{}", banghe_lib::system::app_update_channel());
        return;
    }
    banghe_lib::run()
}
