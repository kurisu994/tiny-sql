//! 应用全局状态 —— 注入到所有 tauri command

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use db_driver::MySqlDriver;
use ssh_multihop::SshTunnel;
use tokio::sync::Mutex as AsyncMutex;

use crate::config::ssh_known_hosts::SshKnownHostsStore;
use crate::config::store::ConnectionStore;
use crate::tofu::SshTofuManager;

/// 一条已打开的活跃连接 —— driver（pool）与隧道生命周期绑定。
///
/// **字段声明顺序即 drop 顺序**：`driver` 在前先 drop（关 pool），`tunnel` 在后
/// （关 listener / session）。反过来先关隧道会让 pool 刷一堆 EOF 错误。
/// 干净关闭走 [`OpenConnection::close`]（先 await pool 关闭再落 tunnel）。
pub struct OpenConnection {
    pub driver: MySqlDriver,
    /// 直连时为 None；走 SSH 时持有隧道，保活到连接关闭
    pub tunnel: Option<SshTunnel>,
}

impl OpenConnection {
    /// 干净关闭：先 await 关闭连接池，再 drop 隧道（满足「先 pool 后 tunnel」）。
    pub async fn close(self) {
        self.driver.close().await;
        drop(self.tunnel);
    }
}

/// 全局状态。
pub struct AppState {
    /// 连接配置加密存储。用 Mutex 串行化文件读写（load→改→save 不能并发交错）。
    pub store: Mutex<ConnectionStore>,
    /// 已打开的活跃连接注册表：connection_id → OpenConnection。
    pub connections: AsyncMutex<HashMap<String, OpenConnection>>,
    /// SSH known_hosts 信任库（TOFU）。
    pub known_hosts: Arc<SshKnownHostsStore>,
    /// TOFU 决策管理器（前端弹窗回调通道）。
    pub tofu: Arc<SshTofuManager>,
    /// 会话内 passphrase 缓存：connection_id → passphrase（NFR-011：仅内存不落盘）。
    pub passphrases: Mutex<HashMap<String, String>>,
}

impl AppState {
    pub fn new(store: ConnectionStore, known_hosts: SshKnownHostsStore) -> Self {
        Self {
            store: Mutex::new(store),
            connections: AsyncMutex::new(HashMap::new()),
            known_hosts: Arc::new(known_hosts),
            tofu: Arc::new(SshTofuManager::default()),
            passphrases: Mutex::new(HashMap::new()),
        }
    }
}
