//! AES-256-GCM 加密 —— 连接配置整体文件加密 + master key 管理
//!
//! 复用自 redis-desktop-client，函数通用化为「加密任意字符串」。
//! tiny-sql 对**整个 connections.enc 文件**加密（不是逐字段），满足 FR-001：
//! `cat connections.enc` 不能看到明文 host/user/password。
//!
//! 安全定位（ARCHITECTURE §5）：v0.1 用应用内置流程生成的本地 master key，
//! 等同 Keychain 级「防止打开文件就看到明文」，不是抗逆向的强加密；
//! 用户主密码派生 key 留 v0.2。

use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use std::path::Path;

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
}
