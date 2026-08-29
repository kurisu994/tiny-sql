//! 加密分享连接配置（FR-221）。
//!
//! 独立口令 Argon2id → AES-256-GCM，自描述信封。不含 master.key / security.json。
//! 默认不打包私钥文件内容；导入一律新 id，不带入 known_hosts。

use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use crate::commands::query::QueryCommandError;
use crate::config::encryption::{
    derive_master_key, generate_salt, ARGON2_M_COST_KIB, ARGON2_P_COST, ARGON2_T_COST,
};
use crate::config::store::StoredConnection;
use crate::state::AppState;

const SHARE_KIND: &str = "tiny-sql-share";
const SHARE_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
struct ShareKdf {
    alg: String,
    m: u32,
    t: u32,
    p: u32,
    salt: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ShareEnvelope {
    v: u32,
    kind: String,
    kdf: ShareKdf,
    nonce: String,
    data: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShareKeyMaterial {
    connection_id: String,
    hop_index: usize,
    content: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharePayload {
    connections: Vec<StoredConnection>,
    private_keys: Vec<ShareKeyMaterial>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareExportInput {
    pub ids: Vec<String>,
    pub password: String,
    pub path: String,
    pub include_private_keys: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePreviewInput {
    pub path: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePreviewItem {
    pub name: String,
    pub driver: String,
    pub hop_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePreviewResult {
    pub connections: Vec<SharePreviewItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareImportInput {
    pub path: String,
    pub password: String,
}

fn err(key: &str) -> QueryCommandError {
    QueryCommandError::from_key(key)
}

/// 用独立口令封装分享密文。
pub fn encrypt_share(password: &str, plaintext: &str) -> Result<String, QueryCommandError> {
    if password.is_empty() {
        return Err(err("error.share.empty_password"));
    }
    let salt = generate_salt();
    let key = derive_master_key(password, &salt).map_err(|_| err("error.share.failed"))?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|_| err("error.share.failed"))?;
    let envelope = ShareEnvelope {
        v: SHARE_VERSION,
        kind: SHARE_KIND.to_string(),
        kdf: ShareKdf {
            alg: "argon2id".into(),
            m: ARGON2_M_COST_KIB,
            t: ARGON2_T_COST,
            p: ARGON2_P_COST,
            salt: BASE64.encode(salt),
        },
        nonce: BASE64.encode(nonce),
        data: BASE64.encode(ciphertext),
    };
    serde_json::to_string(&envelope).map_err(|_| err("error.share.failed"))
}

/// 解开分享信封。口令错误或密文被改返回稳定 key。
pub fn decrypt_share(password: &str, blob: &str) -> Result<String, QueryCommandError> {
    if password.is_empty() {
        return Err(err("error.share.empty_password"));
    }
    let envelope: ShareEnvelope =
        serde_json::from_str(blob.trim()).map_err(|_| err("error.share.invalid"))?;
    if envelope.v != SHARE_VERSION || envelope.kind != SHARE_KIND {
        return Err(err("error.share.invalid"));
    }
    let salt = BASE64
        .decode(envelope.kdf.salt)
        .map_err(|_| err("error.share.invalid"))?;
    let nonce = BASE64
        .decode(envelope.nonce)
        .map_err(|_| err("error.share.invalid"))?;
    let data = BASE64
        .decode(envelope.data)
        .map_err(|_| err("error.share.invalid"))?;
    if nonce.len() != 12 {
        return Err(err("error.share.invalid"));
    }
    let key = derive_master_key(password, &salt).map_err(|_| err("error.share.failed"))?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.as_ref()));
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce), data.as_ref())
        .map_err(|_| err("error.share.wrong_password"))?;
    String::from_utf8(plain).map_err(|_| err("error.share.invalid"))
}

fn unique_name(existing: &[String], name: &str) -> String {
    if !existing.iter().any(|item| item == name) {
        return name.to_string();
    }
    let first = format!("{name} (导入)");
    if !existing.iter().any(|item| item == &first) {
        return first;
    }
    for index in 2..1000 {
        let candidate = format!("{name} (导入 {index})");
        if !existing.iter().any(|item| item == &candidate) {
            return candidate;
        }
    }
    format!("{name} (导入 {})", Uuid::new_v4())
}

fn collect_private_keys(connections: &[StoredConnection]) -> Vec<ShareKeyMaterial> {
    let mut keys = Vec::new();
    for connection in connections {
        for (hop_index, hop) in connection.ssh.hops.iter().enumerate() {
            let Some(path) = hop.private_key_path.as_deref().filter(|p| !p.is_empty()) else {
                continue;
            };
            if let Ok(content) = fs::read_to_string(path) {
                keys.push(ShareKeyMaterial {
                    connection_id: connection.id.clone(),
                    hop_index,
                    content,
                });
            }
        }
    }
    keys
}

fn write_imported_key(app: &AppHandle, content: &str) -> Result<String, QueryCommandError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| err("error.share.failed"))?
        .join("imported-keys");
    fs::create_dir_all(&dir).map_err(|_| err("error.share.failed"))?;
    let path = dir.join(format!("{}.pem", Uuid::new_v4()));
    fs::write(&path, content).map_err(|_| err("error.share.failed"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perm = fs::metadata(&path)
            .map_err(|_| err("error.share.failed"))?
            .permissions();
        perm.set_mode(0o600);
        fs::set_permissions(&path, perm).map_err(|_| err("error.share.failed"))?;
    }
    Ok(path.display().to_string())
}

/// 导出选中连接到分享文件。
#[tauri::command]
pub fn connection_share_export(
    state: State<'_, AppState>,
    input: ShareExportInput,
) -> Result<(), QueryCommandError> {
    if input.password.is_empty() {
        return Err(err("error.share.empty_password"));
    }
    let store = state.store.lock().map_err(|_| err("error.share.failed"))?;
    let all = store.load().map_err(QueryCommandError::from_key)?;
    let selected: Vec<StoredConnection> = all
        .into_iter()
        .filter(|item| input.ids.iter().any(|id| id == &item.id))
        .collect();
    if selected.is_empty() {
        return Err(err("error.share.empty"));
    }
    let private_keys = if input.include_private_keys {
        collect_private_keys(&selected)
    } else {
        Vec::new()
    };
    let payload = SharePayload {
        connections: selected,
        private_keys,
    };
    let json = serde_json::to_string(&payload).map_err(|_| err("error.share.failed"))?;
    let blob = encrypt_share(&input.password, &json)?;
    fs::write(&input.path, blob).map_err(|_| err("error.share.io"))?;
    Ok(())
}

/// 预览分享文件（不写 store，不展示密码）。
#[tauri::command]
pub fn connection_share_preview(
    input: SharePreviewInput,
) -> Result<SharePreviewResult, QueryCommandError> {
    let blob = fs::read_to_string(&input.path).map_err(|_| err("error.share.io"))?;
    let json = decrypt_share(&input.password, &blob)?;
    let payload: SharePayload =
        serde_json::from_str(&json).map_err(|_| err("error.share.invalid"))?;
    Ok(SharePreviewResult {
        connections: payload
            .connections
            .iter()
            .map(|item| SharePreviewItem {
                name: item.name.clone(),
                driver: item.driver.as_str().to_string(),
                hop_count: item.ssh.hops.len(),
            })
            .collect(),
    })
}

/// 导入分享文件：新 id、重名加后缀、不写 known_hosts。
#[tauri::command]
pub fn connection_share_import(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ShareImportInput,
) -> Result<usize, QueryCommandError> {
    let blob = fs::read_to_string(&input.path).map_err(|_| err("error.share.io"))?;
    let json = decrypt_share(&input.password, &blob)?;
    let payload: SharePayload =
        serde_json::from_str(&json).map_err(|_| err("error.share.invalid"))?;
    let store = state.store.lock().map_err(|_| err("error.share.failed"))?;
    let existing = store.load().map_err(QueryCommandError::from_key)?;
    let mut names: Vec<String> = existing.iter().map(|item| item.name.clone()).collect();
    let mut imported = 0usize;
    for mut connection in payload.connections {
        let old_id = connection.id.clone();
        connection.id = Uuid::new_v4().to_string();
        connection.last_used_at = None;
        connection.sort_order = None;
        connection.name = unique_name(&names, &connection.name);
        names.push(connection.name.clone());
        for key in payload
            .private_keys
            .iter()
            .filter(|item| item.connection_id == old_id)
        {
            if let Some(hop) = connection.ssh.hops.get_mut(key.hop_index) {
                hop.private_key_path = Some(write_imported_key(&app, &key.content)?);
            }
        }
        store
            .upsert(connection)
            .map_err(QueryCommandError::from_key)?;
        imported += 1;
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_roundtrip_hides_secret() {
        let plain = r#"{"password":"s3cret-share"}"#;
        let blob = encrypt_share("share-pass", plain).unwrap();
        assert!(!blob.contains("s3cret-share"));
        assert!(!blob.contains("share-pass"));
        assert_eq!(decrypt_share("share-pass", &blob).unwrap(), plain);
    }

    #[test]
    fn wrong_password_and_tamper_rejected() {
        let blob = encrypt_share("ok", r#"{"a":1}"#).unwrap();
        let wrong = decrypt_share("nope", &blob).unwrap_err();
        let wrong_json = serde_json::to_value(&wrong).unwrap();
        assert_eq!(wrong_json["key"], "error.share.wrong_password");

        let mut tampered = blob;
        tampered.push('x');
        let bad = decrypt_share("ok", &tampered).unwrap_err();
        let bad_json = serde_json::to_value(&bad).unwrap();
        assert_eq!(bad_json["key"], "error.share.invalid");
    }

    #[test]
    fn unique_name_appends_suffix() {
        let existing = vec!["prod".into(), "prod (导入)".into()];
        assert_eq!(unique_name(&existing, "prod"), "prod (导入 2)");
        assert_eq!(unique_name(&existing, "dev"), "dev");
    }
}
