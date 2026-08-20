//! 最近打开的 SQL 文件列表（FR-240）
//!
//! 明文 JSON 落盘（recent_files.json）：只记录路径与打开时间，路径不属于敏感信息，
//! 不进入加密存储；SQL 内容本身永不落盘（除非用户显式保存到自选路径）。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 最近文件最多保留条数。
const RECENT_FILES_LIMIT: usize = 20;
const RECENT_FILES_FILENAME: &str = "recent_files.json";

/// 一条最近文件记录。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentFileEntry {
    pub path: String,
    /// RFC3339 打开/保存时间
    pub opened_at: String,
}

/// 最近文件 store：最新在前，按路径去重。
pub struct RecentFilesStore {
    store_path: PathBuf,
}

impl RecentFilesStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            store_path: app_data_dir.join(RECENT_FILES_FILENAME),
        }
    }

    /// 读取全部记录（最新在前）。文件不存在或损坏返回空。
    pub fn load(&self) -> Vec<RecentFileEntry> {
        let Ok(blob) = std::fs::read_to_string(&self.store_path) else {
            return vec![];
        };
        serde_json::from_str(&blob).unwrap_or_default()
    }

    /// 记录一次打开/保存（置顶 + 按路径去重 + 截断上限）。
    pub fn touch(&self, path: &str) -> Result<(), String> {
        let mut entries = self.load();
        entries.retain(|entry| entry.path != path);
        entries.insert(
            0,
            RecentFileEntry {
                path: path.to_string(),
                opened_at: chrono::Utc::now().to_rfc3339(),
            },
        );
        entries.truncate(RECENT_FILES_LIMIT);
        self.save(&entries)
    }

    /// 移除一条记录（如打开失败确认文件已失效）。
    pub fn remove(&self, path: &str) -> Result<(), String> {
        let mut entries = self.load();
        entries.retain(|entry| entry.path != path);
        self.save(&entries)
    }

    fn save(&self, entries: &[RecentFileEntry]) -> Result<(), String> {
        let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
        if let Some(parent) = self.store_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let tmp_path = self.store_path.with_extension("tmp");
        std::fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp_path, &self.store_path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (PathBuf, RecentFilesStore) {
        let dir = std::env::temp_dir().join(format!("tiny-sql-recent-{}", uuid::Uuid::new_v4()));
        (dir.clone(), RecentFilesStore::new(dir))
    }

    #[test]
    fn touch_dedupes_and_caps_at_limit() {
        let (_dir, store) = temp_store();
        for i in 0..25 {
            store.touch(&format!("/tmp/q{i}.sql")).unwrap();
        }
        store.touch("/tmp/q0.sql").unwrap();
        let entries = store.load();
        assert_eq!(entries.len(), RECENT_FILES_LIMIT);
        assert_eq!(entries[0].path, "/tmp/q0.sql", "重复 touch 应置顶");
        assert_eq!(
            entries.iter().filter(|e| e.path == "/tmp/q0.sql").count(),
            1,
            "同一路径只保留一条"
        );
    }

    #[test]
    fn remove_deletes_entry() {
        let (_dir, store) = temp_store();
        store.touch("/tmp/a.sql").unwrap();
        store.touch("/tmp/b.sql").unwrap();
        store.remove("/tmp/a.sql").unwrap();
        let entries = store.load();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "/tmp/b.sql");
    }
}
