//! CSV 导入命令（FR-252，v0.4 Week 6）
//!
//! 设计要点：
//! - 复用「dialog 选路径 + 后端读写」模式，不引入 `tauri-plugin-fs`；
//! - CSV 解析手写 RFC 4180 状态机（引号转义、内嵌换行、CRLF、UTF-8 BOM），
//!   逐行产出并携带数据行号（1 起，不含表头），供跳过模式精确定位失败行；
//! - 空值语义与导出（FR-107）闭环：无引号 `NULL` → SQL NULL，`""` → 空串，
//!   空字段 → 空串；
//! - 分批（每批 ≤ 1000 行）调 driver `bulk_insert_rows`：中止模式批内单事务
//!   回滚即停止；跳过模式逐行 autocommit，失败行收集行号继续；
//! - 值不做类型推断，统一文本由数据库隐式转换（V4-R04）。

use std::fs::File;
use std::io::{BufReader, Read};

use db_driver::{BulkInsertResult, Driver, DriverError, DriverKind, MetadataScope};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::commands::query::{driver_of, QueryCommandError};
use crate::state::{ActiveQuery, AppState};

/// CSV 导入每批行数上限。
const IMPORT_BATCH_SIZE: usize = 1_000;

/// CSV 预览返回（FR-252）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    /// 首行（有表头时为列名，否则为第一行数据）
    pub headers: Vec<String>,
    /// 预览数据行（最多 `max_rows` 行；None = SQL NULL）
    pub rows: Vec<Vec<Option<String>>>,
    /// 数据行总数（不含表头行）
    pub total_rows: usize,
}

/// CSV 导入输入（FR-252）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportInput {
    pub database: String,
    pub schema: Option<String>,
    pub table: String,
    pub path: String,
    /// CSV 列 → 表列名映射（下标即 CSV 列序；None = 跳过该列）
    pub mapping: Vec<Option<String>>,
    /// 首行是表头（导入时跳过）
    pub has_header: bool,
    /// 错误策略：true = 跳过失败行收集报告；false = 任一行失败整体停止
    pub skip_errors: bool,
}

/// CSV 导入结果（FR-252）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvImportResult {
    pub inserted: usize,
    /// 失败数据行号（1 起，不含表头）
    pub failed_rows: Vec<usize>,
}

/// RFC 4180 CSV 逐行解析器：引号转义（`""`）、内嵌换行、CRLF/LF、UTF-8 BOM。
///
/// 空值语义：无引号 `NULL` → None；`""` → Some("")；空字段 → Some("")。
struct CsvReader<R: Read> {
    reader: R,
    /// 推回缓冲（BOM 检测与单字节 peek 共用）
    peeked: std::collections::VecDeque<u8>,
    /// 当前数据行号（1 起；不含表头的逻辑由调用方控制）
    line: usize,
    /// BOM 已处理
    bom_done: bool,
}

impl<R: Read> CsvReader<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            peeked: std::collections::VecDeque::new(),
            line: 0,
            bom_done: false,
        }
    }

    fn read_byte(&mut self) -> std::io::Result<Option<u8>> {
        if let Some(b) = self.peeked.pop_front() {
            return Ok(Some(b));
        }
        let mut buf = [0u8; 1];
        match self.reader.read(&mut buf)? {
            0 => Ok(None),
            _ => Ok(Some(buf[0])),
        }
    }

    fn peek_byte(&mut self) -> std::io::Result<Option<u8>> {
        if self.peeked.is_empty() {
            if let Some(b) = self.read_byte()? {
                self.peeked.push_back(b);
            }
        }
        Ok(self.peeked.front().copied())
    }

    /// 读取下一条记录（一行数据）；EOF 返回 None。
    /// 字段内嵌换行不结束记录；记录以未引用换行或 EOF 结束。
    fn next_record(&mut self) -> Result<Option<Vec<Option<String>>>, String> {
        // 首条记录前剥离 UTF-8 BOM；非 BOM 字节推回流里正常参与解析
        if !self.bom_done {
            self.bom_done = true;
            let mut bom = [0u8; 3];
            let mut filled = 0usize;
            while filled < 3 {
                match self.read_byte().map_err(|e| e.to_string())? {
                    Some(b) => {
                        bom[filled] = b;
                        filled += 1;
                    }
                    None => break,
                }
            }
            if !(filled == 3 && bom == [0xEF, 0xBB, 0xBF]) {
                for &b in bom[..filled].iter().rev() {
                    self.peeked.push_front(b);
                }
            }
        }
        match self.peek_byte().map_err(|e| e.to_string())? {
            None => Ok(None),
            Some(_) => self.parse_record(),
        }
    }

    fn parse_record(&mut self) -> Result<Option<Vec<Option<String>>>, String> {
        let mut fields: Vec<Option<String>> = Vec::new();
        let mut field: Vec<u8> = Vec::new();
        let mut in_quotes = false;
        let mut quoted_field = false;
        let mut field_started = false;
        loop {
            let byte = self.read_byte().map_err(|e| e.to_string())?;
            match byte {
                None => {
                    if !field_started && fields.is_empty() {
                        return Ok(None);
                    }
                    self.line += 1;
                    fields.push(finish_field(field, quoted_field));
                    return Ok(Some(fields));
                }
                Some(b'"') if in_quotes => {
                    if self.peek_byte().map_err(|e| e.to_string())? == Some(b'"') {
                        // 双写引号转义
                        self.read_byte().map_err(|e| e.to_string())?;
                        field.push(b'"');
                    } else {
                        in_quotes = false;
                    }
                }
                Some(b'"') if !field_started => {
                    in_quotes = true;
                    quoted_field = true;
                    field_started = true;
                }
                Some(b'"') => {
                    // 非引号字段中的引号：原样保留（宽松解析）
                    field.push(b'"');
                    field_started = true;
                }
                Some(b',') if !in_quotes => {
                    fields.push(finish_field(std::mem::take(&mut field), quoted_field));
                    quoted_field = false;
                    field_started = false;
                }
                Some(b'\n') if !in_quotes => {
                    self.line += 1;
                    fields.push(finish_field(std::mem::take(&mut field), quoted_field));
                    return Ok(Some(fields));
                }
                Some(b'\r') if !in_quotes => {
                    // CRLF：吞掉可能的 \n 后结束记录
                    if self.peek_byte().map_err(|e| e.to_string())? == Some(b'\n') {
                        self.read_byte().map_err(|e| e.to_string())?;
                    }
                    self.line += 1;
                    fields.push(finish_field(std::mem::take(&mut field), quoted_field));
                    return Ok(Some(fields));
                }
                Some(b) => {
                    field.push(b);
                    field_started = true;
                }
            }
        }
    }
}

/// 字段收尾：引号包裹的 `NULL` 是文本；无引号 `NULL` 才是 SQL NULL。
fn finish_field(field: Vec<u8>, quoted: bool) -> Option<String> {
    let text = String::from_utf8_lossy(&field).into_owned();
    if !quoted && text == "NULL" {
        None
    } else {
        Some(text)
    }
}

/// 读取 CSV 预览（FR-252）：表头 + 前 `max_rows` 数据行 + 数据行总数。
#[tauri::command]
pub async fn csv_import_preview(
    path: String,
    has_header: bool,
    max_rows: Option<usize>,
) -> Result<CsvPreview, String> {
    let file = File::open(&path).map_err(|_| "error.sqlfile.read_failed".to_string())?;
    let mut reader = CsvReader::new(BufReader::new(file));
    let limit = max_rows.unwrap_or(100).clamp(1, 1000);

    let first = reader
        .next_record()
        .map_err(|_| "error.sqlfile.read_failed".to_string())?
        .ok_or_else(|| "error.sqlfile.read_failed".to_string())?;
    let headers: Vec<String> = first
        .iter()
        .map(|value| value.clone().unwrap_or_default())
        .collect();

    let mut rows: Vec<Vec<Option<String>>> = Vec::new();
    let mut total_rows = 0usize;
    // 首行不是表头时它本身就是第一行数据
    if !has_header {
        total_rows += 1;
        if limit > 0 {
            rows.push(first.clone());
        }
    }
    while let Some(record) = reader
        .next_record()
        .map_err(|_| "error.sqlfile.read_failed".to_string())?
    {
        total_rows += 1;
        if rows.len() < limit {
            rows.push(record);
        }
    }
    Ok(CsvPreview {
        headers,
        rows,
        total_rows,
    })
}

/// 执行 CSV 导入（FR-252）：流式读取 + 分批参数化 INSERT。
#[tauri::command]
pub async fn db_import_csv(
    state: State<'_, AppState>,
    id: String,
    input: CsvImportInput,
) -> Result<CsvImportResult, QueryCommandError> {
    let CsvImportInput {
        database,
        schema,
        table,
        path,
        mapping,
        has_header,
        skip_errors,
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
    let result = run_import(
        &driver,
        &database,
        schema,
        &table,
        &path,
        &mapping,
        has_header,
        skip_errors,
        token,
    )
    .await;
    state.queries.lock().await.remove(&query_id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_import(
    driver: &crate::state::ActiveDriver,
    database: &str,
    schema: Option<String>,
    table: &str,
    path: &str,
    mapping: &[Option<String>],
    has_header: bool,
    skip_errors: bool,
    token: CancellationToken,
) -> Result<CsvImportResult, QueryCommandError> {
    // 目标列：mapping 中非 None 的表列名
    let target_columns: Vec<String> = mapping.iter().flatten().cloned().collect();
    if target_columns.is_empty() {
        return Err(QueryCommandError::from_key(
            "error.driver.invalid_identifier",
        ));
    }
    let scope = match Driver::kind(driver) {
        DriverKind::MySql => MetadataScope::mysql(database),
        DriverKind::PostgreSql => {
            let schema = schema
                .filter(|value| !value.trim().is_empty())
                .ok_or(DriverError::SchemaRequired)
                .map_err(QueryCommandError::from)?;
            MetadataScope::postgresql(database, schema)
        }
    };

    let file =
        File::open(path).map_err(|_| QueryCommandError::from_key("error.sqlfile.read_failed"))?;
    let mut reader = CsvReader::new(BufReader::new(file));
    if has_header {
        // 跳过表头行
        let _ = reader
            .next_record()
            .map_err(|_| QueryCommandError::from_key("error.sqlfile.read_failed"))?;
    }

    let mut inserted = 0usize;
    let mut failed_rows: Vec<usize> = Vec::new();
    let mut batch: Vec<Vec<Option<String>>> = Vec::with_capacity(IMPORT_BATCH_SIZE);
    let mut batch_start_line = 0usize;

    while let Some(record) = reader
        .next_record()
        .map_err(|_| QueryCommandError::from_key("error.sqlfile.read_failed"))?
    {
        if batch.is_empty() {
            batch_start_line = reader.line;
        }
        // 按映射抽取目标列值：mapping[i] = Some(表列名) 的 CSV 列 i 才导入（越界补 None → NULL）
        let row: Vec<Option<String>> = mapping
            .iter()
            .enumerate()
            .filter(|(_, target)| target.is_some())
            .map(|(csv_index, _)| record.get(csv_index).cloned().flatten())
            .collect();
        batch.push(row);
        if batch.len() >= IMPORT_BATCH_SIZE {
            flush_batch(
                driver,
                &scope,
                table,
                &target_columns,
                &mut batch,
                batch_start_line,
                skip_errors,
                &token,
                &mut inserted,
                &mut failed_rows,
            )
            .await?;
        }
    }
    if !batch.is_empty() {
        flush_batch(
            driver,
            &scope,
            table,
            &target_columns,
            &mut batch,
            batch_start_line,
            skip_errors,
            &token,
            &mut inserted,
            &mut failed_rows,
        )
        .await?;
    }
    Ok(CsvImportResult {
        inserted,
        failed_rows,
    })
}

#[allow(clippy::too_many_arguments)]
async fn flush_batch(
    driver: &crate::state::ActiveDriver,
    scope: &MetadataScope,
    table: &str,
    columns: &[String],
    batch: &mut Vec<Vec<Option<String>>>,
    batch_start_line: usize,
    skip_errors: bool,
    token: &CancellationToken,
    inserted: &mut usize,
    failed_rows: &mut Vec<usize>,
) -> Result<(), QueryCommandError> {
    let result: BulkInsertResult = Driver::bulk_insert_rows(
        driver,
        scope,
        table,
        columns,
        batch,
        !skip_errors,
        token.clone(),
    )
    .await
    .map_err(QueryCommandError::from)?;
    *inserted += result.inserted;
    // 批内下标 → 全局数据行号
    failed_rows.extend(result.failed_rows.iter().map(|i| batch_start_line + i));
    batch.clear();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn parse_all(input: &str) -> Vec<Vec<Option<String>>> {
        let mut reader = CsvReader::new(Cursor::new(input.as_bytes().to_vec()));
        let mut records = Vec::new();
        while let Some(record) = reader.next_record().expect("解析失败") {
            records.push(record);
        }
        records
    }

    #[test]
    fn csv_parses_basic_rows_and_crlf() {
        let records = parse_all("id,name\r\n1,alpha\r\n2,beta\r\n");
        assert_eq!(records.len(), 3);
        assert_eq!(records[0], vec![Some("id".into()), Some("name".into())]);
        assert_eq!(records[2], vec![Some("2".into()), Some("beta".into())]);
    }

    #[test]
    fn csv_parses_quoted_fields_with_escapes_and_embedded_newlines() {
        let records = parse_all("id,note\n1,\"含,逗号\"\n2,\"两行\n数据\"\n3,\"引号\"\"转义\"");
        assert_eq!(records.len(), 4);
        assert_eq!(records[1][1].as_deref(), Some("含,逗号"));
        assert_eq!(records[2][1].as_deref(), Some("两行\n数据"));
        assert_eq!(records[3][1].as_deref(), Some("引号\"转义"));
    }

    #[test]
    fn csv_null_semantics_match_export() {
        // 无引号 NULL → None；"" 与空字段 → 空串；引号 "NULL" → 文本
        let records = parse_all("a,b,c,d\nNULL,\"\",,\"NULL\"");
        assert_eq!(records.len(), 2);
        assert_eq!(records[1][0], None);
        assert_eq!(records[1][1].as_deref(), Some(""));
        assert_eq!(records[1][2].as_deref(), Some(""));
        assert_eq!(records[1][3].as_deref(), Some("NULL"));
    }

    #[test]
    fn csv_strips_utf8_bom() {
        let records = parse_all("\u{FEFF}id,name\n1,a");
        assert_eq!(records[0], vec![Some("id".into()), Some("name".into())]);
    }

    #[test]
    fn csv_handles_lf_only_and_trailing_without_newline() {
        let records = parse_all("a,b\n1,2");
        assert_eq!(records.len(), 2);
        assert_eq!(records[1], vec![Some("1".into()), Some("2".into())]);
    }

    #[test]
    fn csv_tracks_line_numbers() {
        let mut reader = CsvReader::new(Cursor::new(
            "h\nx\n两行\n内嵌\n".replace("x", "\"两\n行\"").into_bytes(),
        ));
        let _ = reader.next_record(); // 表头
        let record = reader.next_record().expect("解析失败").expect("应有记录");
        assert_eq!(record[0].as_deref(), Some("两\n行"));
        assert_eq!(reader.line, 2, "内嵌换行只计一个数据行");
    }
}
