//! 数据库用户与权限查看（FR-262）。
//! 不把密码哈希送到前端。变更 SQL 由前端生成，走 db_query 写确认。

use db_driver::{Driver, DriverKind, QueryOptions};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::commands::query::{driver_of, QueryCommandError};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegeAccount {
    pub name: String,
    pub host: Option<String>,
    pub can_login: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivilegeListResult {
    pub driver: String,
    pub accounts: Vec<PrivilegeAccount>,
    pub read_only: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowGrantsInput {
    pub name: String,
    pub host: Option<String>,
}

fn err(key: &str) -> QueryCommandError {
    QueryCommandError::from_key(key)
}

/// 列出账号。MySQL 来自 mysql.user（仅 User/Host）；PG 来自 pg_roles 只读。
#[tauri::command]
pub async fn db_list_accounts(
    state: State<'_, AppState>,
    id: String,
) -> Result<PrivilegeListResult, QueryCommandError> {
    let driver = driver_of(&state, &id)
        .await
        .map_err(QueryCommandError::from_key)?;
    let kind = Driver::kind(&driver);
    let token = CancellationToken::new();
    match kind {
        DriverKind::MySql => {
            let rows = Driver::query(
                &driver,
                "SELECT User, Host FROM mysql.user ORDER BY User, Host",
                QueryOptions {
                    row_limit: 2000,
                    allow_write: false,
                },
                token,
            )
            .await
            .map_err(|e| {
                if e.i18n_key() == "error.driver.query_failed" {
                    err("error.privilege.forbidden")
                } else {
                    QueryCommandError::from(e)
                }
            })?;
            let accounts = rows
                .rows
                .into_iter()
                .map(|row| PrivilegeAccount {
                    name: row.first().cloned().flatten().unwrap_or_default(),
                    host: row.get(1).cloned().flatten(),
                    can_login: true,
                })
                .collect();
            Ok(PrivilegeListResult {
                driver: "mysql".into(),
                accounts,
                read_only: false,
            })
        }
        DriverKind::PostgreSql => {
            let rows = Driver::query(
                &driver,
                "SELECT rolname, rolcanlogin FROM pg_roles ORDER BY rolname",
                QueryOptions {
                    row_limit: 2000,
                    allow_write: false,
                },
                token,
            )
            .await
            .map_err(QueryCommandError::from)?;
            let accounts = rows
                .rows
                .into_iter()
                .map(|row| PrivilegeAccount {
                    name: row.first().cloned().flatten().unwrap_or_default(),
                    host: None,
                    can_login: row
                        .get(1)
                        .and_then(|v| v.as_deref())
                        .is_some_and(|v| v == "t" || v == "true" || v == "1"),
                })
                .collect();
            Ok(PrivilegeListResult {
                driver: "postgresql".into(),
                accounts,
                read_only: true,
            })
        }
    }
}

/// MySQL SHOW GRANTS 文本；PG 返回不支持。
#[tauri::command]
pub async fn db_show_grants(
    state: State<'_, AppState>,
    id: String,
    input: ShowGrantsInput,
) -> Result<Vec<String>, QueryCommandError> {
    let driver = driver_of(&state, &id)
        .await
        .map_err(QueryCommandError::from_key)?;
    if Driver::kind(&driver) != DriverKind::MySql {
        return Err(err("error.privilege.unsupported"));
    }
    let user = input.name.trim();
    let host = input.host.as_deref().unwrap_or("%").trim();
    if !user
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_$.-".contains(c))
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_$.%-".contains(c))
    {
        return Err(err("error.driver.invalid_identifier"));
    }
    let sql = format!("SHOW GRANTS FOR '{user}'@'{host}'");
    let rows = Driver::query(
        &driver,
        &sql,
        QueryOptions {
            row_limit: 500,
            allow_write: false,
        },
        CancellationToken::new(),
    )
    .await
    .map_err(|e| {
        if e.i18n_key() == "error.driver.query_failed" {
            err("error.privilege.forbidden")
        } else {
            QueryCommandError::from(e)
        }
    })?;
    Ok(rows
        .rows
        .into_iter()
        .filter_map(|row| row.into_iter().next().flatten())
        .collect())
}
