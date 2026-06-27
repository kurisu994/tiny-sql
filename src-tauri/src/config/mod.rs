//! 配置持久化 —— 加密 store 与连接配置 CRUD
//!
//! - [`encryption`]：AES-256-GCM + master key
//! - [`store`]：连接配置整体加密落盘（connections.enc）
//! - [`ssh_known_hosts`]：SSH 信任库（known_hosts.json，明文，TOFU 用）

pub mod encryption;
pub mod ssh_known_hosts;
pub mod store;
