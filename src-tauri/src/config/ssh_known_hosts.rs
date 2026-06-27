//! SSH known_hosts 自有存储（TOFU 信任库）
//!
//! 路径 `~/Library/Application Support/tiny-sql/known_hosts.json`，结构
//! `{ "host:port": "SHA256:xxx" }`。指纹是公开信息，无需加密。
//!
//! **铁律（NFR-012）**：只读写本文件，**绝不读写** `~/.ssh/known_hosts`，
//! 不污染用户的 OpenSSH 信任域。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// known_hosts 文件名
pub const KNOWN_HOSTS_FILENAME: &str = "known_hosts.json";

/// SSH 信任库 —— host:port → sha256 指纹的内存缓存 + JSON 持久化。
///
/// 用 Mutex 串行化读写，写入走临时文件 + rename 原子替换。
pub struct SshKnownHostsStore {
    path: PathBuf,
    entries: Mutex<HashMap<String, String>>,
}

impl SshKnownHostsStore {
    /// 从 `app_data_dir` 加载（文件不存在或损坏时以空表起步）。
    pub fn new(app_data_dir: PathBuf) -> Self {
        let path = app_data_dir.join(KNOWN_HOSTS_FILENAME);
        let entries = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, String>>(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            entries: Mutex::new(entries),
        }
    }

    /// 查询某 host:port 已信任的指纹（无则 None）。
    pub fn get(&self, host: &str, port: u16) -> Option<String> {
        let key = Self::key(host, port);
        self.entries.lock().unwrap().get(&key).cloned()
    }

    /// 记录 / 更新某 host:port 的指纹并落盘。
    pub fn insert(&self, host: &str, port: u16, fingerprint: &str) -> Result<(), String> {
        let key = Self::key(host, port);
        let snapshot = {
            let mut entries = self.entries.lock().unwrap();
            entries.insert(key, fingerprint.to_string());
            entries.clone()
        };
        self.persist(&snapshot)
    }

    /// host:port 归一化为存储 key。
    fn key(host: &str, port: u16) -> String {
        format!("{host}:{port}")
    }

    /// 原子写入 JSON 文件。
    fn persist(&self, entries: &HashMap<String, String>) -> Result<(), String> {
        let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp_path = self.path.with_extension("tmp");
        std::fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp_path, &self.path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tiny-sql-kh-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn insert_get_roundtrip_and_persist() {
        let dir = temp_dir();
        let store = SshKnownHostsStore::new(dir.clone());
        assert_eq!(store.get("bastion.internal", 22), None);

        store.insert("bastion.internal", 22, "SHA256:abc").unwrap();
        assert_eq!(
            store.get("bastion.internal", 22),
            Some("SHA256:abc".to_string())
        );

        // 重新加载应保留信任
        let reloaded = SshKnownHostsStore::new(dir.clone());
        assert_eq!(
            reloaded.get("bastion.internal", 22),
            Some("SHA256:abc".to_string())
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn different_port_is_different_host() {
        let dir = temp_dir();
        let store = SshKnownHostsStore::new(dir.clone());
        store.insert("h", 22, "SHA256:a").unwrap();
        assert_eq!(store.get("h", 2222), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
