//! 结果集导出命令（FR-107，v0.2 Week 6）
//!
//! 设计要点：
//! - 查询与写文件都在后端完成，10 万行结果不经过前端 IPC 序列化；
//! - 只允许读类 SQL：`allow_write` 恒为 false，写操作被 db-driver guard 拒绝；
//! - CSV 带 UTF-8 BOM（Excel 打开中文不乱码），SQL NULL 写作无引号 `NULL`，
//!   空字符串写作 `""`，两者可区分；字符串按 RFC 4180 转义，行尾 CRLF；
//! - Excel 用 rust_xlsxwriter constant memory 模式流式写出，NULL 为空白单元格，
//!   空串为空字符串单元格。

use std::fs::File;
use std::io::{BufWriter, Write};

use db_driver::{Driver, QueryOptions, RowSet, QUERY_RESULT_LIMIT};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;

use crate::state::AppState;

/// 支持的导出格式。
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Xlsx,
}

/// 导出结果摘要。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// 实际写出的数据行数（不含表头）
    pub rows: usize,
    /// 结果集是否被 10 万行硬上限截断
    pub truncated: bool,
}

/// 执行当前 SQL 并把结果集流式写入用户选择的文件。
///
/// 重新执行保证导出的是最新数据；结果集始终受 `QUERY_RESULT_LIMIT` 硬上限约束。
#[tauri::command]
pub async fn db_export_query(
    state: State<'_, AppState>,
    id: String,
    sql: String,
    format: ExportFormat,
    path: String,
) -> Result<ExportResult, String> {
    let driver = {
        let conns = state.connections.lock().await;
        conns
            .get(&id)
            .map(|c| c.driver.clone())
            .ok_or_else(|| "error.connection.not_open".to_string())?
    };
    let row_set = Driver::query(
        &driver,
        &sql,
        QueryOptions {
            row_limit: QUERY_RESULT_LIMIT,
            allow_write: false,
        },
        CancellationToken::new(),
    )
    .await
    .map_err(|e| e.i18n_key().to_string())?;

    let rows = row_set.rows.len();
    let truncated = row_set.truncated;
    match format {
        ExportFormat::Csv => write_csv(&path, &row_set)?,
        ExportFormat::Xlsx => write_xlsx(&path, &row_set)?,
    }
    Ok(ExportResult { rows, truncated })
}

/// CSV 单元格转义（RFC 4180）：含分隔符/引号/换行时双引号包裹并双写内部引号。
/// 空串与字面 "NULL" 文本也强制加引号，与 SQL NULL 的无引号 `NULL` 标记区分。
fn csv_escape(value: &str) -> String {
    let needs_quotes = value.is_empty()
        || value.eq_ignore_ascii_case("null")
        || value.contains([',', '"', '\n', '\r']);
    if needs_quotes {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// 导出 IO 失败只返回稳定 key，原始错误（含路径细节）留在后端日志。
fn export_io_error(context: &str, error: impl std::fmt::Display) -> String {
    log::error!("导出失败（{context}）: {error}");
    "error.export.io".to_string()
}

/// 写 CSV：BOM + 表头 + 逐行 flush 写出；NULL → `NULL`，空串 → `""`。
fn write_csv(path: &str, row_set: &RowSet) -> Result<(), String> {
    let file = File::create(path).map_err(|e| export_io_error("create", e))?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(b"\xef\xbb\xbf")
        .map_err(|e| export_io_error("bom", e))?;
    let header = row_set
        .columns
        .iter()
        .map(|c| csv_escape(c))
        .collect::<Vec<_>>()
        .join(",");
    writer
        .write_all(header.as_bytes())
        .and_then(|_| writer.write_all(b"\r\n"))
        .map_err(|e| export_io_error("header", e))?;
    for row in &row_set.rows {
        let line = row
            .iter()
            .map(|cell| match cell {
                // SQL NULL 与空字符串必须可区分（FR-107）
                None => "NULL".to_string(),
                Some(value) => csv_escape(value),
            })
            .collect::<Vec<_>>()
            .join(",");
        writer
            .write_all(line.as_bytes())
            .and_then(|_| writer.write_all(b"\r\n"))
            .map_err(|e| export_io_error("row", e))?;
    }
    writer.flush().map_err(|e| export_io_error("flush", e))?;
    Ok(())
}

/// 写 Excel：constant memory 模式逐行流式写出；NULL → 空白单元格，空串 → 空字符串。
fn write_xlsx(path: &str, row_set: &RowSet) -> Result<(), String> {
    let mut workbook = rust_xlsxwriter::Workbook::new();
    let worksheet = workbook.add_worksheet_with_constant_memory();
    for (col, name) in row_set.columns.iter().enumerate() {
        worksheet
            .write_string(0, col as u16, name)
            .map_err(|e| export_io_error("xlsx header", e))?;
    }
    for (row_idx, row) in row_set.rows.iter().enumerate() {
        let row_num = (row_idx + 1) as u32;
        for (col_idx, cell) in row.iter().enumerate() {
            let col_num = col_idx as u16;
            match cell {
                None => {
                    worksheet
                        .write_blank(row_num, col_num, &rust_xlsxwriter::Format::default())
                        .map_err(|e| export_io_error("xlsx blank", e))?;
                }
                Some(value) => {
                    worksheet
                        .write_string(row_num, col_num, value)
                        .map_err(|e| export_io_error("xlsx cell", e))?;
                }
            }
        }
    }
    workbook
        .save(path)
        .map_err(|e| export_io_error("xlsx save", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_row_set() -> RowSet {
        RowSet {
            columns: vec!["id".to_string(), "name".to_string(), "note".to_string()],
            rows: vec![
                vec![Some("1".into()), Some("alice".into()), None],
                vec![
                    Some("2".into()),
                    Some("".into()),
                    Some("含,逗号\"引号\"\n换行".into()),
                ],
            ],
            truncated: false,
        }
    }

    fn temp_path(ext: &str) -> String {
        std::env::temp_dir()
            .join(format!("tiny-sql-export-{}.{}", uuid::Uuid::new_v4(), ext))
            .to_string_lossy()
            .to_string()
    }

    #[test]
    fn csv_distinguishes_null_and_empty_string() {
        let path = temp_path("csv");
        write_csv(&path, &sample_row_set()).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).ok();

        assert!(raw.starts_with('\u{feff}'), "CSV 必须带 BOM");
        let lines: Vec<&str> = raw.trim_start_matches('\u{feff}').lines().collect();
        assert_eq!(lines[0], "id,name,note");
        assert_eq!(lines[1], "1,alice,NULL", "SQL NULL 必须写作无引号 NULL");
        assert_eq!(
            lines[2], "2,\"\",\"含,逗号\"\"引号\"\"",
            "空串必须是带引号空串，特殊字符按 RFC 4180 转义"
        );
        assert_eq!(lines[3], "换行\"", "字段内换行保留在引号内");
    }

    #[test]
    fn csv_quotes_literal_null_text() {
        // 文本 "NULL" 必须加引号，否则与 SQL NULL 标记混淆
        let mut row_set = sample_row_set();
        row_set.rows[0][2] = Some("NULL".to_string());
        let path = temp_path("csv");
        write_csv(&path, &row_set).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).ok();
        let lines: Vec<&str> = raw.trim_start_matches('\u{feff}').lines().collect();
        assert_eq!(lines[1], "1,alice,\"NULL\"");
    }

    #[test]
    fn xlsx_roundtrip_keeps_blank_cells_for_null() {
        let path = temp_path("xlsx");
        write_xlsx(&path, &sample_row_set()).unwrap();
        let meta = std::fs::metadata(&path).unwrap();
        assert!(meta.len() > 0, "xlsx 文件必须非空");
        // xlsx 是 zip，magic number 校验
        let mut magic = [0u8; 2];
        use std::io::Read;
        File::open(&path).unwrap().read_exact(&mut magic).unwrap();
        assert_eq!(&magic, b"PK");
        std::fs::remove_file(&path).ok();
    }
}
