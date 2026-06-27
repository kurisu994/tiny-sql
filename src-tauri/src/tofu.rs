//! SSH TOFU（Trust On First Use）决策管理
//!
//! 当某跳遇到 known_hosts 里没有的新 host key 时，后端 emit `ssh:tofu-request`
//! 事件给前端弹窗，并在此挂起等待用户决定（最多 120s）。前端通过
//! `ssh_tofu_decision` 命令回传 accept/reject，唤醒对应等待。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

/// TOFU 等待超时：超过即视为拒绝（防前端弹窗 unmount / 用户离开导致永久挂起）
const TOFU_TIMEOUT: Duration = Duration::from_secs(120);

/// emit 给前端的 TOFU 请求载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TofuRequestPayload {
    pub connection_id: String,
    pub hop_index: usize,
    pub host: String,
    pub port: u16,
    /// OpenSSH 风格 sha256 指纹，如 `SHA256:abc...`
    pub fingerprint: String,
}

/// TOFU 决策管理器 —— 维护「等待中的弹窗」与其回调通道。
#[derive(Default)]
pub struct SshTofuManager {
    /// key = `connection_id:hop_index`，value = 唤醒等待的 oneshot 发送端
    pending: Mutex<HashMap<String, oneshot::Sender<bool>>>,
}

impl SshTofuManager {
    /// 发起一次 TOFU 请求：emit 事件并挂起等待前端决定（120s 超时）。
    /// 返回 `true` = 用户信任，`false` = 拒绝 / 超时。
    pub async fn request(
        &self,
        app: &AppHandle,
        connection_id: &str,
        hop_index: usize,
        host: &str,
        port: u16,
        fingerprint: &str,
    ) -> bool {
        let key = Self::key(connection_id, hop_index);
        let (tx, rx) = oneshot::channel();
        // 同 key 若已有等待，旧的被替换 → 旧 sender drop → 旧等待得到 false
        self.pending.lock().unwrap().insert(key.clone(), tx);

        let payload = TofuRequestPayload {
            connection_id: connection_id.to_string(),
            hop_index,
            host: host.to_string(),
            port,
            fingerprint: fingerprint.to_string(),
        };
        if app.emit("ssh:tofu-request", payload).is_err() {
            self.pending.lock().unwrap().remove(&key);
            return false;
        }

        let decision = match tokio::time::timeout(TOFU_TIMEOUT, rx).await {
            Ok(Ok(accept)) => accept,
            // 超时或 sender 被 drop（如同 key 覆盖）→ 拒绝
            _ => false,
        };
        // 清理（resolve 已 remove 时这里是 no-op）
        self.pending.lock().unwrap().remove(&key);
        decision
    }

    /// 前端回传决策：唤醒对应等待。无匹配等待（已超时清理）时静默忽略。
    pub fn resolve(&self, connection_id: &str, hop_index: usize, accept: bool) {
        let key = Self::key(connection_id, hop_index);
        if let Some(tx) = self.pending.lock().unwrap().remove(&key) {
            let _ = tx.send(accept);
        }
    }

    fn key(connection_id: &str, hop_index: usize) -> String {
        format!("{connection_id}:{hop_index}")
    }
}
