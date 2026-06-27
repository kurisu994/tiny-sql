//! tiny-sql Tauri 壳
//!
//! 组装层：把前端 IPC 转给 config（加密 store）/ db-driver（MySQL）/ ssh-multihop（隧道）。
//! command 实现见 [`commands`]，全局状态见 [`state`]。

use tauri::Manager;

pub mod commands;
pub mod config;
pub mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // 初始化连接配置加密存储（master key + connections.enc 落在 app data 目录）
            let app_data_dir = app.path().app_data_dir()?;
            let store =
                config::store::ConnectionStore::new(app_data_dir).map_err(std::io::Error::other)?;
            app.manage(state::AppState::new(store));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::connection_list,
            commands::connection::connection_create,
            commands::connection::connection_update,
            commands::connection::connection_delete,
            commands::connection::connection_test,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
