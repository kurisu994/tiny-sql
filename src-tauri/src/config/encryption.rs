//! AES-256-GCM 加密 —— 连接配置整体文件加密 + master key / 用户主密码管理
//!
//! 复用自 redis-desktop-client，函数通用化为「加密任意字符串」。
//! tiny-sql 对**整个 connections.enc 文件**加密（不是逐字段），满足 FR-001：
//! `cat connections.enc` 不能看到明文 host/user/password。
//!
//! 两个加密时代：
//! - v1（v0.1 起）：随机本地 master key 落盘 `master.key`（0600），防「打开文件就看到明文」；
//! - v2（v0.2 起，FR-102）：用户主密码经 Argon2id 派生数据 key，密文为自描述 JSON envelope。
//!   KDF 参数与盐集中在 `security.json`，数据文件本身只携带版本号、nonce 与密文。

use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use zeroize::Zeroizing;

/// 获取或生成 master key —— 首次运行生成并以 0600 权限持久化到文件
pub fn get_or_create_master_key(key_path: &Path) -> Result<[u8; 32], String> {
    if key_path.exists() {
        let content = std::fs::read_to_string(key_path).map_err(|e| e.to_string())?;
        let key_bytes = BASE64.decode(content.trim()).map_err(|e| e.to_string())?;
        if key_bytes.len() != 32 {
            return Err("master key 长度无效".into());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_bytes);
        Ok(key)
    } else {
        let key = Aes256Gcm::generate_key(OsRng);
        let key_b64 = BASE64.encode(key.as_slice());
        if let Some(parent) = key_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(key_path, &key_b64).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perm = std::fs::metadata(key_path)
                .map_err(|e| e.to_string())?
                .permissions();
            perm.set_mode(0o600);
            std::fs::set_permissions(key_path, perm).map_err(|e| e.to_string())?;
        }
        let mut arr = [0u8; 32];
        arr.copy_from_slice(key.as_slice());
        Ok(arr)
    }
}

/// 加密任意字符串 —— 返回 base64(nonce + ciphertext)，nonce 固定 12 字节拼在前面
pub fn encrypt_str(master_key: &[u8; 32], plaintext: &str) -> Result<String, String> {
    let key = Key::<Aes256Gcm>::from_slice(master_key);
    let cipher = Aes256Gcm::new(key);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("加密失败: {e}"))?;

    let mut combined = nonce.to_vec();
    combined.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(&combined))
}

/// 解密 [`encrypt_str`] 的输出
pub fn decrypt_str(master_key: &[u8; 32], encrypted: &str) -> Result<String, String> {
    let key = Key::<Aes256Gcm>::from_slice(master_key);
    let cipher = Aes256Gcm::new(key);
    let combined = BASE64
        .decode(encrypted)
        .map_err(|e| format!("base64 解码失败: {e}"))?;

    if combined.len() < 12 {
        return Err("加密数据格式无效".into());
    }

    let (nonce_bytes, ciphertext) = combined.split_at(12);
    let nonce = Nonce::from_slice(nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| format!("解密失败: {e}"))?;

    String::from_utf8(plaintext).map_err(|e| format!("UTF-8 解码失败: {e}"))
}

// ===== v2：用户主密码派生 key（FR-102）=====

/// Argon2id 内存成本（KiB）——19 MiB，RFC 9106 第二推荐档。
pub const ARGON2_M_COST_KIB: u32 = 19 * 1024;
/// Argon2id 迭代次数。
pub const ARGON2_T_COST: u32 = 2;
/// Argon2id 并行度。
pub const ARGON2_P_COST: u32 = 1;
/// KDF 盐长度（字节）。
pub const SALT_LEN: usize = 16;

/// 生成随机 KDF 盐。
pub fn generate_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    aes_gcm::aead::rand_core::RngCore::fill_bytes(&mut OsRng, &mut salt);
    salt
}

/// 用 Argon2id v19 从用户主密码派生 32 字节数据加密 key。
///
/// 参数固定为 [`ARGON2_M_COST_KIB`] / [`ARGON2_T_COST`] / [`ARGON2_P_COST`]；
/// 返回值用 [`Zeroizing`] 包装，离开作用域即清零内存。
pub fn derive_master_key(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>, String> {
    let params = Params::new(ARGON2_M_COST_KIB, ARGON2_T_COST, ARGON2_P_COST, Some(32))
        .map_err(|e| format!("Argon2 参数无效: {e}"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; 32]);
    argon2
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|e| format!("主密码派生失败: {e}"))?;
    Ok(key)
}

/// v2 自描述密文 envelope。KDF 参数/盐集中在 `security.json`，这里只带版本、
/// nonce 与密文，保持数据文件最小。
#[derive(Debug, Serialize, Deserialize)]
pub struct EnvelopeV2 {
    pub v: u32,
    /// base64(12 字节 nonce)
    pub nonce: String,
    /// base64(ciphertext + 16 字节 tag)
    pub data: String,
}

const ENVELOPE_V2: u32 = 2;

/// 判断密文是否为 v2 envelope（v1 是纯 base64 字符串，v2 是 JSON）。
pub fn is_v2_envelope(blob: &str) -> bool {
    let trimmed = blob.trim();
    trimmed.starts_with('{') && trimmed.contains("\"v\":2")
}

/// 用派生 key 加密为 v2 envelope JSON。
pub fn encrypt_v2(key: &[u8; 32], plaintext: &str) -> Result<String, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|e| format!("加密失败: {e}"))?;
    let envelope = EnvelopeV2 {
        v: ENVELOPE_V2,
        nonce: BASE64.encode(nonce),
        data: BASE64.encode(ciphertext),
    };
    serde_json::to_string(&envelope).map_err(|e| e.to_string())
}

/// 解密 v2 envelope JSON；格式不符或 key 错误都会失败。
pub fn decrypt_v2(key: &[u8; 32], blob: &str) -> Result<String, String> {
    let envelope: EnvelopeV2 =
        serde_json::from_str(blob.trim()).map_err(|e| format!("密文 envelope 格式无效: {e}"))?;
    if envelope.v != ENVELOPE_V2 {
        return Err(format!("不支持的密文版本: {}", envelope.v));
    }
    let nonce_bytes = BASE64
        .decode(envelope.nonce)
        .map_err(|e| format!("nonce 解码失败: {e}"))?;
    if nonce_bytes.len() != 12 {
        return Err("nonce 长度无效".into());
    }
    let ciphertext = BASE64
        .decode(envelope.data)
        .map_err(|e| format!("密文解码失败: {e}"))?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ciphertext.as_ref())
        .map_err(|_| "解密失败：key 错误或数据已损坏".to_string())?;
    String::from_utf8(plaintext).map_err(|e| format!("UTF-8 解码失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = [42u8; 32];
        let plaintext = r#"{"host":"db.internal","password":"s3cret"}"#;
        let encrypted = encrypt_str(&key, plaintext).unwrap();
        // 密文里不应出现明文片段
        assert!(!encrypted.contains("db.internal"));
        let decrypted = decrypt_str(&key, &encrypted).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_with_wrong_key_fails() {
        let encrypted = encrypt_str(&[1u8; 32], "hello").unwrap();
        // 错误 key 必须解密失败，而不是返回乱码
        assert!(decrypt_str(&[2u8; 32], &encrypted).is_err());
    }

    #[test]
    fn empty_string_roundtrip() {
        let key = [7u8; 32];
        let encrypted = encrypt_str(&key, "").unwrap();
        assert_eq!(decrypt_str(&key, &encrypted).unwrap(), "");
    }

    #[test]
    fn master_key_derivation_is_deterministic_and_salt_sensitive() {
        let salt_a = generate_salt();
        let salt_b = generate_salt();
        let key_a1 = derive_master_key("correct horse", &salt_a).unwrap();
        let key_a2 = derive_master_key("correct horse", &salt_a).unwrap();
        let key_b = derive_master_key("correct horse", &salt_b).unwrap();

        assert_eq!(*key_a1, *key_a2, "同密码同盐必须派生相同 key");
        assert_ne!(*key_a1, *key_b, "不同盐必须派生不同 key");
    }

    #[test]
    fn v2_envelope_roundtrip_and_wrong_key_rejected() {
        let salt = generate_salt();
        let key = derive_master_key("主密码-🔒", &salt).unwrap();
        let blob = encrypt_v2(&key, r#"{"password":"s3cret"}"#).unwrap();

        assert!(is_v2_envelope(&blob));
        assert!(!blob.contains("s3cret"), "envelope 不能包含明文");
        let legacy = encrypt_str(&[9u8; 32], "legacy").unwrap();
        assert!(!is_v2_envelope(&legacy), "v1 纯密文不能被嗅探为 v2");

        let wrong = derive_master_key("wrong-password", &salt).unwrap();
        assert!(decrypt_v2(&wrong, &blob).is_err(), "错误 key 必须失败");
        assert_eq!(decrypt_v2(&key, &blob).unwrap(), r#"{"password":"s3cret"}"#);
    }
}
