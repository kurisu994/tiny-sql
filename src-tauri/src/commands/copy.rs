//! 双连接表级数据拷贝（FR-266）。
//!
//! 源侧 browse 分页读，目标侧 `bulk_insert_rows`。只允许已打开、同方言连接。

use db_driver::{
    Driver, DriverKind, MetadataScope, QueryOptions, TableBrowseQuery, TABLE_PREVIEW_LIMIT,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::commands::query::{driver_of, QueryCommandError};
use crate::state::{ActiveQuery, AppState};

const COPY_PAGE: usize = TABLE_PREVIEW_LIMIT;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyEndpoint {
    pub id: String,
    pub database: String,
    pub schema: Option<String>,
    pub table: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPreviewInput {
    pub source: CopyEndpoint,
    pub dest: CopyEndpoint,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyColumnMapping {
    pub source: String,
    pub dest: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPreviewResult {
    pub mappings: Vec<CopyColumnMapping>,
    pub source_total: Option<u64>,
    pub dest_total: Option<u64>,
    pub replace_sql: String,
    pub cross_driver: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyTableInput {
    pub source: CopyEndpoint,
    pub dest: CopyEndpoint,
    /// append | replace
    pub mode: String,
    /// 必须等于 dest `database.table`
    pub confirm_target: String,
    pub query_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyTableResult {
    pub copied: u64,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyProgressPayload {
    query_id: String,
    copied: u64,
}

fn err(key: &str) -> QueryCommandError {
    QueryCommandError::from_key(key)
}

fn ident_key(name: &str, kind: DriverKind) -> String {
    match kind {
        DriverKind::MySql => name.to_ascii_lowercase(),
        DriverKind::PostgreSql => name.to_string(),
    }
}

pub fn map_columns(source: &[String], dest: &[String], kind: DriverKind) -> Vec<(String, String)> {
    let dest_by_key: Vec<(String, &String)> = dest
        .iter()
        .map(|name| (ident_key(name, kind), name))
        .collect();
    let mut used = std::collections::HashSet::new();
    let mut out = Vec::new();
    for src in source {
        let key = ident_key(src, kind);
        if used.contains(&key) {
            continue;
        }
        if let Some((_, dest_name)) = dest_by_key.iter().find(|(k, _)| k == &key) {
            used.insert(key);
            out.push((src.clone(), (*dest_name).clone()));
        }
    }
    out
}

fn expected_target(endpoint: &CopyEndpoint) -> String {
    format!("{}.{}", endpoint.database.trim(), endpoint.table.trim())
}

fn scope_of(kind: DriverKind, endpoint: &CopyEndpoint) -> Result<MetadataScope, QueryCommandError> {
    match kind {
        DriverKind::MySql => Ok(MetadataScope::mysql(endpoint.database.trim())),
        DriverKind::PostgreSql => {
            let schema = endpoint
                .schema
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| err("error.driver.schema_required"))?;
            Ok(MetadataScope::postgresql(endpoint.database.trim(), schema))
        }
    }
}

fn quote_table(kind: DriverKind, endpoint: &CopyEndpoint) -> Result<String, QueryCommandError> {
    match kind {
        DriverKind::MySql => Ok(format!(
            "`{}`.`{}`",
            endpoint.database.trim().replace('`', "``"),
            endpoint.table.trim().replace('`', "``")
        )),
        DriverKind::PostgreSql => {
            let schema = endpoint
                .schema
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("public");
            Ok(format!(
                "\"{}\".\"{}\"",
                schema.replace('"', "\"\""),
                endpoint.table.trim().replace('"', "\"\"")
            ))
        }
    }
}

fn replace_sql(kind: DriverKind, endpoint: &CopyEndpoint) -> Result<String, QueryCommandError> {
    Ok(format!("TRUNCATE TABLE {};", quote_table(kind, endpoint)?))
}

fn project_row(
    source_columns: &[String],
    row: &[Option<String>],
    mapping: &[(String, String)],
    kind: DriverKind,
) -> Vec<Option<String>> {
    mapping
        .iter()
        .map(|(source, _)| {
            let key = ident_key(source, kind);
            source_columns
                .iter()
                .position(|name| ident_key(name, kind) == key)
                .and_then(|index| row.get(index).cloned())
                .flatten()
                .map(Some)
                .unwrap_or(None)
        })
        .collect()
}

/// 预览列映射与双方行数。
#[tauri::command]
pub async fn db_copy_preview(
    state: State<'_, AppState>,
    input: CopyPreviewInput,
) -> Result<CopyPreviewResult, QueryCommandError> {
    let source = driver_of(&state, &input.source.id)
        .await
        .map_err(QueryCommandError::from_key)?;
    let dest = driver_of(&state, &input.dest.id)
        .await
        .map_err(QueryCommandError::from_key)?;
    let kind = Driver::kind(&source);
    let cross_driver = kind != Driver::kind(&dest);
    if cross_driver {
        return Ok(CopyPreviewResult {
            mappings: vec![],
            source_total: None,
            dest_total: None,
            replace_sql: String::new(),
            cross_driver: true,
        });
    }
    let source_scope = scope_of(kind, &input.source)?;
    let dest_scope = scope_of(kind, &input.dest)?;
    let token = CancellationToken::new();
    let source_cols = Driver::list_columns(&source, &source_scope, &input.source.table)
        .await
        .map_err(QueryCommandError::from)?;
    let dest_cols = Driver::list_columns(&dest, &dest_scope, &input.dest.table)
        .await
        .map_err(QueryCommandError::from)?;
    let mappings = map_columns(
        &source_cols
            .iter()
            .map(|c| c.name.clone())
            .collect::<Vec<_>>(),
        &dest_cols.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
        kind,
    );
    let source_page = Driver::browse_table(
        &source,
        &source_scope,
        &input.source.table,
        &TableBrowseQuery {
            filters: vec![],
            order: None,
            limit: 1,
            offset: 0,
        },
        token.clone(),
    )
    .await
    .map_err(QueryCommandError::from)?;
    let dest_page = Driver::browse_table(
        &dest,
        &dest_scope,
        &input.dest.table,
        &TableBrowseQuery {
            filters: vec![],
            order: None,
            limit: 1,
            offset: 0,
        },
        token,
    )
    .await
    .map_err(QueryCommandError::from)?;
    Ok(CopyPreviewResult {
        mappings: mappings
            .into_iter()
            .map(|(source, dest)| CopyColumnMapping { source, dest })
            .collect(),
        source_total: source_page.total,
        dest_total: dest_page.total,
        replace_sql: replace_sql(kind, &input.dest)?,
        cross_driver: false,
    })
}

/// 执行表拷贝。
#[tauri::command]
pub async fn db_copy_table_rows(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CopyTableInput,
) -> Result<CopyTableResult, QueryCommandError> {
    if input.confirm_target.trim() != expected_target(&input.dest) {
        return Err(err("error.copy.target_mismatch"));
    }
    let source = driver_of(&state, &input.source.id)
        .await
        .map_err(QueryCommandError::from_key)?;
    let dest = driver_of(&state, &input.dest.id)
        .await
        .map_err(QueryCommandError::from_key)?;
    let kind = Driver::kind(&source);
    if kind != Driver::kind(&dest) {
        return Err(err("error.copy.cross_driver"));
    }
    let source_scope = scope_of(kind, &input.source)?;
    let dest_scope = scope_of(kind, &input.dest)?;
    let source_cols = Driver::list_columns(&source, &source_scope, &input.source.table)
        .await
        .map_err(QueryCommandError::from)?;
    let dest_cols = Driver::list_columns(&dest, &dest_scope, &input.dest.table)
        .await
        .map_err(QueryCommandError::from)?;
    let mapping = map_columns(
        &source_cols
            .iter()
            .map(|c| c.name.clone())
            .collect::<Vec<_>>(),
        &dest_cols.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
        kind,
    );
    if mapping.is_empty() {
        return Err(err("error.copy.no_mapped_columns"));
    }
    let dest_order: Vec<String> = mapping.iter().map(|(_, dest)| dest.clone()).collect();
    let query_id = input
        .query_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let token = CancellationToken::new();
    state.queries.lock().await.insert(
        query_id.clone(),
        ActiveQuery {
            connection_id: input.dest.id.clone(),
            cancel_token: token.clone(),
        },
    );
    let result = async {
        if input.mode == "replace" {
            Driver::query(
                &dest,
                &replace_sql(kind, &input.dest)?,
                QueryOptions {
                    row_limit: 1,
                    allow_write: true,
                },
                token.clone(),
            )
            .await
            .map_err(QueryCommandError::from)?;
        } else if input.mode != "append" {
            return Err(err("error.copy.failed"));
        }
        let mut copied = 0u64;
        let mut offset = 0usize;
        loop {
            if token.is_cancelled() {
                return Err(err("error.copy.cancelled"));
            }
            let page = Driver::browse_table(
                &source,
                &source_scope,
                &input.source.table,
                &TableBrowseQuery {
                    filters: vec![],
                    order: None,
                    limit: COPY_PAGE,
                    offset,
                },
                token.clone(),
            )
            .await
            .map_err(QueryCommandError::from)?;
            let rows = &page.row_set.rows;
            if rows.is_empty() {
                break;
            }
            let projected: Vec<Vec<Option<String>>> = rows
                .iter()
                .map(|row| project_row(&page.row_set.columns, row, &mapping, kind))
                .collect();
            Driver::bulk_insert_rows(
                &dest,
                &dest_scope,
                &input.dest.table,
                &dest_order,
                &projected,
                true,
                token.clone(),
            )
            .await
            .map_err(QueryCommandError::from)?;
            copied += projected.len() as u64;
            let _ = app.emit(
                "copy:progress",
                CopyProgressPayload {
                    query_id: query_id.clone(),
                    copied,
                },
            );
            offset += rows.len();
            if !page.has_next_page {
                break;
            }
        }
        Ok(CopyTableResult {
            copied,
            truncated: false,
        })
    }
    .await;
    state.queries.lock().await.remove(&query_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_maps_case_insensitive_and_skips_missing() {
        let mapped = map_columns(
            &["id".into(), "Name".into(), "extra".into()],
            &["name".into(), "id".into()],
            DriverKind::MySql,
        );
        assert_eq!(
            mapped,
            vec![("id".into(), "id".into()), ("Name".into(), "name".into())]
        );
    }

    #[test]
    fn confirm_target_is_database_dot_table() {
        let dest = CopyEndpoint {
            id: "c".into(),
            database: "app".into(),
            schema: Some("public".into()),
            table: "users".into(),
        };
        assert_eq!(expected_target(&dest), "app.users");
    }
}
