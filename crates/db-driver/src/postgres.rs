use std::time::Duration;

use futures_util::TryStreamExt;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgRow};
use sqlx::{Column, ConnectOptions, Executor, PgPool, Row, TypeInfo, ValueRef};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use super::*;

/// PostgreSQL 连接参数。TLS/证书配置在后续安全阶段统一补齐。
#[derive(Debug, Clone, Default)]
pub struct PostgresConnectSettings {
    /// 建立连接池的整体超时；`None` 表示只使用 sqlx acquire timeout。
    pub connect_timeout: Option<Duration>,
}

/// PostgreSQL driver。
///
/// 主连接池负责业务查询；独立 control pool 通过 `pg_cancel_backend` 取消服务端
/// backend，避免主池满载时取消也阻塞。SSH 仍由上层把目标映射为本地 TCP 端口。
#[derive(Clone)]
pub struct PostgresDriver {
    pool: PgPool,
    control_pool: PgPool,
}

impl PostgresDriver {
    /// 建立 PostgreSQL 连接池。`database` 为空时沿用服务端/账号默认数据库。
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
            PostgresConnectSettings::default(),
        )
        .await
    }

    /// 按指定连接参数建立 PostgreSQL 连接池。
    pub async fn connect_with_settings(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        database: &str,
        settings: PostgresConnectSettings,
    ) -> Result<Self, DriverError> {
        // 显式连接配置不读取用户 ~/.pgpass，避免空密码时静默使用额外凭据。
        let mut opts = PgConnectOptions::new_without_pgpass()
            .host(host)
            .port(port)
            .username(username)
            .password(password)
            .application_name("tiny-sql")
            .log_statements(log::LevelFilter::Off);
        if !database.is_empty() {
            opts = opts.database(database);
        }

        let pool = connect_postgres_pool(opts.clone(), 5, settings.connect_timeout).await?;
        let control_pool = connect_postgres_pool(opts, 1, settings.connect_timeout).await?;
        Ok(Self { pool, control_pool })
    }

    /// 用完整 PostgreSQL URL 建立连接池，供本地 integration 测试使用。
    pub async fn connect_url(url: &str) -> Result<Self, DriverError> {
        let opts: PgConnectOptions = url
            .parse()
            .map_err(|e: sqlx::Error| DriverError::ConnectFailed(e.to_string()))?;
        let opts = opts.log_statements(log::LevelFilter::Off);
        let pool = connect_postgres_pool(opts.clone(), 5, None).await?;
        let control_pool = connect_postgres_pool(opts, 1, None).await?;
        Ok(Self { pool, control_pool })
    }

    /// 跑一条 `SELECT 1`，用于 PostgreSQL vertical slice 与连接测试。
    pub async fn ping(&self) -> Result<i64, DriverError> {
        let row: (i64,) = sqlx::query_as("SELECT 1::BIGINT")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(row.0)
    }

    /// 列出当前账号可连接的 database，并标记当前连接所在 database。
    pub async fn list_databases(&self) -> Result<Vec<DatabaseMeta>, DriverError> {
        let rows = sqlx::query_as::<_, (String, bool)>(
            "SELECT datname, datname = current_database() \
             FROM pg_database \
             WHERE datallowconn AND NOT datistemplate \
               AND has_database_privilege(datname, 'CONNECT') \
             ORDER BY datname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(query_failed)?;
        Ok(rows
            .into_iter()
            .map(|(name, is_current)| DatabaseMeta { name, is_current })
            .collect())
    }

    /// 列出当前 PostgreSQL database 下可使用的 schema。
    ///
    /// PostgreSQL 不能在同一连接上切换 database；请求非当前 database 时返回稳定错误，
    /// 由 Week 3 应用层重建对应 database 的连接，而不是悄悄查询错误作用域。
    pub async fn list_schemas(&self, database: &str) -> Result<Vec<SchemaMeta>, DriverError> {
        self.ensure_current_database(database).await?;
        let rows = sqlx::query_as::<_, (String, bool)>(
            "SELECT n.nspname, n.nspname = current_schema() \
             FROM pg_namespace AS n \
             WHERE n.nspname NOT LIKE 'pg_toast%' \
               AND n.nspname NOT LIKE 'pg_temp_%' \
               AND has_schema_privilege(n.oid, 'USAGE') \
             ORDER BY n.nspname",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(query_failed)?;
        Ok(rows
            .into_iter()
            .map(|(name, is_default)| SchemaMeta { name, is_default })
            .collect())
    }

    /// 列出 PostgreSQL database/schema 下的表、视图和物化视图。
    pub async fn list_tables(&self, scope: &MetadataScope) -> Result<Vec<TableMeta>, DriverError> {
        self.ensure_current_database(&scope.database).await?;
        let schema = scope
            .schema
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(DriverError::SchemaRequired)?;
        let rows = sqlx::query_as::<_, (String, String, Option<i64>, Option<String>)>(
            "SELECT c.relname, \
                    CASE c.relkind \
                        WHEN 'r' THEN 'BASE TABLE' \
                        WHEN 'p' THEN 'PARTITIONED TABLE' \
                        WHEN 'v' THEN 'VIEW' \
                        WHEN 'm' THEN 'MATERIALIZED VIEW' \
                        WHEN 'f' THEN 'FOREIGN TABLE' \
                    END, \
                    CASE WHEN c.relkind IN ('r', 'p', 'm') \
                         THEN GREATEST(c.reltuples, 0)::BIGINT \
                         ELSE NULL END, \
                    obj_description(c.oid, 'pg_class') \
             FROM pg_class AS c \
             JOIN pg_namespace AS n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 \
               AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
             ORDER BY c.relname",
        )
        .bind(schema)
        .fetch_all(&self.pool)
        .await
        .map_err(query_failed)?;
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

    /// 列出 PostgreSQL database/schema/table 下的列。
    pub async fn list_columns(
        &self,
        scope: &MetadataScope,
        table: &str,
    ) -> Result<Vec<ColumnMeta>, DriverError> {
        self.ensure_current_database(&scope.database).await?;
        let schema = scope
            .schema
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(DriverError::SchemaRequired)?;
        let rows =
            sqlx::query_as::<_, (String, String, bool, String, Option<String>, Option<String>)>(
                "SELECT a.attname, \
                    format_type(a.atttypid, a.atttypmod), \
                    NOT a.attnotnull, \
                    CASE \
                        WHEN EXISTS ( \
                            SELECT 1 FROM pg_index AS i \
                            WHERE i.indrelid = a.attrelid \
                              AND i.indisprimary \
                              AND a.attnum = ANY(i.indkey) \
                        ) THEN 'PRI' \
                        WHEN EXISTS ( \
                            SELECT 1 FROM pg_index AS i \
                            WHERE i.indrelid = a.attrelid \
                              AND i.indisunique \
                              AND i.indnkeyatts = 1 \
                              AND a.attnum = ANY(i.indkey) \
                        ) THEN 'UNI' \
                        WHEN EXISTS ( \
                            SELECT 1 FROM pg_index AS i \
                            WHERE i.indrelid = a.attrelid \
                              AND a.attnum = ANY(i.indkey) \
                        ) THEN 'MUL' \
                        ELSE '' \
                    END, \
                    pg_get_expr(ad.adbin, ad.adrelid), \
                    col_description(a.attrelid, a.attnum) \
             FROM pg_attribute AS a \
             JOIN pg_class AS c ON c.oid = a.attrelid \
             JOIN pg_namespace AS n ON n.oid = c.relnamespace \
             LEFT JOIN pg_attrdef AS ad \
                    ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             WHERE n.nspname = $1 \
               AND c.relname = $2 \
               AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
               AND a.attnum > 0 \
               AND NOT a.attisdropped \
             ORDER BY a.attnum",
            )
            .bind(schema)
            .bind(table)
            .fetch_all(&self.pool)
            .await
            .map_err(query_failed)?;
        Ok(rows
            .into_iter()
            .map(
                |(name, data_type, nullable, column_key, default_value, comment)| ColumnMeta {
                    name,
                    data_type,
                    nullable,
                    column_key,
                    default_value,
                    comment,
                },
            )
            .collect())
    }

    /// 执行 PostgreSQL SQL，默认使用编辑器 10 万行硬上限。
    pub async fn query(&self, sql: &str) -> Result<RowSet, DriverError> {
        self.query_with_options(sql, QueryOptions::default(), CancellationToken::new())
            .await
    }

    /// 执行 PostgreSQL SQL，支持方言感知的行数上限、写确认与服务端原生取消。
    pub async fn query_with_options(
        &self,
        sql: &str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        let prepared = prepare_query_sql_for_dialect(sql, options, SqlDialect::PostgreSql)?;
        let mut conn = self.pool.acquire().await.map_err(query_failed)?;
        let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *conn)
            .await
            .map_err(query_failed)?;

        match prepared.kind {
            PreparedSqlKind::Read {
                limit,
                server_capped,
            } => {
                let columns = describe_columns(&mut conn, &prepared.sql).await?;
                self.fetch_rows(
                    &prepared.sql,
                    columns,
                    FetchPolicy {
                        limit,
                        server_capped,
                    },
                    &mut conn,
                    backend_pid,
                    cancel_token,
                )
                .await
            }
            PreparedSqlKind::Write => {
                let columns = describe_columns(&mut conn, &prepared.sql).await?;
                if columns.is_empty() {
                    self.execute_write(&prepared.sql, &mut conn, backend_pid, cancel_token)
                        .await
                } else {
                    // PostgreSQL DML ... RETURNING 既需要写确认，也应把结果行返回给用户。
                    self.fetch_rows(
                        &prepared.sql,
                        columns,
                        FetchPolicy {
                            limit: options.effective_limit(),
                            server_capped: false,
                        },
                        &mut conn,
                        backend_pid,
                        cancel_token,
                    )
                    .await
                }
            }
        }
    }

    async fn fetch_rows(
        &self,
        sql: &str,
        mut columns: Vec<String>,
        policy: FetchPolicy,
        conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        backend_pid: i32,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        let mut rows = sqlx::query(sql).fetch(&mut **conn);
        let mut data: Vec<Vec<Option<String>>> = Vec::new();
        let mut truncated = false;

        loop {
            tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    drop(rows);
                    self.cancel_backend(backend_pid).await;
                    conn.close_on_drop();
                    return Err(DriverError::QueryCancelled);
                }
                row = rows.try_next() => {
                    let row = match row {
                        Ok(row) => row,
                        Err(_) if cancel_token.is_cancelled() => {
                            drop(rows);
                            conn.close_on_drop();
                            return Err(DriverError::QueryCancelled);
                        }
                        Err(error) => return Err(query_failed(error)),
                    };
                    let Some(row) = row else { break; };
                    if columns.is_empty() {
                        columns = row.columns().iter().map(|column| column.name().to_string()).collect();
                    }
                    if data.len() >= policy.limit {
                        truncated = true;
                        break;
                    }
                    data.push((0..row.columns().len()).map(|index| postgres_cell_to_string(&row, index)).collect());
                }
            }
        }

        if truncated && !policy.server_capped {
            drop(rows);
            self.cancel_backend(backend_pid).await;
            conn.close_on_drop();
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
        conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        backend_pid: i32,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                self.cancel_backend(backend_pid).await;
                conn.close_on_drop();
                Err(DriverError::QueryCancelled)
            }
            result = sqlx::query(sql).execute(&mut **conn) => {
                let result = result.map_err(query_failed)?;
                Ok(RowSet {
                    columns: vec!["affected_rows".to_string()],
                    rows: vec![vec![Some(result.rows_affected().to_string())]],
                    truncated: false,
                })
            }
        }
    }

    async fn ensure_current_database(&self, database: &str) -> Result<(), DriverError> {
        let current: String = sqlx::query_scalar("SELECT current_database()")
            .fetch_one(&self.pool)
            .await
            .map_err(query_failed)?;
        if current == database {
            Ok(())
        } else {
            Err(DriverError::DatabaseSwitchRequired)
        }
    }

    /// 从独立 control pool 调用 PostgreSQL 原生 `pg_cancel_backend`。
    async fn cancel_backend(&self, backend_pid: i32) {
        let _ = tokio::time::timeout(
            CONTROL_QUERY_TIMEOUT,
            sqlx::query_scalar::<_, bool>("SELECT pg_cancel_backend($1)")
                .bind(backend_pid)
                .fetch_one(&self.control_pool),
        )
        .await;
    }

    /// 幂等关闭 PostgreSQL 连接池。
    pub async fn close(&self) {
        self.pool.close().await;
        self.control_pool.close().await;
    }
}

impl Driver for PostgresDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::PostgreSql
    }

    fn ping(&self) -> DriverFuture<'_, i64> {
        Box::pin(PostgresDriver::ping(self))
    }

    fn list_databases(&self) -> DriverFuture<'_, Vec<DatabaseMeta>> {
        Box::pin(PostgresDriver::list_databases(self))
    }

    fn list_schemas<'a>(&'a self, database: &'a str) -> DriverFuture<'a, Vec<SchemaMeta>> {
        Box::pin(PostgresDriver::list_schemas(self, database))
    }

    fn list_tables<'a>(&'a self, scope: &'a MetadataScope) -> DriverFuture<'a, Vec<TableMeta>> {
        Box::pin(PostgresDriver::list_tables(self, scope))
    }

    fn list_columns<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ColumnMeta>> {
        Box::pin(PostgresDriver::list_columns(self, scope, table))
    }

    fn query<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, RowSet> {
        Box::pin(PostgresDriver::query_with_options(
            self,
            sql,
            options,
            cancel_token,
        ))
    }

    fn close(&self) -> DriverCloseFuture<'_> {
        Box::pin(PostgresDriver::close(self))
    }
}

async fn connect_postgres_pool(
    opts: PgConnectOptions,
    max_connections: u32,
    connect_timeout: Option<Duration>,
) -> Result<PgPool, DriverError> {
    let future = PgPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts);
    match connect_timeout {
        Some(duration) => timeout(duration, future)
            .await
            .map_err(|_| DriverError::ConnectFailed("connection timeout".to_string()))?
            .map_err(|error| DriverError::ConnectFailed(error.to_string())),
        None => future
            .await
            .map_err(|error| DriverError::ConnectFailed(error.to_string())),
    }
}

async fn describe_columns(
    conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
    sql: &str,
) -> Result<Vec<String>, DriverError> {
    Ok((&mut **conn)
        .describe(sql)
        .await
        .map_err(query_failed)?
        .columns()
        .iter()
        .map(|column| column.name().to_string())
        .collect())
}

/// 把 PostgreSQL 动态结果集的单元格转成字符串；NULL 返回 None。
fn postgres_cell_to_string(row: &PgRow, index: usize) -> Option<String> {
    if let Ok(raw) = row.try_get_raw(index) {
        if raw.is_null() {
            return None;
        }
    }
    let type_name = row.column(index).type_info().name().to_uppercase();
    let decoded = match type_name.as_str() {
        "BOOL" => try_decode_postgres::<bool>(row, index),
        "INT2" => try_decode_postgres::<i16>(row, index),
        "INT4" => try_decode_postgres::<i32>(row, index),
        "INT8" => try_decode_postgres::<i64>(row, index),
        "FLOAT4" => try_decode_postgres::<f32>(row, index),
        "FLOAT8" => try_decode_postgres::<f64>(row, index),
        "NUMERIC" => try_decode_postgres::<bigdecimal::BigDecimal>(row, index),
        "DATE" => try_decode_postgres::<chrono::NaiveDate>(row, index),
        "TIME" => try_decode_postgres::<chrono::NaiveTime>(row, index),
        "TIMESTAMP" => try_decode_postgres::<chrono::NaiveDateTime>(row, index),
        "TIMESTAMPTZ" => try_decode_postgres::<chrono::DateTime<chrono::Utc>>(row, index),
        "JSON" | "JSONB" => try_decode_postgres::<sqlx::types::JsonValue>(row, index),
        "BYTEA" => decode_postgres_bytes(row, index),
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "UNKNOWN" => {
            try_decode_postgres::<String>(row, index)
        }
        _ => try_decode_postgres::<String>(row, index)
            .or_else(|| try_decode_postgres::<i64>(row, index))
            .or_else(|| try_decode_postgres::<f64>(row, index)),
    };
    Some(decoded.unwrap_or_else(|| "<unsupported>".to_string()))
}

fn try_decode_postgres<'row, T>(row: &'row PgRow, index: usize) -> Option<String>
where
    T: sqlx::Decode<'row, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + std::string::ToString,
{
    row.try_get::<T, _>(index)
        .ok()
        .map(|value| value.to_string())
}

fn decode_postgres_bytes(row: &PgRow, index: usize) -> Option<String> {
    row.try_get::<Vec<u8>, _>(index)
        .ok()
        .map(|bytes| match std::str::from_utf8(&bytes) {
            Ok(value) => value.to_string(),
            Err(_) => format!("<{} bytes>", bytes.len()),
        })
}
