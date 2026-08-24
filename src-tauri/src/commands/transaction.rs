//! 事务命令（FR-244）—— 独占 session 的开启、查询、提交、回滚与关闭
//!
//! 每个事务 tab 对应一个 session；session 内所有语句固定同一物理连接。
//! 连接关闭 / 重连时由 connection 生命周期统一 close（未提交自动回滚），
//! 不存在「重连续事务」语义。

use std::sync::Arc;

use db_driver::{Driver, QueryOptions, RowSet, QUERY_RESULT_LIMIT};
use serde::Serialize;
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::query::{driver_of, record_history, QueryCommandError};
use crate::state::{ActiveQuery, ActiveSession, AppState};

/// 事务内查询的返回：结果集 + 最新事务状态（用户手写 COMMIT/ROLLBACK 后前端同步）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxQueryResult {
    row_set: RowSet,
    in_transaction: bool,
}

/// 从注册表取出 session 句柄并校验连接归属；session 不存在或串连接时统一报失效。
async fn session_of(
    state: &State<'_, AppState>,
    id: &str,
    session_id: &str,
) -> Result<Arc<ActiveSession>, QueryCommandError> {
    let session = state
        .sessions
        .lock()
        .await
        .get(session_id)
        .cloned()
        .ok_or_else(|| QueryCommandError::from_key("error.driver.session_broken"))?;
    if session.connection_id != id {
        return Err(QueryCommandError::from_key("error.driver.session_broken"));
    }
    Ok(session)
}

/// 开启事务：建立独占 session 并 BEGIN，返回 session_id。
#[tauri::command]
pub async fn transaction_begin(
    state: State<'_, AppState>,
    id: String,
) -> Result<String, QueryCommandError> {
    crate::commands::query::reject_if_read_only(&state, &id)?;
    // 与 close/reconnect 串行化「取 driver + 建 session + 注册」：
    // session 要么注册后被重连清理，要么就建立在新连接上，不会落进两阶段之间。
    let lifecycle = state.connection_lifecycle(&id);
    let _lifecycle = lifecycle.lock().await;
    let driver = driver_of(&state, &id)
        .await
        .map_err(QueryCommandError::from_key)?;
    let session = Driver::begin_session(&driver)
        .await
        .map_err(QueryCommandError::from)?;
    let session_id = Uuid::new_v4().to_string();
    state.sessions.lock().await.insert(
        session_id.clone(),
        Arc::new(ActiveSession {
            connection_id: id.clone(),
            session: tokio::sync::Mutex::new(session),
        }),
    );
    Ok(session_id)
}

/// 事务内查询输入（打包结构以满足 command 参数约束）。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxQueryInput {
    pub session_id: String,
    pub sql: String,
    pub query_id: Option<String>,
    pub row_limit: Option<u32>,
    pub allow_write: Option<bool>,
    pub schema: Option<String>,
}

/// 在事务 session 内执行 SQL；取消语义与 `db_query` 相同（复用 query_id + cancel token）。
#[tauri::command]
pub async fn transaction_query(
    state: State<'_, AppState>,
    id: String,
    input: TxQueryInput,
) -> Result<TxQueryResult, QueryCommandError> {
    crate::commands::query::reject_query_if_read_only(
        &state,
        &id,
        &input.sql,
        input.allow_write.unwrap_or(false),
    )?;
    let TxQueryInput {
        session_id,
        sql,
        query_id,
        row_limit,
        allow_write,
        schema,
    } = input;
    let session = session_of(&state, &id, &session_id).await?;
    let query_id = query_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let token = CancellationToken::new();
    state.queries.lock().await.insert(
        query_id.clone(),
        ActiveQuery {
            connection_id: id.clone(),
            cancel_token: token.clone(),
        },
    );
    let mut guard = session.session.lock().await;
    let result = guard
        .query(
            &sql,
            QueryOptions {
                row_limit: row_limit.map(|v| v as usize).unwrap_or(QUERY_RESULT_LIMIT),
                allow_write: allow_write.unwrap_or(false),
            },
            token,
        )
        .await;
    let in_transaction = guard.in_transaction();
    drop(guard);
    state.queries.lock().await.remove(&query_id);
    // 连接已断开时 driver_of 失败：历史跳过，不影响错误返回
    if let Ok(driver) = driver_of(&state, &id).await {
        record_history(
            &state,
            &id,
            &driver,
            &sql,
            schema.as_deref(),
            result.is_ok(),
        );
    }
    let row_set = result.map_err(QueryCommandError::from)?;
    Ok(TxQueryResult {
        row_set,
        in_transaction,
    })
}

/// 提交当前事务。
#[tauri::command]
pub async fn transaction_commit(
    state: State<'_, AppState>,
    id: String,
    session_id: String,
) -> Result<(), QueryCommandError> {
    let session = session_of(&state, &id, &session_id).await?;
    let mut guard = session.session.lock().await;
    guard.commit().await.map_err(QueryCommandError::from)
}

/// 回滚当前事务。
#[tauri::command]
pub async fn transaction_rollback(
    state: State<'_, AppState>,
    id: String,
    session_id: String,
) -> Result<(), QueryCommandError> {
    let session = session_of(&state, &id, &session_id).await?;
    let mut guard = session.session.lock().await;
    guard.rollback().await.map_err(QueryCommandError::from)
}

/// 结束事务 session（未提交自动回滚）；幂等，session 不存在时静默成功。
#[tauri::command]
pub async fn transaction_close(
    state: State<'_, AppState>,
    id: String,
    session_id: String,
) -> Result<(), String> {
    let session = state.sessions.lock().await.remove(&session_id);
    if let Some(session) = session {
        session.session.lock().await.close().await;
    }
    let _ = id;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tx_query_result_serializes_camel_case() {
        let value = serde_json::to_value(TxQueryResult {
            row_set: RowSet {
                columns: vec![],
                rows: vec![],
                truncated: false,
            },
            in_transaction: true,
        })
        .unwrap();
        assert!(value.get("rowSet").is_some());
        assert_eq!(value["inTransaction"], true);
    }
}
