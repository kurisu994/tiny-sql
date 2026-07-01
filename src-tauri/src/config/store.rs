//! 连接配置持久化 —— 整个文件 AES-256-GCM 加密落盘
//!
//! 与 redis-desktop-client 的逐字段加密不同：tiny-sql 把**整个 JSON** 加密，
//! 满足 FR-001（`cat connections.enc` 看不到明文 host/user/password）。
//!
//! passphrase 不进持久化模型（NFR-011：仅会话内存）；SSH 配置 Week 3 填充。

use crate::config::encryption;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 密文存储文件名（整体加密，非明文 JSON）
pub const CONNECTIONS_FILENAME: &str = "connections.enc";
/// master key 文件名（0600 权限）
pub const MASTER_KEY_FILENAME: &str = "master.key";

/// 持久化的单条连接配置
///
/// 序列化字段统一 camelCase 与前端 TypeScript / IPC 对齐。整体文件加密，
/// 所以 password 在解密后的 JSON 里是明文（文件层面已加密保护）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: String,
    /// 默认 database，可空字符串
    #[serde(default)]
    pub database: String,
    /// SSH 隧道配置（Week 3 填充，Week 2 默认 disabled）
    #[serde(default)]
    pub ssh: SshConfig,
    /// MySQL SSL 配置。v0.1 默认禁用，避免 sqlx Preferred 在内网库上误握手。
    #[serde(default)]
    pub ssl: SslConfig,
    /// 连接高级设置。部分字段先持久化，driver 支持后逐步接线。
    #[serde(default)]
    pub advanced: AdvancedConfig,
    /// 最近使用时间（ISO 8601），用于列表排序（FR-003）
    #[serde(default)]
    pub last_used_at: Option<String>,
}

/// SSH 隧道配置 —— 支持任意 N 跳串联，hops 顺序即链路顺序
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub hops: Vec<SshHop>,
}

/// MySQL SSL 配置 —— mode 取 disabled/preferred/required/verify_ca/verify_identity
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SslConfig {
    #[serde(default = "default_ssl_mode")]
    pub mode: String,
    #[serde(default)]
    pub ca_path: String,
    #[serde(default)]
    pub client_cert_path: String,
    #[serde(default)]
    pub client_key_path: String,
}

impl Default for SslConfig {
    fn default() -> Self {
        Self {
            mode: default_ssl_mode(),
            ca_path: String::new(),
            client_cert_path: String::new(),
            client_key_path: String::new(),
        }
    }
}

/// 连接高级设置 —— 与前端高级 tab 保持 camelCase 对齐
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedConfig {
    #[serde(default)]
    pub keep_alive_enabled: bool,
    #[serde(default = "default_keep_alive_interval_seconds")]
    pub keep_alive_interval_seconds: u64,
    #[serde(default = "default_true")]
    pub connect_timeout_enabled: bool,
    #[serde(default = "default_timeout_seconds")]
    pub connect_timeout_seconds: u64,
    #[serde(default)]
    pub read_timeout_enabled: bool,
    #[serde(default = "default_timeout_seconds")]
    pub read_timeout_seconds: u64,
    #[serde(default = "default_true")]
    pub write_timeout_enabled: bool,
    #[serde(default = "default_timeout_seconds")]
    pub write_timeout_seconds: u64,
    #[serde(default)]
    pub compression_enabled: bool,
    #[serde(default)]
    pub auto_connect: bool,
}

impl Default for AdvancedConfig {
    fn default() -> Self {
        Self {
            keep_alive_enabled: false,
            keep_alive_interval_seconds: default_keep_alive_interval_seconds(),
            connect_timeout_enabled: true,
            connect_timeout_seconds: default_timeout_seconds(),
            read_timeout_enabled: false,
            read_timeout_seconds: default_timeout_seconds(),
            write_timeout_enabled: true,
            write_timeout_seconds: default_timeout_seconds(),
            compression_enabled: false,
            auto_connect: false,
        }
    }
}

/// 单跳 SSH 节点（持久化模型，不含 passphrase）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHop {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// "password" | "privateKey"
    pub auth_type: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
}

fn default_ssl_mode() -> String {
    "disabled".to_string()
}

fn default_true() -> bool {
    true
}

fn default_timeout_seconds() -> u64 {
    30
}

fn default_keep_alive_interval_seconds() -> u64 {
    240
}

/// 连接存储管理器 —— 负责连接配置的加密读写
pub struct ConnectionStore {
    master_key: [u8; 32],
    store_path: PathBuf,
}

impl ConnectionStore {
    /// 初始化存储 —— 加载或生成 master key。`app_data_dir` 由 Tauri path API 提供。
    pub fn new(app_data_dir: PathBuf) -> Result<Self, String> {
        let key_path = app_data_dir.join(MASTER_KEY_FILENAME);
        let master_key = encryption::get_or_create_master_key(&key_path)?;
        let store_path = app_data_dir.join(CONNECTIONS_FILENAME);
        Ok(Self {
            master_key,
            store_path,
        })
    }

    /// 加载全部连接配置（解密整个文件）。文件不存在时返回空列表。
    pub fn load(&self) -> Result<Vec<StoredConnection>, String> {
        if !self.store_path.exists() {
            return Ok(vec![]);
        }
        let encrypted = std::fs::read_to_string(&self.store_path).map_err(|e| e.to_string())?;
        if encrypted.trim().is_empty() {
            return Ok(vec![]);
        }
        let json = encryption::decrypt_str(&self.master_key, encrypted.trim())?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }

    /// 保存全部连接配置（加密整个文件 + 临时文件原子写入）。
    fn save(&self, connections: &[StoredConnection]) -> Result<(), String> {
        let json = serde_json::to_string(connections).map_err(|e| e.to_string())?;
        let encrypted = encryption::encrypt_str(&self.master_key, &json)?;
        if let Some(parent) = self.store_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // 临时文件 + rename 原子写入，避免崩溃导致文件损坏
        let tmp_path = self.store_path.with_extension("tmp");
        std::fs::write(&tmp_path, encrypted).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp_path, &self.store_path).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 新增或更新一条连接（按 id 判定）。
    pub fn upsert(&self, connection: StoredConnection) -> Result<(), String> {
        let mut connections = self.load()?;
        if let Some(pos) = connections.iter().position(|c| c.id == connection.id) {
            connections[pos] = connection;
        } else {
            connections.push(connection);
        }
        self.save(&connections)
    }

    /// 删除一条连接。
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut connections = self.load()?;
        connections.retain(|c| c.id != id);
        self.save(&connections)
    }

    /// 更新最近使用时间（FR-003 排序用）。连接不存在时静默忽略。
    pub fn touch_last_used(&self, id: &str, when_iso8601: String) -> Result<(), String> {
        let mut connections = self.load()?;
        if let Some(conn) = connections.iter_mut().find(|c| c.id == id) {
            conn.last_used_at = Some(when_iso8601);
            self.save(&connections)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个测试用独立临时目录，避免 master key / 存储互相污染
    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tiny-sql-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample(id: &str, host: &str) -> StoredConnection {
        StoredConnection {
            id: id.to_string(),
            name: "prod".to_string(),
            host: host.to_string(),
            port: 3306,
            user: "root".to_string(),
            password: "p@ss-w0rd".to_string(),
            database: "app".to_string(),
            ssh: SshConfig::default(),
            ssl: SslConfig::default(),
            advanced: AdvancedConfig::default(),
            last_used_at: None,
        }
    }

    #[test]
    fn upsert_load_roundtrip() {
        let dir = temp_dir();
        let store = ConnectionStore::new(dir.clone()).unwrap();
        store.upsert(sample("c1", "secret-host.internal")).unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].host, "secret-host.internal");
        assert_eq!(loaded[0].password, "p@ss-w0rd");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_ssl_and_advanced_get_defaults() {
        let raw = r#"{
            "id": "c1",
            "name": "legacy",
            "host": "127.0.0.1",
            "port": 3306,
            "user": "root",
            "password": "",
            "database": "",
            "ssh": { "enabled": false, "hops": [] }
        }"#;
        let conn: StoredConnection = serde_json::from_str(raw).unwrap();

        assert_eq!(conn.ssl.mode, "disabled");
        assert!(conn.advanced.connect_timeout_enabled);
        assert_eq!(conn.advanced.connect_timeout_seconds, 30);
        assert_eq!(conn.advanced.keep_alive_interval_seconds, 240);
        assert!(conn.advanced.write_timeout_enabled);
    }

    #[test]
    fn file_on_disk_has_no_plaintext() {
        // FR-001：磁盘文件不能出现明文 host / password
        let dir = temp_dir();
        let store = ConnectionStore::new(dir.clone()).unwrap();
        store.upsert(sample("c1", "secret-host.internal")).unwrap();

        let raw = std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap();
        assert!(
            !raw.contains("secret-host.internal"),
            "host 明文泄露: {raw}"
        );
        assert!(!raw.contains("p@ss-w0rd"), "password 明文泄露: {raw}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn upsert_updates_existing_and_delete_removes() {
        let dir = temp_dir();
        let store = ConnectionStore::new(dir.clone()).unwrap();
        store.upsert(sample("c1", "h1")).unwrap();

        let mut updated = sample("c1", "h2");
        updated.name = "renamed".to_string();
        store.upsert(updated).unwrap();
        let loaded = store.load().unwrap();
        assert_eq!(loaded.len(), 1, "相同 id 应更新而非新增");
        assert_eq!(loaded[0].host, "h2");
        assert_eq!(loaded[0].name, "renamed");

        store.delete("c1").unwrap();
        assert!(store.load().unwrap().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
}
