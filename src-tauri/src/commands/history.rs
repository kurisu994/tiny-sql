//! SQL 历史命令（FR-106）
//!
//! 历史由后端在 `db_query` 结束后自动记录（成功 / 失败都记），前端只读列表
//! 与显式清空。锁定状态下返回 `error.security.locked`。

use tauri::State;

use crate::config::history::HistoryEntry;
use crate::state::AppState;

/// 列出 SQL 历史（最新在前，最多 100 条）。
#[tauri::command]
pub fn history_list(state: State<'_, AppState>) -> Result<Vec<HistoryEntry>, String> {
    state.history.load()
}

/// 清空全部 SQL 历史。
#[tauri::command]
pub fn history_clear(state: State<'_, AppState>) -> Result<(), String> {
    state.history.clear()
}
