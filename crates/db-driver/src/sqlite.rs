//! SQLite driver —— 本地文件型数据库实现。
//!
//! 与 MySQL / PostgreSQL 的关键差异：
//! - **连接目标是文件路径**，没有 host/port/账号，也不经过 SSH 隧道。
//! - **没有服务端**，取消不靠 `KILL QUERY` / `pg_cancel_backend`，而是给连接装
//!   SQLite 原生 progress handler：回调返回 false 即中断当前语句（SQLITE_INTERRUPT）。
//!   handler 绑定 cancel token，语句结束必须摘除，否则连接回池后会被旧 token 误伤。
//! - **没有 schema 层级**：`MetadataScope::database` 对应 ATTACH 名（主库固定 `main`），
//!   `schema` 恒为 None；`list_schemas` 返回空列表。
//! - 元数据来自 `sqlite_master` 与 `pragma_*` 表值函数（可参数化绑定，避免拼接）。

use std::collections::BTreeMap;
use std::time::Duration;

use futures_util::TryStreamExt;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, ConnectOptions, Executor, Row, Sqlite, SqlitePool, TypeInfo, ValueRef};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

use super::*;

/// SQLite 主库名。SQLite 的 "database" 即 ATTACH 名，未 ATTACH 时只有 main。
const MAIN_DATABASE: &str = "main";

/// progress handler 的回调间隔（约多少条虚拟机指令回调一次）。
/// 太小影响吞吐，太大取消不跟手；64 在大表扫描下大约每毫秒内可响应多次。
const PROGRESS_HANDLER_OPS: i32 = 64;

/// SQLite 连接参数。
#[derive(Debug, Clone, Default)]
pub struct SqliteConnectSettings {
    /// 文件不存在时是否创建。客户端默认 false —— 打错路径应当报错而不是建出空库。
    pub create_if_missing: bool,
    /// 以只读模式打开（连接层强制，比应用层 guard 更硬）。
    pub read_only: bool,
    /// 建立连接池的整体超时；`None` 表示只使用 sqlx acquire timeout。
    pub connect_timeout: Option<Duration>,
}

/// 连接被取消污染时的处置策略（与 PostgreSQL 同名枚举语义一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirtyConnPolicy {
    /// pool 路径：销毁连接，杜绝 progress handler 残留回池。
    Discard,
    /// session 路径：事务绑死这条连接，摘除 handler 后继续使用。
    Keep,
}

/// SQLite driver。
///
/// 连接池上限 4：SQLite 读可并发，写由文件锁串行化，busy_timeout 负责等待。
/// 不需要 PostgreSQL / MySQL 那样的独立 control pool —— 取消走连接内的
/// progress handler，不需要另开一条连接下发取消指令。
#[derive(Clone)]
pub struct SqliteDriver {
    pool: SqlitePool,
}

impl SqliteDriver {
    /// 打开 SQLite 数据库文件（默认不创建、可读写）。
    pub async fn connect(path: &str) -> Result<Self, DriverError> {
        Self::connect_with_settings(path, SqliteConnectSettings::default()).await
    }

    /// 按指定参数打开 SQLite 数据库文件。
    pub async fn connect_with_settings(
        path: &str,
        settings: SqliteConnectSettings,
    ) -> Result<Self, DriverError> {
        let path = path.trim();
        if path.is_empty() {
            return Err(DriverError::ConnectFailed("empty sqlite path".to_string()));
        }
        let opts = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(settings.create_if_missing)
            .read_only(settings.read_only)
            // 写锁冲突时等待而不是立刻 SQLITE_BUSY（多客户端同时开同一文件很常见）
            .busy_timeout(Duration::from_secs(5))
            // 显式开启外键约束（SQLite 自身默认关闭）：表编辑走的是参数化 DML，
            // 打开后误删父行会被数据库挡住，比事后发现孤儿行好
            .foreign_keys(true)
            .log_statements(log::LevelFilter::Off);
        // 不显式设置 journal_mode：sqlx 默认不下发该 pragma，避免把用户的库
        // 悄悄转成 WAL（该转换会改写文件头且不可用 busy_timeout 等待）。
        let pool = connect_sqlite_pool(opts, 4, settings.connect_timeout).await?;
        Ok(Self { pool })
    }

    /// 验证连接可用。
    pub async fn ping(&self) -> Result<i64, DriverError> {
        let row: (i64,) = sqlx::query_as("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(row.0)
    }

    /// 列出主库与所有 ATTACH 的库（`PRAGMA database_list`）。
    pub async fn list_databases(&self) -> Result<Vec<DatabaseMeta>, DriverError> {
        let rows = sqlx::query_as::<_, (i64, String, Option<String>)>("PRAGMA database_list")
            .fetch_all(&self.pool)
            .await
            .map_err(query_failed)?;
        let databases: Vec<DatabaseMeta> = rows
            .into_iter()
            .map(|(_, name, _)| DatabaseMeta {
                is_current: name == MAIN_DATABASE,
                name,
            })
            .collect();
        // 极端情况下（pragma 被裁剪）兜底给出主库，保证前端树不空
        if databases.is_empty() {
            return Ok(vec![DatabaseMeta {
                name: MAIN_DATABASE.to_string(),
                is_current: true,
            }]);
        }
        Ok(databases)
    }

    /// SQLite 没有独立 schema 层级，恒返回空列表（前端据此不渲染 schema 层）。
    pub async fn list_schemas(&self, _database: &str) -> Result<Vec<SchemaMeta>, DriverError> {
        Ok(Vec::new())
    }

    /// 列出库内的表与视图；`sqlite_%` 内部对象不展示。
    pub async fn list_tables(&self, scope: &MetadataScope) -> Result<Vec<TableMeta>, DriverError> {
        let database = scope_database(scope);
        // 库名是标识符，不能参数化；双引号引用后内部双引号双写，注入不可达
        let sql = format!(
            "SELECT name, type FROM {}.sqlite_master \
             WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' \
             ORDER BY name",
            quote_sqlite_ident(&database)
        );
        let rows = sqlx::query_as::<_, (String, String)>(&sql)
            .fetch_all(&self.pool)
            .await
            .map_err(query_failed)?;
        Ok(rows
            .into_iter()
            .map(|(name, kind)| TableMeta {
                name,
                table_type: if kind == "view" {
                    "VIEW".to_string()
                } else {
                    "BASE TABLE".to_string()
                },
                // SQLite 不维护行数统计，没有可用的低成本估算
                rows: None,
                comment: None,
            })
            .collect())
    }

    /// 列出表的列（`pragma_table_info`）。
    ///
    /// `column_key` 与 MySQL 语义对齐：主键 PRI，单列唯一索引 UNI，其余被索引列 MUL。
    pub async fn list_columns(
        &self,
        scope: &MetadataScope,
        table: &str,
    ) -> Result<Vec<ColumnMeta>, DriverError> {
        let database = scope_database(scope);
        let columns = self.table_info(&database, table).await?;
        let indexes = self.list_indexes(scope, table).await?;
        let mut unique_single: std::collections::BTreeSet<&str> = Default::default();
        let mut indexed: std::collections::BTreeSet<&str> = Default::default();
        for index in &indexes {
            if index.index_type == "PRIMARY" {
                continue;
            }
            if index.unique && index.columns.len() == 1 {
                unique_single.insert(index.columns[0].as_str());
            }
            for column in &index.columns {
                indexed.insert(column.as_str());
            }
        }
        Ok(columns
            .iter()
            .map(|column| ColumnMeta {
                column_key: if column.pk > 0 {
                    "PRI".to_string()
                } else if unique_single.contains(column.name.as_str()) {
                    "UNI".to_string()
                } else if indexed.contains(column.name.as_str()) {
                    "MUL".to_string()
                } else {
                    String::new()
                },
                name: column.name.clone(),
                // 无声明类型的列（如 rowid 别名的表达式列）统一显示 BLOB 亲和性
                data_type: if column.data_type.is_empty() {
                    "BLOB".to_string()
                } else {
                    column.data_type.clone()
                },
                nullable: !column.not_null && column.pk == 0,
                default_value: column.default_value.clone(),
                comment: None,
            })
            .collect())
    }

    /// 逐表汇总列与约束（FR-263 ER 图用）。
    ///
    /// SQLite 是本地文件，pragma 查询本身很便宜，这里只把 N 张表的多次 IPC 往返
    /// 收敛成一次调用。
    pub async fn schema_overview(
        &self,
        scope: &MetadataScope,
    ) -> Result<Vec<TableOverview>, DriverError> {
        let mut overviews = Vec::new();
        for table in self.list_tables(scope).await? {
            if table.table_type != "BASE TABLE" {
                continue;
            }
            let columns = self.list_columns(scope, &table.name).await?;
            let constraints = self.list_constraints(scope, &table.name).await?;
            overviews.push(TableOverview {
                name: table.name,
                comment: table.comment,
                columns,
                constraints,
            });
        }
        Ok(overviews)
    }

    /// 列出表的索引（FR-241）。
    ///
    /// `INTEGER PRIMARY KEY`（rowid 别名）在 `index_list` 中没有条目，
    /// 这里按 `table_info` 的 pk 顺序补一条 PRIMARY，保证主键校验链路可用。
    pub async fn list_indexes(
        &self,
        scope: &MetadataScope,
        table: &str,
    ) -> Result<Vec<IndexMeta>, DriverError> {
        let database = scope_database(scope);
        let rows = sqlx::query_as::<_, (i64, String, i64, String)>(
            "SELECT seq, name, \"unique\", origin FROM pragma_index_list(?, ?) ORDER BY seq",
        )
        .bind(table)
        .bind(&database)
        .fetch_all(&self.pool)
        .await
        .map_err(query_failed)?;

        let mut indexes: Vec<IndexMeta> = Vec::with_capacity(rows.len());
        let mut has_primary = false;
        for (_, name, unique, origin) in rows {
            let columns = self.index_columns(&database, &name).await?;
            // 表达式索引的成员列名为 NULL，index_columns 已过滤，可能剩空列表
            if columns.is_empty() {
                continue;
            }
            let index_type = match origin.as_str() {
                "pk" => {
                    has_primary = true;
                    "PRIMARY"
                }
                _ if unique != 0 => "UNIQUE",
                _ => "INDEX",
            };
            indexes.push(IndexMeta {
                name,
                columns,
                unique: unique != 0 || index_type == "PRIMARY",
                index_type: index_type.to_string(),
            });
        }

        if !has_primary {
            let pk_columns = primary_key_columns(&self.table_info(&database, table).await?);
            if !pk_columns.is_empty() {
                indexes.insert(
                    0,
                    IndexMeta {
                        name: "PRIMARY".to_string(),
                        columns: pk_columns,
                        unique: true,
                        index_type: "PRIMARY".to_string(),
                    },
                );
            }
        }
        Ok(indexes)
    }

    /// 列出表的约束（FR-241）：主键、唯一约束与外键。
    ///
    /// SQLite 的 CHECK 约束只存在于 `sqlite_master.sql` 原文里，没有 pragma 可查，
    /// 这里不做 DDL 文本解析，因此不返回 CHECK。
    pub async fn list_constraints(
        &self,
        scope: &MetadataScope,
        table: &str,
    ) -> Result<Vec<ConstraintMeta>, DriverError> {
        let database = scope_database(scope);
        let mut constraints: Vec<ConstraintMeta> = Vec::new();

        let pk_columns = primary_key_columns(&self.table_info(&database, table).await?);
        if !pk_columns.is_empty() {
            constraints.push(ConstraintMeta {
                name: "PRIMARY".to_string(),
                constraint_type: "PRIMARY KEY".to_string(),
                columns: pk_columns,
                reference: None,
            });
        }

        for index in self.list_indexes(scope, table).await? {
            if index.index_type == "UNIQUE" {
                constraints.push(ConstraintMeta {
                    name: index.name,
                    constraint_type: "UNIQUE".to_string(),
                    columns: index.columns,
                    reference: None,
                });
            }
        }

        // 外键按 id 归组；reference 用 MySQL 同款 `table(col, col)` 文本，
        // 前端 ER / 外键跳转的解析规则可直接复用
        let rows = sqlx::query_as::<_, (i64, i64, String, String, Option<String>)>(
            "SELECT id, seq, \"table\", \"from\", \"to\" \
             FROM pragma_foreign_key_list(?, ?) ORDER BY id, seq",
        )
        .bind(table)
        .bind(&database)
        .fetch_all(&self.pool)
        .await
        .map_err(query_failed)?;
        let mut grouped: BTreeMap<i64, (String, Vec<String>, Vec<String>)> = BTreeMap::new();
        for (id, _, target_table, from, to) in rows {
            let entry = grouped
                .entry(id)
                .or_insert_with(|| (target_table, Vec::new(), Vec::new()));
            entry.1.push(from);
            // `to` 为 NULL 表示引用目标表的主键，交由前端按目标表主键解析
            if let Some(to) = to {
                entry.2.push(to);
            }
        }
        for (id, (target_table, from_columns, to_columns)) in grouped {
            let target_columns = if to_columns.is_empty() {
                primary_key_columns(&self.table_info(&database, &target_table).await?)
            } else {
                to_columns
            };
            constraints.push(ConstraintMeta {
                name: format!("fk_{table}_{id}"),
                constraint_type: "FOREIGN KEY".to_string(),
                columns: from_columns,
                reference: Some(format!("{target_table}({})", target_columns.join(", "))),
            });
        }
        Ok(constraints)
    }

    /// 执行 SQL，默认使用编辑器 10 万行硬上限。
    pub async fn query(&self, sql: &str) -> Result<RowSet, DriverError> {
        self.query_with_options(sql, QueryOptions::default(), CancellationToken::new())
            .await
    }

    /// 执行 SQL，支持行数上限、写确认与 progress handler 取消。
    pub async fn query_with_options(
        &self,
        sql: &str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        let prepared = prepare_query_sql_for_dialect(sql, options, SqlDialect::Sqlite)?;
        // 与 MySQL / PG 一致：事务控制语句必须走独占 session（FR-244）
        if matches!(prepared.kind, PreparedSqlKind::TxControl(_)) {
            return Err(DriverError::TxRequiresSession);
        }
        self.execute_prepared(&prepared, cancel_token).await
    }

    /// 从 pool 取连接执行已分类语句（`query` / `query_many` 共用）。
    async fn execute_prepared(
        &self,
        prepared: &PreparedSql,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        let mut conn = self.pool.acquire().await.map_err(query_failed)?;
        execute_prepared_on(&mut conn, prepared, cancel_token, DirtyConnPolicy::Discard).await
    }

    /// 执行多语句脚本（FR-243）：拆分 → 预检 → 顺序执行，首错 / 取消中止。
    pub async fn query_many(
        &self,
        sql: &str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> Result<MultiQueryResult, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        let (statements, prepared_list) = prepare_statements(sql, options, SqlDialect::Sqlite)?;
        let driver = self.clone();
        query_many_with(
            statements,
            prepared_list,
            move |prepared, token| {
                let driver = driver.clone();
                Box::pin(async move { driver.execute_prepared(prepared, token).await })
            },
            cancel_token,
        )
        .await
    }

    /// 浏览表数据（FR-242）：服务端筛选 / 排序 / 分页，COUNT 超时降级 None。
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
        let database = scope_database(scope);
        let from = qualified_table(&database, table);
        let (where_sql, binds) =
            build_filter_clause(&query.filters, quote_sqlite_ident, |_| "?".to_string());
        let order_sql = query.order.as_ref().map_or(String::new(), |order| {
            format!(
                " ORDER BY {} {}",
                quote_sqlite_ident(&order.column),
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
        let data_future = async {
            let columns = describe_columns(&mut conn, &data_sql)
                .await
                .unwrap_or_default();
            fetch_rows(
                &mut conn,
                &data_sql,
                &binds,
                columns,
                limit + 1,
                cancel_token.clone(),
                DirtyConnPolicy::Discard,
            )
            .await
        };
        let count_future = self.count_rows(&count_sql, &binds, &cancel_token);
        let (data_result, total) = tokio::join!(data_future, count_future);
        let row_set = data_result?;
        let mut data = row_set.rows;

        // 列头补空：0 行结果集也展示表头
        let columns = if row_set.columns.is_empty() {
            self.list_columns(scope, table)
                .await?
                .into_iter()
                .map(|column| column.name)
                .collect()
        } else {
            row_set.columns
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

    /// COUNT 查询：独立连接 + 5s 超时 + 可取消；超时/失败降级 None。
    async fn count_rows(
        &self,
        sql: &str,
        binds: &[FilterValue],
        cancel_token: &CancellationToken,
    ) -> Option<u64> {
        let work = async {
            let mut conn = self.pool.acquire().await.ok()?;
            bind_filter_values(sqlx::query_scalar::<_, i64>(sql), binds)
                .fetch_one(&mut *conn)
                .await
                .ok()
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

    /// 批量应用表编辑（FR-250）：短事务独占一条连接，逐条参数化 DML，
    /// 全部成功才 COMMIT；任一失败 / 取消 / 影响行数异常整体回滚。
    pub async fn apply_table_edits(
        &self,
        scope: &MetadataScope,
        table: &str,
        pk_columns: &[String],
        edits: &[TableEdit],
        cancel_token: CancellationToken,
    ) -> Result<ApplyEditsResult, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        if edits.is_empty() {
            return Ok(ApplyEditsResult { applied: 0 });
        }
        let database = scope_database(scope);
        // 主键权威校验：传入列集合必须与表真实主键一致（顺序无关）
        let actual: std::collections::BTreeSet<String> = self
            .table_info(&database, table)
            .await
            .map(|info| primary_key_columns(&info).into_iter().collect())?;
        let expected: std::collections::BTreeSet<String> = pk_columns.iter().cloned().collect();
        if actual.is_empty() || actual != expected {
            return Err(DriverError::NoPrimaryKey);
        }

        let table_sql = qualified_table(&database, table);
        let mut conn = self.pool.acquire().await.map_err(query_failed)?;
        conn.execute(sqlx::raw_sql("BEGIN"))
            .await
            .map_err(query_failed)?;

        let mut applied = 0usize;
        for (index, edit) in edits.iter().enumerate() {
            let Some((sql, binds)) =
                build_edit_sql(edit, &table_sql, quote_sqlite_ident, |_| "?".to_string())
            else {
                continue;
            };
            let done = match execute_dml(&mut conn, &sql, &binds, &cancel_token).await {
                Ok(done) => done,
                Err(DriverError::QueryCancelled) => {
                    rollback_or_close(&mut conn).await;
                    return Err(DriverError::QueryCancelled);
                }
                Err(error) => {
                    rollback_or_close(&mut conn).await;
                    return Err(DriverError::EditApplyFailed {
                        index,
                        detail: error.to_string(),
                    });
                }
            };
            // UPDATE / DELETE 期望恰好命中 1 行：0 行即他端并发改动，>1 行说明
            // 定位条件不唯一，两者都整体回滚报冲突
            if !matches!(edit, TableEdit::Insert { .. }) && done != 1 {
                rollback_or_close(&mut conn).await;
                return Err(DriverError::EditConflict { index });
            }
            applied += 1;
        }

        if let Err(error) = conn.execute(sqlx::raw_sql("COMMIT")).await {
            // COMMIT 失败销毁连接，未提交事务由 SQLite 在连接关闭时回滚
            conn.close_on_drop();
            return Err(query_failed(error));
        }
        Ok(ApplyEditsResult { applied })
    }

    /// 批量插入行（FR-252）：参数化逐行 INSERT；transactional 时批内单事务，
    /// 失败整体回滚并定位批内行号；非事务模式逐行 autocommit 收集失败行。
    pub async fn bulk_insert_rows(
        &self,
        scope: &MetadataScope,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
        transactional: bool,
        cancel_token: CancellationToken,
    ) -> Result<BulkInsertResult, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        if rows.is_empty() {
            return Ok(BulkInsertResult {
                inserted: 0,
                failed_rows: vec![],
            });
        }
        if columns.is_empty() {
            return Err(DriverError::InvalidSql);
        }
        let database = scope_database(scope);
        let table_sql = qualified_table(&database, table);
        let mut conn = self.pool.acquire().await.map_err(query_failed)?;
        if transactional {
            conn.execute(sqlx::raw_sql("BEGIN"))
                .await
                .map_err(query_failed)?;
        }

        let mut inserted = 0usize;
        let mut failed_rows: Vec<usize> = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            let (sql, binds) =
                build_insert_row(&table_sql, columns, row, quote_sqlite_ident, |_| {
                    "?".to_string()
                });
            match execute_dml(&mut conn, &sql, &binds, &cancel_token).await {
                Ok(_) => inserted += 1,
                Err(DriverError::QueryCancelled) => {
                    if transactional {
                        rollback_or_close(&mut conn).await;
                    }
                    return Err(DriverError::QueryCancelled);
                }
                Err(error) if transactional => {
                    rollback_or_close(&mut conn).await;
                    return Err(DriverError::EditApplyFailed {
                        index,
                        detail: error.to_string(),
                    });
                }
                Err(_) => failed_rows.push(index),
            }
        }

        if transactional {
            if let Err(error) = conn.execute(sqlx::raw_sql("COMMIT")).await {
                conn.close_on_drop();
                return Err(query_failed(error));
            }
        }
        Ok(BulkInsertResult {
            inserted,
            failed_rows,
        })
    }

    /// 幂等关闭连接池。
    pub async fn close(&self) {
        self.pool.close().await;
    }

    /// 读取 `pragma_table_info`，供列 / 索引 / 主键校验共用。
    async fn table_info(
        &self,
        database: &str,
        table: &str,
    ) -> Result<Vec<SqliteColumnInfo>, DriverError> {
        let rows = sqlx::query_as::<_, (String, String, i64, Option<String>, i64)>(
            "SELECT name, type, \"notnull\", dflt_value, pk \
             FROM pragma_table_info(?, ?) ORDER BY cid",
        )
        .bind(table)
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(query_failed)?;
        Ok(rows
            .into_iter()
            .map(
                |(name, data_type, not_null, default_value, pk)| SqliteColumnInfo {
                    name,
                    data_type,
                    not_null: not_null != 0,
                    default_value,
                    pk,
                },
            )
            .collect())
    }

    /// 读取索引成员列（表达式索引成员列名为 NULL，直接过滤）。
    async fn index_columns(&self, database: &str, index: &str) -> Result<Vec<String>, DriverError> {
        let rows = sqlx::query_as::<_, (i64, Option<String>)>(
            "SELECT seqno, name FROM pragma_index_info(?, ?) ORDER BY seqno",
        )
        .bind(index)
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(query_failed)?;
        Ok(rows.into_iter().filter_map(|(_, name)| name).collect())
    }
}

impl Driver for SqliteDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::Sqlite
    }

    fn ping(&self) -> DriverFuture<'_, i64> {
        Box::pin(SqliteDriver::ping(self))
    }

    fn list_databases(&self) -> DriverFuture<'_, Vec<DatabaseMeta>> {
        Box::pin(SqliteDriver::list_databases(self))
    }

    fn list_schemas<'a>(&'a self, database: &'a str) -> DriverFuture<'a, Vec<SchemaMeta>> {
        Box::pin(SqliteDriver::list_schemas(self, database))
    }

    fn list_tables<'a>(&'a self, scope: &'a MetadataScope) -> DriverFuture<'a, Vec<TableMeta>> {
        Box::pin(SqliteDriver::list_tables(self, scope))
    }

    fn list_columns<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ColumnMeta>> {
        Box::pin(SqliteDriver::list_columns(self, scope, table))
    }

    fn list_indexes<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<IndexMeta>> {
        Box::pin(SqliteDriver::list_indexes(self, scope, table))
    }

    fn list_constraints<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ConstraintMeta>> {
        Box::pin(SqliteDriver::list_constraints(self, scope, table))
    }

    fn schema_overview<'a>(
        &'a self,
        scope: &'a MetadataScope,
    ) -> DriverFuture<'a, Vec<TableOverview>> {
        Box::pin(SqliteDriver::schema_overview(self, scope))
    }

    fn query<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, RowSet> {
        Box::pin(SqliteDriver::query_with_options(
            self,
            sql,
            options,
            cancel_token,
        ))
    }

    fn begin_session(&self) -> DriverFuture<'_, Box<dyn DriverSession>> {
        Box::pin(async move {
            Ok(Box::new(SqliteSession::begin(self.clone()).await?) as Box<dyn DriverSession>)
        })
    }

    fn browse_table<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        query: &'a TableBrowseQuery,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, TableBrowseResult> {
        Box::pin(SqliteDriver::browse_table(
            self,
            scope,
            table,
            query,
            cancel_token,
        ))
    }

    fn query_many<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, MultiQueryResult> {
        Box::pin(SqliteDriver::query_many(self, sql, options, cancel_token))
    }

    fn apply_table_edits<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        pk_columns: &'a [String],
        edits: &'a [TableEdit],
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, ApplyEditsResult> {
        Box::pin(SqliteDriver::apply_table_edits(
            self,
            scope,
            table,
            pk_columns,
            edits,
            cancel_token,
        ))
    }

    fn bulk_insert_rows<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        columns: &'a [String],
        rows: &'a [Vec<Option<String>>],
        transactional: bool,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, BulkInsertResult> {
        Box::pin(SqliteDriver::bulk_insert_rows(
            self,
            scope,
            table,
            columns,
            rows,
            transactional,
            cancel_token,
        ))
    }

    fn close(&self) -> DriverCloseFuture<'_> {
        Box::pin(SqliteDriver::close(self))
    }
}

/// SQLite 独占 session：BEGIN 后所有语句固定同一物理连接（FR-244）。
///
/// SQLite 事务是连接级的，取消后 progress handler 已摘除、连接协议无残留，
/// 因此不像 PostgreSQL 那样需要额外的 `SELECT 1` 协议校验；连接断开
///（文件被删除 / 磁盘错误）时后续语句返回 `SessionBroken`。
pub struct SqliteSession {
    conn: Option<sqlx::pool::PoolConnection<Sqlite>>,
    in_transaction: bool,
}

impl SqliteSession {
    async fn begin(driver: SqliteDriver) -> Result<Self, DriverError> {
        let mut conn = driver.pool.acquire().await.map_err(query_failed)?;
        conn.execute(sqlx::raw_sql("BEGIN"))
            .await
            .map_err(query_failed)?;
        Ok(Self {
            conn: Some(conn),
            in_transaction: true,
        })
    }

    /// 归还 pool 前尽力回滚；失败销毁连接（SQLite 在连接关闭时兜底回滚）。
    async fn cleanup(mut conn: sqlx::pool::PoolConnection<Sqlite>, in_transaction: bool) {
        if !in_transaction {
            return;
        }
        let done = timeout(
            CONTROL_QUERY_TIMEOUT * 2,
            conn.execute(sqlx::raw_sql("ROLLBACK")),
        )
        .await;
        if !matches!(done, Ok(Ok(_))) {
            conn.close_on_drop();
        }
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

impl DriverSession for SqliteSession {
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
            let prepared = prepare_query_sql_for_dialect(sql, options, SqlDialect::Sqlite)?;
            let Some(conn) = self.conn.as_mut() else {
                return Err(DriverError::SessionBroken);
            };
            if let PreparedSqlKind::TxControl(tx) = prepared.kind {
                // 事务控制语句执行很快，取消窗口可忽略
                let result = conn
                    .execute(sqlx::raw_sql(&prepared.sql))
                    .await
                    .map_err(query_failed)?;
                match tx {
                    TxControl::Begin => self.in_transaction = true,
                    TxControl::Commit | TxControl::Rollback => self.in_transaction = false,
                    TxControl::Neutral => {}
                }
                return Ok(RowSet {
                    columns: vec!["affected_rows".to_string()],
                    rows: vec![vec![Some(result.rows_affected().to_string())]],
                    truncated: false,
                });
            }
            execute_prepared_on(conn, &prepared, cancel_token, DirtyConnPolicy::Keep).await
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

impl Drop for SqliteSession {
    fn drop(&mut self) {
        let Some(conn) = self.conn.take() else {
            return;
        };
        // 未经 close 的 session：后台尽力回滚后归还，无 runtime 直接销毁连接
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(Self::cleanup(conn, self.in_transaction));
        } else {
            let mut conn = conn;
            conn.close_on_drop();
        }
    }
}

/// `pragma_table_info` 的单列快照。
struct SqliteColumnInfo {
    name: String,
    data_type: String,
    not_null: bool,
    default_value: Option<String>,
    /// 0 表示非主键，否则是主键内 1 起的位置
    pk: i64,
}

/// 按 pk 位置排序取出主键列名。
fn primary_key_columns(columns: &[SqliteColumnInfo]) -> Vec<String> {
    let mut pk: Vec<&SqliteColumnInfo> = columns.iter().filter(|column| column.pk > 0).collect();
    pk.sort_by_key(|column| column.pk);
    pk.into_iter().map(|column| column.name.clone()).collect()
}

/// 作用域库名：空值回落到主库 `main`。
fn scope_database(scope: &MetadataScope) -> String {
    let name = scope.database.trim();
    if name.is_empty() {
        MAIN_DATABASE.to_string()
    } else {
        name.to_string()
    }
}

/// 生成 `"db"."table"` 全限定表名。
fn qualified_table(database: &str, table: &str) -> String {
    format!(
        "{}.{}",
        quote_sqlite_ident(database),
        quote_sqlite_ident(table)
    )
}

async fn connect_sqlite_pool(
    opts: SqliteConnectOptions,
    max_connections: u32,
    connect_timeout: Option<Duration>,
) -> Result<SqlitePool, DriverError> {
    let future = SqlitePoolOptions::new()
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

/// 给连接装上 progress handler：token 取消后回调返回 false，SQLite 中断当前语句。
async fn arm_cancel(conn: &mut sqlx::pool::PoolConnection<Sqlite>, token: CancellationToken) {
    if let Ok(mut handle) = conn.lock_handle().await {
        handle.set_progress_handler(PROGRESS_HANDLER_OPS, move || !token.is_cancelled());
    }
}

/// 摘除 progress handler。**语句结束必须调用**：handler 会跟着连接回池，
/// 旧 token 一旦取消，后续借用这条连接的查询会被立刻中断。
async fn disarm_cancel(conn: &mut sqlx::pool::PoolConnection<Sqlite>) {
    if let Ok(mut handle) = conn.lock_handle().await {
        handle.remove_progress_handler();
    }
}

/// 把筛选绑定值按顺序挂到 query 上（`?` 占位符与 binds 顺序一一对应）。
fn bind_filter_values<'q, O>(
    mut query: sqlx::query::QueryScalar<'q, Sqlite, O, sqlx::sqlite::SqliteArguments<'q>>,
    binds: &[FilterValue],
) -> sqlx::query::QueryScalar<'q, Sqlite, O, sqlx::sqlite::SqliteArguments<'q>> {
    for value in binds {
        query = match value {
            FilterValue::Int(v) => query.bind(*v),
            FilterValue::Float(v) => query.bind(*v),
            FilterValue::Text(v) => query.bind(v.clone()),
        };
    }
    query
}

fn bind_values<'q>(
    mut query: sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    binds: &[FilterValue],
) -> sqlx::query::Query<'q, Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for value in binds {
        query = match value {
            FilterValue::Int(v) => query.bind(*v),
            FilterValue::Float(v) => query.bind(*v),
            FilterValue::Text(v) => query.bind(v.clone()),
        };
    }
    query
}

/// 执行一条参数化 DML，返回影响行数；取消时返回 [`DriverError::QueryCancelled`]。
async fn execute_dml(
    conn: &mut sqlx::pool::PoolConnection<Sqlite>,
    sql: &str,
    binds: &[FilterValue],
    cancel_token: &CancellationToken,
) -> Result<u64, DriverError> {
    arm_cancel(conn, cancel_token.clone()).await;
    let outcome = tokio::select! {
        biased;
        _ = cancel_token.cancelled() => None,
        result = bind_values(sqlx::query(sql), binds).execute(&mut **conn) => Some(result),
    };
    disarm_cancel(conn).await;
    match outcome {
        None => Err(DriverError::QueryCancelled),
        Some(Err(_)) if cancel_token.is_cancelled() => Err(DriverError::QueryCancelled),
        Some(Err(error)) => Err(query_failed(error)),
        Some(Ok(done)) => Ok(done.rows_affected()),
    }
}

/// 事务失败路径：尽力 ROLLBACK；失败销毁连接（SQLite 在连接关闭时兜底回滚）。
async fn rollback_or_close(conn: &mut sqlx::pool::PoolConnection<Sqlite>) {
    if conn.execute(sqlx::raw_sql("ROLLBACK")).await.is_err() {
        conn.close_on_drop();
    }
}

/// 在给定连接上执行已分类语句（pool 路径与 session 路径共用）。
async fn execute_prepared_on(
    conn: &mut sqlx::pool::PoolConnection<Sqlite>,
    prepared: &PreparedSql,
    cancel_token: CancellationToken,
    dirty: DirtyConnPolicy,
) -> Result<RowSet, DriverError> {
    match prepared.kind {
        PreparedSqlKind::Read { limit, .. } => {
            let columns = describe_columns(conn, &prepared.sql).await?;
            fetch_rows(
                conn,
                &prepared.sql,
                &[],
                columns,
                limit,
                cancel_token,
                dirty,
            )
            .await
        }
        PreparedSqlKind::Write => {
            let columns = describe_columns(conn, &prepared.sql).await?;
            if columns.is_empty() {
                let affected = execute_dml(conn, &prepared.sql, &[], &cancel_token).await?;
                Ok(RowSet {
                    columns: vec!["affected_rows".to_string()],
                    rows: vec![vec![Some(affected.to_string())]],
                    truncated: false,
                })
            } else {
                // SQLite 3.35+ 的 DML ... RETURNING：既要写确认，也要把结果行返回
                fetch_rows(
                    conn,
                    &prepared.sql,
                    &[],
                    columns,
                    prepared.row_limit,
                    cancel_token,
                    dirty,
                )
                .await
            }
        }
        PreparedSqlKind::TxControl(_) => unreachable!("TxControl 已在调用方分流"),
    }
}

/// 抓取行流：客户端上限截断 + 可取消。取消后按 `dirty` 决定销毁还是保留连接。
async fn fetch_rows(
    conn: &mut sqlx::pool::PoolConnection<Sqlite>,
    sql: &str,
    binds: &[FilterValue],
    mut columns: Vec<String>,
    limit: usize,
    cancel_token: CancellationToken,
    dirty: DirtyConnPolicy,
) -> Result<RowSet, DriverError> {
    arm_cancel(conn, cancel_token.clone()).await;
    let mut data: Vec<Vec<Option<String>>> = Vec::new();
    let mut truncated = false;
    let mut cancelled = false;
    let mut failure: Option<DriverError> = None;
    {
        let mut stream = bind_values(sqlx::query(sql), binds).fetch(&mut **conn);
        loop {
            tokio::select! {
                biased;
                _ = cancel_token.cancelled() => {
                    cancelled = true;
                    break;
                }
                row = stream.try_next() => {
                    let row = match row {
                        Ok(row) => row,
                        Err(_) if cancel_token.is_cancelled() => {
                            cancelled = true;
                            break;
                        }
                        Err(error) => {
                            failure = Some(query_failed(error));
                            break;
                        }
                    };
                    let Some(row) = row else { break };
                    if columns.is_empty() {
                        columns = row
                            .columns()
                            .iter()
                            .map(|column| column.name().to_string())
                            .collect();
                    }
                    if data.len() >= limit {
                        truncated = true;
                        break;
                    }
                    data.push(
                        (0..row.columns().len())
                            .map(|index| sqlite_cell_to_string(&row, index))
                            .collect(),
                    );
                }
            }
        }
    }

    if cancelled {
        // 取消后连接上可能还挂着未消费的语句：pool 路径直接销毁；
        // session 路径必须保留连接（事务在上面），只摘掉 handler
        if dirty == DirtyConnPolicy::Discard {
            conn.close_on_drop();
        } else {
            disarm_cancel(conn).await;
        }
        return Err(DriverError::QueryCancelled);
    }
    disarm_cancel(conn).await;
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(RowSet {
        columns,
        rows: data,
        truncated,
    })
}

/// 预取列名，让 0 行结果集也能展示表头，并借此区分「写语句」与「写 + RETURNING」。
async fn describe_columns(
    conn: &mut sqlx::pool::PoolConnection<Sqlite>,
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

/// 把 SQLite 动态结果集的单元格转成字符串；NULL 返回 None。
///
/// **按取值的真实类型分派，不看列声明类型**：SQLite 是动态类型，列声明类型只是
/// 亲和性，而且表达式列（`COUNT(*)`、`a + b`）根本没有声明类型 —— 按声明类型分派
/// 会把这些列一律当成 NULL。真实类型只有 INTEGER / REAL / TEXT / BLOB / NULL 五种，
/// 后面仍保留一条兜底链应对取不到类型的边角情况。
fn sqlite_cell_to_string(row: &SqliteRow, index: usize) -> Option<String> {
    let value_type = match row.try_get_raw(index) {
        Ok(raw) if raw.is_null() => return None,
        Ok(raw) => Some(raw.type_info().name().to_uppercase()),
        Err(_) => None,
    };
    let decoded = match value_type.as_deref() {
        Some("INTEGER") => try_decode_sqlite::<i64>(row, index),
        Some("REAL") => try_decode_sqlite::<f64>(row, index),
        Some("TEXT") => try_decode_sqlite::<String>(row, index),
        Some("BLOB") => decode_sqlite_bytes(row, index),
        _ => None,
    };
    Some(
        decoded
            .or_else(|| try_decode_sqlite::<String>(row, index))
            .or_else(|| try_decode_sqlite::<i64>(row, index))
            .or_else(|| try_decode_sqlite::<f64>(row, index))
            .or_else(|| decode_sqlite_bytes(row, index))
            .unwrap_or_else(|| "<unsupported>".to_string()),
    )
}

fn try_decode_sqlite<'row, T>(row: &'row SqliteRow, index: usize) -> Option<String>
where
    T: sqlx::Decode<'row, Sqlite> + sqlx::Type<Sqlite> + std::string::ToString,
{
    row.try_get::<T, _>(index)
        .ok()
        .map(|value| value.to_string())
}

fn decode_sqlite_bytes(row: &SqliteRow, index: usize) -> Option<String> {
    row.try_get::<Vec<u8>, _>(index)
        .ok()
        .map(|bytes| match std::str::from_utf8(&bytes) {
            Ok(value) => value.to_string(),
            Err(_) => format!("<{} bytes>", bytes.len()),
        })
}
