//! 数据浏览命令 —— 基于已打开连接的 schema/table 元数据与结果集查询
//!
//! 都从 [`AppState`] 活跃连接注册表里按 `connection_id` 取出 driver（克隆 pool 句柄、
//! 不长持注册表锁），再调 db-driver。连接未打开返回 `error.connection.not_open`。

use db_driver::{
    ColumnMeta, DatabaseMeta, MySqlDriver, QueryOptions, RowSet, TableMeta, QUERY_RESULT_LIMIT,
};
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::state::AppState;

/// 从注册表取出指定连接的 driver 句柄（克隆，brief lock）。
async fn driver_of(state: &State<'_, AppState>, id: &str) -> Result<MySqlDriver, String> {
    let conns = state.connections.lock().await;
    conns
        .get(id)
        .map(|c| c.driver.clone())
        .ok_or_else(|| "error.connection.not_open".to_string())
}

/// 列出连接下所有 database。
#[tauri::command]
pub async fn db_list_databases(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<DatabaseMeta>, String> {
    driver_of(&state, &id)
        .await?
        .list_databases()
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
    driver_of(&state, &id)
        .await?
        .create_database(&name, charset.as_deref(), collation.as_deref())
        .await
        .map_err(|e| e.i18n_key().to_string())
}

/// 列出指定 database 下所有表。
#[tauri::command]
pub async fn db_list_tables(
    state: State<'_, AppState>,
    id: String,
    database: String,
) -> Result<Vec<TableMeta>, String> {
    driver_of(&state, &id)
        .await?
        .list_tables(&database)
        .await
        .map_err(|e| e.i18n_key().to_string())
}

/// 列出指定表的所有列。
#[tauri::command]
pub async fn db_list_columns(
    state: State<'_, AppState>,
    id: String,
    database: String,
    table: String,
) -> Result<Vec<ColumnMeta>, String> {
    driver_of(&state, &id)
        .await?
        .list_columns(&database, &table)
        .await
        .map_err(|e| e.i18n_key().to_string())
}

/// 执行 SQL，返回结果集。
///
/// `row_limit` 用于区分表浏览 1000 行与 SQL 编辑器 10w 行；后端会强制 clamp。
/// `allow_write` 只表示前端已做二次确认，真正的多语句/写操作护栏仍在 db-driver。
#[tauri::command]
pub async fn db_query(
    state: State<'_, AppState>,
    id: String,
    sql: String,
    query_id: Option<String>,
    row_limit: Option<u32>,
    allow_write: Option<bool>,
) -> Result<RowSet, String> {
    let driver = driver_of(&state, &id).await?;
    let query_id = query_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let token = CancellationToken::new();
    state
        .queries
        .lock()
        .await
        .insert(query_id.clone(), token.clone());

    let result = driver
        .query_with_options(
            &sql,
            QueryOptions {
                row_limit: row_limit.map(|v| v as usize).unwrap_or(QUERY_RESULT_LIMIT),
                allow_write: allow_write.unwrap_or(false),
            },
            token,
        )
        .await
        .map_err(|e| e.i18n_key().to_string());

    state.queries.lock().await.remove(&query_id);
    result
}

/// 取消正在执行的 SQL。若 query 已完成，幂等成功。
#[tauri::command]
pub async fn db_query_cancel(state: State<'_, AppState>, query_id: String) -> Result<(), String> {
    if let Some(token) = state.queries.lock().await.get(&query_id) {
        token.cancel();
    }
    Ok(())
}
