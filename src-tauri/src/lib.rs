//! tiny-sql Tauri 壳 —— v0.1 vertical slice
//!
//! 只有一个 command [`test_select_1`]：把前端传来的连接信息（可选多跳 SSH +
//! MySQL 目标）打通到 MySQL，跑一条 `SELECT 1`，回传结果字符串给前端。
//! 验证"前端 → command → ssh-multihop → db-driver → MySQL"这条最小链路。

use serde::Deserialize;
use ssh_multihop::{SshAuth, SshHop};

pub mod config;

/// 前端传入的单跳配置
#[derive(Debug, Deserialize)]
struct HopInput {
    host: String,
    port: u16,
    username: String,
    /// "password" | "privateKey"
    auth_type: String,
    password: Option<String>,
    private_key_path: Option<String>,
    passphrase: Option<String>,
}

/// 前端传入的整条连接配置
#[derive(Debug, Deserialize)]
struct ConnectInput {
    /// 为空则直连 MySQL（不走 SSH），方便本地快速验证
    #[serde(default)]
    hops: Vec<HopInput>,
    mysql_host: String,
    mysql_port: u16,
    user: String,
    #[serde(default)]
    password: String,
    #[serde(default)]
    database: String,
}

impl HopInput {
    /// 转成 ssh-multihop 的 SshHop；auth_type 非法时返回 i18n key
    fn into_hop(self) -> Result<SshHop, String> {
        let auth = match self.auth_type.as_str() {
            "password" => SshAuth::Password(self.password.unwrap_or_default()),
            "privateKey" => SshAuth::PrivateKey {
                path: self.private_key_path.unwrap_or_default(),
                passphrase: self.passphrase,
            },
            _ => return Err("error.ssh.invalid_auth_type".to_string()),
        };
        Ok(SshHop {
            host: self.host,
            port: self.port,
            username: self.username,
            auth,
        })
    }
}

/// vertical slice 核心命令：连上 MySQL 跑 SELECT 1。
///
/// 返回 `Ok("SELECT 1 = 1")` 表示整条链路打通；`Err(i18n_key)` 由前端翻译。
#[tauri::command]
async fn test_select_1(input: ConnectInput) -> Result<String, String> {
    let result = if input.hops.is_empty() {
        // 直连：跳过 SSH，直接连 MySQL
        db_driver::ping_select_1(
            &input.mysql_host,
            input.mysql_port,
            &input.user,
            &input.password,
            &input.database,
        )
        .await
        .map_err(|e| e.i18n_key().to_string())?
    } else {
        // 多跳 SSH：先建隧道，再连隧道的本地端口
        let hops: Vec<SshHop> = input
            .hops
            .into_iter()
            .map(HopInput::into_hop)
            .collect::<Result<_, _>>()?;
        let tunnel = ssh_multihop::open(&hops, &input.mysql_host, input.mysql_port)
            .await
            .map_err(|e| e.i18n_key().to_string())?;
        let addr = tunnel.local_addr();
        db_driver::ping_select_1(
            &addr.ip().to_string(),
            addr.port(),
            &input.user,
            &input.password,
            &input.database,
        )
        .await
        .map_err(|e| e.i18n_key().to_string())?
        // tunnel 在此 drop，关闭 listener 与 session
    };

    Ok(format!("SELECT 1 = {result}"))
}

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![test_select_1])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
