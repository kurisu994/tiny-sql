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

/// `fetch_rows` 的返回：结果集外加连接污染标记。
struct FetchOutcome {
    row_set: RowSet,
    /// 是否发生过客户端截断（连接上可能有未消费的行流残留）。
    conn_dirty: bool,
}

/// 连接被污染（取消 / 客户端截断留下未消费行流）时的处置策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirtyConnPolicy {
    /// pool 路径：直接销毁连接，避免协议残留回池。
    Discard,
    /// session 路径：保留连接（事务绑死在这条连接上），由 session 验证后决定。
    Keep,
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

    /// 列出 PostgreSQL 表的索引（FR-241）：pg_index 按索引名归组，列保持索引内顺序。
    /// 表达式索引（indkey 含 0）只保留列成员。
    pub async fn list_indexes(
        &self,
        scope: &MetadataScope,
        table: &str,
    ) -> Result<Vec<IndexMeta>, DriverError> {
        self.ensure_current_database(&scope.database).await?;
        let schema = scope
            .schema
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(DriverError::SchemaRequired)?;
        let rows = sqlx::query_as::<_, (String, bool, bool, Vec<String>)>(
            "SELECT c2.relname, i.indisunique, i.indisprimary, \
                    array_agg(a.attname ORDER BY k.n) AS columns \
             FROM pg_index AS i \
             JOIN pg_class AS c ON c.oid = i.indrelid \
             JOIN pg_class AS c2 ON c2.oid = i.indexrelid \
             JOIN pg_namespace AS n ON n.oid = c.relnamespace \
             CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, n) \
             JOIN pg_attribute AS a ON a.attrelid = c.oid AND a.attnum = k.attnum \
             WHERE n.nspname = $1 AND c.relname = $2 \
             GROUP BY c2.relname, i.indisunique, i.indisprimary \
             ORDER BY c2.relname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(query_failed)?;
        Ok(rows
            .into_iter()
            .map(|(name, unique, primary, columns)| IndexMeta {
                index_type: if primary {
                    "PRIMARY"
                } else if unique {
                    "UNIQUE"
                } else {
                    "INDEX"
                }
                .to_string(),
                name,
                columns,
                unique,
            })
            .collect())
    }

    /// 列出 PostgreSQL 表的约束（FR-241）：pg_constraint 归组，
    /// reference 为 `pg_get_constraintdef` 完整定义文本（含外键引用与 CHECK 表达式）。
    pub async fn list_constraints(
        &self,
        scope: &MetadataScope,
        table: &str,
    ) -> Result<Vec<ConstraintMeta>, DriverError> {
        self.ensure_current_database(&scope.database).await?;
        let schema = scope
            .schema
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(DriverError::SchemaRequired)?;
        let rows = sqlx::query_as::<_, (String, String, Option<Vec<String>>, Option<String>)>(
            "SELECT con.conname, \
                    CASE con.contype \
                        WHEN 'p' THEN 'PRIMARY KEY' \
                        WHEN 'f' THEN 'FOREIGN KEY' \
                        WHEN 'u' THEN 'UNIQUE' \
                        ELSE 'CHECK' \
                    END, \
                    (SELECT array_agg(a.attname ORDER BY k.n) \
                     FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, n) \
                     JOIN pg_attribute AS a \
                       ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS columns, \
                    pg_get_constraintdef(con.oid) AS definition \
             FROM pg_constraint AS con \
             JOIN pg_class AS c ON c.oid = con.conrelid \
             JOIN pg_namespace AS n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2 \
             ORDER BY con.conname",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(query_failed)?;
        Ok(rows
            .into_iter()
            .map(|(name, constraint_type, columns, definition)| ConstraintMeta {
                name,
                constraint_type,
                columns: columns.unwrap_or_default(),
                reference: definition,
            })
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
        // 同 MySQL：事务控制语句必须走独占 session，禁止泄漏到 pool 连接（FR-244）
        if matches!(prepared.kind, PreparedSqlKind::TxControl(_)) {
            return Err(DriverError::TxRequiresSession);
        }
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
                    DirtyConnPolicy::Discard,
                )
                .await
                .map(|outcome| outcome.row_set)
            }
            PreparedSqlKind::Write => {
                let columns = describe_columns(&mut conn, &prepared.sql).await?;
                if columns.is_empty() {
                    self.execute_write(
                        &prepared.sql,
                        &mut conn,
                        backend_pid,
                        cancel_token,
                        DirtyConnPolicy::Discard,
                    )
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
                        DirtyConnPolicy::Discard,
                    )
                    .await
                    .map(|outcome| outcome.row_set)
                }
            }
            PreparedSqlKind::TxControl(_) => unreachable!("TxControl 已在 prepare 后拒绝"),
        }
    }

    /// 浏览表数据（FR-242）：服务端筛选 / 排序 / 分页，COUNT 超时降级 None。
    /// PostgreSQL 只能浏览当前 database，scope 校验沿用 metadata 语义。
    pub async fn browse_table(
        &self,
        scope: &MetadataScope,
        table: &str,
        query: &TableBrowseQuery,
        cancel_token: CancellationToken,
    ) -> Result<TableBrowseResult, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        self.ensure_current_database(&scope.database).await?;
        let schema = scope
            .schema
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or(DriverError::SchemaRequired)?;
        let from = format!("{}.{}", quote_pg_ident(schema), quote_pg_ident(table));
        let (where_sql, binds) = build_filter_clause(&query.filters, quote_pg_ident, |n| {
            format!("${n}")
        });
        let order_sql = query.order.as_ref().map_or(String::new(), |order| {
            format!(
                " ORDER BY {} {}",
                quote_pg_ident(&order.column),
                if order.descending { "DESC" } else { "ASC" }
            )
        });
        let limit = query.effective_limit();
        // 多取一行探测「是否有下一页」（COUNT 失败降级时仍保证分页行为正确）
        let data_sql = format!(
            "SELECT * FROM {from}{where_sql}{order_sql}\nLIMIT {} OFFSET {}",
            limit + 1,
            query.offset
        );
        let count_sql = format!("SELECT COUNT(*) FROM {from}{where_sql}");

        let mut conn = self.pool.acquire().await.map_err(query_failed)?;
        let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *conn)
            .await
            .map_err(query_failed)?;

        let data_future = async {
            let mut q = sqlx::query(&data_sql);
            for value in &binds {
                q = match value {
                    FilterValue::Int(v) => q.bind(*v),
                    FilterValue::Float(v) => q.bind(*v),
                    FilterValue::Text(v) => q.bind(v.clone()),
                };
            }
            let mut rows = q.fetch(&mut *conn);
            let mut columns: Vec<String> = Vec::new();
            let mut data: Vec<Vec<Option<String>>> = Vec::new();
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
                        data.push((0..row.columns().len()).map(|index| postgres_cell_to_string(&row, index)).collect());
                    }
                }
            }
            Ok((columns, data))
        };
        let count_future = self.count_rows(&count_sql, &binds, &cancel_token);
        let (data_result, total) = tokio::join!(data_future, count_future);
        let (columns, mut data) = data_result?;

        // 列头补空：0 行结果集也展示表头。从 metadata 取（PG describe 带 $N 参数
        // 的语句可能推断不出参数类型；list_columns 顺序与 SELECT * 一致）
        let columns = if columns.is_empty() {
            self.list_columns(scope, table)
                .await?
                .into_iter()
                .map(|column| column.name)
                .collect()
        } else {
            columns
        };

        let has_next_page = match total {
            Some(total) => query.offset + limit < total as usize,
            None => data.len() > limit,
        };
        data.truncate(limit);
        Ok(TableBrowseResult {
            row_set: RowSet {
                columns,
                rows: data,
                truncated: false,
            },
            total,
            has_next_page,
        })
    }

    /// COUNT 查询：独立连接 + 5s 超时 + 可取消；超时/失败降级 None，不影响浏览主链路。
    async fn count_rows(
        &self,
        sql: &str,
        binds: &[FilterValue],
        cancel_token: &CancellationToken,
    ) -> Option<u64> {
        let work = async {
            let mut conn = self.pool.acquire().await.ok()?;
            let mut q = sqlx::query_scalar::<_, i64>(sql);
            for value in binds {
                q = match value {
                    FilterValue::Int(v) => q.bind(*v),
                    FilterValue::Float(v) => q.bind(*v),
                    FilterValue::Text(v) => q.bind(v.clone()),
                };
            }
            q.fetch_one(&mut *conn).await.ok()
        };
        let cancellable = async {
            tokio::select! {
                result = work => result,
                _ = cancel_token.cancelled() => None,
            }
        };
        match timeout(Duration::from_secs(5), cancellable).await {
            Ok(value) => value.map(|count| count.max(0) as u64),
            Err(_) => None,
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
        dirty_policy: DirtyConnPolicy,
    ) -> Result<FetchOutcome, DriverError> {
        let mut rows = sqlx::query(sql).fetch(&mut **conn);
        let mut data: Vec<Vec<Option<String>>> = Vec::new();
        let mut truncated = false;

        loop {
            tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    drop(rows);
                    self.cancel_backend(backend_pid).await;
                    if dirty_policy == DirtyConnPolicy::Discard {
                        conn.close_on_drop();
                    }
                    return Err(DriverError::QueryCancelled);
                }
                row = rows.try_next() => {
                    let row = match row {
                        Ok(row) => row,
                        Err(_) if cancel_token.is_cancelled() => {
                            drop(rows);
                            if dirty_policy == DirtyConnPolicy::Discard {
                                conn.close_on_drop();
                            }
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

        let mut conn_dirty = false;
        if truncated && !policy.server_capped {
            drop(rows);
            self.cancel_backend(backend_pid).await;
            conn_dirty = true;
            if dirty_policy == DirtyConnPolicy::Discard {
                conn.close_on_drop();
            }
        }

        Ok(FetchOutcome {
            row_set: RowSet {
                columns,
                rows: data,
                truncated,
            },
            conn_dirty,
        })
    }

    async fn execute_write(
        &self,
        sql: &str,
        conn: &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
        backend_pid: i32,
        cancel_token: CancellationToken,
        dirty_policy: DirtyConnPolicy,
    ) -> Result<RowSet, DriverError> {
        tokio::select! {
            biased;
            _ = cancel_token.cancelled() => {
                self.cancel_backend(backend_pid).await;
                if dirty_policy == DirtyConnPolicy::Discard {
                    conn.close_on_drop();
                }
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

    fn list_indexes<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<IndexMeta>> {
        Box::pin(PostgresDriver::list_indexes(self, scope, table))
    }

    fn list_constraints<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ConstraintMeta>> {
        Box::pin(PostgresDriver::list_constraints(self, scope, table))
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

    fn begin_session(&self) -> DriverFuture<'_, Box<dyn DriverSession>> {
        Box::pin(async move {
            Ok(Box::new(PostgresSession::begin(self.clone()).await?) as Box<dyn DriverSession>)
        })
    }

    fn browse_table<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        query: &'a TableBrowseQuery,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, TableBrowseResult> {
        Box::pin(PostgresDriver::browse_table(
            self,
            scope,
            table,
            query,
            cancel_token,
        ))
    }

    fn close(&self) -> DriverCloseFuture<'_> {
        Box::pin(PostgresDriver::close(self))
    }
}

/// PostgreSQL 独占 session：BEGIN 后所有语句固定同一物理连接（FR-244）。
///
/// 与 MySQL 的差异：
/// - 取消用 `pg_cancel_backend`；取消 / 客户端截断后连接上可能有未消费的
///   行流残留，session 会发 `SELECT 1` 验证协议干净再继续使用，验证失败则
///   销毁连接并返回 SessionBroken（事务由服务端兜底回滚）。
/// - 出错（含取消）后事务进入 aborted 状态：`in_transaction` 保持 true，
///   需要用户显式 ROLLBACK 恢复，与 PG 语义一致。
/// - session 结束时先 `ROLLBACK`（若在事务中）再 `RESET ALL; CLOSE ALL; DISCARD TEMP`
///   清理会话状态归还 pool（不用 DISCARD ALL：它会清空 sqlx 的 prepared statement
///   cache，复用时报 "prepared statement does not exist"）；失败则销毁连接。
pub struct PostgresSession {
    driver: PostgresDriver,
    conn: Option<sqlx::pool::PoolConnection<sqlx::Postgres>>,
    backend_pid: i32,
    in_transaction: bool,
}

impl PostgresSession {
    /// 从主 pool 取一条连接并开启事务。
    async fn begin(driver: PostgresDriver) -> Result<Self, DriverError> {
        let mut conn = driver.pool.acquire().await.map_err(query_failed)?;
        let backend_pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *conn)
            .await
            .map_err(query_failed)?;
        conn.execute(sqlx::raw_sql("BEGIN"))
            .await
            .map_err(query_failed)?;
        Ok(Self {
            driver,
            conn: Some(conn),
            backend_pid,
            in_transaction: true,
        })
    }

    /// 归还 pool 前尽力清理会话状态；失败销毁连接（服务端兜底回滚）。
    async fn cleanup(mut conn: sqlx::pool::PoolConnection<sqlx::Postgres>, in_transaction: bool) {
        let steps = async {
            if in_transaction {
                conn.execute(sqlx::raw_sql("ROLLBACK")).await?;
            }
            // 清理会话状态但保留 prepared statement cache：DISCARD ALL 会 DEALLOCATE
            // 全部预备语句，sqlx 缓存的 sqlx_s_N 复用时报 "prepared statement does not exist"
            conn.execute(sqlx::raw_sql("RESET ALL; CLOSE ALL; DISCARD TEMP"))
                .await
        };
        let done = timeout(CONTROL_QUERY_TIMEOUT * 2, steps).await;
        if !matches!(done, Ok(Ok(_))) {
            conn.close_on_drop();
        }
    }

    /// 取消 / 客户端截断后验证连接协议干净；验证失败销毁连接并标记 session 失效。
    async fn verify_conn(&mut self) -> Result<(), DriverError> {
        let Some(conn) = self.conn.as_mut() else {
            return Err(DriverError::SessionBroken);
        };
        let check = timeout(
            CONTROL_QUERY_TIMEOUT,
            sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&mut **conn),
        )
        .await;
        if matches!(check, Ok(Ok(_))) {
            return Ok(());
        }
        // 协议已脏或连接已断：事务无法挽救，销毁连接由服务端兜底回滚
        self.in_transaction = false;
        if let Some(mut conn) = self.conn.take() {
            conn.close_on_drop();
        }
        Err(DriverError::SessionBroken)
    }

    /// commit / rollback 的公共路径；失败时销毁连接，杜绝事务状态中间态。
    async fn finish_tx(&mut self, stmt: &'static str) -> Result<(), DriverError> {
        if !self.in_transaction {
            return Err(DriverError::SessionNotInTransaction);
        }
        let Some(conn) = self.conn.as_mut() else {
            return Err(DriverError::SessionBroken);
        };
        match conn.execute(sqlx::raw_sql(stmt)).await {
            Ok(_) => {
                self.in_transaction = false;
                Ok(())
            }
            Err(error) => {
                self.in_transaction = false;
                if let Some(mut conn) = self.conn.take() {
                    conn.close_on_drop();
                }
                Err(query_failed(error))
            }
        }
    }
}

impl DriverSession for PostgresSession {
    fn query<'a>(
        &'a mut self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, RowSet> {
        Box::pin(async move {
            if cancel_token.is_cancelled() {
                return Err(DriverError::QueryCancelled);
            }
            let prepared = prepare_query_sql_for_dialect(sql, options, SqlDialect::PostgreSql)?;
            let Some(conn) = self.conn.as_mut() else {
                return Err(DriverError::SessionBroken);
            };
            let result = match prepared.kind {
                PreparedSqlKind::Read {
                    limit,
                    server_capped,
                } => {
                    let columns = describe_columns(conn, &prepared.sql).await?;
                    self.driver
                        .fetch_rows(
                            &prepared.sql,
                            columns,
                            FetchPolicy {
                                limit,
                                server_capped,
                            },
                            conn,
                            self.backend_pid,
                            cancel_token,
                            DirtyConnPolicy::Keep,
                        )
                        .await
                        .map(|outcome| (outcome.row_set, outcome.conn_dirty))
                }
                PreparedSqlKind::Write => {
                    let columns = describe_columns(conn, &prepared.sql).await?;
                    if columns.is_empty() {
                        self.driver
                            .execute_write(
                                &prepared.sql,
                                conn,
                                self.backend_pid,
                                cancel_token,
                                DirtyConnPolicy::Keep,
                            )
                            .await
                            .map(|row_set| (row_set, false))
                    } else {
                        // DML ... RETURNING：返回结果行
                        self.driver
                            .fetch_rows(
                                &prepared.sql,
                                columns,
                                FetchPolicy {
                                    limit: options.effective_limit(),
                                    server_capped: false,
                                },
                                conn,
                                self.backend_pid,
                                cancel_token,
                                DirtyConnPolicy::Keep,
                            )
                            .await
                            .map(|outcome| (outcome.row_set, outcome.conn_dirty))
                    }
                }
                PreparedSqlKind::TxControl(tx) => {
                    // 事务控制语句走 simple protocol，执行很快，取消窗口可忽略
                    let result = conn
                        .execute(sqlx::raw_sql(&prepared.sql))
                        .await
                        .map_err(query_failed)?;
                    match tx {
                        TxControl::Begin => self.in_transaction = true,
                        TxControl::Commit | TxControl::Rollback => self.in_transaction = false,
                        TxControl::Neutral => {}
                    }
                    Ok((
                        RowSet {
                            columns: vec!["affected_rows".to_string()],
                            rows: vec![vec![Some(result.rows_affected().to_string())]],
                            truncated: false,
                        },
                        false,
                    ))
                }
            };
            // 取消（Err(QueryCancelled)）或客户端截断（conn_dirty）后验证协议干净
            let dirty = match &result {
                Ok((_, dirty)) => *dirty,
                Err(DriverError::QueryCancelled) => true,
                Err(_) => false,
            };
            if dirty {
                self.verify_conn().await?;
            }
            result.map(|(row_set, _)| row_set)
        })
    }

    fn commit(&mut self) -> DriverFuture<'_, ()> {
        Box::pin(self.finish_tx("COMMIT"))
    }

    fn rollback(&mut self) -> DriverFuture<'_, ()> {
        Box::pin(self.finish_tx("ROLLBACK"))
    }

    fn close(&mut self) -> DriverCloseFuture<'_> {
        Box::pin(async move {
            let in_transaction = self.in_transaction;
            self.in_transaction = false;
            if let Some(conn) = self.conn.take() {
                Self::cleanup(conn, in_transaction).await;
            }
        })
    }

    fn in_transaction(&self) -> bool {
        self.in_transaction
    }
}

impl Drop for PostgresSession {
    fn drop(&mut self) {
        let Some(conn) = self.conn.take() else {
            return;
        };
        // 未经 close 的 session：后台尽力清理后归还，无 runtime 直接销毁连接
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(Self::cleanup(conn, self.in_transaction));
        } else {
            let mut conn = conn;
            conn.close_on_drop();
        }
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
