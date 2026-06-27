//! tauri command 层 —— 把前端 IPC 调用转给 config / db-driver / ssh-multihop
//!
//! 错误统一返回稳定 i18n key 字符串，前端按 key 翻译（不泄露后端语言）。

pub mod connection;
pub mod query;
pub mod ssh_tofu;
