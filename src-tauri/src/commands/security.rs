//! 用户主密码安全命令（FR-102）
//!
//! 前端在启动时查询 `security_status`：Locked 时先弹解锁框；安全设置里提供
//! 启用 / 关闭 / 锁定与忘记密码重置。所有错误只返回稳定 i18n key。

use serde::Serialize;
use tauri::State;

use crate::security::SecurityStatus;
use crate::state::AppState;

/// 返回给前端的安全状态。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatusPayload {
    /// "disabled" / "locked" / "unlocked"
    pub status: SecurityStatus,
    /// 是否允许持久化 SSH 私钥 passphrase（仅主密码解锁后）
    pub can_persist_passphrase: bool,
}

fn payload(state: &AppState) -> SecurityStatusPayload {
    let status = state.security.status();
    SecurityStatusPayload {
        status,
        can_persist_passphrase: status == SecurityStatus::Unlocked,
    }
}

/// 查询当前主密码状态（启动时调用）。
#[tauri::command]
pub fn security_status(state: State<'_, AppState>) -> SecurityStatusPayload {
    payload(&state)
}

/// 设置主密码并把已有数据文件迁移到 v2 envelope。失败时原文件保持不变。
#[tauri::command]
pub fn security_setup(state: State<'_, AppState>, password: String) -> Result<(), String> {
    state.security.setup_master_password(&password)
}

/// 解锁：校验主密码，派生 key 仅驻留内存。
#[tauri::command]
pub fn security_unlock(state: State<'_, AppState>, password: String) -> Result<(), String> {
    state.security.unlock(&password)
}

/// 手动锁定：清空内存派生 key。
#[tauri::command]
pub fn security_lock(state: State<'_, AppState>) {
    state.security.lock();
}

/// 关闭主密码保护：数据迁回 v1，已持久化的 passphrase 一并清除。
#[tauri::command]
pub fn security_disable(state: State<'_, AppState>, password: String) -> Result<(), String> {
    state.security.disable_master_password(&password)
}

/// 忘记主密码的重置：删除全部加密数据（连接配置 / passphrase / SQL 历史），
/// 前端必须已向用户明确告知不可恢复。
#[tauri::command]
pub fn security_reset(state: State<'_, AppState>) -> Result<(), String> {
    // 重置后所有活跃连接的持久化配置已不存在，但不断开当前会话（内存仍可用）。
    state.security.reset_all()
}
