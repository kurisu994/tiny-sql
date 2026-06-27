//! 应用全局状态 —— 注入到所有 tauri command

use std::sync::Mutex;

use crate::config::store::ConnectionStore;

/// 全局状态。Week 2 只持有连接配置存储；Week 3+ 再加活跃连接 pool / TOFU manager。
pub struct AppState {
    /// 连接配置加密存储。用 Mutex 串行化文件读写（load→改→save 不能并发交错）。
    pub store: Mutex<ConnectionStore>,
}

impl AppState {
    pub fn new(store: ConnectionStore) -> Self {
        Self {
            store: Mutex::new(store),
        }
    }
}
