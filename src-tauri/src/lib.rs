//! tiny-sql Tauri 壳
//!
//! 组装层：把前端 IPC 转给 config（加密 store）/ db-driver（MySQL）/ ssh-multihop（隧道）。
//! command 实现见 [`commands`]，全局状态见 [`state`]。

#[cfg(desktop)]
use tauri::Emitter;
use tauri::Manager;

pub mod commands;
pub mod config;
pub mod security;
pub mod state;
pub mod tofu;

#[cfg(desktop)]
const CHECK_UPDATE_MENU_ID: &str = "check_update";
#[cfg(desktop)]
const CHECK_UPDATE_EVENT: &str = "app:check-update";

#[cfg(target_os = "macos")]
fn setup_app_menu<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};

    let menu = Menu::default(app.handle())?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let check_update = MenuItem::with_id(
            app.handle(),
            CHECK_UPDATE_MENU_ID,
            "Check for Updates...",
            true,
            None::<&str>,
        )?;
        app_menu.insert(&check_update, 1)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    let builder = builder.on_menu_event(|app, event| {
        if event.id() == CHECK_UPDATE_MENU_ID {
            let _ = app.emit(CHECK_UPDATE_EVENT, ());
        }
    });

    builder
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            #[cfg(target_os = "macos")]
            setup_app_menu(app)?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // 初始化主密码安全管理、连接配置加密存储、SQL 历史与 SSH 信任库
            // （security.json / master.key / connections.enc / history.enc /
            // known_hosts.json 都落在 app data 目录）
            let app_data_dir = app.path().app_data_dir()?;
            let security = std::sync::Arc::new(
                security::SecurityManager::new(app_data_dir.clone())
                    .map_err(std::io::Error::other)?,
            );
            let store = config::store::ConnectionStore::new(app_data_dir.clone(), security.clone())
                .map_err(std::io::Error::other)?;
            let history =
                config::history::HistoryStore::new(app_data_dir.clone(), security.clone());
            let recent_files = config::recent_files::RecentFilesStore::new(app_data_dir.clone());
            let known_hosts = config::ssh_known_hosts::SshKnownHostsStore::new(app_data_dir);
            app.manage(state::AppState::new(
                store,
                known_hosts,
                security,
                history,
                recent_files,
            ));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connection::connection_list,
            commands::connection::connection_create,
            commands::connection::connection_update,
            commands::connection::connection_delete,
            commands::connection::connection_test,
            commands::connection::connection_open,
            commands::connection::connection_reconnect,
            commands::connection::connection_close,
            commands::query::db_list_databases,
            commands::query::db_list_schemas,
            commands::query::db_create_database,
            commands::query::db_list_tables,
            commands::query::db_list_columns,
            commands::query::db_list_indexes,
            commands::query::db_list_constraints,
            commands::query::db_query,
            commands::query::db_query_cancel,
            commands::query::db_query_many,
            commands::query::db_browse_table,
            commands::query::db_apply_table_edits,
            commands::ssh_tofu::ssh_tofu_decision,
            commands::security::security_status,
            commands::security::security_setup,
            commands::security::security_unlock,
            commands::security::security_lock,
            commands::security::security_disable,
            commands::security::security_reset,
            commands::history::history_list,
            commands::history::history_clear,
            commands::export::db_export_query,
            commands::transaction::transaction_begin,
            commands::transaction::transaction_query,
            commands::transaction::transaction_commit,
            commands::transaction::transaction_rollback,
            commands::transaction::transaction_close,
            commands::sql_file::sql_file_read,
            commands::sql_file::sql_file_write,
            commands::sql_file::sql_file_recent_list,
            commands::sql_file::sql_file_recent_touch,
            commands::sql_file::sql_file_recent_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
