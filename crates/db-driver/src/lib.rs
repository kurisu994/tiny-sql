//! MySQL driver
//!
//! v0.1 vertical slice 只暴露 [`ping_select_1`]：连上 MySQL 跑一条 `SELECT 1`，
//! 用来打通"隧道本地端口 → sqlx → MySQL"这条最小链路。
//!
//! 设计：v0.1 是具体 `struct`/函数，**不抽 `trait Driver`**。v0.2 加 PostgreSQL
//! 时再用 rust-analyzer extract trait（两个实现在手才设计接口，避免抽象提前）。
//!
//! 与隧道的桥接方式：sqlx 不吃自定义 `TcpStream`，所以走"本地 listener 端口 →
//! `mysql://127.0.0.1:port` URL"。ssh-multihop 暴露本地端口，这里用 host=127.0.0.1
//! + 该端口连接即可。直连（无 SSH）时传真实 host:port。

use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions};
use sqlx::ConnectOptions;

/// driver 错误 —— 每个变体对应一个稳定的前端 i18n key
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("error.driver.connect_failed: {0}")]
    ConnectFailed(String),
    #[error("error.driver.query_failed: {0}")]
    QueryFailed(String),
}

impl DriverError {
    pub fn i18n_key(&self) -> &'static str {
        match self {
            Self::ConnectFailed(_) => "error.driver.connect_failed",
            Self::QueryFailed(_) => "error.driver.query_failed",
        }
    }
}

/// 连上 MySQL 跑一条 `SELECT 1`，返回结果（恒为 1）。
///
/// vertical slice 的最小验证：能连、能查就算这条链路通了。
///
/// - `host` / `port`：走隧道时是 `127.0.0.1` + 隧道本地端口；直连时是真实地址
/// - `database`：可空字符串（不指定默认库）
pub async fn ping_select_1(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    database: &str,
) -> Result<i64, DriverError> {
    // 用 ConnectOptions 而非 URL 拼接，避免密码里的特殊字符需要 URL 编码
    let mut opts = MySqlConnectOptions::new()
        .host(host)
        .port(port)
        .username(username)
        .password(password);
    if !database.is_empty() {
        opts = opts.database(database);
    }
    // vertical slice 不需要语句日志
    opts = opts.log_statements(log::LevelFilter::Off);

    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts)
        .await
        .map_err(|e| DriverError::ConnectFailed(e.to_string()))?;

    let row: (i64,) = sqlx::query_as("SELECT 1")
        .fetch_one(&pool)
        .await
        .map_err(|e| DriverError::QueryFailed(e.to_string()))?;

    pool.close().await;
    Ok(row.0)
}
