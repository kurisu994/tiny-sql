//! 应用全局状态 —— 注入到所有 tauri command

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tokio::task::JoinHandle;

use db_driver::{
    ColumnMeta, ConstraintMeta, DatabaseMeta, Driver, DriverCloseFuture, DriverFuture, DriverKind,
    DriverSession, IndexMeta, MetadataScope, MySqlDriver, PostgresDriver, QueryOptions, RowSet,
    SchemaMeta, SqliteDriver, TableBrowseQuery, TableBrowseResult, TableMeta,
};
use ssh_multihop::SshTunnel;
use tokio::sync::Mutex as AsyncMutex;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

use crate::config::history::HistoryStore;
use crate::config::recent_files::RecentFilesStore;
use crate::config::ssh_known_hosts::SshKnownHostsStore;
use crate::config::store::ConnectionStore;
use crate::security::SecurityManager;
use crate::tofu::SshTofuManager;

/// 活跃连接持有的具体数据库 driver。
///
/// 使用显式 enum 保留方言专属能力（如 MySQL 的 CREATE DATABASE），同时为通用
/// metadata/query 路径实现对象安全 [`Driver`] 契约 —— 通用方法统一委托给
/// [`ActiveDriver::inner`]，新增 driver 只需在 `inner` 里加一条分支。
#[derive(Clone)]
pub enum ActiveDriver {
    MySql(MySqlDriver),
    PostgreSql(PostgresDriver),
    Sqlite(SqliteDriver),
}

impl ActiveDriver {
    /// 取得 MySQL 具体实现；非 MySQL 返回 None。
    pub fn as_mysql(&self) -> Option<&MySqlDriver> {
        match self {
            Self::MySql(driver) => Some(driver),
            Self::PostgreSql(_) | Self::Sqlite(_) => None,
        }
    }

    /// 通用 [`Driver`] 契约的委托目标。
    fn inner(&self) -> &dyn Driver {
        match self {
            Self::MySql(driver) => driver,
            Self::PostgreSql(driver) => driver,
            Self::Sqlite(driver) => driver,
        }
    }
}

impl Driver for ActiveDriver {
    fn kind(&self) -> DriverKind {
        self.inner().kind()
    }

    fn ping(&self) -> DriverFuture<'_, i64> {
        self.inner().ping()
    }

    fn list_databases(&self) -> DriverFuture<'_, Vec<DatabaseMeta>> {
        self.inner().list_databases()
    }

    fn list_schemas<'a>(&'a self, database: &'a str) -> DriverFuture<'a, Vec<SchemaMeta>> {
        self.inner().list_schemas(database)
    }

    fn list_tables<'a>(&'a self, scope: &'a MetadataScope) -> DriverFuture<'a, Vec<TableMeta>> {
        self.inner().list_tables(scope)
    }

    fn list_columns<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ColumnMeta>> {
        self.inner().list_columns(scope, table)
    }

    fn list_indexes<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<IndexMeta>> {
        self.inner().list_indexes(scope, table)
    }

    fn list_constraints<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ConstraintMeta>> {
        self.inner().list_constraints(scope, table)
    }

    fn query<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, RowSet> {
        self.inner().query(sql, options, cancel_token)
    }

    fn begin_session(&self) -> DriverFuture<'_, Box<dyn DriverSession>> {
        self.inner().begin_session()
    }

    fn browse_table<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        query: &'a TableBrowseQuery,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, TableBrowseResult> {
        self.inner().browse_table(scope, table, query, cancel_token)
    }

    fn query_many<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, db_driver::MultiQueryResult> {
        self.inner().query_many(sql, options, cancel_token)
    }

    fn apply_table_edits<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        pk_columns: &'a [String],
        edits: &'a [db_driver::TableEdit],
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, db_driver::ApplyEditsResult> {
        self.inner()
            .apply_table_edits(scope, table, pk_columns, edits, cancel_token)
    }

    fn bulk_insert_rows<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        columns: &'a [String],
        rows: &'a [Vec<Option<String>>],
        transactional: bool,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, db_driver::BulkInsertResult> {
        self.inner()
            .bulk_insert_rows(scope, table, columns, rows, transactional, cancel_token)
    }

    fn close(&self) -> DriverCloseFuture<'_> {
        self.inner().close()
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
    /// 低频 SELECT 1 采样；关闭或 drop 时 abort，避免泄漏到下一 session。
    pub db_rtt_task: Option<JoinHandle<()>>,
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
    /// 干净关闭：先停 RTT 采样，再 await 关闭连接池；隧道随字段 drop 释放。
    pub async fn close(mut self) {
        self.abort_db_rtt();
        Driver::close(&self.driver).await;
    }

    fn abort_db_rtt(&mut self) {
        if let Some(task) = self.db_rtt_task.take() {
            task.abort();
        }
    }
}

impl Drop for OpenConnection {
    fn drop(&mut self) {
        self.abort_db_rtt();
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
    /// 最近打开的 SQL 文件列表（FR-240，明文路径）。
    pub recent_files: RecentFilesStore,
}

impl AppState {
    pub fn new(
        store: ConnectionStore,
        known_hosts: SshKnownHostsStore,
        security: Arc<SecurityManager>,
        history: HistoryStore,
        recent_files: RecentFilesStore,
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
            recent_files,
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
