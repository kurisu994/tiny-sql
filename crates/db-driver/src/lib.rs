//! MySQL / PostgreSQL database drivers
//!
//! v0.2 已从现有 MySQL 调用面提取对象安全的最小 [`Driver`] 契约；连接创建仍由
//! 具体 driver 负责，避免把方言专属配置和后续对象编辑能力塞进通用接口。
//!
//! 与隧道的桥接方式：sqlx 不吃自定义 `TcpStream`，所以走"本地 listener 端口 →
//! `mysql://127.0.0.1:port` URL"。ssh-multihop 暴露本地端口，这里用 host=127.0.0.1
//! + 该端口连接即可。直连（无 SSH）时传真实 host:port。
//!
//! Week 2 范围：connect / ping / list_databases / list_tables / list_columns / query。
//! query 的防 OOM 由「顶层安全时追加 LIMIT + 客户端 10w 行截断」组成；
//! 取消走独立 control pool：MySQL 发 `KILL QUERY`，PostgreSQL 调
//! `pg_cancel_backend`。

use std::future::Future;
use std::pin::Pin;
use std::str::FromStr;
use std::time::Duration;

use futures_util::TryStreamExt;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::{Column, ConnectOptions, Executor, MySqlPool, Row, TypeInfo, ValueRef};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;

mod postgres;
mod session;

pub use postgres::{PostgresConnectSettings, PostgresDriver};
pub use session::DriverSession;

/// 表浏览默认服务端行数上限（FR-021）。
pub const TABLE_PREVIEW_LIMIT: usize = 1_000;

/// SQL 编辑器客户端硬上限（FR-022）。
pub const QUERY_RESULT_LIMIT: usize = 100_000;

const CONTROL_QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// 连接使用的数据库 Driver 类型。
///
/// 序列化值是稳定的持久化/IPC 契约；旧连接记录缺少该字段时默认 MySQL。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DriverKind {
    #[default]
    MySql,
    PostgreSql,
}

impl DriverKind {
    /// 与 serde 持久化值一致的稳定字符串（"mysql" / "postgresql"）。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MySql => "mysql",
            Self::PostgreSql => "postgresql",
        }
    }
}

/// driver 错误 —— 每个变体对应一个稳定的前端 i18n key（NFR-041：key 只能加不能改名）
#[derive(Debug, thiserror::Error)]
pub enum DriverError {
    #[error("error.driver.connect_failed")]
    ConnectFailed(String),
    #[error("error.driver.query_failed")]
    QueryFailed(String),
    #[error("error.driver.invalid_sql")]
    InvalidSql,
    #[error("error.driver.multiple_statements")]
    MultipleStatements,
    #[error("error.driver.write_requires_confirmation")]
    WriteRequiresConfirmation,
    #[error("error.driver.query_cancelled")]
    QueryCancelled,
    #[error("error.driver.invalid_identifier")]
    InvalidIdentifier,
    #[error("error.driver.database_switch_required")]
    DatabaseSwitchRequired,
    #[error("error.driver.schema_required")]
    SchemaRequired,
    #[error("error.driver.tls_handshake_failed")]
    TlsHandshakeFailed(String),
    #[error("error.driver.tls_verify_failed")]
    TlsVerifyFailed(String),
    #[error("error.driver.tx_requires_session")]
    TxRequiresSession,
    #[error("error.driver.session_not_in_transaction")]
    SessionNotInTransaction,
    #[error("error.driver.session_broken")]
    SessionBroken,
    /// 表无主键或传入的主键列与实际主键不一致（FR-250），拒绝进入编辑执行。
    #[error("error.driver.no_primary_key")]
    NoPrimaryKey,
    /// 编辑批第 `index` 条执行失败，整个事务已回滚；detail 只留后端，不跨 IPC。
    #[error("error.driver.edit_apply_failed")]
    EditApplyFailed { index: usize, detail: String },
    /// 编辑批第 `index` 条 UPDATE/DELETE 影响行数不为 1（他端并发改动），已整体回滚。
    #[error("error.driver.edit_conflict")]
    EditConflict { index: usize },
}

impl DriverError {
    /// 返回可安全暴露给前端的 SQL 行号；原始数据库错误文本始终留在后端。
    pub fn sql_line(&self) -> Option<u32> {
        match self {
            Self::QueryFailed(detail) => extract_sql_error_line(detail),
            _ => None,
        }
    }

    pub fn i18n_key(&self) -> &'static str {
        match self {
            Self::ConnectFailed(_) => "error.driver.connect_failed",
            Self::QueryFailed(_) => "error.driver.query_failed",
            Self::InvalidSql => "error.driver.invalid_sql",
            Self::MultipleStatements => "error.driver.multiple_statements",
            Self::WriteRequiresConfirmation => "error.driver.write_requires_confirmation",
            Self::QueryCancelled => "error.driver.query_cancelled",
            Self::InvalidIdentifier => "error.driver.invalid_identifier",
            Self::DatabaseSwitchRequired => "error.driver.database_switch_required",
            Self::SchemaRequired => "error.driver.schema_required",
            Self::TlsHandshakeFailed(_) => "error.driver.tls_handshake_failed",
            Self::TlsVerifyFailed(_) => "error.driver.tls_verify_failed",
            Self::TxRequiresSession => "error.driver.tx_requires_session",
            Self::SessionNotInTransaction => "error.driver.session_not_in_transaction",
            Self::SessionBroken => "error.driver.session_broken",
            Self::NoPrimaryKey => "error.driver.no_primary_key",
            Self::EditApplyFailed { .. } => "error.driver.edit_apply_failed",
            Self::EditConflict { .. } => "error.driver.edit_conflict",
        }
    }

    /// 编辑批失败 / 冲突时的语句序号（FR-250）；可安全暴露给前端定位 dirty 行。
    pub fn edit_index(&self) -> Option<usize> {
        match self {
            Self::EditApplyFailed { index, .. } | Self::EditConflict { index } => Some(*index),
            _ => None,
        }
    }
}

/// MySQL 连接失败按 SSL 模式细分出 TLS 专项 key（FR-103）：仅在用户显式启用
/// TLS 时分类，避免把普通网络/认证错误误报为 TLS 问题。原始错误文本只留在
/// 后端结构化字段，不随 i18n key 跨 IPC。
fn classify_mysql_connect_error(detail: String, ssl_mode: MySqlTlsMode) -> DriverError {
    if matches!(ssl_mode, MySqlTlsMode::Disabled) {
        return DriverError::ConnectFailed(detail);
    }
    let lower = detail.to_ascii_lowercase();
    // 证书/主机名验证失败：rustls 与 native-tls 的常见文案
    const VERIFY_MARKERS: &[&str] = &[
        "certificate verify failed",
        "invalid peer certificate",
        "unknown ca",
        "certificate has expired",
        "certificate is not yet valid",
        "not valid for",
        "hostname mismatch",
        "cert expired",
        "self signed certificate",
        "self-signed certificate",
    ];
    if VERIFY_MARKERS.iter().any(|m| lower.contains(m)) {
        return DriverError::TlsVerifyFailed(detail);
    }
    // 握手/协议层失败：服务端未启用 SSL、TLS 版本不兼容等
    const HANDSHAKE_MARKERS: &[&str] = &["tls", "ssl", "handshake"];
    if HANDSHAKE_MARKERS.iter().any(|m| lower.contains(m)) {
        return DriverError::TlsHandshakeFailed(detail);
    }
    DriverError::ConnectFailed(detail)
}

/// 把 `connect_pool` 返回的连接错误按当前 SSL 模式重新分类为 TLS 专项 key。
fn reclassify_tls(error: DriverError, ssl_mode: MySqlTlsMode) -> DriverError {
    match error {
        DriverError::ConnectFailed(detail) => classify_mysql_connect_error(detail, ssl_mode),
        other => other,
    }
}

fn extract_sql_error_line(detail: &str) -> Option<u32> {
    let lowercase = detail.to_ascii_lowercase();
    [" at line ", " line "].into_iter().find_map(|marker| {
        let start = lowercase.rfind(marker)? + marker.len();
        let digits: String = lowercase[start..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        digits.parse::<u32>().ok().filter(|line| *line > 0)
    })
}

/// SQL 执行选项。
#[derive(Debug, Clone, Copy)]
pub struct QueryOptions {
    /// 最多返回多少行；后端会强制 clamp 到 `1..=QUERY_RESULT_LIMIT`。
    pub row_limit: usize,
    /// 非 SELECT/CTE 语句是否已由前端完成二次确认。
    pub allow_write: bool,
}

impl Default for QueryOptions {
    fn default() -> Self {
        Self {
            row_limit: QUERY_RESULT_LIMIT,
            allow_write: false,
        }
    }
}

impl QueryOptions {
    pub fn table_preview() -> Self {
        Self {
            row_limit: TABLE_PREVIEW_LIMIT,
            allow_write: false,
        }
    }

    fn effective_limit(self) -> usize {
        self.row_limit.clamp(1, QUERY_RESULT_LIMIT)
    }
}

/// 单个 database。PostgreSQL 只能直接浏览当前连接所在 database。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseMeta {
    pub name: String,
    /// 是否为当前连接所在 database。
    pub is_current: bool,
}

/// 单个 schema。MySQL 中 schema 与 database 同义，PostgreSQL 中是独立层级。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaMeta {
    pub name: String,
    /// 是否为当前连接的默认 schema。
    pub is_default: bool,
}

/// metadata 查询作用域，显式区分 database 与可选 schema。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataScope {
    pub database: String,
    pub schema: Option<String>,
}

impl MetadataScope {
    /// 构造 MySQL metadata 作用域；schema 与 database 同义，不重复保存。
    pub fn mysql(database: impl Into<String>) -> Self {
        Self {
            database: database.into(),
            schema: None,
        }
    }

    /// 构造 PostgreSQL metadata 作用域。
    pub fn postgresql(database: impl Into<String>, schema: impl Into<String>) -> Self {
        Self {
            database: database.into(),
            schema: Some(schema.into()),
        }
    }
}

/// 单张表的元信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct RowSet {
    /// 列名（按查询顺序）
    pub columns: Vec<String>,
    /// 行数据，外层是行、内层是列；None = NULL
    pub rows: Vec<Vec<Option<String>>>,
    /// 是否因客户端硬上限被截断
    pub truncated: bool,
}

/// Driver 异步操作返回值。
///
/// 使用装箱 Future 保持 [`Driver`] 对象安全，Week 3 可直接放入多 driver 容器，
/// 无需依赖额外的 async-trait 宏。
pub type DriverFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, DriverError>> + Send + 'a>>;

/// Driver 关闭操作返回值。关闭是幂等清理，不向 UI 暴露二次错误。
pub type DriverCloseFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// 浏览查询每页行数上限（FR-242）：超出 clamp，防超大页拖垮隧道。
pub const TABLE_BROWSE_MAX_LIMIT: usize = 10_000;

/// 筛选操作符（FR-242）。枚举值即 SQL 语义，不允许拼接受用户文本。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FilterOp {
    Eq,
    NotEq,
    Gt,
    GtEq,
    Lt,
    LtEq,
    Like,
    NotLike,
    IsNull,
    IsNotNull,
}

/// 单条筛选条件：列名由应用层按已加载 metadata 白名单校验后传入（driver 只做
/// 标识符引用转义），值全部参数化绑定，绝不拼接进 SQL 文本。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFilter {
    pub column: String,
    pub op: FilterOp,
    /// 统一按文本传输；IsNull / IsNotNull 时忽略。
    pub value: String,
}

/// 单列排序（FR-242）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableOrder {
    pub column: String,
    pub descending: bool,
}

/// 表数据浏览查询（FR-242）：服务端 WHERE / ORDER BY / LIMIT / OFFSET。
#[derive(Debug, Clone)]
pub struct TableBrowseQuery {
    pub filters: Vec<TableFilter>,
    pub order: Option<TableOrder>,
    pub limit: usize,
    pub offset: usize,
}

impl TableBrowseQuery {
    fn effective_limit(&self) -> usize {
        self.limit.clamp(1, TABLE_BROWSE_MAX_LIMIT)
    }
}

/// 浏览查询结果（FR-242）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableBrowseResult {
    pub row_set: RowSet,
    /// 满足筛选条件的总行数；COUNT 超时或失败时为 None（前端降级为未知总数分页）。
    pub total: Option<u64>,
    /// 是否还有下一页（有 total 时精确计算，否则用 LIMIT+1 探测）。
    pub has_next_page: bool,
}

/// 编辑单元格值（FR-250）：列名 + 文本值，`None` 表示 SQL NULL。
///
/// 统一按文本传输，数值解析与筛选值（[`parse_filter_value`]）同规则；
/// 列名由应用层按已加载 metadata 白名单校验后传入，driver 只做标识符引用转义。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditCell {
    pub column: String,
    pub value: Option<String>,
}

/// 单条表编辑操作（FR-250）。
///
/// - `Insert`：按 `values` 列集合插入一行（未提及的列走数据库默认值）。
/// - `Update`：`pk` 主键定位 + `changes` 列新值；主键列本身不可修改。
/// - `Delete`：`pk` 主键定位删除。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TableEdit {
    Insert {
        values: Vec<EditCell>,
    },
    Update {
        pk: Vec<EditCell>,
        changes: Vec<EditCell>,
    },
    Delete {
        pk: Vec<EditCell>,
    },
}

/// 编辑批应用结果（FR-250）：全部成功时返回应用条数。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyEditsResult {
    pub applied: usize,
}

/// 批量插入结果（FR-252 CSV 导入）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkInsertResult {
    /// 成功插入行数
    pub inserted: usize,
    /// 跳过模式下失败的行下标（批内 0 起，调用方换算全局行号）；中止模式恒为空
    pub failed_rows: Vec<usize>,
}

/// 索引元信息（FR-241）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMeta {
    pub name: String,
    /// 按索引内顺序的列名
    pub columns: Vec<String>,
    pub unique: bool,
    /// "PRIMARY" / "UNIQUE" / "INDEX"（归一化）
    pub index_type: String,
}

/// 约束元信息（FR-241）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConstraintMeta {
    pub name: String,
    /// "PRIMARY KEY" / "FOREIGN KEY" / "UNIQUE" / "CHECK"
    pub constraint_type: String,
    /// 约束涉及的列（CHECK 无列时为空）
    pub columns: Vec<String>,
    /// 外键引用目标（MySQL：`schema.table(col,…)`）或约束定义文本（PostgreSQL）；
    /// 无引用 / 无定义时为 None。
    pub reference: Option<String>,
}

/// 筛选值绑定（FR-242）：能解析为整数/浮点的按数值绑定（PostgreSQL 严格类型比较
/// 需要），其余按文本（MySQL 隐式转换、PG 日期/布尔文本均可比较）。
#[derive(Debug, Clone, PartialEq)]
enum FilterValue {
    Int(i64),
    Float(f64),
    Text(String),
}

fn parse_filter_value(raw: &str) -> FilterValue {
    let trimmed = raw.trim();
    if !trimmed.is_empty() {
        if let Ok(value) = trimmed.parse::<i64>() {
            return FilterValue::Int(value);
        }
        if let Ok(value) = trimmed.parse::<f64>() {
            if value.is_finite() {
                return FilterValue::Float(value);
            }
        }
    }
    FilterValue::Text(raw.to_string())
}

/// 由筛选条件生成 WHERE 子句与绑定值。`placeholder` 按方言生成（MySQL `?` / PG `$N`）。
fn build_filter_clause(
    filters: &[TableFilter],
    quote: impl Fn(&str) -> String,
    placeholder: impl Fn(usize) -> String,
) -> (String, Vec<FilterValue>) {
    let mut clauses: Vec<String> = Vec::new();
    let mut binds: Vec<FilterValue> = Vec::new();
    for filter in filters {
        let column = quote(&filter.column);
        let clause = match filter.op {
            FilterOp::Eq
            | FilterOp::NotEq
            | FilterOp::Gt
            | FilterOp::GtEq
            | FilterOp::Lt
            | FilterOp::LtEq
            | FilterOp::Like
            | FilterOp::NotLike => {
                let op = match filter.op {
                    FilterOp::Eq => "=",
                    FilterOp::NotEq => "<>",
                    FilterOp::Gt => ">",
                    FilterOp::GtEq => ">=",
                    FilterOp::Lt => "<",
                    FilterOp::LtEq => "<=",
                    FilterOp::Like => "LIKE",
                    FilterOp::NotLike => "NOT LIKE",
                    _ => unreachable!(),
                };
                binds.push(parse_filter_value(&filter.value));
                format!("{column} {op} {}", placeholder(binds.len()))
            }
            FilterOp::IsNull => format!("{column} IS NULL"),
            FilterOp::IsNotNull => format!("{column} IS NOT NULL"),
        };
        clauses.push(clause);
    }
    if clauses.is_empty() {
        (String::new(), binds)
    } else {
        (format!(" WHERE {}", clauses.join(" AND ")), binds)
    }
}

/// 按行值生成参数化 INSERT（FR-252）：列名按方言引用，None 写 NULL 字面量，
/// 非 None 值参数化绑定（占位符编号按非 NULL 值递增）。
fn build_insert_row(
    table_sql: &str,
    columns: &[String],
    row: &[Option<String>],
    quote: impl Fn(&str) -> String,
    placeholder: impl Fn(usize) -> String,
) -> (String, Vec<FilterValue>) {
    let columns_sql = columns
        .iter()
        .map(|column| quote(column))
        .collect::<Vec<_>>()
        .join(", ");
    let mut binds: Vec<FilterValue> = Vec::new();
    let placeholders = row
        .iter()
        .map(|value| match value {
            None => "NULL".to_string(),
            Some(raw) => {
                binds.push(parse_filter_value(raw));
                placeholder(binds.len())
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    (
        format!("INSERT INTO {table_sql} ({columns_sql}) VALUES ({placeholders})"),
        binds,
    )
}

/// MySQL 反引号标识符引用（内部反引号双写转义）。
fn quote_mysql_ident(name: &str) -> String {
    format!("`{}`", name.replace('`', "``"))
}

/// 生成「列 = 值」片段：NULL 值写 `IS NULL` 字面量（WHERE 用）或直接 `NULL`（SET 用），
/// 不拼用户文本；非 NULL 值一律参数化绑定。
fn edit_cell_eq(
    cell: &EditCell,
    binds: &mut Vec<FilterValue>,
    quote: &impl Fn(&str) -> String,
    placeholder: &impl Fn(usize) -> String,
) -> String {
    let column = quote(&cell.column);
    match &cell.value {
        None => format!("{column} IS NULL"),
        Some(raw) => {
            binds.push(parse_filter_value(raw));
            format!("{column} = {}", placeholder(binds.len()))
        }
    }
}

/// 生成「列 = 值」赋值片段（INSERT / UPDATE SET 用）：NULL 写字面量 `NULL`。
fn edit_cell_assign(
    cell: &EditCell,
    binds: &mut Vec<FilterValue>,
    quote: &impl Fn(&str) -> String,
    placeholder: &impl Fn(usize) -> String,
) -> String {
    let column = quote(&cell.column);
    match &cell.value {
        None => format!("{column} = NULL"),
        Some(raw) => {
            binds.push(parse_filter_value(raw));
            format!("{column} = {}", placeholder(binds.len()))
        }
    }
}

/// 由编辑操作生成参数化 DML（FR-250）。`table_sql` 为已按方言引用的全限定表名。
/// 返回 `None` 表示该条无需执行（如 Update 无变更列 —— 前端不应产生，防御性跳过）。
fn build_edit_sql(
    edit: &TableEdit,
    table_sql: &str,
    quote: impl Fn(&str) -> String,
    placeholder: impl Fn(usize) -> String,
) -> Option<(String, Vec<FilterValue>)> {
    let mut binds: Vec<FilterValue> = Vec::new();
    match edit {
        TableEdit::Insert { values } => {
            if values.is_empty() {
                return None;
            }
            let columns = values
                .iter()
                .map(|cell| quote(&cell.column))
                .collect::<Vec<_>>()
                .join(", ");
            let placeholders = values
                .iter()
                .map(|cell| match &cell.value {
                    None => "NULL".to_string(),
                    Some(raw) => {
                        binds.push(parse_filter_value(raw));
                        placeholder(binds.len())
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");
            Some((
                format!("INSERT INTO {table_sql} ({columns}) VALUES ({placeholders})"),
                binds,
            ))
        }
        TableEdit::Update { pk, changes } => {
            if pk.is_empty() || changes.is_empty() {
                return None;
            }
            let set_clause = changes
                .iter()
                .map(|cell| edit_cell_assign(cell, &mut binds, &quote, &placeholder))
                .collect::<Vec<_>>()
                .join(", ");
            let where_clause = pk
                .iter()
                .map(|cell| edit_cell_eq(cell, &mut binds, &quote, &placeholder))
                .collect::<Vec<_>>()
                .join(" AND ");
            Some((
                format!("UPDATE {table_sql} SET {set_clause} WHERE {where_clause}"),
                binds,
            ))
        }
        TableEdit::Delete { pk } => {
            if pk.is_empty() {
                return None;
            }
            let where_clause = pk
                .iter()
                .map(|cell| edit_cell_eq(cell, &mut binds, &quote, &placeholder))
                .collect::<Vec<_>>()
                .join(" AND ");
            Some((
                format!("DELETE FROM {table_sql} WHERE {where_clause}"),
                binds,
            ))
        }
    }
}

/// PostgreSQL 双引号标识符引用（内部双引号双写转义）。
fn quote_pg_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// MySQL / PostgreSQL 共用的最小数据库 Driver 契约。
///
/// 仅覆盖 v0.2 多 driver 主链路需要的 ping、metadata、query、cancel 与 close。
/// 连接创建由各 driver factory 负责；取消通过传入 [`CancellationToken`] 实现，
/// 由具体 driver 映射为数据库原生取消机制。创建/编辑数据库对象等方言专属能力
/// 不进入本契约。
pub trait Driver: Send + Sync {
    /// 返回 driver 的稳定类型。
    fn kind(&self) -> DriverKind;

    /// 验证连接可用，成功返回数据库执行 `SELECT 1` 的结果。
    fn ping(&self) -> DriverFuture<'_, i64>;

    /// 列出当前连接可见的 database。
    fn list_databases(&self) -> DriverFuture<'_, Vec<DatabaseMeta>>;

    /// 列出指定 database 下的 schema。
    fn list_schemas<'a>(&'a self, database: &'a str) -> DriverFuture<'a, Vec<SchemaMeta>>;

    /// 列出指定 metadata 作用域下的表。
    fn list_tables<'a>(&'a self, scope: &'a MetadataScope) -> DriverFuture<'a, Vec<TableMeta>>;

    /// 列出指定 metadata 作用域/table 下的列。
    fn list_columns<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ColumnMeta>>;

    /// 列出指定表的索引（FR-241）。
    fn list_indexes<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<IndexMeta>>;

    /// 列出指定表的约束（FR-241）。
    fn list_constraints<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ConstraintMeta>>;

    /// 执行 SQL；取消令牌由应用层按 query_id 管理。
    fn query<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, RowSet>;

    /// 获取绑定单条物理连接的独占 session（FR-244）。
    ///
    /// session 建立时已执行 BEGIN；`close` / `Drop` 时未提交事务自动回滚。
    /// 普通查询继续走 `query` 的 pool 路径，两者互不影响。
    fn begin_session(&self) -> DriverFuture<'_, Box<dyn DriverSession>>;

    /// 浏览表数据：服务端筛选 / 排序 / 分页 + 总行数（FR-242）。
    ///
    /// `query.filters` 的列名必须先经应用层白名单校验；driver 负责标识符引用
    /// 转义与值参数化。取消语义与 `query` 相同；COUNT 超时降级为 `total = None`。
    fn browse_table<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        query: &'a TableBrowseQuery,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, TableBrowseResult>;

    /// 执行多语句脚本（FR-243）：按方言拆分后逐条执行，首错 / 取消中止、
    /// 后续语句标记 skipped。预检遇事务控制语句整体拒绝（pool 路径不执行事务）；
    /// 写语句仍需 `allow_write` 确认，否则整体返回 WriteRequiresConfirmation。
    fn query_many<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, MultiQueryResult>;

    /// 在短事务中批量应用表编辑（FR-250）：后端权威校验 `pk_columns` 与表真实
    /// 主键一致（不一致 / 无主键返回 [`DriverError::NoPrimaryKey`]），然后
    /// `BEGIN` → 逐条参数化 DML → 全部成功 `COMMIT`；任一条失败整体 `ROLLBACK`
    /// 并返回 [`DriverError::EditApplyFailed`]（携带失败序号）；UPDATE/DELETE
    /// 影响行数不为 1 时返回 [`DriverError::EditConflict`] 并回滚。
    ///
    /// 事务为短时持有：调用期间独占一条连接，返回即释放，与 FR-244 的长事务
    /// session 互不占用。取消语义与 `query` 相同，取消后事务回滚。
    fn apply_table_edits<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        pk_columns: &'a [String],
        edits: &'a [TableEdit],
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, ApplyEditsResult>;

    /// 批量插入行（FR-252 CSV 导入）：参数化 INSERT，不要求表有主键。
    ///
    /// - `transactional = true`（中止模式）：批内单事务，任一行失败整体回滚并
    ///   返回 [`DriverError::EditApplyFailed`]（index 为批内失败行下标）。
    /// - `transactional = false`（跳过模式）：逐行 autocommit，失败行收集进
    ///   [`BulkInsertResult::failed_rows`] 继续后续行。
    /// 取消语义与 `query` 相同：中止模式当前批回滚，跳过模式停止于当前行。
    fn bulk_insert_rows<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        columns: &'a [String],
        rows: &'a [Vec<Option<String>>],
        transactional: bool,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, BulkInsertResult>;

    /// 幂等关闭 driver 持有的连接资源。
    fn close(&self) -> DriverCloseFuture<'_>;
}

/// MySQL driver —— [`Driver`] 契约的首个具体实现。
///
/// 内部持有 `sqlx::MySqlPool`（max_connections = 5）。直连传真实 host:port；
/// 走隧道时 host=127.0.0.1 + 隧道本地端口。`MySqlPool` 内部是 Arc，`Clone`
/// 只增引用计数，便于在 AppState 注册表外短暂取出执行查询而不长持锁。
#[derive(Clone)]
pub struct MySqlDriver {
    pool: MySqlPool,
    /// 独立 control pool：只用于 `KILL QUERY`，不从主 pool 借连接，避免主 pool 满时取消也卡住。
    control_pool: MySqlPool,
}

/// MySQL SSL 模式。默认禁用以适配内网 MySQL；需要 TLS 时由连接配置显式启用。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum MySqlTlsMode {
    #[default]
    Disabled,
    Preferred,
    Required,
    VerifyCa,
    VerifyIdentity,
}

impl MySqlTlsMode {
    fn to_sqlx(self) -> MySqlSslMode {
        match self {
            Self::Disabled => MySqlSslMode::Disabled,
            Self::Preferred => MySqlSslMode::Preferred,
            Self::Required => MySqlSslMode::Required,
            Self::VerifyCa => MySqlSslMode::VerifyCa,
            Self::VerifyIdentity => MySqlSslMode::VerifyIdentity,
        }
    }
}

impl FromStr for MySqlTlsMode {
    type Err = DriverError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "disabled" => Ok(Self::Disabled),
            "preferred" => Ok(Self::Preferred),
            "required" => Ok(Self::Required),
            "verify_ca" => Ok(Self::VerifyCa),
            "verify_identity" => Ok(Self::VerifyIdentity),
            _ => Err(DriverError::ConnectFailed(format!(
                "invalid mysql ssl mode: {value}"
            ))),
        }
    }
}

/// MySQL 连接参数。除账号/地址外的可选项集中在这里，便于 UI 配置逐步接线。
#[derive(Debug, Clone, Default)]
pub struct MySqlConnectSettings {
    pub ssl_mode: MySqlTlsMode,
    pub ssl_ca_path: Option<String>,
    pub ssl_client_cert_path: Option<String>,
    pub ssl_client_key_path: Option<String>,
    pub connect_timeout: Option<Duration>,
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
        Self::connect_with_settings(
            host,
            port,
            username,
            password,
            database,
            MySqlConnectSettings::default(),
        )
        .await
    }

    /// 按指定连接参数建立连接池。`database` 为空字符串表示不指定默认库。
    pub async fn connect_with_settings(
        host: &str,
        port: u16,
        username: &str,
        password: &str,
        database: &str,
        settings: MySqlConnectSettings,
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
        // 默认禁用 TLS 以兼容内网 MySQL；用户显式选择 SSL 模式时按配置启用。
        opts = opts
            .ssl_mode(settings.ssl_mode.to_sqlx())
            .log_statements(log::LevelFilter::Off);
        if let Some(path) = non_empty_path(settings.ssl_ca_path.as_deref()) {
            opts = opts.ssl_ca(path);
        }
        if let Some(path) = non_empty_path(settings.ssl_client_cert_path.as_deref()) {
            opts = opts.ssl_client_cert(path);
        }
        if let Some(path) = non_empty_path(settings.ssl_client_key_path.as_deref()) {
            opts = opts.ssl_client_key(path);
        }

        let pool = connect_pool(opts.clone(), 5, settings.connect_timeout)
            .await
            .map_err(|e| reclassify_tls(e, settings.ssl_mode))?;
        let control_pool = connect_pool(opts, 1, settings.connect_timeout)
            .await
            .map_err(|e| reclassify_tls(e, settings.ssl_mode))?;

        Ok(Self { pool, control_pool })
    }

    /// 用完整 `mysql://` URL 建立连接池。
    ///
    /// integration 测试用 `TINY_SQL_TEST_MYSQL_URL`，未来隧道桥接也走本地端口 URL。
    pub async fn connect_url(url: &str) -> Result<Self, DriverError> {
        let opts = mysql_options_from_url(url)?;
        let pool = MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(opts.clone())
            .await
            .map_err(|e| DriverError::ConnectFailed(e.to_string()))?;
        let control_pool = MySqlPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(opts)
            .await
            .map_err(|e| DriverError::ConnectFailed(e.to_string()))?;
        Ok(Self { pool, control_pool })
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
        let current: Option<String> = sqlx::query_scalar("SELECT DATABASE()")
            .fetch_one(&self.pool)
            .await
            .map_err(query_failed)?;
        let rows = sqlx::query_as::<_, (String,)>(
            "SELECT schema_name FROM information_schema.schemata ORDER BY schema_name",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(query_failed)?;
        Ok(rows
            .into_iter()
            .map(|(name,)| DatabaseMeta {
                is_current: current.as_deref() == Some(name.as_str()),
                name,
            })
            .collect())
    }

    /// 返回 MySQL database 对应的同名 schema。
    pub async fn list_schemas(&self, database: &str) -> Result<Vec<SchemaMeta>, DriverError> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS( \
                 SELECT 1 FROM information_schema.schemata WHERE schema_name = ? \
             )",
        )
        .bind(database)
        .fetch_one(&self.pool)
        .await
        .map_err(query_failed)?;
        Ok(if exists {
            vec![SchemaMeta {
                name: database.to_string(),
                is_default: true,
            }]
        } else {
            Vec::new()
        })
    }

    /// 创建 database。库名使用反引号安全转义；字符集 / 排序规则只允许 MySQL 标识符字符。
    pub async fn create_database(
        &self,
        name: &str,
        charset: Option<&str>,
        collation: Option<&str>,
    ) -> Result<(), DriverError> {
        let sql = build_create_database_sql(name, charset, collation)?;
        sqlx::query(&sql)
            .execute(&self.pool)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(())
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

    /// 执行 SQL，返回结果集。默认用于 SQL 编辑器：最多返回 10w 行，非 SELECT 需显式确认。
    pub async fn query(&self, sql: &str) -> Result<RowSet, DriverError> {
        self.query_with_options(sql, QueryOptions::default(), CancellationToken::new())
            .await
    }

    /// 列出表的索引（FR-241）：information_schema.STATISTICS 按索引名归组，列保持索引内顺序。
    pub async fn list_indexes(
        &self,
        database: &str,
        table: &str,
    ) -> Result<Vec<IndexMeta>, DriverError> {
        let rows = sqlx::query_as::<_, (String, String, bool)>(
            "SELECT index_name, column_name, non_unique \
             FROM information_schema.statistics \
             WHERE table_schema = ? AND table_name = ? \
             ORDER BY index_name, seq_in_index",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        let mut indexes: Vec<IndexMeta> = Vec::new();
        for (name, column, non_unique) in rows {
            match indexes.iter_mut().find(|index| index.name == name) {
                Some(index) => index.columns.push(column),
                None => indexes.push(IndexMeta {
                    index_type: if name == "PRIMARY" {
                        "PRIMARY"
                    } else if non_unique {
                        "INDEX"
                    } else {
                        "UNIQUE"
                    }
                    .to_string(),
                    name,
                    columns: vec![column],
                    unique: !non_unique,
                }),
            }
        }
        Ok(indexes)
    }

    /// 列出表的约束（FR-241）：TABLE_CONSTRAINTS + KEY_COLUMN_USAGE 按约束名归组，
    /// 外键引用拼为 `schema.table(col,…)`；CHECK 无列记录时列为空。
    pub async fn list_constraints(
        &self,
        database: &str,
        table: &str,
    ) -> Result<Vec<ConstraintMeta>, DriverError> {
        let rows = sqlx::query_as::<
            _,
            (
                String,
                String,
                Option<String>,
                Option<String>,
                Option<String>,
                Option<String>,
            ),
        >(
            "SELECT tc.constraint_name, tc.constraint_type, kcu.column_name, \
                    kcu.referenced_table_schema, kcu.referenced_table_name, kcu.referenced_column_name \
             FROM information_schema.table_constraints AS tc \
             LEFT JOIN information_schema.key_column_usage AS kcu \
               ON kcu.constraint_schema = tc.constraint_schema \
              AND kcu.constraint_name = tc.constraint_name \
              AND kcu.table_schema = tc.table_schema \
              AND kcu.table_name = tc.table_name \
             WHERE tc.table_schema = ? AND tc.table_name = ? \
             ORDER BY tc.constraint_name, kcu.ordinal_position",
        )
        .bind(database)
        .bind(table)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        struct Acc {
            constraint_type: String,
            columns: Vec<String>,
            ref_schema: Option<String>,
            ref_table: Option<String>,
            ref_columns: Vec<String>,
        }
        let mut accs: Vec<(String, Acc)> = Vec::new();
        for (name, constraint_type, column, ref_schema, ref_table, ref_column) in rows {
            let pos = accs.iter().position(|(n, _)| *n == name);
            let acc = match pos {
                Some(i) => &mut accs[i].1,
                None => {
                    accs.push((
                        name,
                        Acc {
                            constraint_type,
                            columns: vec![],
                            ref_schema: None,
                            ref_table: None,
                            ref_columns: vec![],
                        },
                    ));
                    &mut accs.last_mut().expect("刚 push 必存在").1
                }
            };
            if let Some(column) = column {
                acc.columns.push(column);
            }
            if let (Some(schema), Some(table), Some(column)) = (ref_schema, ref_table, ref_column) {
                acc.ref_schema = Some(schema);
                acc.ref_table = Some(table);
                acc.ref_columns.push(column);
            }
        }
        Ok(accs
            .into_iter()
            .map(|(name, acc)| ConstraintMeta {
                name,
                constraint_type: acc.constraint_type,
                columns: acc.columns,
                reference: match (acc.ref_schema, acc.ref_table) {
                    (Some(schema), Some(table)) if !acc.ref_columns.is_empty() => {
                        Some(format!("{schema}.{table}({})", acc.ref_columns.join(", ")))
                    }
                    _ => None,
                },
            })
            .collect())
    }

    /// 执行 SQL，支持顶层安全追加 LIMIT、10w 硬上限与 `KILL QUERY` 取消。
    pub async fn query_with_options(
        &self,
        sql: &str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        let prepared = prepare_query_sql(sql, options)?;
        // 事务控制语句在 pool 连接上执行会把事务状态泄漏给下一个借用者（FR-244），
        // 必须走 begin_session 的独占连接
        if matches!(prepared.kind, PreparedSqlKind::TxControl(_)) {
            return Err(DriverError::TxRequiresSession);
        }
        self.execute_prepared(&prepared, cancel_token).await
    }

    /// 按已分类语句在 pool 新连接上执行（`query` / `query_many` 共用）。
    async fn execute_prepared(
        &self,
        prepared: &PreparedSql,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        let mysql_thread_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;

        match prepared.kind {
            PreparedSqlKind::Read {
                limit,
                server_capped,
            } => {
                self.fetch_read_rows(
                    &prepared.sql,
                    limit,
                    server_capped,
                    &mut conn,
                    mysql_thread_id,
                    cancel_token,
                )
                .await
            }
            PreparedSqlKind::Write => {
                self.execute_write(&prepared.sql, &mut conn, mysql_thread_id, cancel_token)
                    .await
            }
            PreparedSqlKind::TxControl(_) => unreachable!("TxControl 已在 prepare 后拒绝"),
        }
    }

    /// 执行多语句脚本（FR-243）：拆分 → 预检 → 顺序执行，首错 / 取消中止。
    pub async fn query_many(
        &self,
        sql: &str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> Result<MultiQueryResult, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        let (statements, prepared_list) = prepare_statements(sql, options, SqlDialect::MySql)?;
        let driver = self.clone();
        query_many_with(
            statements,
            prepared_list,
            move |prepared, token| {
                let driver = driver.clone();
                Box::pin(async move { driver.execute_prepared(prepared, token).await })
            },
            cancel_token,
        )
        .await
    }

    /// 浏览表数据（FR-242）：服务端筛选 / 排序 / 分页，COUNT 超时降级 None。
    pub async fn browse_table(
        &self,
        scope: &MetadataScope,
        table: &str,
        query: &TableBrowseQuery,
        cancel_token: CancellationToken,
    ) -> Result<TableBrowseResult, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        let from = format!(
            "{}.{}",
            quote_mysql_ident(&scope.database),
            quote_mysql_ident(table)
        );
        let (where_sql, binds) =
            build_filter_clause(&query.filters, quote_mysql_ident, |_| "?".to_string());
        let order_sql = query.order.as_ref().map_or(String::new(), |order| {
            format!(
                " ORDER BY {} {}",
                quote_mysql_ident(&order.column),
                if order.descending { "DESC" } else { "ASC" }
            )
        });
        let limit = query.effective_limit();
        // 多取一行探测「是否有下一页」（COUNT 失败降级时仍保证分页行为正确）
        let data_sql = format!(
            "SELECT * FROM {from}{where_sql}{order_sql}\nLIMIT {} OFFSET {}",
            limit + 1,
            query.offset
        );
        let count_sql = format!("SELECT COUNT(*) FROM {from}{where_sql}");

        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        let mysql_thread_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;

        let data_future = async {
            // describe 拿列头（0 行结果集也需要表头；prepare 阶段不需要绑定值）
            let mut columns: Vec<String> = (&mut *conn)
                .describe(&data_sql)
                .await
                .map_err(|e| DriverError::QueryFailed(e.to_string()))?
                .columns()
                .iter()
                .map(|c| c.name().to_string())
                .collect();
            let mut q = sqlx::query(&data_sql);
            for value in &binds {
                q = match value {
                    FilterValue::Int(v) => q.bind(*v),
                    FilterValue::Float(v) => q.bind(*v),
                    FilterValue::Text(v) => q.bind(v.clone()),
                };
            }
            let mut rows = q.fetch(&mut *conn);
            let mut data: Vec<Vec<Option<String>>> = Vec::new();
            loop {
                tokio::select! {
                    row = rows.try_next() => {
                        let Some(row) = row.map_err(|e| DriverError::QueryFailed(e.to_string()))? else {
                            break;
                        };
                        if columns.is_empty() {
                            columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        data.push((0..row.columns().len()).map(|i| cell_to_string(&row, i)).collect());
                    }
                    _ = cancel_token.cancelled() => {
                        drop(rows);
                        self.kill_query(mysql_thread_id).await;
                        return Err(DriverError::QueryCancelled);
                    }
                }
            }
            Ok((columns, data))
        };
        let count_future = self.count_rows(&count_sql, &binds, &cancel_token);
        let (data_result, total) = tokio::join!(data_future, count_future);
        let (columns, mut data) = data_result?;

        let has_next_page = match total {
            Some(total) => query.offset + limit < total as usize,
            None => data.len() > limit,
        };
        data.truncate(limit);
        Ok(TableBrowseResult {
            row_set: RowSet {
                columns,
                rows: data,
                truncated: false,
            },
            total,
            has_next_page,
        })
    }

    /// COUNT 查询：独立连接 + 5s 超时 + 可取消；超时/失败降级 None，不影响浏览主链路。
    async fn count_rows(
        &self,
        sql: &str,
        binds: &[FilterValue],
        cancel_token: &CancellationToken,
    ) -> Option<u64> {
        let work = async {
            let mut conn = self.pool.acquire().await.ok()?;
            let mut q = sqlx::query_scalar::<_, i64>(sql);
            for value in binds {
                q = match value {
                    FilterValue::Int(v) => q.bind(*v),
                    FilterValue::Float(v) => q.bind(*v),
                    FilterValue::Text(v) => q.bind(v.clone()),
                };
            }
            q.fetch_one(&mut *conn).await.ok()
        };
        let cancellable = async {
            tokio::select! {
                result = work => result,
                _ = cancel_token.cancelled() => None,
            }
        };
        match timeout(Duration::from_secs(5), cancellable).await {
            Ok(value) => value.map(|count| count.max(0) as u64),
            Err(_) => None,
        }
    }

    async fn fetch_read_rows(
        &self,
        sql: &str,
        limit: usize,
        server_capped: bool,
        conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
        mysql_thread_id: u64,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        // 用已持有的连接 describe，不从同一个 pool 再借第二个连接
        //（并发查询占满 pool 时会互相等 describe 的 acquire 造成整体卡死）
        let mut columns: Vec<String> = (&mut **conn)
            .describe(sql)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?
            .columns()
            .iter()
            .map(|c| c.name().to_string())
            .collect();

        let mut rows = sqlx::query(sql).fetch(&mut **conn);
        let mut data: Vec<Vec<Option<String>>> = Vec::new();
        let mut truncated = false;

        loop {
            tokio::select! {
                row = rows.try_next() => {
                    let Some(row) = row.map_err(|e| DriverError::QueryFailed(e.to_string()))? else {
                        break;
                    };
                    // SHOW PROCESSLIST / EXPLAIN 等语句 prepare 阶段拿不到列元信息
                    //（describe 返回空列），从首行数据补齐列名
                    if columns.is_empty() {
                        columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                    }
                    if data.len() >= limit {
                        truncated = true;
                        break;
                    }
                    data.push((0..row.columns().len()).map(|i| cell_to_string(&row, i)).collect());
                }
                _ = cancel_token.cancelled() => {
                    drop(rows);
                    self.kill_query(mysql_thread_id).await;
                    return Err(DriverError::QueryCancelled);
                }
            }
        }

        // 服务端没有 LIMIT 兜底时客户端截断会留下未读完的大结果集，
        // 归还连接前 KILL 止损，避免 sqlx 在下次使用时 drain 全量行（多跳隧道上代价高）
        if truncated && !server_capped {
            drop(rows);
            self.kill_query(mysql_thread_id).await;
        }

        Ok(RowSet {
            columns,
            rows: data,
            truncated,
        })
    }

    async fn execute_write(
        &self,
        sql: &str,
        conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>,
        mysql_thread_id: u64,
        cancel_token: CancellationToken,
    ) -> Result<RowSet, DriverError> {
        tokio::select! {
            result = sqlx::query(sql).execute(&mut **conn) => {
                let result = result.map_err(|e| DriverError::QueryFailed(e.to_string()))?;
                Ok(RowSet {
                    columns: vec!["affected_rows".to_string(), "last_insert_id".to_string()],
                    rows: vec![vec![
                        Some(result.rows_affected().to_string()),
                        Some(result.last_insert_id().to_string()),
                    ]],
                    truncated: false,
                })
            }
            _ = cancel_token.cancelled() => {
                self.kill_query(mysql_thread_id).await;
                Err(DriverError::QueryCancelled)
            }
        }
    }

    /// 批量应用表编辑（FR-250）：短事务独占一条连接，逐条参数化 DML，
    /// 全部成功才 COMMIT；任一失败 / 取消 / 影响行数异常整体 ROLLBACK。
    pub async fn apply_table_edits(
        &self,
        scope: &MetadataScope,
        table: &str,
        pk_columns: &[String],
        edits: &[TableEdit],
        cancel_token: CancellationToken,
    ) -> Result<ApplyEditsResult, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        if edits.is_empty() {
            return Ok(ApplyEditsResult { applied: 0 });
        }
        // 主键权威校验：传入列集合必须与表真实主键一致（顺序无关），杜绝前端过期元数据
        let constraints = self.list_constraints(&scope.database, table).await?;
        let actual: Option<std::collections::BTreeSet<&str>> = constraints
            .iter()
            .find(|c| c.constraint_type == "PRIMARY KEY")
            .map(|c| c.columns.iter().map(String::as_str).collect());
        let expected: std::collections::BTreeSet<&str> =
            pk_columns.iter().map(String::as_str).collect();
        match actual {
            Some(actual) if !actual.is_empty() && actual == expected => {}
            _ => return Err(DriverError::NoPrimaryKey),
        }

        let table_sql = format!(
            "{}.{}",
            quote_mysql_ident(&scope.database),
            quote_mysql_ident(table)
        );
        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        let mysql_thread_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        // 事务语句走 text protocol（MySQL 预处理协议不支持，1295 ER_UNSUPPORTED_PS）
        conn.execute(sqlx::raw_sql("START TRANSACTION"))
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;

        let mut applied = 0usize;
        for (index, edit) in edits.iter().enumerate() {
            let Some((sql, binds)) =
                build_edit_sql(edit, &table_sql, quote_mysql_ident, |_| "?".to_string())
            else {
                continue;
            };
            let mut q = sqlx::query(&sql);
            for value in &binds {
                q = match value {
                    FilterValue::Int(v) => q.bind(*v),
                    FilterValue::Float(v) => q.bind(*v),
                    FilterValue::Text(v) => q.bind(v.clone()),
                };
            }
            let outcome = tokio::select! {
                result = q.execute(&mut *conn) => result,
                _ = cancel_token.cancelled() => {
                    self.kill_query(mysql_thread_id).await;
                    Self::rollback_or_close(&mut conn).await;
                    return Err(DriverError::QueryCancelled);
                }
            };
            let done = match outcome {
                Ok(done) => done,
                Err(error) => {
                    Self::rollback_or_close(&mut conn).await;
                    return Err(DriverError::EditApplyFailed {
                        index,
                        detail: error.to_string(),
                    });
                }
            };
            // UPDATE / DELETE 期望恰好命中 1 行：0 行即他端并发改动，>1 行说明
            // 定位条件不唯一（如前端漏传主键列），两者都整体回滚报冲突
            if !matches!(edit, TableEdit::Insert { .. }) && done.rows_affected() != 1 {
                Self::rollback_or_close(&mut conn).await;
                return Err(DriverError::EditConflict { index });
            }
            applied += 1;
        }

        if let Err(error) = conn.execute(sqlx::raw_sql("COMMIT")).await {
            // COMMIT 失败销毁连接由服务端兜底回滚，杜绝「以为已提交」的中间态
            conn.close_on_drop();
            return Err(DriverError::QueryFailed(error.to_string()));
        }
        Ok(ApplyEditsResult { applied })
    }

    /// 批量插入行（FR-252）：参数化逐行 INSERT；transactional 时批内单事务，
    /// 失败整体回滚并定位批内行号；非事务模式逐行 autocommit 收集失败行。
    pub async fn bulk_insert_rows(
        &self,
        scope: &MetadataScope,
        table: &str,
        columns: &[String],
        rows: &[Vec<Option<String>>],
        transactional: bool,
        cancel_token: CancellationToken,
    ) -> Result<BulkInsertResult, DriverError> {
        if cancel_token.is_cancelled() {
            return Err(DriverError::QueryCancelled);
        }
        if rows.is_empty() {
            return Ok(BulkInsertResult {
                inserted: 0,
                failed_rows: vec![],
            });
        }
        if columns.is_empty() {
            return Err(DriverError::InvalidSql);
        }
        let table_sql = format!(
            "{}.{}",
            quote_mysql_ident(&scope.database),
            quote_mysql_ident(table)
        );
        let mut conn = self
            .pool
            .acquire()
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        let mysql_thread_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        if transactional {
            conn.execute(sqlx::raw_sql("START TRANSACTION"))
                .await
                .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        }

        let mut inserted = 0usize;
        let mut failed_rows: Vec<usize> = Vec::new();
        for (index, row) in rows.iter().enumerate() {
            let (sql, binds) =
                build_insert_row(&table_sql, columns, row, quote_mysql_ident, |_| {
                    "?".to_string()
                });
            let mut q = sqlx::query(&sql);
            for value in &binds {
                q = match value {
                    FilterValue::Int(v) => q.bind(*v),
                    FilterValue::Float(v) => q.bind(*v),
                    FilterValue::Text(v) => q.bind(v.clone()),
                };
            }
            let outcome = tokio::select! {
                result = q.execute(&mut *conn) => result,
                _ = cancel_token.cancelled() => {
                    self.kill_query(mysql_thread_id).await;
                    if transactional {
                        Self::rollback_or_close(&mut conn).await;
                    }
                    return Err(DriverError::QueryCancelled);
                }
            };
            match outcome {
                Ok(_) => inserted += 1,
                Err(error) if transactional => {
                    Self::rollback_or_close(&mut conn).await;
                    return Err(DriverError::EditApplyFailed {
                        index,
                        detail: error.to_string(),
                    });
                }
                Err(_) => failed_rows.push(index),
            }
        }

        if transactional {
            if let Err(error) = conn.execute(sqlx::raw_sql("COMMIT")).await {
                conn.close_on_drop();
                return Err(DriverError::QueryFailed(error.to_string()));
            }
        }
        Ok(BulkInsertResult {
            inserted,
            failed_rows,
        })
    }

    /// 编辑事务失败路径：尽力 ROLLBACK；ROLLBACK 也失败则销毁连接，
    /// 防止带未提交事务的脏连接归还 pool 污染后续查询。
    async fn rollback_or_close(conn: &mut sqlx::pool::PoolConnection<sqlx::MySql>) {
        if conn.execute(sqlx::raw_sql("ROLLBACK")).await.is_err() {
            conn.close_on_drop();
        }
    }

    /// 从独立 control pool 发 KILL QUERY；取消路径不再向用户暴露二次失败。
    async fn kill_query(&self, mysql_thread_id: u64) {
        let sql = format!("KILL QUERY {mysql_thread_id}");
        let _ = tokio::time::timeout(
            CONTROL_QUERY_TIMEOUT,
            sqlx::query(&sql).execute(&self.control_pool),
        )
        .await;
    }

    /// 关闭连接池。
    pub async fn close(&self) {
        self.pool.close().await;
        self.control_pool.close().await;
    }
}

impl Driver for MySqlDriver {
    fn kind(&self) -> DriverKind {
        DriverKind::MySql
    }

    fn ping(&self) -> DriverFuture<'_, i64> {
        Box::pin(MySqlDriver::ping(self))
    }

    fn list_databases(&self) -> DriverFuture<'_, Vec<DatabaseMeta>> {
        Box::pin(MySqlDriver::list_databases(self))
    }

    fn list_schemas<'a>(&'a self, database: &'a str) -> DriverFuture<'a, Vec<SchemaMeta>> {
        Box::pin(MySqlDriver::list_schemas(self, database))
    }

    fn list_tables<'a>(&'a self, scope: &'a MetadataScope) -> DriverFuture<'a, Vec<TableMeta>> {
        Box::pin(MySqlDriver::list_tables(self, &scope.database))
    }

    fn list_columns<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ColumnMeta>> {
        Box::pin(MySqlDriver::list_columns(self, &scope.database, table))
    }

    fn list_indexes<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<IndexMeta>> {
        Box::pin(MySqlDriver::list_indexes(self, &scope.database, table))
    }

    fn list_constraints<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
    ) -> DriverFuture<'a, Vec<ConstraintMeta>> {
        Box::pin(MySqlDriver::list_constraints(self, &scope.database, table))
    }

    fn query<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, RowSet> {
        Box::pin(MySqlDriver::query_with_options(
            self,
            sql,
            options,
            cancel_token,
        ))
    }

    fn begin_session(&self) -> DriverFuture<'_, Box<dyn DriverSession>> {
        Box::pin(async move {
            Ok(Box::new(MySqlSession::begin(self.clone()).await?) as Box<dyn DriverSession>)
        })
    }

    fn browse_table<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        query: &'a TableBrowseQuery,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, TableBrowseResult> {
        Box::pin(MySqlDriver::browse_table(
            self,
            scope,
            table,
            query,
            cancel_token,
        ))
    }

    fn query_many<'a>(
        &'a self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, MultiQueryResult> {
        Box::pin(MySqlDriver::query_many(self, sql, options, cancel_token))
    }

    fn apply_table_edits<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        pk_columns: &'a [String],
        edits: &'a [TableEdit],
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, ApplyEditsResult> {
        Box::pin(MySqlDriver::apply_table_edits(
            self,
            scope,
            table,
            pk_columns,
            edits,
            cancel_token,
        ))
    }

    fn bulk_insert_rows<'a>(
        &'a self,
        scope: &'a MetadataScope,
        table: &'a str,
        columns: &'a [String],
        rows: &'a [Vec<Option<String>>],
        transactional: bool,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, BulkInsertResult> {
        Box::pin(MySqlDriver::bulk_insert_rows(
            self,
            scope,
            table,
            columns,
            rows,
            transactional,
            cancel_token,
        ))
    }

    fn close(&self) -> DriverCloseFuture<'_> {
        Box::pin(MySqlDriver::close(self))
    }
}

/// MySQL 独占 session：BEGIN 后所有语句固定同一物理连接（FR-244）。
///
/// 取消与截断止损沿用 `KILL QUERY`（只杀当前语句，事务保留）。
/// session 结束时用 `RESET CONNECTION`（MySQL 5.7.3+）一次性清理未提交事务、
/// `USE` 切换、用户变量等全部会话状态再归还 pool；清理失败则 `close_on_drop`
/// 销毁连接，由服务端在连接关闭时兜底回滚。
pub struct MySqlSession {
    driver: MySqlDriver,
    conn: Option<sqlx::pool::PoolConnection<sqlx::MySql>>,
    mysql_thread_id: u64,
    in_transaction: bool,
}

impl MySqlSession {
    /// 从主 pool 取一条连接并开启事务。
    async fn begin(driver: MySqlDriver) -> Result<Self, DriverError> {
        let mut conn = driver
            .pool
            .acquire()
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        let mysql_thread_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut *conn)
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        // 事务/会话管理语句走 text protocol：MySQL 预处理协议不支持（1295 ER_UNSUPPORTED_PS）
        conn.execute(sqlx::raw_sql("START TRANSACTION"))
            .await
            .map_err(|e| DriverError::QueryFailed(e.to_string()))?;
        Ok(Self {
            driver,
            conn: Some(conn),
            mysql_thread_id,
            in_transaction: true,
        })
    }

    /// 归还 pool 前尽力清理会话状态；失败销毁连接（服务端兜底回滚）。
    async fn cleanup(mut conn: sqlx::pool::PoolConnection<sqlx::MySql>) {
        let reset = timeout(CONTROL_QUERY_TIMEOUT, async {
            conn.execute(sqlx::raw_sql("RESET CONNECTION")).await
        })
        .await;
        if !matches!(reset, Ok(Ok(_))) {
            conn.close_on_drop();
        }
    }

    /// commit / rollback 的公共路径；失败时销毁连接，杜绝「前端以为已提交
    /// 而后端未提交」的中间态——事务最终状态只能是已提交或已回滚。
    async fn finish_tx(&mut self, stmt: &'static str) -> Result<(), DriverError> {
        if !self.in_transaction {
            return Err(DriverError::SessionNotInTransaction);
        }
        let Some(conn) = self.conn.as_mut() else {
            return Err(DriverError::SessionBroken);
        };
        match conn.execute(sqlx::raw_sql(stmt)).await {
            Ok(_) => {
                self.in_transaction = false;
                Ok(())
            }
            Err(error) => {
                self.in_transaction = false;
                if let Some(mut conn) = self.conn.take() {
                    conn.close_on_drop();
                }
                Err(query_failed(error))
            }
        }
    }
}

impl DriverSession for MySqlSession {
    fn query<'a>(
        &'a mut self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, RowSet> {
        Box::pin(async move {
            if cancel_token.is_cancelled() {
                return Err(DriverError::QueryCancelled);
            }
            let prepared = prepare_query_sql(sql, options)?;
            let Some(conn) = self.conn.as_mut() else {
                return Err(DriverError::SessionBroken);
            };
            match prepared.kind {
                PreparedSqlKind::Read {
                    limit,
                    server_capped,
                } => {
                    self.driver
                        .fetch_read_rows(
                            &prepared.sql,
                            limit,
                            server_capped,
                            conn,
                            self.mysql_thread_id,
                            cancel_token,
                        )
                        .await
                }
                PreparedSqlKind::Write => {
                    self.driver
                        .execute_write(&prepared.sql, conn, self.mysql_thread_id, cancel_token)
                        .await
                }
                PreparedSqlKind::TxControl(tx) => {
                    // 事务控制语句走 text protocol（MySQL 预处理协议不支持），
                    // 执行很快，取消窗口可忽略
                    let result = conn
                        .execute(sqlx::raw_sql(&prepared.sql))
                        .await
                        .map_err(query_failed)?;
                    match tx {
                        TxControl::Begin => self.in_transaction = true,
                        TxControl::Commit | TxControl::Rollback => self.in_transaction = false,
                        TxControl::Neutral => {}
                    }
                    Ok(RowSet {
                        columns: vec!["affected_rows".to_string()],
                        rows: vec![vec![Some(result.rows_affected().to_string())]],
                        truncated: false,
                    })
                }
            }
        })
    }

    fn commit(&mut self) -> DriverFuture<'_, ()> {
        Box::pin(self.finish_tx("COMMIT"))
    }

    fn rollback(&mut self) -> DriverFuture<'_, ()> {
        Box::pin(self.finish_tx("ROLLBACK"))
    }

    fn close(&mut self) -> DriverCloseFuture<'_> {
        Box::pin(async move {
            self.in_transaction = false;
            if let Some(conn) = self.conn.take() {
                Self::cleanup(conn).await;
            }
        })
    }

    fn in_transaction(&self) -> bool {
        self.in_transaction
    }
}

impl Drop for MySqlSession {
    fn drop(&mut self) {
        let Some(conn) = self.conn.take() else {
            return;
        };
        // 未经 close 的 session（如连接整体断开时）：后台尽力清理后归还，
        // 无 tokio runtime 时直接销毁连接，服务端兜底回滚未提交事务
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(Self::cleanup(conn));
        } else {
            let mut conn = conn;
            conn.close_on_drop();
        }
    }
}

fn mysql_options_from_url(url: &str) -> Result<MySqlConnectOptions, DriverError> {
    let mut opts: MySqlConnectOptions = url
        .parse()
        .map_err(|e: sqlx::Error| DriverError::ConnectFailed(e.to_string()))?;
    if !url_has_ssl_mode(url) {
        opts = opts.ssl_mode(MySqlSslMode::Disabled);
    }
    Ok(opts.log_statements(log::LevelFilter::Off))
}

async fn connect_pool(
    opts: MySqlConnectOptions,
    max_connections: u32,
    connect_timeout: Option<Duration>,
) -> Result<MySqlPool, DriverError> {
    let fut = MySqlPoolOptions::new()
        .max_connections(max_connections)
        .acquire_timeout(Duration::from_secs(10))
        .connect_with(opts);
    match connect_timeout {
        Some(duration) => timeout(duration, fut)
            .await
            .map_err(|_| DriverError::ConnectFailed("connection timeout".to_string()))?
            .map_err(|e| DriverError::ConnectFailed(e.to_string())),
        None => fut
            .await
            .map_err(|e| DriverError::ConnectFailed(e.to_string())),
    }
}

fn query_failed(error: sqlx::Error) -> DriverError {
    DriverError::QueryFailed(error.to_string())
}

fn non_empty_path(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

fn build_create_database_sql(
    name: &str,
    charset: Option<&str>,
    collation: Option<&str>,
) -> Result<String, DriverError> {
    let name = validate_database_name(name)?;
    let mut sql = format!("CREATE DATABASE {}", quote_mysql_identifier(name));

    if let Some(charset) = normalize_mysql_option_ident(charset)? {
        sql.push_str(" DEFAULT CHARACTER SET = ");
        sql.push_str(charset);
    }
    if let Some(collation) = normalize_mysql_option_ident(collation)? {
        sql.push_str(" DEFAULT COLLATE = ");
        sql.push_str(collation);
    }

    Ok(sql)
}

fn validate_database_name(name: &str) -> Result<&str, DriverError> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.contains('\0') {
        return Err(DriverError::InvalidIdentifier);
    }
    Ok(name)
}

fn normalize_mysql_option_ident(value: Option<&str>) -> Result<Option<&str>, DriverError> {
    let Some(value) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
    {
        Ok(Some(value))
    } else {
        Err(DriverError::InvalidIdentifier)
    }
}

fn quote_mysql_identifier(value: &str) -> String {
    format!("`{}`", value.replace('`', "``"))
}

fn url_has_ssl_mode(url: &str) -> bool {
    url.split_once('?')
        .map(|(_, query)| {
            query.split('&').any(|part| {
                let key = part.split_once('=').map_or(part, |(key, _)| key);
                key.eq_ignore_ascii_case("ssl-mode")
            })
        })
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PreparedSqlKind {
    /// 返回结果集的语句（SELECT / WITH / SHOW / EXPLAIN / DESC）：fetch 行流。
    /// `server_capped` 表示已在语句末尾追加服务端 LIMIT；false 时靠客户端截断兜底。
    Read {
        limit: usize,
        server_capped: bool,
    },
    Write,
    /// 事务控制语句（BEGIN / COMMIT / ROLLBACK / SAVEPOINT 等）。
    /// 只允许在独占 session 上执行（FR-244）：pool 路径执行会把事务状态泄漏给
    /// 下一个借用者，因此直接拒绝；session 路径执行后按 [`TxControl`] 更新事务状态。
    TxControl(TxControl),
}

/// 事务控制语句对 session 事务状态的影响。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TxControl {
    /// BEGIN / START TRANSACTION：开启事务（MySQL 嵌套 BEGIN 隐式提交后重开，状态仍是在事务中）。
    Begin,
    /// COMMIT：事务结束。
    Commit,
    /// ROLLBACK（不含 ROLLBACK TO SAVEPOINT）：事务结束。
    Rollback,
    /// SAVEPOINT / RELEASE / ROLLBACK TO SAVEPOINT：不改变事务开关状态。
    Neutral,
}

/// 识别事务控制语句（FR-244）。`tokens` 是已消毒语句的 token 序列（大写）。
fn classify_tx_control(tokens: &[String]) -> Option<TxControl> {
    let first = tokens.first()?.as_str();
    let second = tokens.get(1).map(String::as_str);
    match first {
        "BEGIN" => Some(TxControl::Begin),
        // START TRANSACTION / START TRANSACTION READ WRITE 等
        "START" if second == Some("TRANSACTION") => Some(TxControl::Begin),
        "COMMIT" | "ROLLBACK" => {
            // AND CHAIN：提交/回滚后立即开启新事务，净效果仍在事务中
            let and_chain =
                second == Some("AND") && tokens.get(2).map(String::as_str) == Some("CHAIN");
            if and_chain {
                return Some(TxControl::Begin);
            }
            match (first, second) {
                ("COMMIT", _) => Some(TxControl::Commit),
                // ROLLBACK TO SAVEPOINT 不结束事务
                ("ROLLBACK", Some("TO")) => Some(TxControl::Neutral),
                _ => Some(TxControl::Rollback),
            }
        }
        "SAVEPOINT" | "RELEASE" => Some(TxControl::Neutral),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreparedSql {
    sql: String,
    kind: PreparedSqlKind,
    /// 客户端行数上限（Write + RETURNING 场景使用）
    row_limit: usize,
}

/// 多语句脚本的单条执行结果（FR-243）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatementResult {
    /// 语句原文（超长截断，仅用于展示）
    pub sql: String,
    pub outcome: StatementOutcome,
}

/// 单条语句的执行结局（FR-243）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum StatementOutcome {
    #[serde(rename = "ok")]
    Ok { row_set: RowSet },
    #[serde(rename = "error")]
    Error { key: String, line: Option<u32> },
    /// 因前序失败或取消而未执行
    #[serde(rename = "skipped")]
    Skipped,
}

/// 多语句执行结果：与脚本语句一一对应（FR-243）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiQueryResult {
    pub statements: Vec<StatementResult>,
}

/// 结果展示用的语句原文最大长度。
const STATEMENT_SQL_MAX_CHARS: usize = 500;

fn truncate_statement_sql(sql: &str) -> String {
    if sql.chars().count() > STATEMENT_SQL_MAX_CHARS {
        sql.chars().take(STATEMENT_SQL_MAX_CHARS).collect()
    } else {
        sql.to_string()
    }
}

/// 按方言把多语句脚本拆分为单条语句（FR-243）。
///
/// 分号只在「普通」状态切分；字符串、标识符引号、行/块注释与 PostgreSQL
/// dollar-quoted body 内的分号不算。拆分后空白语句丢弃；存在未闭合的引号 /
/// 注释 / dollar-quote 时返回 `InvalidSql`（边界不确定即拒绝，绝不尽力执行）。
fn split_statements(sql: &str, dialect: SqlDialect) -> Result<Vec<String>, DriverError> {
    #[derive(PartialEq)]
    enum State {
        Normal,
        SingleQuote,
        DoubleQuote,
        Backtick,
        LineComment,
        BlockComment,
        DollarQuote,
    }
    let chars: Vec<(usize, char)> = sql.char_indices().collect();
    let n = chars.len();
    let mut state = State::Normal;
    let mut dollar_tag: Vec<char> = Vec::new();
    let mut statements: Vec<String> = Vec::new();
    let mut stmt_start = 0usize;
    let mut i = 0usize;

    while i < n {
        let (byte, ch) = chars[i];
        match state {
            State::Normal => match ch {
                '\'' => state = State::SingleQuote,
                '"' => state = State::DoubleQuote,
                '`' if dialect == SqlDialect::MySql => state = State::Backtick,
                '#' if dialect == SqlDialect::MySql => state = State::LineComment,
                '-' if i + 1 < n && chars[i + 1].1 == '-' => {
                    state = State::LineComment;
                    i += 1;
                }
                '/' if i + 1 < n && chars[i + 1].1 == '*' => {
                    state = State::BlockComment;
                    i += 1;
                }
                '$' if dialect == SqlDialect::PostgreSql => {
                    // 尝试解析 $tag$ 开界（空 tag 即 $$）
                    let mut j = i + 1;
                    if j < n && (chars[j].1.is_ascii_alphabetic() || chars[j].1 == '_') {
                        while j < n && (chars[j].1.is_ascii_alphanumeric() || chars[j].1 == '_') {
                            j += 1;
                        }
                    }
                    if j < n && chars[j].1 == '$' {
                        dollar_tag = chars[i..=j].iter().map(|(_, c)| *c).collect();
                        state = State::DollarQuote;
                        i = j;
                    }
                }
                ';' => {
                    let stmt = sql[stmt_start..byte].trim();
                    if !stmt.is_empty() {
                        statements.push(stmt.to_string());
                    }
                    stmt_start = byte + 1;
                }
                _ => {}
            },
            State::SingleQuote => {
                if ch == '\\' {
                    i += 1; // 双方言保守跳过转义字符
                } else if ch == '\'' {
                    if i + 1 < n && chars[i + 1].1 == '\'' {
                        i += 1; // '' 转义
                    } else {
                        state = State::Normal;
                    }
                }
            }
            State::DoubleQuote => {
                if ch == '"' {
                    if i + 1 < n && chars[i + 1].1 == '"' {
                        i += 1; // "" 转义
                    } else {
                        state = State::Normal;
                    }
                }
            }
            State::Backtick => {
                if ch == '`' {
                    if i + 1 < n && chars[i + 1].1 == '`' {
                        i += 1; // `` 转义
                    } else {
                        state = State::Normal;
                    }
                }
            }
            State::LineComment => {
                if ch == '\n' {
                    state = State::Normal;
                }
            }
            State::BlockComment => {
                if ch == '*' && i + 1 < n && chars[i + 1].1 == '/' {
                    state = State::Normal;
                    i += 1;
                }
            }
            State::DollarQuote => {
                if ch == '$' {
                    let tag_len = dollar_tag.len();
                    if i + tag_len <= n
                        && chars[i..i + tag_len]
                            .iter()
                            .map(|(_, c)| *c)
                            .eq(dollar_tag.iter().copied())
                    {
                        state = State::Normal;
                        i += tag_len - 1;
                    }
                }
            }
        }
        i += 1;
    }
    if state != State::Normal {
        return Err(DriverError::InvalidSql);
    }
    let tail = sql[stmt_start..].trim();
    if !tail.is_empty() {
        statements.push(tail.to_string());
    }
    if statements.is_empty() {
        return Err(DriverError::InvalidSql);
    }
    Ok(statements)
}

/// 多语句执行的共享流程（FR-243）：拆分 → 逐条预检分类（遇事务控制语句整体
/// 拒绝，pool 路径不执行事务）→ 顺序执行，首错 / 取消中止，剩余标记 skipped。
async fn query_many_with<F>(
    statements: Vec<String>,
    prepared_list: Vec<PreparedSql>,
    execute: F,
    cancel_token: CancellationToken,
) -> Result<MultiQueryResult, DriverError>
where
    F: for<'a> Fn(&'a PreparedSql, CancellationToken) -> DriverFuture<'a, RowSet>,
{
    let mut results: Vec<StatementResult> = Vec::with_capacity(statements.len());
    let mut iter = statements.iter().zip(&prepared_list);
    let mut stopped = false;
    for (stmt, prepared) in iter.by_ref() {
        if cancel_token.is_cancelled() {
            stopped = true;
            break;
        }
        match execute(prepared, cancel_token.clone()).await {
            Ok(row_set) => results.push(StatementResult {
                sql: truncate_statement_sql(stmt),
                outcome: StatementOutcome::Ok { row_set },
            }),
            Err(error) => {
                results.push(StatementResult {
                    sql: truncate_statement_sql(stmt),
                    outcome: StatementOutcome::Error {
                        key: error.i18n_key().to_string(),
                        line: error.sql_line(),
                    },
                });
                stopped = true;
                break;
            }
        }
    }
    if stopped {
        for (stmt, _) in iter {
            results.push(StatementResult {
                sql: truncate_statement_sql(stmt),
                outcome: StatementOutcome::Skipped,
            });
        }
    }
    Ok(MultiQueryResult {
        statements: results,
    })
}

/// 多语句预检：拆分 + 逐条 guard 分类；事务控制语句整体拒绝（FR-243）。
fn prepare_statements(
    sql: &str,
    options: QueryOptions,
    dialect: SqlDialect,
) -> Result<(Vec<String>, Vec<PreparedSql>), DriverError> {
    let statements = split_statements(sql, dialect)?;
    let mut prepared_list = Vec::with_capacity(statements.len());
    for stmt in &statements {
        let prepared = prepare_query_sql_for_dialect(stmt, options, dialect)?;
        if matches!(prepared.kind, PreparedSqlKind::TxControl(_)) {
            return Err(DriverError::TxRequiresSession);
        }
        prepared_list.push(prepared);
    }
    Ok((statements, prepared_list))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SqlDialect {
    MySql,
    PostgreSql,
}

/// 分析并改写 SQL：
/// - 拒绝空 SQL / 多语句；
/// - 方言支持的读语句在顶层安全时追加 LIMIT（不做 derived table 包装——
///   `SELECT *` JOIN 的重名列在包装后会报 1060 Duplicate column name）；
/// - MySQL SHOW/EXPLAIN/DESC、PostgreSQL SHOW/EXPLAIN 按元数据读处理；
/// - 其余语句仅在 `allow_write=true` 时执行，作为 best-effort 写操作二次确认。
fn prepare_query_sql(sql: &str, options: QueryOptions) -> Result<PreparedSql, DriverError> {
    prepare_query_sql_for_dialect(sql, options, SqlDialect::MySql)
}

fn prepare_query_sql_for_dialect(
    sql: &str,
    options: QueryOptions,
    dialect: SqlDialect,
) -> Result<PreparedSql, DriverError> {
    let sanitized = match dialect {
        SqlDialect::MySql => strip_literals_and_comments(sql),
        SqlDialect::PostgreSql => {
            strip_literals_and_comments(&strip_postgres_dollar_quoted_literals(sql))
        }
    };
    let sanitized_stmt = trim_trailing_terminators(&sanitized);
    if sanitized_stmt.trim().is_empty() {
        return Err(DriverError::InvalidSql);
    }
    if sanitized_stmt.contains(';') {
        return Err(DriverError::MultipleStatements);
    }

    let stmt = trim_trailing_terminators(sql);
    let tokens = sql_tokens(&sanitized_stmt);
    let first = tokens.first().map(String::as_str).unwrap_or_default();
    let top_level = top_level_words(&sanitized_stmt);
    let main_statement = if first == "WITH" {
        top_level
            .iter()
            .skip(1)
            .map(String::as_str)
            .find(|token| {
                matches!(
                    *token,
                    "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "TABLE" | "VALUES"
                )
            })
            .unwrap_or_default()
    } else {
        first
    };
    let limit = options.effective_limit();

    let with_contains_write = first == "WITH"
        && tokens
            .iter()
            .skip(1)
            .any(|token| matches!(token.as_str(), "INSERT" | "UPDATE" | "DELETE" | "MERGE"));
    let is_read = !with_contains_write
        && (matches!(main_statement, "SELECT")
            || (dialect == SqlDialect::PostgreSql && matches!(main_statement, "TABLE" | "VALUES")));
    let is_metadata = match dialect {
        SqlDialect::MySql => matches!(first, "SHOW" | "DESC" | "DESCRIBE" | "EXPLAIN"),
        SqlDialect::PostgreSql => matches!(first, "SHOW" | "EXPLAIN"),
    };

    if is_read {
        if can_append_limit(&sanitized_stmt, dialect) {
            // 多取 1 行仅用于精确判断是否截断；返回给前端时会丢掉第 limit+1 行。
            let fetch_limit = limit.saturating_add(1);
            Ok(PreparedSql {
                // 换行追加，避免语句以行注释结尾时 LIMIT 被吞掉
                sql: format!("{stmt}\nLIMIT {fetch_limit}"),
                kind: PreparedSqlKind::Read {
                    limit,
                    server_capped: true,
                },
                row_limit: limit,
            })
        } else {
            Ok(PreparedSql {
                sql: stmt,
                kind: PreparedSqlKind::Read {
                    limit,
                    server_capped: false,
                },
                row_limit: limit,
            })
        }
    } else if is_metadata {
        // EXPLAIN ANALYZE 会真正执行被分析的语句：分析写语句时仍需二次确认
        if first == "EXPLAIN" && explain_analyze_writes(&tokens) && !options.allow_write {
            return Err(DriverError::WriteRequiresConfirmation);
        }
        // 元数据语句不支持追加 LIMIT，结果集本身很小，靠客户端截断兜底
        Ok(PreparedSql {
            sql: stmt,
            kind: PreparedSqlKind::Read {
                limit,
                server_capped: false,
            },
            row_limit: limit,
        })
    } else if let Some(tx) = classify_tx_control(&tokens) {
        // 事务控制语句不修改数据，免写确认；能否执行由 pool（拒绝）/ session（允许）路径分别决定
        Ok(PreparedSql {
            sql: stmt,
            kind: PreparedSqlKind::TxControl(tx),
            row_limit: limit,
        })
    } else {
        if !options.allow_write {
            return Err(DriverError::WriteRequiresConfirmation);
        }
        Ok(PreparedSql {
            sql: stmt,
            kind: PreparedSqlKind::Write,
            row_limit: limit,
        })
    }
}

/// EXPLAIN ANALYZE 是否在分析写语句（ANALYZE 变体会真正执行被分析的语句）。
fn explain_analyze_writes(tokens: &[String]) -> bool {
    if tokens.get(1).map(String::as_str) != Some("ANALYZE") {
        return false;
    }
    let analyzed = tokens
        .iter()
        .skip(2)
        .map(String::as_str)
        // 跳过 FORMAT=TREE / FORMAT=JSON 修饰，找到被分析语句的首 token
        .find(|t| !matches!(*t, "FORMAT" | "TREE" | "JSON" | "TRADITIONAL"))
        .unwrap_or_default();
    !matches!(analyzed, "SELECT" | "WITH" | "TABLE")
}

/// 判断能否在语句末尾安全追加 `LIMIT n`：公共阻断词为 LIMIT/FOR/INTO，
/// MySQL 另含 LOCK/PROCEDURE，PostgreSQL 另含 OFFSET/FETCH。
/// 入参须是已抹掉字符串与注释的 sanitized SQL，避免字面量误判。
fn can_append_limit(sanitized_stmt: &str, dialect: SqlDialect) -> bool {
    let mut depth = 0usize;
    let mut word = String::new();
    // 末尾补一个空格，确保最后一个 token 也会被检查
    for ch in sanitized_stmt.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            word.push(ch);
            continue;
        }
        if !word.is_empty() {
            if depth == 0 {
                let word = word.to_ascii_uppercase();
                let common_blocker = matches!(word.as_str(), "LIMIT" | "FOR" | "INTO");
                let dialect_blocker = match dialect {
                    SqlDialect::MySql => matches!(word.as_str(), "LOCK" | "PROCEDURE"),
                    SqlDialect::PostgreSql => matches!(word.as_str(), "OFFSET" | "FETCH"),
                };
                if common_blocker || dialect_blocker {
                    return false;
                }
            }
            word.clear();
        }
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    true
}

fn top_level_words(sanitized_stmt: &str) -> Vec<String> {
    let mut depth = 0usize;
    let mut word = String::new();
    let mut words = Vec::new();
    for ch in sanitized_stmt.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            word.push(ch);
            continue;
        }
        if !word.is_empty() {
            if depth == 0 {
                words.push(word.to_ascii_uppercase());
            }
            word.clear();
        }
        match ch {
            '(' => depth += 1,
            ')' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    words
}

fn trim_trailing_terminators(sql: &str) -> String {
    let mut end = sql.len();
    for (idx, ch) in sql.char_indices().rev() {
        if ch.is_whitespace() || ch == ';' {
            end = idx;
        } else {
            break;
        }
    }
    sql[..end].trim().to_string()
}

fn strip_postgres_dollar_quoted_literals(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut output = String::with_capacity(sql.len());
    let mut index = 0usize;

    while index < chars.len() {
        if chars[index] != '$' {
            output.push(chars[index]);
            index += 1;
            continue;
        }

        let tag_start = index + 1;
        let mut delimiter_end = tag_start;
        if delimiter_end < chars.len()
            && (chars[delimiter_end].is_ascii_alphabetic() || chars[delimiter_end] == '_')
        {
            delimiter_end += 1;
            while delimiter_end < chars.len()
                && (chars[delimiter_end].is_ascii_alphanumeric() || chars[delimiter_end] == '_')
            {
                delimiter_end += 1;
            }
        }

        if delimiter_end >= chars.len() || chars[delimiter_end] != '$' {
            output.push('$');
            index += 1;
            continue;
        }

        let delimiter = &chars[index..=delimiter_end];
        let content_start = delimiter_end + 1;
        let closing_start = (content_start..chars.len()).find(|candidate| {
            chars.get(*candidate..candidate.saturating_add(delimiter.len())) == Some(delimiter)
        });
        let Some(closing_start) = closing_start else {
            output.push('$');
            index += 1;
            continue;
        };
        let quoted_end = closing_start + delimiter.len();
        for character in &chars[index..quoted_end] {
            output.push(if *character == '\n' { '\n' } else { ' ' });
        }
        index = quoted_end;
    }

    output
}

fn strip_literals_and_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut chars = sql.chars().peekable();

    while let Some(ch) = chars.next() {
        match ch {
            '\'' | '"' => {
                let quote = ch;
                out.push(' ');
                let mut escaped = false;
                for c in chars.by_ref() {
                    out.push(if c == '\n' { '\n' } else { ' ' });
                    if c == quote && !escaped {
                        break;
                    }
                    escaped = c == '\\' && !escaped;
                    if c != '\\' {
                        escaped = false;
                    }
                }
            }
            '`' => {
                out.push(' ');
                while let Some(c) = chars.next() {
                    out.push(if c == '\n' { '\n' } else { ' ' });
                    if c == '`' {
                        if chars.peek() == Some(&'`') {
                            out.push(' ');
                            chars.next();
                            continue;
                        }
                        break;
                    }
                }
            }
            '-' if chars.peek() == Some(&'-') => {
                out.push(' ');
                out.push(' ');
                chars.next();
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                    out.push(' ');
                }
            }
            '#' => {
                out.push(' ');
                for c in chars.by_ref() {
                    if c == '\n' {
                        out.push('\n');
                        break;
                    }
                    out.push(' ');
                }
            }
            '/' if chars.peek() == Some(&'*') => {
                out.push(' ');
                out.push(' ');
                chars.next();
                let mut prev = '\0';
                for c in chars.by_ref() {
                    out.push(if c == '\n' { '\n' } else { ' ' });
                    if prev == '*' && c == '/' {
                        break;
                    }
                    prev = c;
                }
            }
            _ => out.push(ch),
        }
    }

    out
}

fn sql_tokens(sanitized_sql: &str) -> Vec<String> {
    sanitized_sql
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_ascii_uppercase())
        .collect()
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
        "VARCHAR" | "CHAR" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT" | "LONGTEXT" | "ENUM" | "SET" => {
            try_decode::<String>(row, idx)
        }
        "JSON" => try_decode::<sqlx::types::JsonValue>(row, idx),
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
    let result = Driver::ping(&driver).await;
    Driver::close(&driver).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tx_control_statements_are_classified_without_write_confirmation() {
        let options = QueryOptions::default();
        let cases: &[(&str, TxControl)] = &[
            ("BEGIN", TxControl::Begin),
            ("begin", TxControl::Begin),
            ("START TRANSACTION", TxControl::Begin),
            ("START TRANSACTION READ WRITE", TxControl::Begin),
            ("COMMIT", TxControl::Commit),
            ("COMMIT AND NO CHAIN", TxControl::Commit),
            ("COMMIT AND CHAIN", TxControl::Begin),
            ("ROLLBACK", TxControl::Rollback),
            ("ROLLBACK AND CHAIN", TxControl::Begin),
            ("-- 先注释\nROLLBACK", TxControl::Rollback),
            ("ROLLBACK TO SAVEPOINT sp1", TxControl::Neutral),
            ("SAVEPOINT sp1", TxControl::Neutral),
            ("RELEASE SAVEPOINT sp1", TxControl::Neutral),
        ];
        for (sql, expected) in cases {
            let prepared = prepare_query_sql(sql, options)
                .unwrap_or_else(|e| panic!("{sql} 应通过 guard: {e:?}"));
            assert!(
                matches!(prepared.kind, PreparedSqlKind::TxControl(tx) if tx == *expected),
                "{sql} 应识别为 TxControl::{expected:?}"
            );
            let prepared_pg = prepare_query_sql_for_dialect(sql, options, SqlDialect::PostgreSql)
                .unwrap_or_else(|e| panic!("PG: {sql} 应通过 guard: {e:?}"));
            assert!(
                matches!(prepared_pg.kind, PreparedSqlKind::TxControl(tx) if tx == *expected),
                "PG: {sql} 应识别为 TxControl::{expected:?}"
            );
        }
    }

    #[test]
    fn tx_keywords_inside_literals_are_not_tx_control() {
        let options = QueryOptions::default();
        // 字符串 / 注释里的 BEGIN 不触发事务控制分类
        let prepared = prepare_query_sql("SELECT 'BEGIN'", options).expect("字面量应忽略");
        assert!(matches!(prepared.kind, PreparedSqlKind::Read { .. }));
        let prepared = prepare_query_sql("SELECT 1 /* COMMIT */", options).expect("注释应忽略");
        assert!(matches!(prepared.kind, PreparedSqlKind::Read { .. }));
    }

    #[test]
    fn session_trait_is_object_safe() {
        fn accept_session_object(_session: &dyn DriverSession) {}
        let _object_safe_check: fn(&dyn DriverSession) = accept_session_object;
    }

    #[test]
    fn filter_clause_escapes_identifiers_and_parameterizes_values() {
        let (sql, binds) = build_filter_clause(
            &[
                TableFilter {
                    column: "user`name".to_string(),
                    op: FilterOp::Eq,
                    value: "42".to_string(),
                },
                TableFilter {
                    column: "note".to_string(),
                    op: FilterOp::Like,
                    value: "%a%".to_string(),
                },
                TableFilter {
                    column: "deleted".to_string(),
                    op: FilterOp::IsNull,
                    value: String::new(),
                },
            ],
            quote_mysql_ident,
            |_| "?".to_string(),
        );
        assert_eq!(
            sql,
            " WHERE `user``name` = ? AND `note` LIKE ? AND `deleted` IS NULL"
        );
        assert_eq!(
            binds,
            vec![FilterValue::Int(42), FilterValue::Text("%a%".to_string())]
        );

        // 注入尝试：值绝不进入 SQL 文本
        let (sql, binds) = build_filter_clause(
            &[TableFilter {
                column: "id".to_string(),
                op: FilterOp::Eq,
                value: "1 OR 1=1; DROP TABLE users".to_string(),
            }],
            quote_mysql_ident,
            |_| "?".to_string(),
        );
        assert!(!sql.contains("DROP"), "注入文本不得进入 SQL: {sql}");
        assert_eq!(binds.len(), 1);
    }

    #[test]
    fn pg_filter_clause_uses_numbered_placeholders() {
        let (sql, binds) = build_filter_clause(
            &[
                TableFilter {
                    column: "a".to_string(),
                    op: FilterOp::Eq,
                    value: "1".to_string(),
                },
                TableFilter {
                    column: "b".to_string(),
                    op: FilterOp::NotEq,
                    value: "x".to_string(),
                },
            ],
            quote_pg_ident,
            |n| format!("${n}"),
        );
        assert_eq!(sql, " WHERE \"a\" = $1 AND \"b\" <> $2");
        assert_eq!(binds.len(), 2);
    }

    #[test]
    fn filter_value_prefers_numeric_binding() {
        assert_eq!(parse_filter_value("42"), FilterValue::Int(42));
        assert_eq!(parse_filter_value(" 42 "), FilterValue::Int(42));
        assert_eq!(parse_filter_value("4.5"), FilterValue::Float(4.5));
        assert_eq!(parse_filter_value("1e5"), FilterValue::Float(100000.0));
        assert_eq!(
            parse_filter_value("NaN"),
            FilterValue::Text("NaN".to_string())
        );
        assert_eq!(
            parse_filter_value("042x"),
            FilterValue::Text("042x".to_string())
        );
        assert_eq!(parse_filter_value(""), FilterValue::Text(String::new()));
    }

    #[test]
    fn split_statements_handles_literals_comments_and_dollar_quotes() {
        // 普通拆分
        assert_eq!(
            split_statements("SELECT 1; SELECT 2;", SqlDialect::MySql).unwrap(),
            vec!["SELECT 1", "SELECT 2"]
        );
        // 字符串 / 注释 / 标识符内的分号不切
        assert_eq!(
            split_statements("SELECT ';' AS s; -- 注释;\nSELECT 2", SqlDialect::MySql).unwrap(),
            vec!["SELECT ';' AS s", "-- 注释;\nSELECT 2"]
        );
        assert_eq!(
            split_statements("SELECT `a;b` FROM t; SELECT 'it\\'s;x'", SqlDialect::MySql).unwrap(),
            vec!["SELECT `a;b` FROM t", "SELECT 'it\\'s;x'"]
        );
        // 块注释与空语句
        assert_eq!(
            split_statements("/* ; */;; SELECT 1;;", SqlDialect::MySql).unwrap(),
            vec!["/* ; */", "SELECT 1"]
        );
        // PG dollar-quoted body 内的分号不切
        let pg_sql = "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN RAISE NOTICE 'x;y'; END; $body$ LANGUAGE plpgsql; SELECT 1";
        let parts = split_statements(pg_sql, SqlDialect::PostgreSql).unwrap();
        assert_eq!(parts.len(), 2);
        assert!(parts[0].contains("RAISE NOTICE"));
        assert_eq!(parts[1], "SELECT 1");
        // $$ 空 tag
        assert_eq!(
            split_statements(
                "DO $$ BEGIN RAISE NOTICE 'a;b'; END $$; SELECT 2",
                SqlDialect::PostgreSql
            )
            .unwrap()
            .len(),
            2
        );
        // 未闭合 → 拒绝
        assert!(split_statements("SELECT 'abc", SqlDialect::MySql).is_err());
        assert!(split_statements("SELECT $body$ x", SqlDialect::PostgreSql).is_err());
        assert!(split_statements("/* abc", SqlDialect::MySql).is_err());
        // 纯空白/全分号 → InvalidSql
        assert!(split_statements(" ; ; ", SqlDialect::MySql).is_err());
        // PG 的 $1 占位符样式不误判为 dollar-quote
        assert_eq!(
            split_statements("SELECT $1::int; SELECT 2", SqlDialect::PostgreSql)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn prepare_statements_rejects_tx_control_in_scripts() {
        let options = QueryOptions {
            row_limit: 10,
            allow_write: true,
        };
        let error = prepare_statements("SELECT 1; BEGIN; SELECT 2", options, SqlDialect::MySql)
            .expect_err("脚本含事务语句必须整体拒绝");
        assert!(matches!(error, DriverError::TxRequiresSession));
        // 写语句未确认时整体拒绝且不执行
        let error = prepare_statements(
            "SELECT 1; UPDATE t SET a = 1",
            QueryOptions::default(),
            SqlDialect::MySql,
        )
        .expect_err("写语句未确认必须拒绝");
        assert!(matches!(error, DriverError::WriteRequiresConfirmation));
    }

    #[test]
    fn mysql_driver_implements_object_safe_driver_contract() {
        fn assert_driver<T: Driver>() {}
        fn accept_driver_object(_driver: &dyn Driver) {}

        assert_driver::<MySqlDriver>();
        let _object_safe_check: fn(&dyn Driver) = accept_driver_object;
    }

    #[test]
    fn postgres_driver_implements_object_safe_driver_contract() {
        fn assert_driver<T: Driver>() {}

        assert_driver::<PostgresDriver>();
    }

    #[test]
    fn metadata_scope_keeps_postgres_schema_distinct() {
        assert_eq!(
            MetadataScope::mysql("app"),
            MetadataScope {
                database: "app".to_string(),
                schema: None,
            }
        );
        assert_eq!(
            MetadataScope::postgresql("app", "audit"),
            MetadataScope {
                database: "app".to_string(),
                schema: Some("audit".to_string()),
            }
        );
    }

    #[test]
    fn mysql_tls_errors_classify_into_actionable_keys() {
        // 证书/主机名验证失败 → tls_verify_failed
        let verify = classify_mysql_connect_error(
            "error:0A000086:SSL routines::certificate verify failed".to_string(),
            MySqlTlsMode::VerifyCa,
        );
        assert_eq!(verify.i18n_key(), "error.driver.tls_verify_failed");

        let hostname = classify_mysql_connect_error(
            "invalid peer certificate: NotValidForName".to_string(),
            MySqlTlsMode::VerifyIdentity,
        );
        assert_eq!(hostname.i18n_key(), "error.driver.tls_verify_failed");

        // 握手/协议失败 → tls_handshake_failed
        let handshake = classify_mysql_connect_error(
            "error:1408F10B:SSL routines:ssl3_get_record:wrong version number".to_string(),
            MySqlTlsMode::Required,
        );
        assert_eq!(handshake.i18n_key(), "error.driver.tls_handshake_failed");

        // 与 TLS 无关的错误即使启用 TLS 也保持通用 key
        let auth = classify_mysql_connect_error(
            "Access denied for user 'root'@'%'".to_string(),
            MySqlTlsMode::Required,
        );
        assert_eq!(auth.i18n_key(), "error.driver.connect_failed");

        // Disabled 模式永不分类为 TLS 问题
        let plain = classify_mysql_connect_error(
            "tls handshake error: disabled mode should not see this".to_string(),
            MySqlTlsMode::Disabled,
        );
        assert_eq!(plain.i18n_key(), "error.driver.connect_failed");
    }

    #[test]
    fn query_error_extracts_only_positive_mysql_line_number() {
        let error = DriverError::QueryFailed(
            "You have an error in your SQL syntax near 'private_data' at line 23".to_string(),
        );
        assert_eq!(error.sql_line(), Some(23));
        assert_eq!(error.i18n_key(), "error.driver.query_failed");
        assert_eq!(error.to_string(), "error.driver.query_failed");

        assert_eq!(
            DriverError::QueryFailed("database failed".to_string()).sql_line(),
            None
        );
    }

    #[tokio::test]
    async fn postgres_invalid_url_uses_stable_connect_error_key() {
        let error = PostgresDriver::connect_url("not-a-postgres-url")
            .await
            .err()
            .expect("非法 URL 必须失败");
        assert_eq!(error.i18n_key(), "error.driver.connect_failed");
        assert_eq!(error.to_string(), "error.driver.connect_failed");
    }

    #[test]
    fn select_gets_appended_limit() {
        let prepared = prepare_query_sql(
            "SELECT * FROM orders ORDER BY id DESC;",
            QueryOptions::table_preview(),
        )
        .expect("SELECT 应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: 1_000,
                server_capped: true
            }
        );
        assert_eq!(
            prepared.sql,
            "SELECT * FROM orders ORDER BY id DESC\nLIMIT 1001"
        );
    }

    #[test]
    fn join_select_star_is_not_wrapped() {
        // 回归：derived table 包装会让 JOIN 的重名列报 1060 Duplicate column name
        let prepared = prepare_query_sql(
            "SELECT * FROM orders o JOIN users u ON o.user_id = u.id",
            QueryOptions::default(),
        )
        .expect("JOIN SELECT * 应通过");

        assert!(!prepared.sql.contains("tiny_sql_limited"));
        assert!(prepared
            .sql
            .starts_with("SELECT * FROM orders o JOIN users u"));
        assert!(prepared.sql.ends_with("\nLIMIT 100001"));
    }

    #[test]
    fn cte_select_is_treated_as_read_query() {
        let prepared = prepare_query_sql(
            "WITH recent AS (SELECT id FROM orders) SELECT * FROM recent",
            QueryOptions {
                row_limit: 20,
                allow_write: false,
            },
        )
        .expect("CTE SELECT 应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: 20,
                server_capped: true
            }
        );
        assert!(prepared.sql.ends_with("LIMIT 21"));
    }

    #[test]
    fn cte_write_still_requires_confirmation() {
        let error = prepare_query_sql_for_dialect(
            "WITH changed AS (SELECT 1) UPDATE orders SET status = 1",
            QueryOptions::default(),
            SqlDialect::PostgreSql,
        )
        .expect_err("CTE 外层写语句不能绕过确认");

        assert!(matches!(error, DriverError::WriteRequiresConfirmation));

        let error = prepare_query_sql_for_dialect(
            "WITH changed AS (DELETE FROM orders RETURNING id) SELECT * FROM changed",
            QueryOptions::default(),
            SqlDialect::PostgreSql,
        )
        .expect_err("数据修改 CTE 不能伪装成外层 SELECT 绕过确认");
        assert!(matches!(error, DriverError::WriteRequiresConfirmation));
    }

    #[test]
    fn postgres_table_and_values_are_read_queries() {
        for sql in ["TABLE pg_catalog.pg_type", "VALUES (1), (2)"] {
            let prepared = prepare_query_sql_for_dialect(
                sql,
                QueryOptions {
                    row_limit: 10,
                    allow_write: false,
                },
                SqlDialect::PostgreSql,
            )
            .unwrap_or_else(|error| panic!("{sql} 应按 PostgreSQL 读查询处理: {error}"));
            assert_eq!(
                prepared.kind,
                PreparedSqlKind::Read {
                    limit: 10,
                    server_capped: true,
                }
            );
            assert!(prepared.sql.ends_with("LIMIT 11"));
        }
    }

    #[test]
    fn postgres_offset_keeps_original_clause_order() {
        let prepared = prepare_query_sql_for_dialect(
            "SELECT * FROM orders OFFSET 10",
            QueryOptions::default(),
            SqlDialect::PostgreSql,
        )
        .expect("PostgreSQL OFFSET 查询应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: QUERY_RESULT_LIMIT,
                server_capped: false,
            }
        );
        assert_eq!(prepared.sql, "SELECT * FROM orders OFFSET 10");
    }

    #[test]
    fn postgres_dollar_quoted_body_is_one_write_statement() {
        let sql = "DO $body$ BEGIN RAISE NOTICE 'first;second'; END $body$;";
        let error =
            prepare_query_sql_for_dialect(sql, QueryOptions::default(), SqlDialect::PostgreSql)
                .expect_err("DO 语句仍需写确认");
        assert!(matches!(error, DriverError::WriteRequiresConfirmation));

        let prepared = prepare_query_sql_for_dialect(
            sql,
            QueryOptions {
                row_limit: 10,
                allow_write: true,
            },
            SqlDialect::PostgreSql,
        )
        .expect("dollar-quoted body 内的分号不应误判为多语句");
        assert_eq!(prepared.kind, PreparedSqlKind::Write);
    }

    #[test]
    fn postgres_parameter_placeholder_is_not_dollar_quote() {
        let prepared = prepare_query_sql_for_dialect(
            "SELECT $1::BIGINT",
            QueryOptions::default(),
            SqlDialect::PostgreSql,
        )
        .expect("$1 参数占位符不应被当成 dollar quote");
        assert!(matches!(prepared.kind, PreparedSqlKind::Read { .. }));
    }

    #[test]
    fn existing_top_level_limit_is_kept_as_is() {
        let prepared = prepare_query_sql("SELECT * FROM t LIMIT 5", QueryOptions::default())
            .expect("带 LIMIT 的 SELECT 应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: QUERY_RESULT_LIMIT,
                server_capped: false
            }
        );
        assert_eq!(prepared.sql, "SELECT * FROM t LIMIT 5");
    }

    #[test]
    fn subquery_limit_still_gets_server_cap() {
        // 子查询里的 LIMIT 在括号内（深度 > 0），不影响顶层追加
        let prepared = prepare_query_sql(
            "SELECT * FROM (SELECT * FROM t LIMIT 10) x",
            QueryOptions::default(),
        )
        .expect("子查询 LIMIT 应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: QUERY_RESULT_LIMIT,
                server_capped: true
            }
        );
        assert!(prepared.sql.ends_with("\nLIMIT 100001"));
    }

    #[test]
    fn locking_reads_skip_limit_append() {
        // LIMIT 必须出现在 FOR UPDATE 之前，追加会产生语法错误，改由客户端截断兜底
        let prepared = prepare_query_sql(
            "SELECT * FROM t WHERE id = 1 FOR UPDATE",
            QueryOptions::default(),
        )
        .expect("FOR UPDATE 读查询应通过");

        assert_eq!(
            prepared.kind,
            PreparedSqlKind::Read {
                limit: QUERY_RESULT_LIMIT,
                server_capped: false
            }
        );
        assert_eq!(prepared.sql, "SELECT * FROM t WHERE id = 1 FOR UPDATE");
    }

    #[test]
    fn meta_statements_run_without_confirmation() {
        for sql in [
            "SHOW TABLES",
            "SHOW CREATE TABLE users",
            "EXPLAIN SELECT * FROM users",
            "DESC users",
            "DESCRIBE users",
        ] {
            let prepared = prepare_query_sql(sql, QueryOptions::default())
                .unwrap_or_else(|e| panic!("{sql} 应无需确认直接执行: {e}"));
            assert_eq!(
                prepared.kind,
                PreparedSqlKind::Read {
                    limit: QUERY_RESULT_LIMIT,
                    server_capped: false
                },
                "{sql} 应按读查询 fetch 结果集"
            );
            assert_eq!(prepared.sql, sql, "元数据语句不应被改写");
        }
    }

    #[test]
    fn explain_analyze_of_write_requires_confirmation() {
        // EXPLAIN ANALYZE 会真正执行被分析的语句
        let err = prepare_query_sql(
            "EXPLAIN ANALYZE UPDATE t SET x = 1",
            QueryOptions::default(),
        )
        .expect_err("EXPLAIN ANALYZE 写语句必须确认");
        assert!(matches!(err, DriverError::WriteRequiresConfirmation));

        let prepared = prepare_query_sql(
            "EXPLAIN ANALYZE FORMAT=TREE SELECT * FROM t",
            QueryOptions::default(),
        )
        .expect("EXPLAIN ANALYZE SELECT 无需确认");
        assert!(matches!(prepared.kind, PreparedSqlKind::Read { .. }));
    }

    #[test]
    fn semicolon_inside_string_and_comments_is_not_multi_statement() {
        let prepared = prepare_query_sql(
            "SELECT ';' AS semi, 'UPDATE not write' AS s -- DELETE comment\nFROM dual;",
            QueryOptions::default(),
        )
        .expect("字符串和注释里的分号/写关键字应忽略");

        assert!(matches!(prepared.kind, PreparedSqlKind::Read { .. }));
    }

    #[test]
    fn multiple_statements_are_rejected() {
        let err = prepare_query_sql("SELECT 1; SELECT 2", QueryOptions::default())
            .expect_err("多语句必须拒绝");
        assert!(matches!(err, DriverError::MultipleStatements));
    }

    #[test]
    fn write_statement_requires_confirmation() {
        let err = prepare_query_sql("UPDATE orders SET status = 1", QueryOptions::default())
            .expect_err("未确认写操作必须拒绝");
        assert!(matches!(err, DriverError::WriteRequiresConfirmation));

        let prepared = prepare_query_sql(
            "UPDATE orders SET status = 1",
            QueryOptions {
                row_limit: 10,
                allow_write: true,
            },
        )
        .expect("确认后允许执行单条写 SQL");
        assert_eq!(prepared.kind, PreparedSqlKind::Write);
        assert_eq!(prepared.sql, "UPDATE orders SET status = 1");
    }

    #[test]
    fn mysql_url_defaults_to_ssl_disabled() {
        let opts = mysql_options_from_url("mysql://root:password@127.0.0.1:3306/test")
            .expect("URL 应能解析");

        assert!(matches!(opts.get_ssl_mode(), MySqlSslMode::Disabled));
    }

    #[test]
    fn mysql_url_honors_explicit_ssl_mode() {
        let opts =
            mysql_options_from_url("mysql://root:password@127.0.0.1:3306/test?ssl-mode=preferred")
                .expect("URL 应能解析");

        assert!(matches!(opts.get_ssl_mode(), MySqlSslMode::Preferred));
    }

    #[test]
    fn mysql_tls_mode_parses_frontend_values() {
        assert_eq!(
            "verify_identity".parse::<MySqlTlsMode>().unwrap(),
            MySqlTlsMode::VerifyIdentity
        );
        assert!("unknown".parse::<MySqlTlsMode>().is_err());
    }

    #[test]
    fn create_database_sql_quotes_name_and_options() {
        assert_eq!(
            build_create_database_sql("app", None, None).unwrap(),
            "CREATE DATABASE `app`"
        );
        assert_eq!(
            build_create_database_sql("new`db", Some("utf8mb4"), Some("utf8mb4_unicode_ci"))
                .unwrap(),
            "CREATE DATABASE `new``db` DEFAULT CHARACTER SET = utf8mb4 DEFAULT COLLATE = utf8mb4_unicode_ci"
        );
    }

    #[test]
    fn create_database_sql_rejects_invalid_identifiers() {
        assert!(matches!(
            build_create_database_sql("", None, None),
            Err(DriverError::InvalidIdentifier)
        ));
        assert!(matches!(
            build_create_database_sql("app", Some("utf8mb4;DROP"), None),
            Err(DriverError::InvalidIdentifier)
        ));
    }

    // === FR-250 编辑内核：DML 生成 ===

    fn cell(column: &str, value: Option<&str>) -> EditCell {
        EditCell {
            column: column.to_string(),
            value: value.map(str::to_string),
        }
    }

    #[test]
    fn edit_sql_insert_parameterizes_values_and_writes_null_literal() {
        let edit = TableEdit::Insert {
            values: vec![
                cell("id", Some("42")),
                cell("name", Some("含;注入")),
                cell("note", None),
            ],
        };
        let (sql, binds) = build_edit_sql(&edit, "`app`.`users`", quote_mysql_ident, |_| {
            "?".to_string()
        })
        .expect("Insert 应生成 SQL");
        assert_eq!(
            sql,
            "INSERT INTO `app`.`users` (`id`, `name`, `note`) VALUES (?, ?, NULL)"
        );
        assert_eq!(binds.len(), 2);
        assert!(matches!(binds[0], FilterValue::Int(42)));
        assert!(matches!(&binds[1], FilterValue::Text(v) if v == "含;注入"));
    }

    #[test]
    fn edit_sql_update_builds_set_and_pk_where() {
        let edit = TableEdit::Update {
            pk: vec![cell("id", Some("7"))],
            changes: vec![
                cell("name", Some("new")),
                cell("score", Some("9.5")),
                cell("note", None),
            ],
        };
        let (sql, binds) = build_edit_sql(&edit, "\"public\".\"users\"", quote_pg_ident, |n| {
            format!("${n}")
        })
        .expect("Update 应生成 SQL");
        assert_eq!(
            sql,
            "UPDATE \"public\".\"users\" SET \"name\" = $1, \"score\" = $2, \"note\" = NULL WHERE \"id\" = $3"
        );
        assert_eq!(binds.len(), 3);
        assert!(matches!(&binds[0], FilterValue::Text(v) if v == "new"));
        assert!(matches!(binds[1], FilterValue::Float(v) if (v - 9.5).abs() < f64::EPSILON));
        assert!(matches!(binds[2], FilterValue::Int(7)));
    }

    #[test]
    fn edit_sql_delete_uses_pk_where_with_is_null_fallback() {
        let edit = TableEdit::Delete {
            pk: vec![cell("id", Some("1")), cell("sub_id", None)],
        };
        let (sql, binds) =
            build_edit_sql(&edit, "`app`.`t`", quote_mysql_ident, |_| "?".to_string())
                .expect("Delete 应生成 SQL");
        assert_eq!(
            sql,
            "DELETE FROM `app`.`t` WHERE `id` = ? AND `sub_id` IS NULL"
        );
        assert_eq!(binds.len(), 1);
    }

    #[test]
    fn edit_sql_escapes_identifiers() {
        let edit = TableEdit::Insert {
            values: vec![cell("we`ird", Some("1"))],
        };
        let (sql, _) = build_edit_sql(&edit, "`d``b`.`t`", quote_mysql_ident, |_| "?".to_string())
            .expect("Insert 应生成 SQL");
        assert_eq!(sql, "INSERT INTO `d``b`.`t` (`we``ird`) VALUES (?)");

        let (sql, _) = build_edit_sql(&edit, "\"s\".\"t\"", quote_pg_ident, |n| format!("${n}"))
            .expect("PG Insert 应生成 SQL");
        assert!(sql.contains("\"we`ird\""), "PG 列名应双引号引用: {sql}");
    }

    #[test]
    fn edit_sql_skips_noop_edits() {
        assert!(build_edit_sql(
            &TableEdit::Insert { values: vec![] },
            "`d`.`t`",
            quote_mysql_ident,
            |_| "?".to_string()
        )
        .is_none());
        assert!(build_edit_sql(
            &TableEdit::Update {
                pk: vec![cell("id", Some("1"))],
                changes: vec![]
            },
            "`d`.`t`",
            quote_mysql_ident,
            |_| "?".to_string()
        )
        .is_none());
        assert!(build_edit_sql(
            &TableEdit::Delete { pk: vec![] },
            "`d`.`t`",
            quote_mysql_ident,
            |_| "?".to_string()
        )
        .is_none());
    }

    #[test]
    fn edit_errors_expose_stable_keys_and_index() {
        assert_eq!(
            DriverError::NoPrimaryKey.i18n_key(),
            "error.driver.no_primary_key"
        );
        let failed = DriverError::EditApplyFailed {
            index: 2,
            detail: "dup".into(),
        };
        assert_eq!(failed.i18n_key(), "error.driver.edit_apply_failed");
        assert_eq!(failed.edit_index(), Some(2));
        assert_eq!(failed.sql_line(), None);
        let conflict = DriverError::EditConflict { index: 0 };
        assert_eq!(conflict.i18n_key(), "error.driver.edit_conflict");
        assert_eq!(conflict.edit_index(), Some(0));
        assert_eq!(DriverError::QueryCancelled.edit_index(), None);
    }
}
