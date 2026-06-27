//! 数据浏览命令 —— 基于已打开连接的 schema/table 元数据与结果集查询
//!
//! 都从 [`AppState`] 活跃连接注册表里按 `connection_id` 取出 driver（克隆 pool 句柄、
//! 不长持注册表锁），再调 db-driver。连接未打开返回 `error.connection.not_open`。

use db_driver::{ColumnMeta, DatabaseMeta, MySqlDriver, RowSet, TableMeta};
use tauri::State;

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

/// 执行 SQL，返回结果集（Week 3 基础版；子查询包装 LIMIT / 取消留 Week 4）。
#[tauri::command]
pub async fn db_query(
    state: State<'_, AppState>,
    id: String,
    sql: String,
) -> Result<RowSet, String> {
    driver_of(&state, &id)
        .await?
        .query(&sql)
        .await
        .map_err(|e| e.i18n_key().to_string())
}
