//! SQL dump 导出 / 导入命令（FR-252，v0.4 Week 7）
//!
//! 设计要点：
//! - 导出：表级（或当前 scope 全表）DDL + 分批 INSERT，后端流式写文件，
//!   不经过前端序列化；MySQL DDL 用 `SHOW CREATE TABLE` 原文，PostgreSQL
//!   由元数据简化重建（列 / NOT NULL / 默认值 / 主键，不含索引与外键——
//!   完整结构以结构视图 DDL 预览为准，本文件面向数据迁移场景）；
//! - 数据按 `browse_table` 分页循环（每页 10000），多行 VALUES 批量 INSERT
//!   （每语句 ≤ 500 行）；字符串单引号双写转义，NULL 写无引号 NULL；
//! - 导入：大文件流式读取 + 方言分号状态机增量分句（复用 FR-243 状态机），
//!   逐条执行，禁止整文件载入内存；失败定位语句序号；
//! - dump 文件本质是写操作集合：导入一次性确认整个文件，不逐条确认。

use std::fs::File;
use std::io::{BufWriter, Read, Write};

use db_driver::{ColumnMeta, Driver, DriverError, DriverKind, MetadataScope, TableBrowseQuery};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::commands::query::{driver_of, QueryCommandError};
use crate::state::{ActiveQuery, AppState};

/// dump 导出每页拉取行数（browse_table 上限）。
const DUMP_PAGE_SIZE: usize = 10_000;
/// 单条 INSERT 语句包含的最大行数。
const DUMP_INSERT_BATCH: usize = 500;
/// dump 导入流式读取的块大小（64 KiB）。
const IMPORT_CHUNK_SIZE: usize = 64 * 1024;

/// dump 导出输入（FR-252）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDumpInput {
    pub database: String,
    pub schema: Option<String>,
    /// 指定表名；None 导出当前 scope 全部 BASE TABLE（视图不导数据）
    pub table: Option<String>,
    pub path: String,
}

/// dump 导出结果（FR-252）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDumpResult {
    /// 导出的表数量
    pub tables: usize,
    /// 导出的数据总行数
    pub rows: usize,
}

/// dump 导入结果（FR-252）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDumpResult {
    /// 成功执行的语句数
    pub executed: usize,
    /// 失败语句序号（1 起；None = 全部成功）
    pub failed_at: Option<usize>,
    /// 失败语句的截断预览（仅展示用，不含参数值）
    pub failed_preview: Option<String>,
}

/// SQL 字符串字面量转义（按方言）：单引号双方言双写；
/// 反斜杠仅 MySQL 转义（PG 默认 standard_conforming_strings=on，反斜杠是普通字符）。
fn quote_literal(kind: DriverKind, value: &str) -> String {
    match kind {
        DriverKind::MySql => format!("'{}'", value.replace('\\', "\\\\").replace('\'', "''")),
        DriverKind::PostgreSql => format!("'{}'", value.replace('\'', "''")),
    }
}

fn quote_ident(kind: DriverKind, name: &str) -> String {
    match kind {
        DriverKind::MySql => format!("`{}`", name.replace('`', "``")),
        DriverKind::PostgreSql => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

/// PostgreSQL 简化建表 DDL（列 / NOT NULL / 默认值 / 主键；不含索引与外键）。
fn build_pg_simple_ddl(
    schema: &str,
    table: &str,
    columns: &[ColumnMeta],
    pk_columns: &[String],
) -> String {
    let mut lines: Vec<String> = columns
        .iter()
        .map(|column| {
            let mut line = format!(
                "  \"{}\" {}",
                column.name.replace('"', "\"\""),
                column.data_type
            );
            if let Some(default) = &column.default_value {
                line += &format!(" DEFAULT {default}");
            }
            if !column.nullable {
                line += " NOT NULL";
            }
            line
        })
        .collect();
    if !pk_columns.is_empty() {
        let pk_list = pk_columns
            .iter()
            .map(|c| format!("\"{}\"", c.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("  PRIMARY KEY ({pk_list})"));
    }
    format!(
        "CREATE TABLE \"{}\".\"{}\" (\n{}\n);",
        schema.replace('"', "\"\""),
        table.replace('"', "\"\""),
        lines.join(",\n")
    )
}

/// 导出 SQL dump（FR-252）：DDL + 分批 INSERT 流式写文件。
#[tauri::command]
pub async fn db_export_dump(
    state: State<'_, AppState>,
    id: String,
    input: ExportDumpInput,
) -> Result<ExportDumpResult, QueryCommandError> {
    let ExportDumpInput {
        database,
        schema,
        table,
        path,
    } = input;
    let (driver, token) = {
        let lifecycle = state.connection_lifecycle(&id);
        let _lifecycle = lifecycle.lock().await;
        let driver = driver_of(&state, &id)
            .await
            .map_err(QueryCommandError::from_key)?;
        let token = CancellationToken::new();
        state.queries.lock().await.insert(
            Uuid::new_v4().to_string(),
            ActiveQuery {
                connection_id: id.clone(),
                cancel_token: token.clone(),
            },
        );
        (driver, token)
    };
    let kind = Driver::kind(&driver);
    let scope = match kind {
        DriverKind::MySql => MetadataScope::mysql(&database),
        DriverKind::PostgreSql => {
            let schema = schema
                .filter(|value| !value.trim().is_empty())
                .ok_or(DriverError::SchemaRequired)
                .map_err(QueryCommandError::from)?;
            MetadataScope::postgresql(&database, schema)
        }
    };
    let result = run_export(&driver, kind, &scope, table.as_deref(), &path, token).await;
    result
}

async fn run_export(
    driver: &crate::state::ActiveDriver,
    kind: DriverKind,
    scope: &MetadataScope,
    table: Option<&str>,
    path: &str,
    token: CancellationToken,
) -> Result<ExportDumpResult, QueryCommandError> {
    // 表清单：指定表或 scope 下全部 BASE TABLE（视图无稳定主键顺序，不导数据）
    let tables: Vec<String> = match table {
        Some(name) => vec![name.to_string()],
        None => Driver::list_tables(driver, scope)
            .await
            .map_err(QueryCommandError::from)?
            .into_iter()
            .filter(|meta| meta.table_type == "BASE TABLE")
            .map(|meta| meta.name)
            .collect(),
    };
    if tables.is_empty() {
        return Err(QueryCommandError::from_key("error.dump.no_tables"));
    }

    let file = File::create(path).map_err(|_| QueryCommandError::from_key("error.export.io"))?;
    let mut out = BufWriter::new(file);
    let write_line = |out: &mut BufWriter<File>, line: &str| -> Result<(), QueryCommandError> {
        out.write_all(line.as_bytes())
            .and_then(|_| out.write_all(b"\n"))
            .map_err(|_| QueryCommandError::from_key("error.export.io"))
    };

    write_line(&mut out, "-- tiny-sql SQL dump")?;
    write_line(
        &mut out,
        &format!("-- source: {} ({})\n", scope.database, kind.as_str()),
    )?;

    let mut total_rows = 0usize;
    for (table_index, table_name) in tables.iter().enumerate() {
        if token.is_cancelled() {
            return Err(QueryCommandError::from(DriverError::QueryCancelled));
        }
        let columns = Driver::list_columns(driver, scope, table_name)
            .await
            .map_err(QueryCommandError::from)?;
        let column_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();

        // DDL：MySQL 用 SHOW CREATE TABLE 原文；PG 元数据简化重建
        let ddl = match kind {
            DriverKind::MySql => {
                let qualified = format!(
                    "`{}`.`{}`",
                    scope.database.replace('`', "``"),
                    table_name.replace('`', "``")
                );
                let row_set = Driver::query(
                    driver,
                    &format!("SHOW CREATE TABLE {qualified}"),
                    db_driver::QueryOptions {
                        row_limit: 10,
                        allow_write: false,
                    },
                    token.clone(),
                )
                .await
                .map_err(QueryCommandError::from)?;
                row_set
                    .rows
                    .first()
                    .and_then(|row| row.get(1).cloned().flatten())
                    .ok_or_else(|| QueryCommandError::from_key("error.export.io"))?
            }
            DriverKind::PostgreSql => {
                let constraints = Driver::list_constraints(driver, scope, table_name)
                    .await
                    .map_err(QueryCommandError::from)?;
                let pk_columns = constraints
                    .iter()
                    .find(|c| c.constraint_type == "PRIMARY KEY")
                    .map(|c| c.columns.clone())
                    .unwrap_or_default();
                build_pg_simple_ddl(
                    scope.schema.as_deref().unwrap_or("public"),
                    table_name,
                    &columns,
                    &pk_columns,
                )
            }
        };

        write_line(
            &mut out,
            &format!("\n-- 表 {}：{}", table_index + 1, table_name),
        )?;
        write_line(
            &mut out,
            &format!("DROP TABLE IF EXISTS {};", quote_ident(kind, table_name)),
        )?;
        write_line(&mut out, &ddl)?;

        // 数据：分页拉取 + 多行 VALUES 批量 INSERT
        let column_list = column_names
            .iter()
            .map(|c| quote_ident(kind, c))
            .collect::<Vec<_>>()
            .join(", ");
        let mut offset = 0usize;
        loop {
            let page = Driver::browse_table(
                driver,
                scope,
                table_name,
                &TableBrowseQuery {
                    filters: vec![],
                    order: None,
                    limit: DUMP_PAGE_SIZE,
                    offset,
                },
                token.clone(),
            )
            .await
            .map_err(QueryCommandError::from)?;
            for chunk in page.row_set.rows.chunks(DUMP_INSERT_BATCH) {
                let values = chunk
                    .iter()
                    .map(|row| {
                        let cells = row
                            .iter()
                            .map(|cell| match cell {
                                None => "NULL".to_string(),
                                Some(value) => quote_literal(kind, value),
                            })
                            .collect::<Vec<_>>()
                            .join(", ");
                        format!("({cells})")
                    })
                    .collect::<Vec<_>>()
                    .join(",\n  ");
                write_line(
                    &mut out,
                    &format!(
                        "INSERT INTO {} ({}) VALUES\n  {};",
                        quote_ident(kind, table_name),
                        column_list,
                        values
                    ),
                )?;
                total_rows += chunk.len();
            }
            if !page.has_next_page {
                break;
            }
            offset += DUMP_PAGE_SIZE;
        }
    }
    out.flush()
        .map_err(|_| QueryCommandError::from_key("error.export.io"))?;
    Ok(ExportDumpResult {
        tables: tables.len(),
        rows: total_rows,
    })
}

/// dump 导入输入（FR-252）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportDumpInput {
    pub database: String,
    pub schema: Option<String>,
    pub path: String,
}

/// 导入 SQL dump（FR-252）：流式读取 + 增量分句 + 逐条执行。
/// 写确认一次性覆盖整个文件；失败后中止并返回失败语句序号与预览。
#[tauri::command]
pub async fn db_import_dump(
    state: State<'_, AppState>,
    id: String,
    input: ImportDumpInput,
) -> Result<ImportDumpResult, QueryCommandError> {
    crate::commands::query::reject_if_read_only(&state, &id)?;
    let ImportDumpInput {
        database,
        schema,
        path,
    } = input;
    let query_id = Uuid::new_v4().to_string();
    let (driver, token) = {
        let lifecycle = state.connection_lifecycle(&id);
        let _lifecycle = lifecycle.lock().await;
        let driver = driver_of(&state, &id)
            .await
            .map_err(QueryCommandError::from_key)?;
        let token = CancellationToken::new();
        state.queries.lock().await.insert(
            query_id.clone(),
            ActiveQuery {
                connection_id: id.clone(),
                cancel_token: token.clone(),
            },
        );
        (driver, token)
    };
    let result = run_import_dump(&driver, &database, schema, &path, token).await;
    state.queries.lock().await.remove(&query_id);
    result
}

async fn run_import_dump(
    driver: &crate::state::ActiveDriver,
    database: &str,
    schema: Option<String>,
    path: &str,
    token: CancellationToken,
) -> Result<ImportDumpResult, QueryCommandError> {
    // PG：dump 语句不带 schema 限定时在当前 search_path 执行；这里显式校验
    // 目标 database 是当前连接库，schema 存在性交给语句自身（SET search_path 由文件内容决定）。
    if Driver::kind(driver) == DriverKind::PostgreSql {
        let scope = MetadataScope::postgresql(
            database,
            schema.clone().unwrap_or_else(|| "public".to_string()),
        );
        // ensure_current_database 语义校验（复用 browse 路径的守卫）
        Driver::list_tables(driver, &scope)
            .await
            .map_err(QueryCommandError::from)?;
    }

    let file =
        File::open(path).map_err(|_| QueryCommandError::from_key("error.sqlfile.read_failed"))?;
    let mut reader = std::io::BufReader::new(file);
    let dialect = match Driver::kind(driver) {
        DriverKind::MySql => db_driver::SqlDialect::MySql,
        DriverKind::PostgreSql => db_driver::SqlDialect::PostgreSql,
    };
    let mut splitter = db_driver::StatementSplitter::new(dialect);
    let mut executed = 0usize;
    let mut buffer = [0u8; IMPORT_CHUNK_SIZE];

    loop {
        if token.is_cancelled() {
            return Err(QueryCommandError::from(DriverError::QueryCancelled));
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|_| QueryCommandError::from_key("error.sqlfile.read_failed"))?;
        let eof = read == 0;
        let chunk = String::from_utf8_lossy(&buffer[..read]);
        let statements = splitter
            .feed(&chunk, eof)
            .map_err(QueryCommandError::from)?;
        for sql in statements {
            executed += 1;
            let result = Driver::query(
                driver,
                &sql,
                db_driver::QueryOptions {
                    row_limit: 1,
                    allow_write: true,
                },
                token.clone(),
            )
            .await;
            if result.is_err() {
                // 失败属正常返回：语句序号 + 截断预览；原始错误不外泄（同查询错误模型）
                return Ok(ImportDumpResult {
                    executed: executed - 1,
                    failed_at: Some(executed),
                    failed_preview: Some(sql.chars().take(200).collect::<String>()),
                });
            }
        }
        if eof {
            break;
        }
    }
    Ok(ImportDumpResult {
        executed,
        failed_at: None,
        failed_preview: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_literal_escapes_quotes_and_backslash() {
        assert_eq!(quote_literal(DriverKind::MySql, "plain"), "'plain'");
        assert_eq!(quote_literal(DriverKind::MySql, "it's"), "'it''s'");
        assert_eq!(
            quote_literal(DriverKind::MySql, "含\\反斜杠"),
            "'含\\\\反斜杠'"
        );
        assert_eq!(quote_literal(DriverKind::MySql, ""), "''");
        // PG：standard_conforming_strings=on 反斜杠不转义，只双写单引号
        assert_eq!(
            quote_literal(DriverKind::PostgreSql, "含\\反斜杠"),
            "'含\\反斜杠'"
        );
        assert_eq!(quote_literal(DriverKind::PostgreSql, "it's"), "'it''s'");
    }

    #[test]
    fn pg_simple_ddl_rebuilds_columns_and_pk() {
        let columns = vec![
            ColumnMeta {
                name: "id".to_string(),
                data_type: "integer".to_string(),
                nullable: false,
                column_key: "PRI".to_string(),
                default_value: Some("nextval('t_id_seq'::regclass)".to_string()),
                comment: None,
            },
            ColumnMeta {
                name: "name".to_string(),
                data_type: "text".to_string(),
                nullable: true,
                column_key: "".to_string(),
                default_value: None,
                comment: None,
            },
        ];
        let ddl = build_pg_simple_ddl("public", "t", &columns, &["id".to_string()]);
        assert!(ddl.contains("CREATE TABLE \"public\".\"t\""));
        assert!(ddl.contains("\"id\" integer DEFAULT nextval('t_id_seq'::regclass) NOT NULL"));
        assert!(ddl.contains("\"name\" text"));
        assert!(ddl.contains("PRIMARY KEY (\"id\")"));
    }

    #[test]
    fn quote_ident_escapes_by_dialect() {
        assert_eq!(quote_ident(DriverKind::MySql, "a`b"), "`a``b`");
        assert_eq!(quote_ident(DriverKind::PostgreSql, "a\"b"), "\"a\"\"b\"");
    }
}
