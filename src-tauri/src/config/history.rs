//! SQL 执行历史持久化（FR-106，v0.2 Week 6）
//!
//! 最近 100 条历史整体加密落盘 `history.enc`，加密器与连接配置同一套
//! [`SecurityManager`]（未启用主密码时用 v1 本地 key，启用后用 v2 派生 key）。
//! 锁定状态下历史不可读写，返回 `error.security.locked`。
//!
//! 安全约束（V2-R04）：历史只经本模块落盘，不进入日志、不进入导出内容；
//! 用户可从 UI 显式清空。

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::security::{SecurityManager, HISTORY_FILENAME};

/// 历史保留上限（最近的排在最前）。
pub const HISTORY_LIMIT: usize = 100;

/// 单条 SQL 历史记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub connection_id: String,
    pub connection_name: String,
    pub driver: String,
    pub database: String,
    #[serde(default)]
    pub schema: Option<String>,
    pub sql: String,
    /// ISO 8601 执行时间
    pub executed_at: String,
    pub success: bool,
}

/// SQL 历史存储：加载 / 追加（截断到上限）/ 清空。
pub struct HistoryStore {
    security: Arc<SecurityManager>,
    store_path: PathBuf,
}

impl HistoryStore {
    pub fn new(app_data_dir: PathBuf, security: Arc<SecurityManager>) -> Self {
        Self {
            security,
            store_path: app_data_dir.join(HISTORY_FILENAME),
        }
    }

    /// 读取全部历史（最新在前）。文件不存在返回空；锁定返回稳定 key。
    pub fn load(&self) -> Result<Vec<HistoryEntry>, String> {
        if !self.store_path.exists() {
            return Ok(vec![]);
        }
        let blob = std::fs::read_to_string(&self.store_path).map_err(|e| e.to_string())?;
        if blob.trim().is_empty() {
            return Ok(vec![]);
        }
        let json = self.security.read_cipher(&blob)?.decrypt(&blob)?;
        serde_json::from_str(&json).map_err(|e| e.to_string())
    }

    /// 追加一条历史并截断到 [`HISTORY_LIMIT`]。
    pub fn record(&self, entry: HistoryEntry) -> Result<(), String> {
        let mut entries = self.load().unwrap_or_default();
        entries.insert(0, entry);
        entries.truncate(HISTORY_LIMIT);
        self.save(&entries)
    }

    /// 清空全部历史（显式用户操作）。
    pub fn clear(&self) -> Result<(), String> {
        self.save(&[])
    }

    fn save(&self, entries: &[HistoryEntry]) -> Result<(), String> {
        let json = serde_json::to_string(entries).map_err(|e| e.to_string())?;
        let blob = self.security.write_cipher()?.encrypt(&json)?;
        if let Some(parent) = self.store_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp_path = self.store_path.with_extension("tmp");
        std::fs::write(&tmp_path, blob).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp_path, &self.store_path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::security::SecurityStatus;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tiny-sql-hist-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn temp_store() -> (PathBuf, Arc<SecurityManager>, HistoryStore) {
        let dir = temp_dir();
        let security = Arc::new(SecurityManager::new(dir.clone()).unwrap());
        let store = HistoryStore::new(dir.clone(), security.clone());
        (dir, security, store)
    }

    fn entry(id: &str, sql: &str) -> HistoryEntry {
        HistoryEntry {
            id: id.to_string(),
            connection_id: "c1".to_string(),
            connection_name: "prod".to_string(),
            driver: "mysql".to_string(),
            database: "app".to_string(),
            schema: None,
            sql: sql.to_string(),
            executed_at: "2026-08-19T10:00:00Z".to_string(),
            success: true,
        }
    }

    #[test]
    fn record_keeps_newest_first_and_caps_at_limit() {
        let (dir, _security, store) = temp_store();
        for i in 0..120 {
            store
                .record(entry(&format!("e{i}"), &format!("SELECT {i}")))
                .unwrap();
        }
        let entries = store.load().unwrap();
        assert_eq!(entries.len(), HISTORY_LIMIT);
        assert_eq!(entries[0].id, "e119", "最新记录必须在最前");
        assert_eq!(entries[99].id, "e20", "超过上限的旧记录必须被淘汰");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn history_file_has_no_plaintext_sql() {
        // V2-R04：落盘文件不能出现明文 SQL
        let (dir, _security, store) = temp_store();
        store
            .record(entry(
                "e1",
                "SELECT * FROM salary WHERE name = 'alice-secret'",
            ))
            .unwrap();
        let raw = std::fs::read_to_string(dir.join(HISTORY_FILENAME)).unwrap();
        assert!(!raw.contains("alice-secret"), "SQL 明文泄露: {raw}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn clear_empties_history() {
        let (dir, _security, store) = temp_store();
        store.record(entry("e1", "SELECT 1")).unwrap();
        store.clear().unwrap();
        assert!(store.load().unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn locked_history_is_unavailable_until_unlock() {
        let (dir, security, store) = temp_store();
        store.record(entry("e1", "SELECT 1")).unwrap();
        security.setup_master_password("pw").unwrap();
        security.lock();

        assert_eq!(store.load().unwrap_err(), "error.security.locked");
        assert_eq!(
            store.record(entry("e2", "SELECT 2")).unwrap_err(),
            "error.security.locked"
        );

        security.unlock("pw").unwrap();
        let entries = store.load().unwrap();
        assert_eq!(entries.len(), 1, "迁移后旧历史必须保留");
        // 解锁后新历史写为 v2
        store.record(entry("e2", "SELECT 2")).unwrap();
        let raw = std::fs::read_to_string(dir.join(HISTORY_FILENAME)).unwrap();
        assert!(crate::config::encryption::is_v2_envelope(&raw));
        assert_eq!(security.status(), SecurityStatus::Unlocked);
        std::fs::remove_dir_all(&dir).ok();
    }
}
