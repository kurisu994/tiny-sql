//! MySQL driver
//!
//! 设计：v0.1 是具体 `struct MySqlDriver`，**不抽 `trait Driver`**。v0.2 加 PostgreSQL
//! 时再用 rust-analyzer extract trait（两个实现在手才设计接口，避免抽象提前）。
//!
//! 与隧道的桥接方式：sqlx 不吃自定义 `TcpStream`，所以走"本地 listener 端口 →
//! `mysql://127.0.0.1:port` URL"。ssh-multihop 暴露本地端口，这里用 host=127.0.0.1
//! + 该端口连接即可。直连（无 SSH）时传真实 host:port。
//!
//! Week 2 范围：connect / ping / list_databases / list_tables / list_columns / query。
//! query 的子查询包装防 OOM、10w 行截断、独立 control connection KILL QUERY 取消留 Week 4。

use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow};
use sqlx::{Column, ConnectOptions, MySqlPool, Row, TypeInfo, ValueRef};

/// driver 错误 —— 每个变体对应一个稳定的前端 i18n key（NFR-041：key 只能加不能改名）
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("error.driver.connect_failed: {0}")]
    ConnectFailed(String),
    #[error("error.driver.query_failed: {0}")]
    QueryFailed(String),
}

impl DriverError {
    pub fn i18n_key(&self) -> &'static str {
        match self {
            Self::ConnectFailed(_) => "error.driver.connect_failed",
            Self::QueryFailed(_) => "error.driver.query_failed",
        }
    }
}

/// 单个 database（MySQL 里 schema 与 database 同义）
#[derive(Debug, Clone, serde::Serialize)]
pub struct DatabaseMeta {
    pub name: String,
}

/// 单张表的元信息
#[derive(Debug, Clone, serde::Serialize)]
pub struct TableMeta {
    pub name: String,
    /// "BASE TABLE" / "VIEW" 等
    pub table_type: String,
    /// information_schema 给的估算行数（视图或不可估算时为 None）
    pub rows: Option<i64>,
    pub comment: Option<String>,
}

/// 单列的元信息
#[derive(Debug, Clone, serde::Serialize)]
pub struct ColumnMeta {
    pub name: String,
    /// 完整列类型，如 "varchar(255)" / "int unsigned"
    pub data_type: String,
    pub nullable: bool,
    /// 索引标记："PRI" / "UNI" / "MUL" / ""
    pub column_key: String,
    pub default_value: Option<String>,
    pub comment: Option<String>,
}

/// 查询结果集 —— v0.1 所有单元格统一转成字符串展示，None 表示 SQL NULL
#[derive(Debug, Clone, serde::Serialize)]
pub struct RowSet {
    /// 列名（按查询顺序）
    pub columns: Vec<String>,
    /// 行数据，外层是行、内层是列；None = NULL
    pub rows: Vec<Vec<Option<String>>>,
    /// 是否因客户端硬上限被截断（Week 4 接 10w 截断，当前恒为 false）
    pub truncated: bool,
}

/// MySQL driver —— v0.1 具体实现，v0.2 extract 为 trait Driver。
///
/// 内部持有 `sqlx::MySqlPool`（max_connections = 5）。直连传真实 host:port；
/// 走隧道时 host=127.0.0.1 + 隧道本地端口。
pub struct MySqlDriver {
    pool: MySqlPool,
}

impl MySqlDriver {
    /// 建立连接池。`database` 为空字符串表示不指定默认库。
    pub async fn connect(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        database: &str,
    ) -> Result<Self, DriverError> {
        // 用 ConnectOptions 而非 URL 拼接，避免密码里的特殊字符需要 URL 编码
        let mut opts = MySqlConnectOptions::new()
            .host(host)
            .port(port)
            .username(username)
            .password(password);
        if !database.is_empty() {
            opts = opts.database(database);
        }
        opts = opts.log_statements(log::LevelFilter::Off);

        let pool = MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(opts)
            .await
            .map_err(|e| DriverError::ConnectFailed(e.to_string()))?;

        Ok(Self { pool })
    }

    /// 用完整 `mysql://` URL 建立连接池。
    ///
    /// integration 测试用 `TINY_SQL_TEST_MYSQL_URL`，未来隧道桥接也走本地端口 URL。
    pub async fn connect_url(url: &str) -> Result<Self, DriverError> {
        let pool = MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            .connect(url)
            .await
            .map_err(|e| DriverError::ConnectFailed(e.to_string()))?;
        Ok(Self { pool })
    }

    /// 跑一条 `SELECT 1`，用于连接测试。
    pub async fn ping(&self) -> Result<i64, DriverError> {
        let row: (i64,) = sqlx::query_as("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(row.0)
    }

    /// 列出所有可见 database。
    pub async fn list_databases(&self) -> Result<Vec<DatabaseMeta>, DriverError> {
        let rows = sqlx::query_as::<_, (String,)>(
            "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|(name,)| DatabaseMeta { name })
            .collect())
    }

    /// 列出指定 database 下的所有表。
    pub async fn list_tables(&self, database: &str) -> Result<Vec<TableMeta>, DriverError> {
        // table_rows 是 BIGINT UNSIGNED，CAST 成 SIGNED 避免 unsigned 解码踩坑
        let rows = sqlx::query_as::<_, (String, String, Option<i64>, Option<String>)>(
            "SELECT table_name, table_type, CAST(table_rows AS SIGNED), table_comment \
             FROM information_schema.tables \
             WHERE table_schema = ? ORDER BY table_name",
        )
        .bind(database)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(|(name, table_type, rows, comment)| TableMeta {
                name,
                table_type,
                rows,
                comment,
            })
            .collect())
    }

    /// 列出指定表的所有列。
    pub async fn list_columns(
        &self,
        database: &str,
        table: &str,
    ) -> Result<Vec<ColumnMeta>, DriverError> {
        let rows = sqlx::query_as::<_, (String, String, String, String, Option<String>, Option<String>)>(
            "SELECT column_name, column_type, is_nullable, column_key, column_default, column_comment \
             FROM information_schema.columns \
             WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(rows
            .into_iter()
            .map(
                |(name, data_type, is_nullable, column_key, default_value, comment)| ColumnMeta {
                    name,
                    data_type,
                    nullable: is_nullable.eq_ignore_ascii_case("YES"),
                    column_key,
                    default_value,
                    comment,
                },
            )
            .collect())
    }

    /// 执行任意 SQL，返回结果集（Week 2 基础版）。
    ///
    /// TODO(Week4)：拒多语句 + 子查询包装 `SELECT * FROM (<sql>) AS tiny_sql_limited LIMIT 1000`
    /// + 客户端 take(100000) 硬上限 + 独立 control connection 的 KILL QUERY 取消。
    pub async fn query(&self, sql: &str) -> Result<RowSet, DriverError> {
        let rows = sqlx::query(sql)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;

        // TODO(Week4)：空结果集时拿不到列名，改流式 fetch + describe 取表头
        let columns: Vec<String> = rows
            .first()
            .map(|row| row.columns().iter().map(|c| c.name().to_string()).collect())
            .unwrap_or_default();

        let data: Vec<Vec<Option<String>>> = rows
            .iter()
            .map(|row| {
                (0..row.columns().len())
                    .map(|i| cell_to_string(row, i))
                    .collect()
            })
            .collect();

        Ok(RowSet {
            columns,
            rows: data,
            truncated: false,
        })
    }

    /// 关闭连接池。
    pub async fn close(&self) {
        self.pool.close().await;
    }
}

/// 把动态结果集的某个单元格转成字符串；NULL 返回 None。
///
/// v0.1 表格统一按字符串展示，按列类型分派解码，覆盖常见类型，
/// 二进制可打印则按 UTF-8、否则给字节数占位，未知类型走 fallback。
fn cell_to_string(row: &MySqlRow, idx: usize) -> Option<String> {
    // NULL 检测
    if let Ok(raw) = row.try_get_raw(idx) {
        if raw.is_null() {
            return None;
        }
    }
    let type_name = row.column(idx).type_info().name().to_uppercase();
    let decoded = match type_name.as_str() {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => {
            try_decode::<i64>(row, idx).or_else(|| try_decode::<u64>(row, idx))
        }
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "BIGINT UNSIGNED" => try_decode::<u64>(row, idx),
        "FLOAT" | "DOUBLE" => try_decode::<f64>(row, idx),
        "DECIMAL" | "NEWDECIMAL" => try_decode::<bigdecimal::BigDecimal>(row, idx),
        "BOOLEAN" | "BOOL" => try_decode::<bool>(row, idx).or_else(|| try_decode::<i64>(row, idx)),
        "DATE" => try_decode::<chrono::NaiveDate>(row, idx),
        "TIME" => try_decode::<chrono::NaiveTime>(row, idx),
        "DATETIME" | "TIMESTAMP" => try_decode::<chrono::NaiveDateTime>(row, idx),
        "YEAR" => try_decode::<u16>(row, idx).or_else(|| try_decode::<i64>(row, idx)),
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET"
        | "JSON" => try_decode::<String>(row, idx),
        "BINARY" | "VARBINARY" | "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BIT" => {
            decode_bytes(row, idx)
        }
        _ => try_decode::<String>(row, idx)
            .or_else(|| try_decode::<i64>(row, idx))
            .or_else(|| try_decode::<f64>(row, idx)),
    };
    Some(decoded.unwrap_or_else(|| "<unsupported>".to_string()))
}

/// 按目标类型尝试解码并转字符串，失败返回 None。
fn try_decode<'r, T>(row: &'r MySqlRow, idx: usize) -> Option<String>
where
    T: sqlx::Decode<'r, sqlx::MySql> + sqlx::Type<sqlx::MySql> + std::string::ToString,
{
    row.try_get::<T, _>(idx).ok().map(|v| v.to_string())
}

/// 二进制列：可打印则按 UTF-8 文本，否则给字节数占位。
fn decode_bytes(row: &MySqlRow, idx: usize) -> Option<String> {
    row.try_get::<Vec<u8>, _>(idx)
        .ok()
        .map(|b| match std::str::from_utf8(&b) {
            Ok(s) => s.to_string(),
            Err(_) => format!("<{} bytes>", b.len()),
        })
}

/// 连上 MySQL 跑一条 `SELECT 1`（Week 1 vertical slice 的最小验证，沿用至连接测试）。
pub async fn ping_select_1(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
    database: &str,
) -> Result<i64, DriverError> {
    let driver = MySqlDriver::connect(host, port, username, password, database).await?;
    let result = driver.ping().await;
    driver.close().await;
    result
}
