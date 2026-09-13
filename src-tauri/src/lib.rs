// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod idcard;
mod printer;
mod queue_print;

pub mod auth;
pub mod attachment;
pub mod camera;
pub mod cards;
pub mod dashboard;
pub mod db;
pub mod devices;
pub mod domain;
pub mod ledger;
pub mod masters;
pub mod orders;
pub mod payments;
pub mod prefs;
pub mod qc;
pub mod reports;
pub mod scale;
pub mod search;
pub mod serial;
pub mod settlements;
pub mod system;
pub mod window;

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
        // 只用到"选一个已存在的文件"这一个能力：备份页导入外部副本的原生文件选择框
        .plugin(tauri_plugin_dialog::init())
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
                    if let Some(path) = &report.backup_path {
                        // 覆盖安装后的首次启动往往没有任何待跑脚本（结构没变），
                        // 上面那条迁移日志不会响——快照必须单独留一行，现场翻
                        // startup 输出时能确认"这次安装确实拍了退路"。
                        eprintln!("[banghe] 升级快照已生成：{}", path.display());
                    }
                    if !report.healed.is_empty() {
                        // 只在「脚本内容一字未改、老库记的是换行归一之前的字节哈希」时发生，
                        // 补记一次即永久收敛。留日志是为了现场排查时看得出来。
                        eprintln!("[banghe] 迁移校验和按换行归一补记：{:?}", report.healed);
                    }
                    app.manage(database);
                    app.manage(auth::AuthState::default());
                    // 地磅读线程的归宿：start/stop/status 三个命令共用这一个通道句柄
                    app.manage(scale::ScaleHub::default());
                    // 自动备份线程必须在上面几个 manage 之后起：它第一轮就要取 `Db` 与
                    // 备份目录，早一步只会拿到"数据库尚未就绪"然后整天空转。
                    system::spawn_auto_backup(app.handle().clone());
                    // 托盘：主窗口可以被设成"关闭时藏进去"，所以图标必须在进事件循环之前
                    // 就在。建不出来不拦启动——`window::close_behavior` 会因此回落到退出。
                    if let Err(e) = window::setup_tray(app.handle()) {
                        eprintln!("[banghe] {e}；本次运行的「隐藏到托盘」不可用，关闭窗口一律退出");
                    }
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
            printer::printer_list_queues,
            printer::printer_status,
            printer::printer_self_test,
            printer::print_weigh_ticket,
            printer::print_receipt,
            queue_print::print_receipt_queue,
            camera::camera_list_local,
            auth::auth_login,
            auth::auth_session,
            auth::auth_touch,
            auth::auth_unlock,
            auth::auth_logout,
            auth::auth_change_password,
            auth::auth_reset_password,
            auth::auth_verify_supervisor,
            masters::master_station,
            masters::master_varieties,
            masters::master_warehouses,
            masters::master_slots,
            masters::master_prices,
            masters::master_staff,
            masters::master_save_variety,
            masters::master_delete_variety,
            masters::master_save_warehouse,
            masters::master_save_slot,
            masters::master_save_price,
            masters::master_save_staff,
            masters::master_settings,
            masters::master_save_setting,
            dashboard::dashboard_data,
            orders::party_list,
            orders::party_get,
            orders::party_save,
            orders::party_photo_set,
            orders::party_photo,
            orders::order_get,
            orders::order_open,
            orders::order_list,
            orders::order_create,
            orders::order_capture,
            orders::qc_save,
            orders::qc_list,
            orders::order_settle,
            orders::order_set_grade,
            orders::print_log_add,
            orders::order_void,
            orders::settlement_of_order,
            orders::order_assign_destination,
            cards::card_pool_list,
            cards::card_pool_register,
            cards::card_pool_retire,
            cards::card_issue,
            cards::card_locate,
            cards::card_release,
            reports::report_daily,
            reports::settlement_list,
            ledger::report_ledger,
            ledger::report_quality,
            ledger::report_parties,
            ledger::report_staff,
            settlements::settlement_get,
            settlements::settlement_pending,
            settlements::settlement_credits,
            settlements::payment_add,
            idcard::idcard_status,
            idcard::idcard_read,
            idcard::ic_read,
            system::audit_list,
            system::backup_status,
            system::backup_run,
            system::backup_verify,
            system::backup_reveal,
            system::backup_import,
            system::export_write,
            system::db_health,
            system::restore_preflight,
            system::restore_apply,
            system::app_restart,
            system::app_exit,
            prefs::prefs_read,
            prefs::prefs_write,
            qc::qc_get,
            qc::qc_queue_list,
            devices::device_list,
            devices::device_test,
            devices::device_enabled,
            devices::device_mock,
            devices::device_config_update,
            devices::device_probe_report,
            devices::device_create,
            devices::device_update,
            devices::device_delete,
            payments::payment_list,
            payments::payment_method_dist,
            search::search_global,
            scale::scale_start,
            scale::scale_stop,
            scale::scale_status,
            serial::serial_list
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        // 主窗口的 ✕ 先拦下来，由 `window` 模块按偏好决定是退出还是藏进托盘
        // （外接展示窗不拦，关它就是关它）。
        tauri::RunEvent::WindowEvent { label, event, .. } => {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if label == window::MAIN_LABEL {
                    api.prevent_close();
                    window::on_main_close_requested(app_handle.clone());
                }
            }
        }
        // §7 WAL 收尾：退出时收敛 -wal 文件并更新统计，防止它无限增长
        tauri::RunEvent::Exit => {
            // 串口先还回去：读线程不退，进程就带着开着的 COM 口消失，
            // 下次接上仪表可能直接报"端口被占用"。
            if let Some(hub) = app_handle.try_state::<scale::ScaleHub>() {
                hub.shutdown();
            }
            if let Some(database) = app_handle.try_state::<db::Db>() {
                database.checkpoint_wal();
            }
        }
        _ => {}
    });
}
