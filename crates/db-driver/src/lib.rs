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
//! query 的子查询包装防 OOM、10w 行截断、独立 control connection KILL QUERY 取消留 Week 4。

use std::time::Duration;

use futures_util::TryStreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::{Column, ConnectOptions, Executor, MySqlPool, Row, TypeInfo, ValueRef};
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

impl MySqlDriver {
    /// 建立连接池。`database` 为空字符串表示不指定默认库。
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        database: &str,
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
        // v0.1 不启用 MySQL TLS；sqlx 默认 PREFERRED 会在部分内网 MySQL 上握手失败。
        opts = opts
            .ssl_mode(MySqlSslMode::Disabled)
            .log_statements(log::LevelFilter::Off);

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

    /// 执行 SQL，支持子查询包装、10w 硬上限与 `KILL QUERY` 取消。
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
            PreparedSqlKind::Read { limit } => {
                self.fetch_read_rows(
                    &prepared.sql,
                    limit,
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
        conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
        mysql_thread_id: u64,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        let columns: Vec<String> = self
            .pool
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
    Read { limit: usize },
    Write,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedSql {
    sql: String,
    kind: PreparedSqlKind,
}

/// 分析并改写 SQL：
/// - 拒绝空 SQL / 多语句；
/// - SELECT / WITH 用子查询外包 LIMIT；
/// - 非 SELECT 仅在 `allow_write=true` 时执行，作为 best-effort 写操作二次确认。
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
    let is_read = matches!(first, "SELECT" | "WITH");

    if !is_read {
        if !options.allow_write {
            return Err(DriverError::WriteRequiresConfirmation);
        }
        return Ok(PreparedSql {
            sql: stmt,
            kind: PreparedSqlKind::Write,
        });
    }

    let limit = options.effective_limit();
    // 多取 1 行仅用于精确判断是否截断；返回给前端时会丢掉第 limit+1 行。
    let fetch_limit = limit.saturating_add(1);
    Ok(PreparedSql {
        sql: format!("SELECT * FROM ({stmt}) AS tiny_sql_limited LIMIT {fetch_limit}"),
        kind: PreparedSqlKind::Read { limit },
    })
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
    fn select_is_wrapped_with_outer_limit() {
        let prepared = prepare_query_sql(
            "SELECT * FROM orders ORDER BY id DESC;",
            QueryOptions::table_preview(),
        )
        .expect("SELECT 应通过");

        assert_eq!(prepared.kind, PreparedSqlKind::Read { limit: 1_000 });
        assert_eq!(
            prepared.sql,
            "SELECT * FROM (SELECT * FROM orders ORDER BY id DESC) AS tiny_sql_limited LIMIT 1001"
        );
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

        assert_eq!(prepared.kind, PreparedSqlKind::Read { limit: 20 });
        assert!(prepared.sql.ends_with("LIMIT 21"));
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
}
