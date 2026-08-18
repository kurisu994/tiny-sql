//! MySQL driver
//!
//! 设计：v0.1 是具体 `struct MySqlDriver`，**不抽 `trait Driver`**。v0.2 加 PostgreSQL
//! 时再用 rust-analyzer extract trait（两个实现在手才设计接口，避免抽象提前）。
//!
//! 与隧道的桥接方式：sqlx 不吃自定义 `TcpStream`，所以走"本地 listener 端口 →
//! `mysql://127.0.0.1:port` URL"。ssh-multihop 暴露本地端口，这里用 host=127.0.0.1
//! + 该端口连接即可。直连（无 SSH）时传真实 host:port。
//!
//! Week 2 范围：connect / ping / list_databases / list_tables / list_columns / query。
//! query 的防 OOM 由「顶层安全时追加 LIMIT + 客户端 10w 行截断」组成；
//! 取消走独立 control connection 发 KILL QUERY。

use std::str::FromStr;
use std::time::Duration;

use futures_util::TryStreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::{Column, ConnectOptions, Executor, MySqlPool, Row, TypeInfo, ValueRef};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

/// 表浏览默认服务端行数上限（FR-021）。
pub const TABLE_PREVIEW_LIMIT: usize = 1_000;

/// SQL 编辑器客户端硬上限（FR-022）。
pub const QUERY_RESULT_LIMIT: usize = 100_000;

const CONTROL_QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// driver 错误 —— 每个变体对应一个稳定的前端 i18n key（NFR-041：key 只能加不能改名）
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("error.driver.connect_failed: {0}")]
    ConnectFailed(String),
    #[error("error.driver.query_failed: {0}")]
    QueryFailed(String),
    #[error("error.driver.invalid_sql")]
    InvalidSql,
    #[error("error.driver.multiple_statements")]
    MultipleStatements,
    #[error("error.driver.write_requires_confirmation")]
    WriteRequiresConfirmation,
    #[error("error.driver.query_cancelled")]
    QueryCancelled,
    #[error("error.driver.invalid_identifier")]
    InvalidIdentifier,
}

impl DriverError {
    pub fn i18n_key(&self) -> &'static str {
        match self {
            Self::ConnectFailed(_) => "error.driver.connect_failed",
            Self::QueryFailed(_) => "error.driver.query_failed",
            Self::InvalidSql => "error.driver.invalid_sql",
            Self::MultipleStatements => "error.driver.multiple_statements",
            Self::WriteRequiresConfirmation => "error.driver.write_requires_confirmation",
            Self::QueryCancelled => "error.driver.query_cancelled",
            Self::InvalidIdentifier => "error.driver.invalid_identifier",
        }
    }
}

/// SQL 执行选项。
#[derive(Debug, Clone, Copy)]
pub struct QueryOptions {
    /// 最多返回多少行；后端会强制 clamp 到 `1..=QUERY_RESULT_LIMIT`。
    pub row_limit: usize,
    /// 非 SELECT/CTE 语句是否已由前端完成二次确认。
    pub allow_write: bool,
}

impl Default for QueryOptions {
    fn default() -> Self {
        Self {
            row_limit: QUERY_RESULT_LIMIT,
            allow_write: false,
        }
    }
}

impl QueryOptions {
    pub fn table_preview() -> Self {
        Self {
            row_limit: TABLE_PREVIEW_LIMIT,
            allow_write: false,
        }
    }

    fn effective_limit(self) -> usize {
        self.row_limit.clamp(1, QUERY_RESULT_LIMIT)
    }
}

/// 单个 database（MySQL 里 schema 与 database 同义）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseMeta {
    pub name: String,
}

/// 单张表的元信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub name: String,
    /// "BASE TABLE" / "VIEW" 等
    pub table_type: String,
    /// information_schema 给的估算行数（视图或不可估算时为 None）
    pub rows: Option<i64>,
    pub comment: Option<String>,
}

/// 单列的元信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// 完整列类型，如 "varchar(255)" / "int unsigned"
    pub data_type: String,
    pub nullable: bool,
    /// 索引标记："PRI" / "UNI" / "MUL" / ""
    pub column_key: String,
    pub default_value: Option<String>,
    pub comment: Option<String>,
}

/// 查询结果集 —— v0.1 所有单元格统一转成字符串展示，None 表示 SQL NULL
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowSet {
    /// 列名（按查询顺序）
    pub columns: Vec<String>,
    /// 行数据，外层是行、内层是列；None = NULL
    pub rows: Vec<Vec<Option<String>>>,
    /// 是否因客户端硬上限被截断
    pub truncated: bool,
}

/// MySQL driver —— v0.1 具体实现，v0.2 extract 为 trait Driver。
///
/// 内部持有 `sqlx::MySqlPool`（max_connections = 5）。直连传真实 host:port；
/// 走隧道时 host=127.0.0.1 + 隧道本地端口。`MySqlPool` 内部是 Arc，`Clone`
/// 只增引用计数，便于在 AppState 注册表外短暂取出执行查询而不长持锁。
#[derive(Clone)]
pub struct MySqlDriver {
    pool: MySqlPool,
    /// 独立 control pool：只用于 `KILL QUERY`，不从主 pool 借连接，避免主 pool 满时取消也卡住。
    control_pool: MySqlPool,
}

/// MySQL SSL 模式。默认禁用以适配内网 MySQL；需要 TLS 时由连接配置显式启用。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MySqlTlsMode {
    #[default]
    Disabled,
    Preferred,
    Required,
    VerifyCa,
    VerifyIdentity,
}

impl MySqlTlsMode {
    fn to_sqlx(self) -> MySqlSslMode {
        match self {
            Self::Disabled => MySqlSslMode::Disabled,
            Self::Preferred => MySqlSslMode::Preferred,
            Self::Required => MySqlSslMode::Required,
            Self::VerifyCa => MySqlSslMode::VerifyCa,
            Self::VerifyIdentity => MySqlSslMode::VerifyIdentity,
        }
    }
}

impl FromStr for MySqlTlsMode {
    type Err = DriverError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "disabled" => Ok(Self::Disabled),
            "preferred" => Ok(Self::Preferred),
            "required" => Ok(Self::Required),
            "verify_ca" => Ok(Self::VerifyCa),
            "verify_identity" => Ok(Self::VerifyIdentity),
            _ => Err(DriverError::ConnectFailed(format!(
                "invalid mysql ssl mode: {value}"
            ))),
        }
    }
}

/// MySQL 连接参数。除账号/地址外的可选项集中在这里，便于 UI 配置逐步接线。
#[derive(Debug, Clone, Default)]
pub struct MySqlConnectSettings {
    pub ssl_mode: MySqlTlsMode,
    pub ssl_ca_path: Option<String>,
    pub ssl_client_cert_path: Option<String>,
    pub ssl_client_key_path: Option<String>,
    pub connect_timeout: Option<Duration>,
}

impl MySqlDriver {
    /// 建立连接池。`database` 为空字符串表示不指定默认库。
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        database: &str,
    ) -> Result<Self, DriverError> {
        Self::connect_with_settings(
            host,
            port,
            username,
            password,
            database,
            MySqlConnectSettings::default(),
        )
        .await
    }

    /// 按指定连接参数建立连接池。`database` 为空字符串表示不指定默认库。
    pub async fn connect_with_settings(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        database: &str,
        settings: MySqlConnectSettings,
    ) -> Result<Self, DriverError> {
        // 用 ConnectOptions 而非 URL 拼接，避免密码里的特殊字符需要 URL 编码
        let mut opts = MySqlConnectOptions::new()
            .host(host)
            .port(port)
            .username(username)
            .password(password);
        if !database.is_empty() {
            opts = opts.database(database);
        }
        // 默认禁用 TLS 以兼容内网 MySQL；用户显式选择 SSL 模式时按配置启用。
        opts = opts
            .ssl_mode(settings.ssl_mode.to_sqlx())
            .log_statements(log::LevelFilter::Off);
        if let Some(path) = non_empty_path(settings.ssl_ca_path.as_deref()) {
            opts = opts.ssl_ca(path);
        }
        if let Some(path) = non_empty_path(settings.ssl_client_cert_path.as_deref()) {
            opts = opts.ssl_client_cert(path);
        }
        if let Some(path) = non_empty_path(settings.ssl_client_key_path.as_deref()) {
            opts = opts.ssl_client_key(path);
        }

        let pool = connect_pool(opts.clone(), 5, settings.connect_timeout).await?;
        let control_pool = connect_pool(opts, 1, settings.connect_timeout).await?;

        Ok(Self { pool, control_pool })
    }

    /// 用完整 `mysql://` URL 建立连接池。
    ///
    /// integration 测试用 `TINY_SQL_TEST_MYSQL_URL`，未来隧道桥接也走本地端口 URL。
    pub async fn connect_url(url: &str) -> Result<Self, DriverError> {
        let opts = mysql_options_from_url(url)?;
        let pool = MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(opts.clone())
            .await
            .map_err(|e| DriverError::ConnectFailed(e.to_string()))?;
        let control_pool = MySqlPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(opts)
            .await
            .map_err(|e| DriverError::ConnectFailed(e.to_string()))?;
        Ok(Self { pool, control_pool })
    }

    /// 跑一条 `SELECT 1`，用于连接测试。
    pub async fn ping(&self) -> Result<i64, DriverError> {
        let row: (i64,) = sqlx::query_as("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(row.0)
    }

    /// 列出所有可见 database。
    pub async fn list_databases(&self) -> Result<Vec<DatabaseMeta>, DriverError> {
        let rows = sqlx::query_as::<_, (String,)>(
            "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|(name,)| DatabaseMeta { name })
            .collect())
    }

    /// 创建 database。库名使用反引号安全转义；字符集 / 排序规则只允许 MySQL 标识符字符。
    pub async fn create_database(
        &self,
        name: &str,
        charset: Option<&str>,
        collation: Option<&str>,
    ) -> Result<(), DriverError> {
        let sql = build_create_database_sql(name, charset, collation)?;
        sqlx::query(&sql)
            .execute(&self.pool)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(())
    }

    /// 列出指定 database 下的所有表。
    pub async fn list_tables(&self, database: &str) -> Result<Vec<TableMeta>, DriverError> {
        // table_rows 是 BIGINT UNSIGNED，CAST 成 SIGNED 避免 unsigned 解码踩坑
        let rows = sqlx::query_as::<_, (String, String, Option<i64>, Option<String>)>(
            "SELECT table_name, table_type, CAST(table_rows AS SIGNED), table_comment \
             FROM information_schema.tables \
             WHERE table_schema = ? ORDER BY table_name",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|(name, table_type, rows, comment)| TableMeta {
                name,
                table_type,
                rows,
                comment,
            })
            .collect())
    }

    /// 列出指定表的所有列。
    pub async fn list_columns(
        &self,
        database: &str,
        table: &str,
    ) -> Result<Vec<ColumnMeta>, DriverError> {
        let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>, Option<String>)>(
            "SELECT column_name, column_type, is_nullable, column_key, column_default, column_comment \
             FROM information_schema.columns \
             WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(
                |(name, data_type, is_nullable, column_key, default_value, comment)| ColumnMeta {
                    name,
                    data_type,
                    nullable: is_nullable.eq_ignore_ascii_case("YES"),
                    column_key,
                    default_value,
                    comment,
                },
            )
            .collect())
    }

    /// 执行 SQL，返回结果集。默认用于 SQL 编辑器：最多返回 10w 行，非 SELECT 需显式确认。
    pub async fn query(&self, sql: &str) -> Result<RowSet, DriverError> {
        self.query_with_options(sql, QueryOptions::default(), CancellationToken::new())
            .await
    }

    /// 执行 SQL，支持顶层安全追加 LIMIT、10w 硬上限与 `KILL QUERY` 取消。
    pub async fn query_with_options(
        &self,
        sql: &str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        let prepared = prepare_query_sql(sql, options)?;
        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        let mysql_thread_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;

        match prepared.kind {
            PreparedSqlKind::Read {
                limit,
                server_capped,
            } => {
                self.fetch_read_rows(
                    &prepared.sql,
                    limit,
                    server_capped,
                    &mut conn,
                    mysql_thread_id,
                    cancel_token,
                )
                .await
            }
            PreparedSqlKind::Write => {
                self.execute_write(&prepared.sql, &mut conn, mysql_thread_id, cancel_token)
                    .await
            }
        }
    }

    async fn fetch_read_rows(
        &self,
        sql: &str,
        limit: usize,
        server_capped: bool,
        conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
        mysql_thread_id: u64,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        // 用已持有的连接 describe，不从同一个 pool 再借第二个连接
        //（并发查询占满 pool 时会互相等 describe 的 acquire 造成整体卡死）
        let mut columns: Vec<String> = (&mut **conn)
            .describe(sql)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?
            .columns()
            .iter()
            .map(|c| c.name().to_string())
            .collect();

        let mut rows = sqlx::query(sql).fetch(&mut **conn);
        let mut data: Vec<Vec<Option<String>>> = Vec::new();
        let mut truncated = false;

        loop {
            tokio::select! {
                row = rows.try_next() => {
                    let Some(row) = row.map_err(|e| DriverError::QueryFailed(e.to_string()))? else {
                        break;
                    };
                    // SHOW PROCESSLIST / EXPLAIN 等语句 prepare 阶段拿不到列元信息
                    //（describe 返回空列），从首行数据补齐列名
                    if columns.is_empty() {
                        columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                    }
                    if data.len() >= limit {
                        truncated = true;
                        break;
                    }
                    data.push((0..row.columns().len()).map(|i| cell_to_string(&row, i)).collect());
                }
                _ = cancel_token.cancelled() => {
                    drop(rows);
                    self.kill_query(mysql_thread_id).await;
                    return Err(DriverError::QueryCancelled);
                }
            }
        }

        // 服务端没有 LIMIT 兜底时客户端截断会留下未读完的大结果集，
        // 归还连接前 KILL 止损，避免 sqlx 在下次使用时 drain 全量行（多跳隧道上代价高）
        if truncated && !server_capped {
            drop(rows);
            self.kill_query(mysql_thread_id).await;
        }

        Ok(RowSet {
            columns,
            rows: data,
            truncated,
        })
    }

    async fn execute_write(
        &self,
        sql: &str,
        conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
        mysql_thread_id: u64,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        tokio::select! {
            result = sqlx::query(sql).execute(&mut **conn) => {
                let result = result.map_err(|e| DriverError::QueryFailed(e.to_string()))?;
                Ok(RowSet {
                    columns: vec!["affected_rows".to_string(), "last_insert_id".to_string()],
                    rows: vec![vec![
                        Some(result.rows_affected().to_string()),
                        Some(result.last_insert_id().to_string()),
                    ]],
                    truncated: false,
                })
            }
            _ = cancel_token.cancelled() => {
                self.kill_query(mysql_thread_id).await;
                Err(DriverError::QueryCancelled)
            }
        }
    }

    /// 从独立 control pool 发 KILL QUERY；取消路径不再向用户暴露二次失败。
    async fn kill_query(&self, mysql_thread_id: u64) {
        let sql = format!("KILL QUERY {mysql_thread_id}");
        let _ = tokio::time::timeout(
            CONTROL_QUERY_TIMEOUT,
            sqlx::query(&sql).execute(&self.control_pool),
        )
        .await;
    }

    /// 关闭连接池。
    pub async fn close(&self) {
        self.pool.close().await;
        self.control_pool.close().await;
    }
}

fn mysql_options_from_url(url: &str) -> Result<MySqlConnectOptions, DriverError> {
    let mut opts: MySqlConnectOptions = url
        .parse()
        .map_err(|e: sqlx::Error| DriverError::ConnectFailed(e.to_string()))?;
    if !url_has_ssl_mode(url) {
        opts = opts.ssl_mode(MySqlSslMode::Disabled);
    }
    Ok(opts.log_statements(log::LevelFilter::Off))
}

async fn connect_pool(
    opts: MySqlConnectOptions,
    max_connections: u32,
    connect_timeout: Option<Duration>,
) -> Result<MySqlPool, DriverError> {
    let fut = MySqlPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts);
    match connect_timeout {
        Some(duration) => timeout(duration, fut)
            .await
            .map_err(|_| DriverError::ConnectFailed("connection timeout".to_string()))?
            .map_err(|e| DriverError::ConnectFailed(e.to_string())),
        None => fut
            .await
            .map_err(|e| DriverError::ConnectFailed(e.to_string())),
    }
}

fn non_empty_path(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn build_create_database_sql(
    name: &str,
    charset: Option<&str>,
    collation: Option<&str>,
) -> Result<String, DriverError> {
    let name = validate_database_name(name)?;
    let mut sql = format!("CREATE DATABASE {}", quote_mysql_identifier(name));

    if let Some(charset) = normalize_mysql_option_ident(charset)? {
        sql.push_str(" DEFAULT CHARACTER SET = ");
        sql.push_str(charset);
    }
    if let Some(collation) = normalize_mysql_option_ident(collation)? {
        sql.push_str(" DEFAULT COLLATE = ");
        sql.push_str(collation);
    }

    Ok(sql)
}

fn validate_database_name(name: &str) -> Result<&str, DriverError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.contains('\0') {
        return Err(DriverError::InvalidIdentifier);
    }
    Ok(name)
}

fn normalize_mysql_option_ident(value: Option<&str>) -> Result<Option<&str>, DriverError> {
    let Some(value) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        Ok(Some(value))
    } else {
        Err(DriverError::InvalidIdentifier)
    }
}

fn quote_mysql_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn url_has_ssl_mode(url: &str) -> bool {
    url.split_once('?')
        .map(|(_, query)| {
            query.split('&').any(|part| {
                let key = part.split_once('=').map_or(part, |(key, _)| key);
                key.eq_ignore_ascii_case("ssl-mode")
            })
        })
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreparedSqlKind {
    /// 返回结果集的语句（SELECT / WITH / SHOW / EXPLAIN / DESC）：fetch 行流。
    /// `server_capped` 表示已在语句末尾追加服务端 LIMIT；false 时靠客户端截断兜底。
    Read {
        limit: usize,
        server_capped: bool,
    },
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedSql {
    sql: String,
    kind: PreparedSqlKind,
}

/// 分析并改写 SQL：
/// - 拒绝空 SQL / 多语句；
/// - SELECT / WITH 在顶层安全时追加 LIMIT（不做 derived table 包装——
///   `SELECT *` JOIN 的重名列在包装后会报 1060 Duplicate column name）；
/// - SHOW / EXPLAIN / DESC 等元数据语句按读处理，返回结果集且无需写确认；
/// - 其余语句仅在 `allow_write=true` 时执行，作为 best-effort 写操作二次确认。
fn prepare_query_sql(sql: &str, options: QueryOptions) -> Result<PreparedSql, DriverError> {
    let sanitized = strip_literals_and_comments(sql);
    let sanitized_stmt = trim_trailing_terminators(&sanitized);
    if sanitized_stmt.trim().is_empty() {
        return Err(DriverError::InvalidSql);
    }
    if sanitized_stmt.contains(';') {
        return Err(DriverError::MultipleStatements);
    }

    let stmt = trim_trailing_terminators(sql);
    let tokens = sql_tokens(&sanitized_stmt);
    let first = tokens.first().map(String::as_str).unwrap_or_default();
    let limit = options.effective_limit();

    match first {
        "SELECT" | "WITH" => {
            if can_append_limit(&sanitized_stmt) {
                // 多取 1 行仅用于精确判断是否截断；返回给前端时会丢掉第 limit+1 行。
                let fetch_limit = limit.saturating_add(1);
                Ok(PreparedSql {
                    // 换行追加，避免语句以行注释结尾时 LIMIT 被吞掉
                    sql: format!("{stmt}\nLIMIT {fetch_limit}"),
                    kind: PreparedSqlKind::Read {
                        limit,
                        server_capped: true,
                    },
                })
            } else {
                Ok(PreparedSql {
                    sql: stmt,
                    kind: PreparedSqlKind::Read {
                        limit,
                        server_capped: false,
                    },
                })
            }
        }
        "SHOW" | "DESC" | "DESCRIBE" | "EXPLAIN" => {
            // EXPLAIN ANALYZE 会真正执行被分析的语句：分析写语句时仍需二次确认
            if first == "EXPLAIN" && explain_analyze_writes(&tokens) && !options.allow_write {
                return Err(DriverError::WriteRequiresConfirmation);
            }
            // 元数据语句不支持追加 LIMIT，结果集本身很小，靠客户端截断兜底
            Ok(PreparedSql {
                sql: stmt,
                kind: PreparedSqlKind::Read {
                    limit,
                    server_capped: false,
                },
            })
        }
        _ => {
            if !options.allow_write {
                return Err(DriverError::WriteRequiresConfirmation);
            }
            Ok(PreparedSql {
                sql: stmt,
                kind: PreparedSqlKind::Write,
            })
        }
    }
}

/// EXPLAIN ANALYZE 是否在分析写语句（ANALYZE 变体会真正执行被分析的语句）。
fn explain_analyze_writes(tokens: &[String]) -> bool {
    if tokens.get(1).map(String::as_str) != Some("ANALYZE") {
        return false;
    }
    let analyzed = tokens
        .iter()
        .skip(2)
        .map(String::as_str)
        // 跳过 FORMAT=TREE / FORMAT=JSON 修饰，找到被分析语句的首 token
        .find(|t| !matches!(*t, "FORMAT" | "TREE" | "JSON" | "TRADITIONAL"))
        .unwrap_or_default();
    !matches!(analyzed, "SELECT" | "WITH" | "TABLE")
}

/// 判断能否在语句末尾安全追加 `LIMIT n`：顶层（括号深度 0）已出现
/// LIMIT / FOR / LOCK / INTO / PROCEDURE 时不追加，改由客户端截断兜底。
/// 入参须是已抹掉字符串与注释的 sanitized SQL，避免字面量误判。
fn can_append_limit(sanitized_stmt: &str) -> bool {
    let mut depth = 0usize;
    let mut word = String::new();
    // 末尾补一个空格，确保最后一个 token 也会被检查
    for ch in sanitized_stmt.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            word.push(ch);
            continue;
        }
        if !word.is_empty() {
            if depth == 0
                && matches!(
                    word.to_ascii_uppercase().as_str(),
                    "LIMIT" | "FOR" | "LOCK" | "INTO" | "PROCEDURE"
                )
            {
                return false;
            }
            word.clear();
        }
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    true
}

fn trim_trailing_terminators(sql: &str) -> String {
    let mut end = sql.len();
    for (idx, ch) in sql.char_indices().rev() {
        if ch.is_whitespace() || ch == ';' {
            end = idx;
        } else {
            break;
        }
    }
    sql[..end].trim().to_string()
}

fn strip_literals_and_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\'' | '"' => {
                let quote = ch;
                out.push(' ');
                let mut escaped = false;
                for c in chars.by_ref() {
                    out.push(if c == '\n' { '\n' } else { ' ' });
                    if c == quote && !escaped {
                        break;
                    }
                    escaped = c == '\\' && !escaped;
                    if c != '\\' {
                        escaped = false;
                    }
                }
            }
            '`' => {
                out.push(' ');
                while let Some(c) = chars.next() {
                    out.push(if c == '\n' { '\n' } else { ' ' });
                    if c == '`' {
                        if chars.peek() == Some(&'`') {
                            out.push(' ');
                            chars.next();
                            continue;
                        }
                        break;
                    }
                }
            }
            '-' if chars.peek() == Some(&'-') => {
                out.push(' ');
                out.push(' ');
                chars.next();
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                    out.push(' ');
                }
            }
            '#' => {
                out.push(' ');
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                    out.push(' ');
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                out.push(' ');
                out.push(' ');
                chars.next();
                let mut prev = '\0';
                for c in chars.by_ref() {
                    out.push(if c == '\n' { '\n' } else { ' ' });
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
            }
            _ => out.push(ch),
        }
    }

    out
}

fn sql_tokens(sanitized_sql: &str) -> Vec<String> {
    sanitized_sql
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_uppercase())
        .collect()
}

/// 把动态结果集的某个单元格转成字符串；NULL 返回 None。
///
/// v0.1 表格统一按字符串展示，按列类型分派解码，覆盖常见类型，
/// 二进制可打印则按 UTF-8、否则给字节数占位，未知类型走 fallback。
fn cell_to_string(row: &MySqlRow, idx: usize) -> Option<String> {
    // NULL 检测
    if let Ok(raw) = row.try_get_raw(idx) {
        if raw.is_null() {
            return None;
        }
    }
    let type_name = row.column(idx).type_info().name().to_uppercase();
    let decoded = match type_name.as_str() {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => {
            try_decode::<i64>(row, idx).or_else(|| try_decode::<u64>(row, idx))
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" => try_decode::<u64>(row, idx),
        "FLOAT" | "DOUBLE" => try_decode::<f64>(row, idx),
        "DECIMAL" | "NEWDECIMAL" => try_decode::<bigdecimal::BigDecimal>(row, idx),
        "BOOLEAN" | "BOOL" => try_decode::<bool>(row, idx).or_else(|| try_decode::<i64>(row, idx)),
        "DATE" => try_decode::<chrono::NaiveDate>(row, idx),
        "TIME" => try_decode::<chrono::NaiveTime>(row, idx),
        "DATETIME" | "TIMESTAMP" => try_decode::<chrono::NaiveDateTime>(row, idx),
        "YEAR" => try_decode::<u16>(row, idx).or_else(|| try_decode::<i64>(row, idx)),
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET"
        | "JSON" => try_decode::<String>(row, idx),
        "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BIT" => {
            decode_bytes(row, idx)
        }
        _ => try_decode::<String>(row, idx)
            .or_else(|| try_decode::<i64>(row, idx))
            .or_else(|| try_decode::<f64>(row, idx)),
    };
    Some(decoded.unwrap_or_else(|| "<unsupported>".to_string()))
}

/// 按目标类型尝试解码并转字符串，失败返回 None。
fn try_decode<'r, T>(row: &'r MySqlRow, idx: usize) -> Option<String>
where
    T: sqlx::Decode<'r, sqlx::MySql> + sqlx::Type<sqlx::MySql> + std::string::ToString,
{
    row.try_get::<T, _>(idx).ok().map(|v| v.to_string())
}

/// 二进制列：可打印则按 UTF-8 文本，否则给字节数占位。
fn decode_bytes(row: &MySqlRow, idx: usize) -> Option<String> {
    row.try_get::<Vec<u8>, _>(idx)
        .ok()
        .map(|b| match std::str::from_utf8(&b) {
            Ok(s) => s.to_string(),
            Err(_) => format!("<{} bytes>", b.len()),
        })
}

/// 连上 MySQL 跑一条 `SELECT 1`（Week 1 vertical slice 的最小验证，沿用至连接测试）。
pub async fn ping_select_1(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    database: &str,
) -> Result<i64, DriverError> {
    let driver = MySqlDriver::connect(host, port, username, password, database).await?;
    let result = driver.ping().await;
    driver.close().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_gets_appended_limit() {
        let prepared = prepare_query_sql(
            "SELECT * FROM orders ORDER BY id DESC;",
            QueryOptions::table_preview(),
        )
        .expect("SELECT 应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: 1_000,
                server_capped: true
            }
        );
        assert_eq!(
            prepared.sql,
            "SELECT * FROM orders ORDER BY id DESC\nLIMIT 1001"
        );
    }

    #[test]
    fn join_select_star_is_not_wrapped() {
        // 回归：derived table 包装会让 JOIN 的重名列报 1060 Duplicate column name
        let prepared = prepare_query_sql(
            "SELECT * FROM orders o JOIN users u ON o.user_id = u.id",
            QueryOptions::default(),
        )
        .expect("JOIN SELECT * 应通过");

        assert!(!prepared.sql.contains("tiny_sql_limited"));
        assert!(prepared
            .sql
            .starts_with("SELECT * FROM orders o JOIN users u"));
        assert!(prepared.sql.ends_with("\nLIMIT 100001"));
    }

    #[test]
    fn cte_select_is_treated_as_read_query() {
        let prepared = prepare_query_sql(
            "WITH recent AS (SELECT id FROM orders) SELECT * FROM recent",
            QueryOptions {
                row_limit: 20,
                allow_write: false,
            },
        )
        .expect("CTE SELECT 应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: 20,
                server_capped: true
            }
        );
        assert!(prepared.sql.ends_with("LIMIT 21"));
    }

    #[test]
    fn existing_top_level_limit_is_kept_as_is() {
        let prepared = prepare_query_sql("SELECT * FROM t LIMIT 5", QueryOptions::default())
            .expect("带 LIMIT 的 SELECT 应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: QUERY_RESULT_LIMIT,
                server_capped: false
            }
        );
        assert_eq!(prepared.sql, "SELECT * FROM t LIMIT 5");
    }

    #[test]
    fn subquery_limit_still_gets_server_cap() {
        // 子查询里的 LIMIT 在括号内（深度 > 0），不影响顶层追加
        let prepared = prepare_query_sql(
            "SELECT * FROM (SELECT * FROM t LIMIT 10) x",
            QueryOptions::default(),
        )
        .expect("子查询 LIMIT 应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: QUERY_RESULT_LIMIT,
                server_capped: true
            }
        );
        assert!(prepared.sql.ends_with("\nLIMIT 100001"));
    }

    #[test]
    fn locking_reads_skip_limit_append() {
        // LIMIT 必须出现在 FOR UPDATE 之前，追加会产生语法错误，改由客户端截断兜底
        let prepared = prepare_query_sql(
            "SELECT * FROM t WHERE id = 1 FOR UPDATE",
            QueryOptions::default(),
        )
        .expect("FOR UPDATE 读查询应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: QUERY_RESULT_LIMIT,
                server_capped: false
            }
        );
        assert_eq!(prepared.sql, "SELECT * FROM t WHERE id = 1 FOR UPDATE");
    }

    #[test]
    fn meta_statements_run_without_confirmation() {
        for sql in [
            "SHOW TABLES",
            "SHOW CREATE TABLE users",
            "EXPLAIN SELECT * FROM users",
            "DESC users",
            "DESCRIBE users",
        ] {
            let prepared = prepare_query_sql(sql, QueryOptions::default())
                .unwrap_or_else(|e| panic!("{sql} 应无需确认直接执行: {e}"));
            assert_eq!(
                prepared.kind,
                PreparedSqlKind::Read {
                    limit: QUERY_RESULT_LIMIT,
                    server_capped: false
                },
                "{sql} 应按读查询 fetch 结果集"
            );
            assert_eq!(prepared.sql, sql, "元数据语句不应被改写");
        }
    }

    #[test]
    fn explain_analyze_of_write_requires_confirmation() {
        // EXPLAIN ANALYZE 会真正执行被分析的语句
        let err = prepare_query_sql(
            "EXPLAIN ANALYZE UPDATE t SET x = 1",
            QueryOptions::default(),
        )
        .expect_err("EXPLAIN ANALYZE 写语句必须确认");
        assert!(matches!(err, DriverError::WriteRequiresConfirmation));

        let prepared = prepare_query_sql(
            "EXPLAIN ANALYZE FORMAT=TREE SELECT * FROM t",
            QueryOptions::default(),
        )
        .expect("EXPLAIN ANALYZE SELECT 无需确认");
        assert!(matches!(prepared.kind, PreparedSqlKind::Read { .. }));
    }

    #[test]
    fn semicolon_inside_string_and_comments_is_not_multi_statement() {
        let prepared = prepare_query_sql(
            "SELECT ';' AS semi, 'UPDATE not write' AS s -- DELETE comment\nFROM dual;",
            QueryOptions::default(),
        )
        .expect("字符串和注释里的分号/写关键字应忽略");

        assert!(matches!(prepared.kind, PreparedSqlKind::Read { .. }));
    }

    #[test]
    fn multiple_statements_are_rejected() {
        let err = prepare_query_sql("SELECT 1; SELECT 2", QueryOptions::default())
            .expect_err("多语句必须拒绝");
        assert!(matches!(err, DriverError::MultipleStatements));
    }

    #[test]
    fn write_statement_requires_confirmation() {
        let err = prepare_query_sql("UPDATE orders SET status = 1", QueryOptions::default())
            .expect_err("未确认写操作必须拒绝");
        assert!(matches!(err, DriverError::WriteRequiresConfirmation));

        let prepared = prepare_query_sql(
            "UPDATE orders SET status = 1",
            QueryOptions {
                row_limit: 10,
                allow_write: true,
            },
        )
        .expect("确认后允许执行单条写 SQL");
        assert_eq!(prepared.kind, PreparedSqlKind::Write);
        assert_eq!(prepared.sql, "UPDATE orders SET status = 1");
    }

    #[test]
    fn mysql_url_defaults_to_ssl_disabled() {
        let opts = mysql_options_from_url("mysql://root:password@127.0.0.1:3306/test")
            .expect("URL 应能解析");

        assert!(matches!(opts.get_ssl_mode(), MySqlSslMode::Disabled));
    }

    #[test]
    fn mysql_url_honors_explicit_ssl_mode() {
        let opts =
            mysql_options_from_url("mysql://root:password@127.0.0.1:3306/test?ssl-mode=preferred")
                .expect("URL 应能解析");

        assert!(matches!(opts.get_ssl_mode(), MySqlSslMode::Preferred));
    }

    #[test]
    fn mysql_tls_mode_parses_frontend_values() {
        assert_eq!(
            "verify_identity".parse::<MySqlTlsMode>().unwrap(),
            MySqlTlsMode::VerifyIdentity
        );
        assert!("unknown".parse::<MySqlTlsMode>().is_err());
    }

    #[test]
    fn create_database_sql_quotes_name_and_options() {
        assert_eq!(
            build_create_database_sql("app", None, None).unwrap(),
            "CREATE DATABASE `app`"
        );
        assert_eq!(
            build_create_database_sql("new`db", Some("utf8mb4"), Some("utf8mb4_unicode_ci"))
                .unwrap(),
            "CREATE DATABASE `new``db` DEFAULT CHARACTER SET = utf8mb4 DEFAULT COLLATE = utf8mb4_unicode_ci"
        );
    }

    #[test]
    fn create_database_sql_rejects_invalid_identifiers() {
        assert!(matches!(
            build_create_database_sql("", None, None),
            Err(DriverError::InvalidIdentifier)
        ));
        assert!(matches!(
            build_create_database_sql("app", Some("utf8mb4;DROP"), None),
            Err(DriverError::InvalidIdentifier)
        ));
    }
}
