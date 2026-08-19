//! 配置持久化 —— 加密 store 与连接配置 CRUD
//!
//! - [`encryption`]：AES-256-GCM + master key / Argon2id 主密码 KDF
//! - [`store`]：连接配置整体加密落盘（connections.enc）
//! - [`history`]：SQL 历史整体加密落盘（history.enc，FR-106）
//! - [`ssh_known_hosts`]：SSH 信任库（known_hosts.json，明文，TOFU 用）

pub mod encryption;
pub mod history;
pub mod ssh_known_hosts;
pub mod store;
