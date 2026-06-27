//! 配置持久化 —— 加密 store 与连接配置 CRUD
//!
//! - [`encryption`]：AES-256-GCM + master key
//! - [`store`]：连接配置整体加密落盘（connections.enc）

pub mod encryption;
pub mod store;
