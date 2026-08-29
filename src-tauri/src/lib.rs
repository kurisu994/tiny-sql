//! tiny-sql Tauri 壳
//!
//! 组装层：把前端 IPC 转给 config（加密 store）/ db-driver（三数据库 Driver）/ ssh-multihop（隧道）。
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
#[cfg(desktop)]
const SETTINGS_MENU_ID: &str = "settings";
#[cfg(desktop)]
const SETTINGS_EVENT: &str = "app:open-settings";

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
        // 设置项紧随「检查更新」，用 macOS 惯用的 Cmd+, 快捷键
        let settings = MenuItem::with_id(
            app.handle(),
            SETTINGS_MENU_ID,
            "Settings...",
            true,
            Some("CmdOrCtrl+,"),
        )?;
        app_menu.insert(&settings, 2)?;
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
        } else if event.id() == SETTINGS_MENU_ID {
            let _ = app.emit(SETTINGS_EVENT, ());
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
            commands::query::db_schema_overview,
            commands::query::db_query,
            commands::query::db_query_cancel,
            commands::query::db_query_many,
            commands::query::db_browse_table,
            commands::query::db_apply_table_edits,
            commands::import::csv_import_preview,
            commands::import::db_import_csv,
            commands::dump::db_export_dump,
            commands::dump::db_import_dump,
            commands::backup::backup_probe_tools,
            commands::backup::db_backup_export,
            commands::backup::db_backup_restore,
            commands::copy::db_copy_preview,
            commands::copy::db_copy_table_rows,
            commands::privilege::db_list_accounts,
            commands::privilege::db_show_grants,
            commands::ssh_tofu::ssh_tofu_decision,
            commands::security::security_status,
            commands::security::security_setup,
            commands::security::security_unlock,
            commands::security::security_lock,
            commands::security::security_disable,
            commands::security::security_reset,
            commands::share::connection_share_export,
            commands::share::connection_share_preview,
            commands::share::connection_share_import,
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

#[cfg(test)]
mod tests {
    use std::time::Duration;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    /// 更新代理的 socks5 支持契约。
    ///
    /// tauri-plugin-updater 内部的 reqwest 默认不带 socks feature，靠本 crate 在
    /// Cargo.toml 里显式依赖 reqwest 并启用 socks 来统一打开。缺了它 reqwest 不会
    /// 报错，而是把 socks5:// 地址当成普通 HTTP 代理发 CONNECT——用户只会看到更新
    /// 失败，很难定位。所以这里不测「地址能否解析」（`Proxy::all` 对任何 scheme
    /// 都返回 Ok），而是搭一个假代理看 reqwest 实际先说哪种协议：
    /// socks5 握手首字节是 0x05，HTTP CONNECT 则是 ASCII 'C'(0x43)。
    #[tokio::test]
    async fn socks5_proxy_speaks_socks_handshake_not_http_connect() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        // 假代理只读首字节就够判断协议，不需要真的实现 socks
        let probe = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut first = [0u8; 1];
            socket.read_exact(&mut first).await.ok();
            first[0]
        });

        // 插件启用的是 rustls-no-provider：构建 Client 前必须先装 provider，
        // 与 tauri-plugin-updater 运行时的做法一致（ring）
        let _ = rustls::crypto::ring::default_provider().install_default();

        let client = reqwest::Client::builder()
            .proxy(reqwest::Proxy::all(format!("socks5://{addr}")).unwrap())
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        // 目标写 IP 而非域名：socks5（非 socks5h）由客户端本地解析 DNS，
        // 用不可解析的域名会在连代理之前就失败。假代理不会回应，请求必然
        // 超时；这里只关心它发出的第一个字节。
        let _ = client.get("http://127.0.0.1:9/latest.json").send().await;

        let first = tokio::time::timeout(Duration::from_secs(5), probe)
            .await
            .expect("假代理未收到连接")
            .unwrap();
        assert_eq!(
            first, 0x05,
            "reqwest 未走 socks 握手（首字节 {first:#04x}），\
             说明 reqwest 的 socks feature 未启用，检查 Cargo.toml 的 reqwest 依赖"
        );
    }
}
