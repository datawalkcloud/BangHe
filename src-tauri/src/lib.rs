// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod printer;

pub mod auth;
pub mod db;
pub mod domain;

use tauri::Manager;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 启动顺序：注册插件 → 打开站点库并补齐迁移（03 §6）→ 托管连接 → 注册命令。
/// 迁移失败**不进入事件循环**：宁可启动失败并留下 `startup_error.log`，
/// 也不能让磅房拿着一个结构对不上的库收粮。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 调试构建（tauri dev）放行连错锁定：反复试错不该把账号锁死没法自测，
    // 顺带能把此前已锁的账号直接登进去。release 装机仍按 02 §11 锁定；
    // 单元测试不跑这条启动路径，锁定契约照常由 tests/auth_contract.rs 守着。
    #[cfg(debug_assertions)]
    auth::set_lockout_disabled(true);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| -> Box<dyn std::error::Error> { Box::new(e) })?;
            match db::open_and_migrate(&dir, env!("CARGO_PKG_VERSION")) {
                Ok((database, report)) => {
                    if !report.applied.is_empty() {
                        eprintln!(
                            "[banghe] 数据库结构 {} → {}，已执行 {:?}",
                            report.from_version, report.to_version, report.applied
                        );
                    }
                    if !report.healed.is_empty() {
                        // 只在「脚本内容一字未改、老库记的是换行归一之前的字节哈希」时发生，
                        // 补记一次即永久收敛。留日志是为了现场排查时看得出来。
                        eprintln!("[banghe] 迁移校验和按换行归一补记：{:?}", report.healed);
                    }
                    app.manage(database);
                    app.manage(auth::AuthState::default());
                    Ok(())
                }
                Err(e) => {
                    // 磅房机没有控制台：先把可读提示落盘，再中止启动
                    db::migrate::write_startup_error(&dir, &e);
                    Err(Box::new(e) as Box<dyn std::error::Error>)
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            printer::printer_list,
            printer::printer_status,
            printer::printer_self_test,
            printer::print_weigh_ticket,
            auth::auth_login,
            auth::auth_session,
            auth::auth_touch,
            auth::auth_logout,
            auth::auth_change_password,
            auth::auth_reset_password,
            auth::auth_verify_supervisor
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // §7 WAL 收尾：退出时收敛 -wal 文件并更新统计，防止它无限增长
        if let tauri::RunEvent::Exit = event {
            if let Some(database) = app_handle.try_state::<db::Db>() {
                database.checkpoint_wal();
            }
        }
    });
}
