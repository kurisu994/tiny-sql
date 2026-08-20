//! SQL 文件命令（FR-240）—— 保存 / 打开 SQL 文件与最近文件列表
//!
//! 文件读写由后端完成（与导出同一模式，不引入 tauri-plugin-fs）；
//! 路径由用户通过系统对话框选择，后端不主动扫描目录。

use tauri::State;

use crate::config::recent_files::RecentFileEntry;
use crate::state::AppState;

/// SQL 文件大小上限（防误读超大文件拖垮编辑器）。
const SQL_FILE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 读取 SQL 文件内容（UTF-8）。
#[tauri::command]
pub async fn sql_file_read(path: String) -> Result<String, String> {
    let metadata = std::fs::metadata(&path).map_err(|_| "error.sqlfile.read_failed")?;
    if metadata.len() > SQL_FILE_MAX_BYTES {
        return Err("error.sqlfile.too_large".to_string());
    }
    std::fs::read_to_string(&path).map_err(|_| "error.sqlfile.read_failed".to_string())
}

/// 把内容写入 SQL 文件（UTF-8，临时文件 + 原子替换）。
#[tauri::command]
pub async fn sql_file_write(path: String, content: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "error.sqlfile.write_failed")?;
    }
    let tmp_path = target.with_extension("tmp");
    std::fs::write(&tmp_path, content).map_err(|_| "error.sqlfile.write_failed")?;
    std::fs::rename(&tmp_path, &target).map_err(|_| "error.sqlfile.write_failed")?;
    Ok(())
}

/// 读取最近文件列表（最新在前）。
#[tauri::command]
pub async fn sql_file_recent_list(
    state: State<'_, AppState>,
) -> Result<Vec<RecentFileEntry>, String> {
    Ok(state.recent_files.load())
}

/// 记录一次打开/保存（置顶）。
#[tauri::command]
pub async fn sql_file_recent_touch(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state.recent_files.touch(&path)
}

/// 从最近文件移除（打开失败确认失效后调用）。
#[tauri::command]
pub async fn sql_file_recent_remove(
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    state.recent_files.remove(&path)
}
