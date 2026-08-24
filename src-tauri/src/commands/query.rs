//! 数据浏览命令 —— 基于已打开连接的 schema/table 元数据与结果集查询
//!
//! 都从 [`AppState`] 活跃连接注册表里按 `connection_id` 取出 driver（克隆 pool 句柄、
//! 不长持注册表锁），再调 db-driver。连接未打开返回 `error.connection.not_open`。

use db_driver::{
    ColumnMeta, DatabaseMeta, Driver, DriverError, DriverKind, MetadataScope, QueryOptions, RowSet,
    SchemaMeta, TableBrowseQuery, TableBrowseResult, TableFilter, TableMeta, TableOrder,
    QUERY_RESULT_LIMIT, TABLE_PREVIEW_LIMIT,
};
use serde::Serialize;
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::history::HistoryEntry;
use crate::state::{ActiveDriver, ActiveQuery, AppState};

/// 历史记录中 SQL 文本的最大长度，防止超长语句撑爆加密历史文件。
const HISTORY_SQL_MAX_CHARS: usize = 4000;

/// 查询命令返回给前端的安全错误载荷，只包含稳定 key、可选行号与可选编辑语句序号。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryCommandError {
    key: String,
    line: Option<u32>,
    /// 编辑批失败 / 冲突的语句序号（FR-250），仅编辑相关错误携带。
    edit_index: Option<usize>,
}

impl QueryCommandError {
    pub(crate) fn from_key(key: impl Into<String>) -> Self {
        Self {
            key: key.into(),
            line: None,
            edit_index: None,
        }
    }
}

impl From<DriverError> for QueryCommandError {
    fn from(error: DriverError) -> Self {
        Self {
            key: error.i18n_key().to_string(),
            line: error.sql_line(),
            edit_index: error.edit_index(),
        }
    }
}

/// 从注册表取出指定连接的 driver 句柄（克隆，brief lock）。
pub(crate) async fn driver_of(
    state: &State<'_, AppState>,
    id: &str,
) -> Result<ActiveDriver, String> {
    let conns = state.connections.lock().await;
    conns
        .get(id)
        .map(|c| c.driver.clone())
        .ok_or_else(|| "error.connection.not_open".to_string())
}

/// 连接是否标记应用层只读（FR-270）。配置不存在视为非只读。
pub(crate) fn connection_is_read_only(state: &AppState, id: &str) -> Result<bool, String> {
    let conns = state.store.lock().map_err(|_| "error.security.locked".to_string())?;
    Ok(conns.load()?.iter().any(|c| c.id == id && c.read_only))
}

/// 只读连接禁止写 command。
pub(crate) fn reject_if_read_only(
    state: &AppState,
    id: &str,
) -> Result<(), QueryCommandError> {
    if connection_is_read_only(state, id).map_err(QueryCommandError::from_key)? {
        Err(QueryCommandError::from_key("error.connection.read_only"))
    } else {
        Ok(())
    }
}

/// EXPLAIN ANALYZE / EXPLAIN (ANALYZE …) 会真正执行，只读连接一律拒绝。
pub(crate) fn sql_is_explain_analyze(sql: &str) -> bool {
    let tokens: Vec<String> = sql
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|token| !token.is_empty())
        .map(|token| token.to_ascii_uppercase())
        .collect();
    tokens.first().map(String::as_str) == Some("EXPLAIN")
        && tokens.iter().take(6).any(|token| token == "ANALYZE")
}

pub(crate) fn reject_query_if_read_only(
    state: &AppState,
    id: &str,
    sql: &str,
    allow_write: bool,
) -> Result<(), QueryCommandError> {
    if !connection_is_read_only(state, id).map_err(QueryCommandError::from_key)? {
        return Ok(());
    }
    if allow_write || sql_is_explain_analyze(sql) {
        return Err(QueryCommandError::from_key("error.connection.read_only"));
    }
    Ok(())
}

fn metadata_scope(
    kind: DriverKind,
    database: String,
    schema: Option<String>,
) -> Result<MetadataScope, String> {
    match kind {
        DriverKind::MySql => Ok(MetadataScope::mysql(database)),
        DriverKind::PostgreSql => schema
            .filter(|value| !value.trim().is_empty())
            .map(|schema| MetadataScope::postgresql(database, schema))
            .ok_or_else(|| "error.driver.schema_required".to_string()),
    }
}

/// 列出连接下所有 database。
#[tauri::command]
pub async fn db_list_databases(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<DatabaseMeta>, String> {
    let driver = driver_of(&state, &id).await?;
    Driver::list_databases(&driver)
        .await
        .map_err(|e| e.i18n_key().to_string())
}

/// 创建 database，并由 db-driver 负责标识符转义与字符集参数校验。
#[tauri::command]
pub async fn db_create_database(
    state: State<'_, AppState>,
    id: String,
    name: String,
    charset: Option<String>,
    collation: Option<String>,
) -> Result<(), String> {
    if connection_is_read_only(&state, &id)? {
        return Err("error.connection.read_only".into());
    }
    let driver = driver_of(&state, &id).await?;
    driver
        .as_mysql()
        .ok_or_else(|| "error.driver.operation_not_supported".to_string())?
        .create_database(&name, charset.as_deref(), collation.as_deref())
        .await
        .map_err(|e| e.i18n_key().to_string())
}

/// 列出指定 database 下的 schema。MySQL 返回同名 schema，PostgreSQL 返回独立层级。
#[tauri::command]
pub async fn db_list_schemas(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> Result<Vec<SchemaMeta>, String> {
    let driver = driver_of(&state, &id).await?;
    Driver::list_schemas(&driver, &database)
        .await
        .map_err(|error| error.i18n_key().to_string())
}

/// 列出指定 database 下所有表。
#[tauri::command]
pub async fn db_list_tables(
    state: State<'_, AppState>,
    id: String,
    database: String,
    schema: Option<String>,
) -> Result<Vec<TableMeta>, String> {
    let driver = driver_of(&state, &id).await?;
    let scope = metadata_scope(Driver::kind(&driver), database, schema)?;
    Driver::list_tables(&driver, &scope)
        .await
        .map_err(|e| e.i18n_key().to_string())
}

/// 列出指定表的所有列。
#[tauri::command]
pub async fn db_list_columns(
    state: State<'_, AppState>,
    id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<ColumnMeta>, String> {
    let driver = driver_of(&state, &id).await?;
    let scope = metadata_scope(Driver::kind(&driver), database, schema)?;
    Driver::list_columns(&driver, &scope, &table)
        .await
        .map_err(|e| e.i18n_key().to_string())
}

/// 列出指定表的索引（FR-241）。
#[tauri::command]
pub async fn db_list_indexes(
    state: State<'_, AppState>,
    id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<db_driver::IndexMeta>, String> {
    let driver = driver_of(&state, &id).await?;
    let scope = metadata_scope(Driver::kind(&driver), database, schema)?;
    Driver::list_indexes(&driver, &scope, &table)
        .await
        .map_err(|e| e.i18n_key().to_string())
}

/// 列出指定表的约束（FR-241）。
#[tauri::command]
pub async fn db_list_constraints(
    state: State<'_, AppState>,
    id: String,
    database: String,
    schema: Option<String>,
    table: String,
) -> Result<Vec<db_driver::ConstraintMeta>, String> {
    let driver = driver_of(&state, &id).await?;
    let scope = metadata_scope(Driver::kind(&driver), database, schema)?;
    Driver::list_constraints(&driver, &scope, &table)
        .await
        .map_err(|e| e.i18n_key().to_string())
}

/// 执行 SQL，返回结果集。
///
/// `row_limit` 用于区分表浏览 1000 行与 SQL 编辑器 10w 行；后端会强制 clamp。
/// `allow_write` 只表示前端已做二次确认，真正的多语句/写操作护栏仍在 db-driver。
/// `schema` 仅用于 SQL 历史元信息（FR-106），PostgreSQL 前端传当前选中 schema。
#[tauri::command]
pub async fn db_query(
    state: State<'_, AppState>,
    id: String,
    sql: String,
    query_id: Option<String>,
    row_limit: Option<u32>,
    allow_write: Option<bool>,
    schema: Option<String>,
) -> Result<RowSet, QueryCommandError> {
    reject_query_if_read_only(
        &state,
        &id,
        &sql,
        allow_write.unwrap_or(false),
    )?;
    let query_id = query_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    // 与 close/reconnect 串行化“取 driver + 注册 token”：这样重连要么能看到并
    // 取消本查询，要么查询取得的就是新 session driver，不会落进两个阶段之间。
    let (driver, token) = {
        let lifecycle = state.connection_lifecycle(&id);
        let _lifecycle = lifecycle.lock().await;
        let driver = driver_of(&state, &id)
            .await
            .map_err(QueryCommandError::from_key)?;
        let token = CancellationToken::new();
        state.queries.lock().await.insert(
            query_id.clone(),
            ActiveQuery {
                connection_id: id.clone(),
                cancel_token: token.clone(),
            },
        );
        (driver, token)
    };

    let result = Driver::query(
        &driver,
        &sql,
        QueryOptions {
            row_limit: row_limit.map(|v| v as usize).unwrap_or(QUERY_RESULT_LIMIT),
            allow_write: allow_write.unwrap_or(false),
        },
        token,
    )
    .await
    .map_err(QueryCommandError::from);

    state.queries.lock().await.remove(&query_id);
    record_history(
        &state,
        &id,
        &driver,
        &sql,
        schema.as_deref(),
        result.is_ok(),
    );
    result
}

/// 把一次执行写入 SQL 历史（FR-106）。历史落盘失败不影响查询结果本身。
pub(crate) fn record_history(
    state: &State<'_, AppState>,
    connection_id: &str,
    driver: &ActiveDriver,
    sql: &str,
    schema: Option<&str>,
    success: bool,
) {
    let sql = sql.trim();
    if sql.is_empty() {
        return;
    }
    let (connection_name, database) = {
        let store = state.store.lock().unwrap();
        store
            .load()
            .ok()
            .and_then(|conns| {
                conns
                    .into_iter()
                    .find(|c| c.id == connection_id)
                    .map(|c| (c.name, c.database))
            })
            .unwrap_or_default()
    };
    let mut sql_text = sql.to_string();
    if sql_text.chars().count() > HISTORY_SQL_MAX_CHARS {
        sql_text = sql_text.chars().take(HISTORY_SQL_MAX_CHARS).collect();
    }
    let entry = HistoryEntry {
        id: Uuid::new_v4().to_string(),
        connection_id: connection_id.to_string(),
        connection_name,
        driver: Driver::kind(driver).as_str().to_string(),
        database,
        schema: schema.filter(|s| !s.trim().is_empty()).map(str::to_string),
        sql: sql_text,
        executed_at: chrono::Utc::now().to_rfc3339(),
        success,
    };
    // 锁定等状态下记录失败仅忽略，不向前端报错
    let _ = state.history.record(entry);
}

/// 浏览查询输入（FR-242）：列筛选 / 排序 / 分页。打包结构以满足 command 参数约束。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowseTableInput {
    pub database: String,
    pub schema: Option<String>,
    pub table: String,
    pub filters: Vec<TableFilter>,
    pub order: Option<TableOrder>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

/// 浏览表数据：服务端筛选 / 排序 / 分页（FR-242）。
///
/// 列名白名单在这里强制：filter/order 的列必须属于该表已加载列，杜绝任意标识符
/// 进入查询（driver 侧另有标识符引用转义与值参数化双保险）。
#[tauri::command]
pub async fn db_browse_table(
    state: State<'_, AppState>,
    id: String,
    input: BrowseTableInput,
) -> Result<TableBrowseResult, QueryCommandError> {
    let query_id = Uuid::new_v4().to_string();
    let BrowseTableInput {
        database,
        schema,
        table,
        filters,
        order,
        limit,
        offset,
    } = input;
    // 与 close/reconnect 串行化「取 driver + 注册 token」（同 db_query）
    let (driver, token) = {
        let lifecycle = state.connection_lifecycle(&id);
        let _lifecycle = lifecycle.lock().await;
        let driver = driver_of(&state, &id)
            .await
            .map_err(QueryCommandError::from_key)?;
        let token = CancellationToken::new();
        state.queries.lock().await.insert(
            query_id.clone(),
            ActiveQuery {
                connection_id: id.clone(),
                cancel_token: token.clone(),
            },
        );
        (driver, token)
    };
    let scope = metadata_scope(Driver::kind(&driver), database, schema)
        .map_err(QueryCommandError::from_key)?;
    let result = async {
        let columns = Driver::list_columns(&driver, &scope, &table)
            .await
            .map_err(QueryCommandError::from)?;
        let known: std::collections::HashSet<&str> =
            columns.iter().map(|c| c.name.as_str()).collect();
        let invalid = filters
            .iter()
            .any(|filter| !known.contains(filter.column.as_str()))
            || order
                .as_ref()
                .is_some_and(|order| !known.contains(order.column.as_str()));
        if invalid {
            return Err(QueryCommandError::from_key(
                "error.driver.invalid_identifier",
            ));
        }
        Driver::browse_table(
            &driver,
            &scope,
            &table,
            &TableBrowseQuery {
                filters,
                order,
                limit: limit
                    .map(|value| value as usize)
                    .unwrap_or(TABLE_PREVIEW_LIMIT),
                offset: offset.map(|value| value as usize).unwrap_or(0),
            },
            token,
        )
        .await
        .map_err(QueryCommandError::from)
    }
    .await;
    state.queries.lock().await.remove(&query_id);
    result
}

/// 编辑批输入（FR-250）：主键列 + 编辑操作列表。打包结构以满足 command 参数约束。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyTableEditsInput {
    pub database: String,
    pub schema: Option<String>,
    pub table: String,
    pub pk_columns: Vec<String>,
    pub edits: Vec<db_driver::TableEdit>,
}

/// 批量应用表编辑（FR-250）：后端再次校验列白名单后交给 driver 短事务执行。
/// 错误载荷携带 `editIndex` 供前端定位失败 / 冲突的 dirty 行。
#[tauri::command]
pub async fn db_apply_table_edits(
    state: State<'_, AppState>,
    id: String,
    input: ApplyTableEditsInput,
) -> Result<db_driver::ApplyEditsResult, QueryCommandError> {
    reject_if_read_only(&state, &id)?;
    let ApplyTableEditsInput {
        database,
        schema,
        table,
        pk_columns,
        edits,
    } = input;
    let query_id = Uuid::new_v4().to_string();
    let (driver, token) = {
        let lifecycle = state.connection_lifecycle(&id);
        let _lifecycle = lifecycle.lock().await;
        let driver = driver_of(&state, &id)
            .await
            .map_err(QueryCommandError::from_key)?;
        let token = CancellationToken::new();
        state.queries.lock().await.insert(
            query_id.clone(),
            ActiveQuery {
                connection_id: id.clone(),
                cancel_token: token.clone(),
            },
        );
        (driver, token)
    };
    let scope = metadata_scope(Driver::kind(&driver), database, schema)
        .map_err(QueryCommandError::from_key)?;
    let result = async {
        // 列白名单：编辑涉及的列必须属于该表已加载列（与 db_browse_table 同策略）
        let columns = Driver::list_columns(&driver, &scope, &table)
            .await
            .map_err(QueryCommandError::from)?;
        let known: std::collections::HashSet<&str> =
            columns.iter().map(|c| c.name.as_str()).collect();
        let invalid = !pk_columns.iter().all(|c| known.contains(c.as_str()))
            || edits.iter().any(|edit| match edit {
                db_driver::TableEdit::Insert { values } => values
                    .iter()
                    .any(|cell| !known.contains(cell.column.as_str())),
                db_driver::TableEdit::Update { pk, changes } => pk
                    .iter()
                    .chain(changes.iter())
                    .any(|cell| !known.contains(cell.column.as_str())),
                db_driver::TableEdit::Delete { pk } => {
                    pk.iter().any(|cell| !known.contains(cell.column.as_str()))
                }
            });
        if invalid {
            return Err(QueryCommandError::from_key(
                "error.driver.invalid_identifier",
            ));
        }
        Driver::apply_table_edits(&driver, &scope, &table, &pk_columns, &edits, token)
            .await
            .map_err(QueryCommandError::from)
    }
    .await;
    state.queries.lock().await.remove(&query_id);
    result
}

/// 执行多语句脚本（FR-243）：拆分后逐条执行，首错 / 取消中止。
/// 事务控制语句整体拒绝（tx_requires_session 引导去事务 tab）；
/// 写语句未确认时整体拒绝且不执行任何语句。
#[tauri::command]
pub async fn db_query_many(
    state: State<'_, AppState>,
    id: String,
    sql: String,
    query_id: Option<String>,
    allow_write: Option<bool>,
    schema: Option<String>,
) -> Result<db_driver::MultiQueryResult, QueryCommandError> {
    reject_query_if_read_only(
        &state,
        &id,
        &sql,
        allow_write.unwrap_or(false),
    )?;
    let query_id = query_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let (driver, token) = {
        let lifecycle = state.connection_lifecycle(&id);
        let _lifecycle = lifecycle.lock().await;
        let driver = driver_of(&state, &id)
            .await
            .map_err(QueryCommandError::from_key)?;
        let token = CancellationToken::new();
        state.queries.lock().await.insert(
            query_id.clone(),
            ActiveQuery {
                connection_id: id.clone(),
                cancel_token: token.clone(),
            },
        );
        (driver, token)
    };
    let result = Driver::query_many(
        &driver,
        &sql,
        QueryOptions {
            row_limit: QUERY_RESULT_LIMIT,
            allow_write: allow_write.unwrap_or(false),
        },
        token,
    )
    .await;
    state.queries.lock().await.remove(&query_id);
    // 脚本整体记一条历史；任何语句 error 即视为失败
    let success = result
        .as_ref()
        .map(|multi| {
            multi
                .statements
                .iter()
                .all(|stmt| !matches!(stmt.outcome, db_driver::StatementOutcome::Error { .. }))
        })
        .unwrap_or(false);
    record_history(&state, &id, &driver, &sql, schema.as_deref(), success);
    result.map_err(QueryCommandError::from)
}

/// 取消正在执行的 SQL。若 query 已完成，幂等成功。
#[tauri::command]
pub async fn db_query_cancel(state: State<'_, AppState>, query_id: String) -> Result<(), String> {
    if let Some(query) = state.queries.lock().await.get(&query_id) {
        query.cancel_token.cancel();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_scope_preserves_postgres_schema() {
        let mysql = metadata_scope(
            DriverKind::MySql,
            "app".to_string(),
            Some("ignored".to_string()),
        )
        .expect("MySQL scope 应合法");
        assert_eq!(mysql, MetadataScope::mysql("app"));

        let postgres = metadata_scope(
            DriverKind::PostgreSql,
            "app".to_string(),
            Some("audit".to_string()),
        )
        .expect("PostgreSQL scope 应合法");
        assert_eq!(postgres, MetadataScope::postgresql("app", "audit"));
    }

    #[test]
    fn postgres_scope_requires_schema() {
        let error = metadata_scope(DriverKind::PostgreSql, "app".to_string(), None)
            .expect_err("PostgreSQL 表查询必须显式指定 schema");
        assert_eq!(error, "error.driver.schema_required");
    }

    #[test]
    fn query_command_error_exposes_only_key_and_line() {
        let error = QueryCommandError::from(DriverError::QueryFailed(
            "You have an error near 'secret_table' at line 12".to_string(),
        ));
        let value = serde_json::to_value(error).unwrap();

        assert_eq!(value["key"], "error.driver.query_failed");
        assert_eq!(value["line"], 12);
        assert!(!value.to_string().contains("secret_table"));
    }

    #[test]
    fn explain_analyze_variants_are_detected() {
        assert!(sql_is_explain_analyze("EXPLAIN ANALYZE SELECT 1"));
        assert!(sql_is_explain_analyze("explain (analyze, format json) select 1"));
        assert!(!sql_is_explain_analyze("EXPLAIN SELECT 1"));
        assert!(!sql_is_explain_analyze("EXPLAIN SELECT analyze_col FROM t"));
        assert!(!sql_is_explain_analyze("SELECT 1"));
    }
}
