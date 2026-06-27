//! TOFU 决策回调命令 —— 前端弹窗的「信任 / 拒绝」回传

use tauri::State;

use crate::state::AppState;

/// 前端 TOFU 弹窗回传决策，唤醒后端挂起的 host key 校验。
///
/// `accept=true` 信任并继续握手（后端会写入 known_hosts）；`false` 拒绝。
/// 无匹配等待（已超时清理）时静默成功。
#[tauri::command]
pub async fn ssh_tofu_decision(
    state: State<'_, AppState>,
    connection_id: String,
    hop_index: usize,
    accept: bool,
) -> Result<(), String> {
    state.tofu.resolve(&connection_id, hop_index, accept);
    Ok(())
}
