//! 用户主密码安全管理（FR-102，v0.2 Week 4）
//!
//! 三种状态：
//! - `Disabled`（默认）：v1 行为，本地随机 master key 落盘，防明文直读；
//! - `Unlocked`：已设置主密码且本进程已解锁，派生 key 缓存在内存（Zeroizing）；
//! - `Locked`：已设置主密码但尚未解锁，所有加密文件读写返回 `error.security.locked`。
//!
//! 文件布局（app data 目录）：
//! - `security.json`：明文 KDF 元信息（Argon2id 参数 + 盐 + verifier），不含任何秘密；
//! - `connections.enc` / `secrets.enc` / `history.enc`：v1 纯密文或 v2 envelope JSON。
//!
//! 迁移安全（V2-R03）：先复制 `.bak`，再临时文件 + 原子替换；任一步失败用 `.bak`
//! 回滚；`security.json` 最后写入作为「提交点」；启动时发现无主密码元信息但存在
//! `.bak` 则自动还原，保证迁移中断可原样恢复。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::config::encryption;

/// 主密码元信息文件名（明文，仅 KDF 参数与校验值）
pub const SECURITY_META_FILENAME: &str = "security.json";
/// SSH 私钥 passphrase 加密存储文件名（仅主密码启用后存在）
pub const SECRETS_FILENAME: &str = "secrets.enc";
/// SQL 历史加密存储文件名
pub const HISTORY_FILENAME: &str = "history.enc";
/// 连接配置加密存储文件名
pub const CONNECTIONS_FILENAME: &str = "connections.enc";

/// verifier 加密后的已知明文：用于区分「密码错误」与「数据损坏」。
const VERIFIER_PLAINTEXT: &str = "tiny-sql-security-verifier-v1";

/// 主密码状态机。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SecurityStatus {
    /// 未启用主密码（v1 本地 master key）
    Disabled,
    /// 已启用但本进程尚未解锁
    Locked,
    /// 已启用且已解锁（派生 key 在内存）
    Unlocked,
}

/// `security.json` 的明文结构：KDF 参数 + 盐 + verifier。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecurityMeta {
    v: u32,
    kdf: KdfMeta,
    /// encrypt_str(derived_key, VERIFIER_PLAINTEXT) 的 v1 格式密文
    verifier: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfMeta {
    alg: String,
    m_kib: u32,
    t: u32,
    p: u32,
    /// base64(16 字节盐)
    salt: String,
}

/// 当前可用于读写数据文件的加密器。
///
/// `Local` 对应 v1 文件格式（纯 base64 密文），`Master` 对应 v2 envelope。
/// 读取时按文件实际格式选择，与当前状态无关（v1 文件在解锁后仍可读）。
#[derive(Clone)]
pub enum DataCipher {
    /// v1：本地随机 master key
    Local([u8; 32]),
    /// v2：主密码派生 key（内存缓存，drop 即清零）
    Master(Zeroizing<[u8; 32]>),
}

impl std::fmt::Debug for DataCipher {
    /// 密钥材料永不进入 Debug/日志输出。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Local(_) => f.write_str("DataCipher::Local([redacted])"),
            Self::Master(_) => f.write_str("DataCipher::Master([redacted])"),
        }
    }
}

impl DataCipher {
    /// 按对应时代格式加密。
    pub fn encrypt(&self, plaintext: &str) -> Result<String, String> {
        match self {
            Self::Local(key) => encryption::encrypt_str(key, plaintext),
            Self::Master(key) => encryption::encrypt_v2(key, plaintext),
        }
    }

    /// 解密（调用方已按文件格式选对变体）。
    pub fn decrypt(&self, blob: &str) -> Result<String, String> {
        match self {
            Self::Local(key) => encryption::decrypt_str(key, blob),
            Self::Master(key) => encryption::decrypt_v2(key, blob),
        }
    }
}

struct SecurityInner {
    status: SecurityStatus,
    data_key: Option<Zeroizing<[u8; 32]>>,
}

/// 主密码与派生 key 的统一入口，外加 passphrase secrets map 的持久化。
pub struct SecurityManager {
    dir: PathBuf,
    inner: Mutex<SecurityInner>,
}

impl SecurityManager {
    /// 初始化：探测 `security.json` 决定初始状态；发现迁移残留的 `.bak` 且
    /// 无元信息时自动还原（迁移中断恢复）。
    pub fn new(dir: PathBuf) -> Result<Self, String> {
        recover_interrupted_migration(&dir);
        let enabled = dir.join(SECURITY_META_FILENAME).exists();
        Ok(Self {
            dir,
            inner: Mutex::new(SecurityInner {
                status: if enabled {
                    SecurityStatus::Locked
                } else {
                    SecurityStatus::Disabled
                },
                data_key: None,
            }),
        })
    }

    /// 当前主密码状态。
    pub fn status(&self) -> SecurityStatus {
        self.inner.lock().unwrap().status
    }

    fn meta_path(&self) -> PathBuf {
        self.dir.join(SECURITY_META_FILENAME)
    }

    fn secrets_path(&self) -> PathBuf {
        self.dir.join(SECRETS_FILENAME)
    }

    /// 写入时应使用的加密器：
    /// - Disabled → v1 本地 master key；
    /// - Unlocked → v2 派生 key；
    /// - Locked → `error.security.locked`。
    pub fn write_cipher(&self) -> Result<DataCipher, String> {
        let inner = self.inner.lock().unwrap();
        match inner.status {
            SecurityStatus::Disabled => {
                let key_path = self.dir.join(crate::config::store::MASTER_KEY_FILENAME);
                Ok(DataCipher::Local(encryption::get_or_create_master_key(
                    &key_path,
                )?))
            }
            SecurityStatus::Unlocked => {
                let key = inner.data_key.clone().ok_or("error.security.locked")?;
                Ok(DataCipher::Master(key))
            }
            SecurityStatus::Locked => Err("error.security.locked".to_string()),
        }
    }

    /// 按文件实际格式选择加密器（v1 嗅探后用本地 key，v2 需已解锁）。
    pub fn read_cipher(&self, blob: &str) -> Result<DataCipher, String> {
        if encryption::is_v2_envelope(blob) {
            let inner = self.inner.lock().unwrap();
            match inner.status {
                SecurityStatus::Unlocked => {
                    let key = inner.data_key.clone().ok_or("error.security.locked")?;
                    Ok(DataCipher::Master(key))
                }
                // Disabled 状态下不应存在 v2 文件（迁移崩溃残留除外，此时无法解密）
                _ => Err("error.security.locked".to_string()),
            }
        } else {
            let key_path = self.dir.join(crate::config::store::MASTER_KEY_FILENAME);
            Ok(DataCipher::Local(encryption::get_or_create_master_key(
                &key_path,
            )?))
        }
    }

    /// 设置主密码并把所有已存在的数据文件从 v1 迁移到 v2。
    ///
    /// 迁移顺序：`.bak` 备份 → 逐文件 tmp + rename → 最后写 `security.json`
    /// （提交点）。任何失败用 `.bak` 回滚，原文件保持可读。
    pub fn setup_master_password(&self, password: &str) -> Result<(), String> {
        if password.is_empty() {
            return Err("error.security.empty_password".to_string());
        }
        {
            let inner = self.inner.lock().unwrap();
            if inner.status != SecurityStatus::Disabled {
                return Err("error.security.already_enabled".to_string());
            }
        }

        let salt = encryption::generate_salt();
        let key = encryption::derive_master_key(password, &salt)?;

        // 1) 读取现有数据文件明文（v1；文件可能不存在）
        let data_files = [CONNECTIONS_FILENAME, SECRETS_FILENAME, HISTORY_FILENAME];
        let mut plaintexts: Vec<(PathBuf, String)> = Vec::new();
        for name in data_files {
            let path = self.dir.join(name);
            if !path.exists() {
                continue;
            }
            let blob = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            if blob.trim().is_empty() {
                continue;
            }
            let cipher = self.read_cipher(&blob)?;
            let plaintext = cipher
                .decrypt(&blob)
                .map_err(|_| "error.security.migration_failed".to_string())?;
            plaintexts.push((path, plaintext));
        }

        // 2) 逐文件：.bak 备份 → tmp 写 v2 → rename。失败回滚。
        let mut migrated: Vec<PathBuf> = Vec::new();
        let result = (|| -> Result<(), String> {
            for (path, plaintext) in &plaintexts {
                let bak = backup_path(path);
                std::fs::copy(path, &bak).map_err(|e| e.to_string())?;
                let blob = encryption::encrypt_v2(&key, plaintext)?;
                atomic_write(path, &blob)?;
                migrated.push(path.clone());
            }
            // 3) 提交点：最后写 security.json
            let meta = SecurityMeta {
                v: 1,
                kdf: KdfMeta {
                    alg: "argon2id".to_string(),
                    m_kib: encryption::ARGON2_M_COST_KIB,
                    t: encryption::ARGON2_T_COST,
                    p: encryption::ARGON2_P_COST,
                    salt: base64_encode(&salt),
                },
                verifier: encryption::encrypt_str(&key, VERIFIER_PLAINTEXT)?,
            };
            let meta_json = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
            atomic_write(&self.meta_path(), &meta_json)?;
            Ok(())
        })();

        match result {
            Ok(()) => {
                // 成功：清理 .bak（原内容仍受 master.key 保护，但避免多份残留）
                for (path, _) in &plaintexts {
                    let _ = std::fs::remove_file(backup_path(path));
                }
                let mut inner = self.inner.lock().unwrap();
                inner.status = SecurityStatus::Unlocked;
                inner.data_key = Some(key);
                Ok(())
            }
            Err(e) => {
                // 回滚：从 .bak 还原已替换文件，删除提交点
                for (path, _) in &plaintexts {
                    let bak = backup_path(path);
                    if bak.exists() {
                        let _ = std::fs::copy(&bak, path);
                        let _ = std::fs::remove_file(&bak);
                    }
                }
                let _ = std::fs::remove_file(self.meta_path());
                Err(e)
            }
        }
    }

    /// 用主密码解锁：派生 key 并用 verifier 校验，密码错误不触碰任何文件。
    pub fn unlock(&self, password: &str) -> Result<(), String> {
        let meta_raw = std::fs::read_to_string(self.meta_path())
            .map_err(|_| "error.security.not_enabled".to_string())?;
        let meta: SecurityMeta = serde_json::from_str(&meta_raw)
            .map_err(|_| "error.security.meta_corrupted".to_string())?;
        if meta.kdf.alg != "argon2id"
            || meta.kdf.m_kib != encryption::ARGON2_M_COST_KIB
            || meta.kdf.t != encryption::ARGON2_T_COST
            || meta.kdf.p != encryption::ARGON2_P_COST
        {
            // 不自创密码算法，也不静默降级 KDF 强度：参数不符直接拒绝
            return Err("error.security.unsupported_kdf".to_string());
        }
        let salt = base64_decode(&meta.kdf.salt)?;
        let key = encryption::derive_master_key(password, &salt)?;
        let verifier = encryption::decrypt_str(&key, &meta.verifier)
            .map_err(|_| "error.security.wrong_password".to_string())?;
        if verifier != VERIFIER_PLAINTEXT {
            return Err("error.security.wrong_password".to_string());
        }
        let mut inner = self.inner.lock().unwrap();
        inner.status = SecurityStatus::Unlocked;
        inner.data_key = Some(key);
        Ok(())
    }

    /// 锁定：清空内存派生 key。已打开的连接不受影响，新文件读写要求解锁。
    pub fn lock(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.status == SecurityStatus::Unlocked {
            inner.status = SecurityStatus::Locked;
            inner.data_key = None;
        }
    }

    /// 关闭主密码：校验通过后把数据文件迁回 v1，并删除 secrets（passphrase
    /// 只允许在主密码保护下持久化）。
    pub fn disable_master_password(&self, password: &str) -> Result<(), String> {
        self.unlock(password)?;
        let inner = self.inner.lock().unwrap();
        let key = inner
            .data_key
            .clone()
            .ok_or("error.security.locked".to_string())?;
        drop(inner);

        let data_files = [CONNECTIONS_FILENAME, HISTORY_FILENAME];
        let local_key_path = self.dir.join(crate::config::store::MASTER_KEY_FILENAME);
        let local_key = encryption::get_or_create_master_key(&local_key_path)?;
        let mut migrated: Vec<PathBuf> = Vec::new();
        let result = (|| -> Result<(), String> {
            for name in data_files {
                let path = self.dir.join(name);
                if !path.exists() {
                    continue;
                }
                let blob = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
                if blob.trim().is_empty() || !encryption::is_v2_envelope(&blob) {
                    continue;
                }
                let plaintext = encryption::decrypt_v2(&key, &blob)?;
                let bak = backup_path(&path);
                std::fs::copy(&path, &bak).map_err(|e| e.to_string())?;
                let downgraded = encryption::encrypt_str(&local_key, &plaintext)?;
                atomic_write(&path, &downgraded)?;
                migrated.push(path);
            }
            Ok(())
        })();

        match result {
            Ok(()) => {
                for path in &migrated {
                    let _ = std::fs::remove_file(backup_path(path));
                }
                let _ = std::fs::remove_file(self.meta_path());
                let _ = std::fs::remove_file(self.secrets_path());
                let mut inner = self.inner.lock().unwrap();
                inner.status = SecurityStatus::Disabled;
                inner.data_key = None;
                Ok(())
            }
            Err(e) => {
                for path in &migrated {
                    let bak = backup_path(path);
                    if bak.exists() {
                        let _ = std::fs::copy(&bak, path);
                        let _ = std::fs::remove_file(&bak);
                    }
                }
                Err(e)
            }
        }
    }

    /// 忘记主密码的重置路径：删除全部加密数据文件与元信息，回到 Disabled。
    /// 调用方（前端）必须明确告知数据不可恢复。
    pub fn reset_all(&self) -> Result<(), String> {
        for name in [
            CONNECTIONS_FILENAME,
            SECRETS_FILENAME,
            HISTORY_FILENAME,
            SECURITY_META_FILENAME,
        ] {
            let _ = std::fs::remove_file(self.dir.join(name));
            let _ = std::fs::remove_file(backup_path(&self.dir.join(name)));
        }
        let mut inner = self.inner.lock().unwrap();
        inner.status = SecurityStatus::Disabled;
        inner.data_key = None;
        Ok(())
    }

    // ===== passphrase secrets map（仅主密码启用时持久化）=====

    /// 读取全部已持久化的 passphrase（connection_id → passphrase）。
    /// 未解锁返回 `error.security.locked`；文件不存在返回空 map。
    pub fn load_secrets(&self) -> Result<HashMap<String, String>, String> {
        let path = self.secrets_path();
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let blob = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        if blob.trim().is_empty() {
            return Ok(HashMap::new());
        }
        let cipher = self.read_cipher(&blob)?;
        let json = cipher.decrypt(&blob)?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }

    /// 持久化一条 passphrase（覆盖同 connection_id 旧值）。
    pub fn save_secret(&self, connection_id: &str, passphrase: &str) -> Result<(), String> {
        let mut secrets = self.load_secrets()?;
        secrets.insert(connection_id.to_string(), passphrase.to_string());
        self.write_secrets(&secrets)
    }

    /// 删除一条已持久化的 passphrase（连接删除时同步清理）。
    pub fn remove_secret(&self, connection_id: &str) -> Result<(), String> {
        if self.status() != SecurityStatus::Unlocked {
            return Ok(());
        }
        let mut secrets = self.load_secrets()?;
        if secrets.remove(connection_id).is_some() {
            self.write_secrets(&secrets)?;
        }
        Ok(())
    }

    /// 读取单条 passphrase；未持久化或不可用时返回 None。
    pub fn secret_for(&self, connection_id: &str) -> Option<String> {
        if self.status() != SecurityStatus::Unlocked {
            return None;
        }
        self.load_secrets()
            .ok()
            .and_then(|mut secrets| secrets.remove(connection_id))
    }

    fn write_secrets(&self, secrets: &HashMap<String, String>) -> Result<(), String> {
        // 只在主密码保护下落盘；Disabled 状态拒绝持久化 passphrase
        let cipher = self.write_cipher()?;
        if matches!(cipher, DataCipher::Local(_)) {
            return Err("error.security.master_required".to_string());
        }
        let json = serde_json::to_string(secrets).map_err(|e| e.to_string())?;
        atomic_write(&self.secrets_path(), &cipher.encrypt(&json)?)
    }
}

/// `.bak` 备份文件路径。
fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("bak")
}

/// 临时文件 + rename 原子写入。
fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_path = path.with_extension("tmp");
    std::fs::write(&tmp_path, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 迁移中断恢复：无 `security.json` 但存在 `.bak` → 用 `.bak` 还原原文件；
/// 有 `security.json` 说明迁移已提交，残留的 `.bak` 直接清理。
fn recover_interrupted_migration(dir: &Path) {
    let committed = dir.join(SECURITY_META_FILENAME).exists();
    for name in [CONNECTIONS_FILENAME, SECRETS_FILENAME, HISTORY_FILENAME] {
        let path = dir.join(name);
        let bak = backup_path(&path);
        if !bak.exists() {
            continue;
        }
        if committed {
            // 已提交：.bak 是清理前崩溃的残留，直接删除
            let _ = std::fs::remove_file(&bak);
        } else {
            // 未提交：迁移中断，原样还原
            let _ = std::fs::copy(&bak, &path);
            let _ = std::fs::remove_file(&bak);
        }
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(value: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tiny-sql-sec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 在临时目录里造一个 v1 connections.enc。
    fn seed_v1_connections(dir: &Path, json: &str) {
        let key_path = dir.join(crate::config::store::MASTER_KEY_FILENAME);
        let key = encryption::get_or_create_master_key(&key_path).unwrap();
        let blob = encryption::encrypt_str(&key, json).unwrap();
        std::fs::write(dir.join(CONNECTIONS_FILENAME), blob).unwrap();
    }

    #[test]
    fn fresh_dir_starts_disabled() {
        let dir = temp_dir();
        let manager = SecurityManager::new(dir.clone()).unwrap();
        assert_eq!(manager.status(), SecurityStatus::Disabled);
        // Disabled 下写 cipher 是 v1 本地 key
        let cipher = manager.write_cipher().unwrap();
        assert!(matches!(cipher, DataCipher::Local(_)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn setup_migrates_connections_to_v2_and_unlocks() {
        let dir = temp_dir();
        seed_v1_connections(&dir, r#"[{"id":"c1","name":"legacy"}]"#);
        let before = std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap();

        let manager = SecurityManager::new(dir.clone()).unwrap();
        manager.setup_master_password("主密码-1").unwrap();
        assert_eq!(manager.status(), SecurityStatus::Unlocked);

        let after = std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap();
        assert_ne!(before, after);
        assert!(encryption::is_v2_envelope(&after));
        assert!(!after.contains("legacy"), "v2 密文不能含明文");
        // 迁移成功后 .bak 已清理
        assert!(!dir.join("connections.bak").exists());

        // 用解锁后的 cipher 能读回明文
        let cipher = manager.read_cipher(&after).unwrap();
        assert_eq!(
            cipher.decrypt(&after).unwrap(),
            r#"[{"id":"c1","name":"legacy"}]"#
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn restart_requires_unlock_and_wrong_password_is_rejected() {
        let dir = temp_dir();
        seed_v1_connections(&dir, "[]");
        {
            let manager = SecurityManager::new(dir.clone()).unwrap();
            manager.setup_master_password("pw-123").unwrap();
        }
        // 模拟重启：新进程实例
        let manager = SecurityManager::new(dir.clone()).unwrap();
        assert_eq!(manager.status(), SecurityStatus::Locked);
        assert_eq!(manager.write_cipher().unwrap_err(), "error.security.locked");
        assert_eq!(
            manager.unlock("wrong").unwrap_err(),
            "error.security.wrong_password"
        );
        // 错误密码后仍是 Locked，文件未被触碰
        assert_eq!(manager.status(), SecurityStatus::Locked);
        manager.unlock("pw-123").unwrap();
        assert_eq!(manager.status(), SecurityStatus::Unlocked);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lock_clears_key_and_unlock_restores() {
        let dir = temp_dir();
        let manager = SecurityManager::new(dir.clone()).unwrap();
        manager.setup_master_password("pw").unwrap();
        manager.lock();
        assert_eq!(manager.status(), SecurityStatus::Locked);
        assert!(manager.write_cipher().is_err());
        manager.unlock("pw").unwrap();
        assert_eq!(manager.status(), SecurityStatus::Unlocked);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn secrets_require_master_password_and_roundtrip() {
        let dir = temp_dir();
        let manager = SecurityManager::new(dir.clone()).unwrap();
        // Disabled：不允许持久化 passphrase
        assert_eq!(
            manager.save_secret("c1", "pp").unwrap_err(),
            "error.security.master_required"
        );

        manager.setup_master_password("pw").unwrap();
        manager.save_secret("c1", "pp-1").unwrap();
        manager.save_secret("c2", "pp-2").unwrap();
        assert_eq!(manager.secret_for("c1").as_deref(), Some("pp-1"));

        // 落盘文件不含明文
        let raw = std::fs::read_to_string(dir.join(SECRETS_FILENAME)).unwrap();
        assert!(encryption::is_v2_envelope(&raw));
        assert!(!raw.contains("pp-1"));

        // 模拟重启：Locked 时读不到，解锁后恢复
        let manager = SecurityManager::new(dir.clone()).unwrap();
        assert!(manager.secret_for("c1").is_none());
        manager.unlock("pw").unwrap();
        assert_eq!(manager.secret_for("c2").as_deref(), Some("pp-2"));

        manager.remove_secret("c1").unwrap();
        assert!(manager.secret_for("c1").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn disable_downgrades_to_v1_and_removes_secrets() {
        let dir = temp_dir();
        seed_v1_connections(&dir, r#"[{"id":"c1"}]"#);
        let manager = SecurityManager::new(dir.clone()).unwrap();
        manager.setup_master_password("pw").unwrap();
        manager.save_secret("c1", "pp").unwrap();

        manager.disable_master_password("pw").unwrap();
        assert_eq!(manager.status(), SecurityStatus::Disabled);
        let raw = std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap();
        assert!(!encryption::is_v2_envelope(&raw), "降级后应是 v1 格式");
        assert!(!dir.join(SECRETS_FILENAME).exists());
        assert!(!dir.join(SECURITY_META_FILENAME).exists());

        let cipher = manager.write_cipher().unwrap();
        assert_eq!(cipher.decrypt(&raw).unwrap(), r#"[{"id":"c1"}]"#);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reset_removes_all_encrypted_data() {
        let dir = temp_dir();
        seed_v1_connections(&dir, r#"[{"id":"c1"}]"#);
        let manager = SecurityManager::new(dir.clone()).unwrap();
        manager.setup_master_password("pw").unwrap();
        manager.save_secret("c1", "pp").unwrap();

        manager.reset_all().unwrap();
        assert_eq!(manager.status(), SecurityStatus::Disabled);
        assert!(!dir.join(CONNECTIONS_FILENAME).exists());
        assert!(!dir.join(SECRETS_FILENAME).exists());
        assert!(!dir.join(SECURITY_META_FILENAME).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn interrupted_migration_recovers_from_bak_on_next_start() {
        let dir = temp_dir();
        seed_v1_connections(&dir, r#"[{"id":"c1","host":"db.internal"}]"#);
        let original = std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap();

        // 模拟迁移崩溃：v2 文件已替换、.bak 存在、security.json 未写（未提交）
        let manager = SecurityManager::new(dir.clone()).unwrap();
        let salt = encryption::generate_salt();
        let key = encryption::derive_master_key("pw", &salt).unwrap();
        let v2_blob =
            encryption::encrypt_v2(&key, r#"[{"id":"c1","host":"db.internal"}]"#).unwrap();
        std::fs::copy(
            dir.join(CONNECTIONS_FILENAME),
            backup_path(&dir.join(CONNECTIONS_FILENAME)),
        )
        .unwrap();
        std::fs::write(dir.join(CONNECTIONS_FILENAME), v2_blob).unwrap();
        drop(manager);

        // 重启：无 security.json + 存在 .bak → 自动还原为 v1
        let manager = SecurityManager::new(dir.clone()).unwrap();
        assert_eq!(manager.status(), SecurityStatus::Disabled);
        let recovered = std::fs::read_to_string(dir.join(CONNECTIONS_FILENAME)).unwrap();
        assert_eq!(recovered, original, "迁移中断必须原样恢复");
        assert!(!backup_path(&dir.join(CONNECTIONS_FILENAME)).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn tampered_kdf_params_are_rejected() {
        let dir = temp_dir();
        let manager = SecurityManager::new(dir.clone()).unwrap();
        manager.setup_master_password("pw").unwrap();

        // 篡改 KDF 参数（例如降级为弱参数）必须被拒绝
        let meta_path = dir.join(SECURITY_META_FILENAME);
        let raw = std::fs::read_to_string(&meta_path).unwrap();
        let tampered = raw.replace("19456", "1024");
        std::fs::write(&meta_path, tampered).unwrap();

        let manager = SecurityManager::new(dir.clone()).unwrap();
        assert_eq!(
            manager.unlock("pw").unwrap_err(),
            "error.security.unsupported_kdf"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
