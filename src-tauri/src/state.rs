//! 应用全局状态 —— 注入到所有 tauri command

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use db_driver::{
    ColumnMeta, DatabaseMeta, Driver, DriverCloseFuture, DriverFuture, DriverKind, DriverSession,
    MetadataScope, MySqlDriver, PostgresDriver, QueryOptions, RowSet, SchemaMeta, TableBrowseQuery,
    TableBrowseResult, TableMeta,
};
use ssh_multihop::SshTunnel;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::config::history::HistoryStore;
use crate::config::ssh_known_hosts::SshKnownHostsStore;
use crate::config::store::ConnectionStore;
use crate::security::SecurityManager;
use crate::tofu::SshTofuManager;

/// 活跃连接持有的具体数据库 driver。
///
/// 使用显式 enum 保留 MySQL 方言专属能力（如 CREATE DATABASE），同时为通用
/// metadata/query 路径实现对象安全 [`Driver`] 契约。
#[derive(Clone)]
pub enum ActiveDriver {
    MySql(MySqlDriver),
    PostgreSql(PostgresDriver),
}

impl ActiveDriver {
    /// 取得 MySQL 具体实现；非 MySQL 返回 None。
    pub fn as_mysql(&self) -> Option<&MySqlDriver> {
        match self {
            Self::MySql(driver) => Some(driver),
            Self::PostgreSql(_) => None,
        }
    }
}

impl Driver for ActiveDriver {
    fn kind(&self) -> DriverKind {
        match self {
            Self::MySql(driver) => Driver::kind(driver),
            Self::PostgreSql(driver) => Driver::kind(driver),
        }
    }

    fn ping(&self) -> DriverFuture<'_, i64> {
        match self {
            Self::MySql(driver) => Driver::ping(driver),
            Self::PostgreSql(driver) => Driver::ping(driver),
        }
    }

    fn list_databases(&self) -> DriverFuture<'_, Vec<DatabaseMeta>> {
        match self {
            Self::MySql(driver) => Driver::list_databases(driver),
            Self::PostgreSql(driver) => Driver::list_databases(driver),
        }
    }

    fn list_schemas<'a>(&'a self, database: &'a str) -> DriverFuture<'a, Vec<SchemaMeta>> {
        match self {
            Self::MySql(driver) => Driver::list_schemas(driver, database),
            Self::PostgreSql(driver) => Driver::list_schemas(driver, database),
        }
    }

    fn list_tables<'a>(&'a self, scope: &'a MetadataScope) -> DriverFuture<'a, Vec<TableMeta>> {
        match self {
            Self::MySql(driver) => Driver::list_tables(driver, scope),
            Self::PostgreSql(driver) => Driver::list_tables(driver, scope),
        }
    }

    fn list_columns<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ColumnMeta>> {
        match self {
            Self::MySql(driver) => Driver::list_columns(driver, scope, table),
            Self::PostgreSql(driver) => Driver::list_columns(driver, scope, table),
        }
    }

    fn query<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, RowSet> {
        match self {
            Self::MySql(driver) => Driver::query(driver, sql, options, cancel_token),
            Self::PostgreSql(driver) => Driver::query(driver, sql, options, cancel_token),
        }
    }

    fn begin_session(&self) -> DriverFuture<'_, Box<dyn DriverSession>> {
        match self {
            Self::MySql(driver) => Driver::begin_session(driver),
            Self::PostgreSql(driver) => Driver::begin_session(driver),
        }
    }

    fn browse_table<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        query: &'a TableBrowseQuery,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, TableBrowseResult> {
        match self {
            Self::MySql(driver) => {
                Driver::browse_table(driver, scope, table, query, cancel_token)
            }
            Self::PostgreSql(driver) => {
                Driver::browse_table(driver, scope, table, query, cancel_token)
            }
        }
    }

    fn close(&self) -> DriverCloseFuture<'_> {
        match self {
            Self::MySql(driver) => Driver::close(driver),
            Self::PostgreSql(driver) => Driver::close(driver),
        }
    }
}

/// 一条已打开的活跃连接 —— driver（pool）与隧道生命周期绑定。
///
/// **字段声明顺序即 drop 顺序**：`driver` 在前先 drop（关 pool），`tunnel` 在后
/// （关 listener / session）。反过来先关隧道会让 pool 刷一堆 EOF 错误。
/// 干净关闭走 [`OpenConnection::close`]（先 await pool 关闭再落 tunnel）。
pub struct OpenConnection {
    pub driver: ActiveDriver,
    /// 直连时为 None；走 SSH 时持有隧道，保活到连接关闭
    pub tunnel: Option<SshTunnel>,
    /// 每次成功打开都生成的新代号，用于隔离重连前后的异步事件。
    pub session_id: String,
}

/// 正在执行的查询及其所属连接，用于关闭 / 重连时按连接取消。
pub struct ActiveQuery {
    pub connection_id: String,
    pub cancel_token: CancellationToken,
}

/// 一个活跃事务 session（FR-244）：绑定 connection_id 下某条物理连接。
/// 外层 Arc + 锁保证同一 session 语句串行；连接关闭 / 重连时统一 close（自动回滚）。
pub struct ActiveSession {
    pub connection_id: String,
    pub session: tokio::sync::Mutex<Box<dyn DriverSession>>,
}

impl OpenConnection {
    /// 干净关闭：先 await 关闭连接池，再 drop 隧道（满足「先 pool 后 tunnel」）。
    pub async fn close(self) {
        Driver::close(&self.driver).await;
        drop(self.tunnel);
    }
}

/// 全局状态。
pub struct AppState {
    /// 连接配置加密存储。用 Mutex 串行化文件读写（load→改→save 不能并发交错）。
    pub store: Mutex<ConnectionStore>,
    /// 已打开的活跃连接注册表：connection_id → OpenConnection。
    pub connections: AsyncMutex<HashMap<String, OpenConnection>>,
    /// 每条连接独立的 open/close/reconnect 生命周期锁，不阻塞其他连接查询。
    connection_lifecycles: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    /// 正在执行的 query：query_id → 连接边界与 cancel token。
    pub queries: AsyncMutex<HashMap<String, ActiveQuery>>,
    /// 活跃事务 session：session_id → session 句柄（FR-244）。
    pub sessions: AsyncMutex<HashMap<String, std::sync::Arc<ActiveSession>>>,
    /// SSH known_hosts 信任库（TOFU）。
    pub known_hosts: Arc<SshKnownHostsStore>,
    /// TOFU 决策管理器（前端弹窗回调通道）。
    pub tofu: Arc<SshTofuManager>,
    /// 会话内 passphrase 缓存：connection_id → passphrase（NFR-011：仅内存不落盘；
    /// 主密码启用后可通过 secrets map 加密持久化）。
    pub passphrases: Mutex<HashMap<String, Zeroizing<String>>>,
    /// 用户主密码与派生 key 状态机（FR-102）。
    pub security: Arc<SecurityManager>,
    /// SQL 历史加密存储（FR-106）。
    pub history: HistoryStore,
}

impl AppState {
    pub fn new(
        store: ConnectionStore,
        known_hosts: SshKnownHostsStore,
        security: Arc<SecurityManager>,
        history: HistoryStore,
    ) -> Self {
        Self {
            store: Mutex::new(store),
            connections: AsyncMutex::new(HashMap::new()),
            connection_lifecycles: Mutex::new(HashMap::new()),
            queries: AsyncMutex::new(HashMap::new()),
            sessions: AsyncMutex::new(HashMap::new()),
            known_hosts: Arc::new(known_hosts),
            tofu: Arc::new(SshTofuManager::default()),
            passphrases: Mutex::new(HashMap::new()),
            security,
            history,
        }
    }

    /// 获取指定连接的生命周期锁；同 id 串行，不同 id 可并发。
    pub fn connection_lifecycle(&self, id: &str) -> Arc<AsyncMutex<()>> {
        self.connection_lifecycles
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_driver_implements_common_driver_contract() {
        fn assert_driver<T: Driver>() {}

        assert_driver::<ActiveDriver>();
    }
}
