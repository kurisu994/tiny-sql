//! 连接配置持久化 —— 整个文件加密落盘
//!
//! 与 redis-desktop-client 的逐字段加密不同：tiny-sql 把**整个 JSON** 加密，
//! 满足 FR-001（`cat connections.enc` 看不到明文 host/user/password）。
//!
//! 加密器由 [`SecurityManager`] 提供：未启用主密码时是 v1 本地 master key；
//! 启用并解锁后是 v2 主密码派生 key（FR-102）。读取按文件实际格式自动嗅探，
//! 锁定状态下读写返回 `error.security.locked`。
//! passphrase 不进连接持久化模型（NFR-011）；启用主密码后可经 secrets map 加密存盘。

use crate::security::SecurityManager;
use db_driver::DriverKind;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

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
    /// 数据库类型。v0.1 旧记录缺少该字段时按 MySQL 迁移读取。
    #[serde(default)]
    pub driver: DriverKind,
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
    /// 应用层只读（FR-270）。缺省 false，不替代数据库账号权限。
    #[serde(default)]
    pub read_only: bool,
    /// 环境标签 none/prod/staging/dev（FR-271）。缺省 none。
    #[serde(default = "default_env")]
    pub env: String,
}

fn default_env() -> String {
    "none".into()
}

/// 只允许四个稳定值，非法输入回落 none。
pub fn normalize_env(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "prod" | "staging" | "dev" => raw.trim().to_ascii_lowercase(),
        _ => "none".into(),
    }
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
    #[serde(default = "default_true")]
    pub keep_alive_enabled: bool,
    #[serde(default = "default_keep_alive_interval_seconds")]
    pub keep_alive_interval_seconds: u64,
    #[serde(default = "default_keep_alive_failure_threshold")]
    pub keep_alive_failure_threshold: u64,
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
            keep_alive_enabled: true,
            keep_alive_interval_seconds: default_keep_alive_interval_seconds(),
            keep_alive_failure_threshold: default_keep_alive_failure_threshold(),
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
    60
}

fn default_keep_alive_failure_threshold() -> u64 {
    3
}

/// 连接存储管理器 —— 负责连接配置的加密读写；加解密委托给 [`SecurityManager`]。
pub struct ConnectionStore {
    security: Arc<SecurityManager>,
    store_path: PathBuf,
}

impl ConnectionStore {
    /// 初始化存储。`app_data_dir` 由 Tauri path API 提供。
    pub fn new(app_data_dir: PathBuf, security: Arc<SecurityManager>) -> Result<Self, String> {
        let store_path = app_data_dir.join(CONNECTIONS_FILENAME);
        Ok(Self {
            security,
            store_path,
        })
    }

    /// 加载全部连接配置（解密整个文件）。文件不存在时返回空列表；
    /// 主密码锁定中返回 `error.security.locked`。
    pub fn load(&self) -> Result<Vec<StoredConnection>, String> {
        if !self.store_path.exists() {
            return Ok(vec![]);
        }
        let encrypted = std::fs::read_to_string(&self.store_path).map_err(|e| e.to_string())?;
        if encrypted.trim().is_empty() {
            return Ok(vec![]);
        }
        let json = self.security.read_cipher(&encrypted)?.decrypt(&encrypted)?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }

    /// 保存全部连接配置（加密整个文件 + 临时文件原子写入）。
    fn save(&self, connections: &[StoredConnection]) -> Result<(), String> {
        let json = serde_json::to_string(connections).map_err(|e| e.to_string())?;
        let encrypted = self.security.write_cipher()?.encrypt(&json)?;
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
    use crate::config::encryption;
    use std::path::Path;

    /// 每个测试用独立临时目录，避免 master key / 存储互相污染
    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tiny-sql-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_store() -> (PathBuf, Arc<SecurityManager>, ConnectionStore) {
        let dir = temp_dir();
        let security = Arc::new(SecurityManager::new(dir.clone()).unwrap());
        let store = ConnectionStore::new(dir.clone(), security.clone()).unwrap();
        (dir, security, store)
    }

    /// 读取临时目录里的本地 master key（v1）
    fn local_master_key(dir: &Path) -> [u8; 32] {
        encryption::get_or_create_master_key(&dir.join(MASTER_KEY_FILENAME)).unwrap()
    }

    fn sample(id: &str, host: &str) -> StoredConnection {
        StoredConnection {
            id: id.to_string(),
            name: "prod".to_string(),
            driver: DriverKind::MySql,
            host: host.to_string(),
            port: 3306,
            user: "root".to_string(),
            password: "p@ss-w0rd".to_string(),
            database: "app".to_string(),
            ssh: SshConfig::default(),
            ssl: SslConfig::default(),
            advanced: AdvancedConfig::default(),
            last_used_at: None,
            read_only: false,
            env: default_env(),
        }
    }

    #[test]
    fn upsert_load_roundtrip() {
        let (dir, _security, store) = temp_store();
        store.upsert(sample("c1", "secret-host.internal")).unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].host, "secret-host.internal");
        assert_eq!(loaded[0].password, "p@ss-w0rd");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_driver_ssl_and_advanced_get_defaults() {
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

        assert_eq!(conn.driver, DriverKind::MySql);
        assert_eq!(conn.ssl.mode, "disabled");
        assert!(conn.advanced.connect_timeout_enabled);
        assert_eq!(conn.advanced.connect_timeout_seconds, 30);
        assert!(conn.advanced.keep_alive_enabled);
        assert_eq!(conn.advanced.keep_alive_interval_seconds, 60);
        assert!(!conn.read_only);
        assert_eq!(conn.env, "none");
        assert_eq!(normalize_env("PROD"), "prod");
        assert_eq!(normalize_env("weird"), "none");
        assert_eq!(conn.advanced.keep_alive_failure_threshold, 3);
        assert!(conn.advanced.write_timeout_enabled);
    }

    #[test]
    fn legacy_advanced_config_gets_new_keepalive_threshold_default() {
        let raw = r#"{
            "keepAliveEnabled": false,
            "keepAliveIntervalSeconds": 240,
            "connectTimeoutEnabled": true,
            "connectTimeoutSeconds": 30,
            "readTimeoutEnabled": false,
            "readTimeoutSeconds": 30,
            "writeTimeoutEnabled": true,
            "writeTimeoutSeconds": 30,
            "compressionEnabled": false,
            "autoConnect": false
        }"#;
        let advanced: AdvancedConfig = serde_json::from_str(raw).unwrap();

        assert!(!advanced.keep_alive_enabled);
        assert_eq!(advanced.keep_alive_interval_seconds, 240);
        assert_eq!(advanced.keep_alive_failure_threshold, 3);
    }

    #[test]
    fn legacy_encrypted_store_loads_as_mysql_without_rewriting() {
        let (dir, _security, store) = temp_store();
        let legacy_json = r#"[{
            "id": "legacy-1",
            "name": "legacy",
            "host": "127.0.0.1",
            "port": 3306,
            "user": "root",
            "password": "",
            "database": "",
            "ssh": { "enabled": false, "hops": [] }
        }]"#;
        let encrypted = encryption::encrypt_str(&local_master_key(&dir), legacy_json).unwrap();
        std::fs::write(dir.join(CONNECTIONS_FILENAME), &encrypted).unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].driver, DriverKind::MySql);
        assert_eq!(
            std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap(),
            encrypted,
            "兼容读取不应在启动时重写原密文"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn postgres_driver_roundtrip_uses_stable_serialized_value() {
        let (dir, _security, store) = temp_store();
        let mut connection = sample("pg-1", "postgres.internal");
        connection.driver = DriverKind::PostgreSql;
        connection.port = 5432;
        store.upsert(connection).unwrap();

        let loaded = store.load().unwrap();
        assert_eq!(loaded[0].driver, DriverKind::PostgreSql);

        let encrypted = std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap();
        let json = encryption::decrypt_str(&local_master_key(&dir), encrypted.trim()).unwrap();
        assert!(
            json.contains(r#""driver":"postgresql""#),
            "driver 持久化值必须稳定: {json}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn failed_driver_migration_preserves_original_encrypted_file() {
        let (dir, _security, store) = temp_store();
        let unsupported_json = r#"[{
            "id": "future-1",
            "name": "future",
            "driver": "oracle",
            "host": "127.0.0.1",
            "port": 1521,
            "user": "system",
            "password": "",
            "database": "",
            "ssh": { "enabled": false, "hops": [] }
        }]"#;
        let encrypted = encryption::encrypt_str(&local_master_key(&dir), unsupported_json).unwrap();
        std::fs::write(dir.join(CONNECTIONS_FILENAME), &encrypted).unwrap();

        assert!(store.load().is_err(), "未知 driver 必须拒绝迁移");
        assert_eq!(
            std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap(),
            encrypted,
            "迁移失败不得覆盖原密文"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn file_on_disk_has_no_plaintext() {
        // FR-001：磁盘文件不能出现明文 host / password
        let (dir, _security, store) = temp_store();
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
        let (dir, _security, store) = temp_store();
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

    // ===== v0.2 主密码模式（FR-102）=====

    #[test]
    fn locked_store_read_write_fails_with_stable_key() {
        let (dir, security, store) = temp_store();
        store.upsert(sample("c1", "h1")).unwrap();
        security.setup_master_password("pw").unwrap();
        security.lock();

        assert_eq!(store.load().unwrap_err(), "error.security.locked");
        assert_eq!(
            store.upsert(sample("c2", "h2")).unwrap_err(),
            "error.security.locked"
        );

        security.unlock("pw").unwrap();
        assert_eq!(store.load().unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unlocked_store_writes_v2_and_reads_back() {
        let (dir, security, store) = temp_store();
        store.upsert(sample("c1", "secret-host.internal")).unwrap();
        security.setup_master_password("pw").unwrap();

        // 迁移后文件为 v2，读取正常
        let raw = std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap();
        assert!(encryption::is_v2_envelope(&raw));
        assert!(!raw.contains("secret-host.internal"));

        // 新写入也走 v2
        store.upsert(sample("c2", "h2")).unwrap();
        assert_eq!(store.load().unwrap().len(), 2);
        let raw = std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap();
        assert!(encryption::is_v2_envelope(&raw));

        // 模拟重启：锁定后 v2 读不了，解锁后恢复
        let store2 = ConnectionStore::new(
            dir.clone(),
            Arc::new(SecurityManager::new(dir.clone()).unwrap()),
        )
        .unwrap();
        assert_eq!(store2.load().unwrap_err(), "error.security.locked");
        let security3 = Arc::new(SecurityManager::new(dir.clone()).unwrap());
        security3.unlock("pw").unwrap();
        let store3 = ConnectionStore::new(dir.clone(), security3).unwrap();
        assert_eq!(store3.load().unwrap().len(), 2);

        std::fs::remove_dir_all(&dir).ok();
    }
}
