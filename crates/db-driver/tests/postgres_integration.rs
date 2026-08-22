//! 连真实 PostgreSQL 的 integration 测试。
//!
//! 测试默认忽略；配置 `TINY_SQL_TEST_POSTGRES_URL` 后用
//! `just test-postgres-integration` 执行。项目不为 integration 测试启动 Docker。

use std::str::FromStr;
use std::time::Duration;

use bigdecimal::BigDecimal;
use db_driver::{
    Driver, DriverError, MetadataScope, PostgresDriver, QueryOptions, QUERY_RESULT_LIMIT,
};
use tokio_util::sync::CancellationToken;

fn postgres_url() -> String {
    std::env::var("TINY_SQL_TEST_POSTGRES_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .expect("未设置 TINY_SQL_TEST_POSTGRES_URL，不能把 PostgreSQL integration 记为通过")
}

async fn connect() -> PostgresDriver {
    PostgresDriver::connect_url(&postgres_url())
        .await
        .expect("PostgreSQL 连接失败")
}

#[tokio::test]
#[ignore = "需要本地 PostgreSQL：设置 TINY_SQL_TEST_POSTGRES_URL 后运行 just test-postgres-integration"]
async fn postgres_ping_returns_one() {
    let driver = connect().await;
    assert_eq!(driver.ping().await.expect("PostgreSQL ping 失败"), 1);
    driver.close().await;
}

#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_metadata_keeps_database_and_schema_layers() {
    let driver = connect().await;
    let databases = driver
        .list_databases()
        .await
        .expect("database metadata 失败");
    let current = databases
        .iter()
        .find(|database| database.is_current)
        .expect("应标记当前 database")
        .name
        .clone();

    let schemas = driver
        .list_schemas(&current)
        .await
        .expect("schema metadata 失败");
    assert!(schemas.iter().any(|schema| schema.name == "pg_catalog"));

    let scope = MetadataScope::postgresql(&current, "pg_catalog");
    let tables = driver
        .list_tables(&scope)
        .await
        .expect("table metadata 失败");
    assert!(tables.iter().any(|table| table.name == "pg_type"));

    let columns = driver
        .list_columns(&scope, "pg_type")
        .await
        .expect("column metadata 失败");
    assert!(columns.iter().any(|column| column.name == "typname"));

    let error = driver
        .list_schemas("tiny_sql_non_current_database")
        .await
        .expect_err("不能在同一 PostgreSQL 连接上静默切换 database");
    assert!(matches!(error, DriverError::DatabaseSwitchRequired));
    driver.close().await;
}

#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_query_decodes_values_and_enforces_guards() {
    let driver = connect().await;
    let result = driver
        .query(
            "SELECT NULL::TEXT AS null_value, \
                    DATE '2026-08-18' AS date_value, \
                    42::BIGINT AS integer_value, \
                    12.34::NUMERIC AS numeric_value, \
                    '{\"ok\":true}'::JSONB AS json_value",
        )
        .await
        .expect("PostgreSQL 基本类型解码失败");
    assert_eq!(
        result.columns,
        [
            "null_value",
            "date_value",
            "integer_value",
            "numeric_value",
            "json_value",
        ]
    );
    assert_eq!(result.rows.len(), 1);
    assert_eq!(result.rows[0][0], None);
    assert_eq!(result.rows[0][1].as_deref(), Some("2026-08-18"));
    assert_eq!(result.rows[0][2].as_deref(), Some("42"));
    assert_eq!(
        result.rows[0][3]
            .as_deref()
            .and_then(|value| BigDecimal::from_str(value).ok()),
        Some(BigDecimal::from_str("12.34").expect("测试数值应合法")),
    );
    assert_eq!(result.rows[0][4].as_deref(), Some("{\"ok\":true}"));

    let limited = driver
        .query_with_options(
            "SELECT generate_series(1, 3) AS value",
            QueryOptions {
                row_limit: 2,
                allow_write: false,
            },
            CancellationToken::new(),
        )
        .await
        .expect("PostgreSQL 行数上限查询失败");
    assert_eq!(limited.rows.len(), 2);
    assert!(limited.truncated);

    let error = driver
        .query_with_options(
            "SET application_name = 'tiny-sql-integration'",
            QueryOptions::default(),
            CancellationToken::new(),
        )
        .await
        .expect_err("未确认写操作必须拒绝");
    assert!(matches!(error, DriverError::WriteRequiresConfirmation));

    let write_result = driver
        .query_with_options(
            "SET application_name = 'tiny-sql-integration'",
            QueryOptions {
                row_limit: QUERY_RESULT_LIMIT,
                allow_write: true,
            },
            CancellationToken::new(),
        )
        .await
        .expect("确认后的 PostgreSQL 写操作应执行");
    assert_eq!(write_result.columns, ["affected_rows"]);
    driver.close().await;
}

#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_cancel_long_query_returns_query_cancelled() {
    let driver = connect().await;
    let query_driver = driver.clone();
    let cancel_token = CancellationToken::new();
    let query_token = cancel_token.clone();
    let task = tokio::spawn(async move {
        query_driver
            .query_with_options("SELECT pg_sleep(10)", QueryOptions::default(), query_token)
            .await
    });

    tokio::time::sleep(Duration::from_millis(150)).await;
    cancel_token.cancel();
    let result = tokio::time::timeout(Duration::from_secs(5), task)
        .await
        .expect("取消后 5 秒内应结束")
        .expect("query task 不应 panic");
    assert!(matches!(result, Err(DriverError::QueryCancelled)));
    assert_eq!(driver.ping().await.expect("取消后连接池应继续可用"), 1);
    driver.close().await;
}

// === FR-244 独占 session 与可靠事务 ===

fn write_opts() -> QueryOptions {
    QueryOptions {
        row_limit: 100,
        allow_write: true,
    }
}

fn read_opts() -> QueryOptions {
    QueryOptions {
        row_limit: 100,
        allow_write: false,
    }
}

async fn count_probe(driver: &PostgresDriver) -> String {
    driver
        .query("SELECT COUNT(*) FROM tx_session_probe")
        .await
        .expect("COUNT 查询失败")
        .rows[0][0]
        .clone()
        .expect("COUNT 不应为 NULL")
}

/// pool 路径必须拒绝事务控制语句，防事务状态泄漏给下一个借用者。
#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_pool_rejects_tx_control_statements() {
    let driver = connect().await;
    for sql in ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT sp1"] {
        let error = driver
            .query_with_options(sql, write_opts(), CancellationToken::new())
            .await
            .expect_err("pool 路径必须拒绝事务控制语句");
        assert!(
            matches!(error, DriverError::TxRequiresSession),
            "{sql} 应返回 TxRequiresSession，实际: {error:?}"
        );
    }
    driver.close().await;
}

/// session 全流程：同连接证明、回滚、未提交 close 自动回滚、提交生效、aborted 恢复。
#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_session_pins_connection_and_handles_aborted() {
    let driver = connect().await;
    driver
        .query_with_options(
            "DROP TABLE IF EXISTS tx_session_probe",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("清理旧表失败");
    driver
        .query_with_options(
            "CREATE TABLE tx_session_probe (id INT PRIMARY KEY)",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("建表失败");

    // 同一连接证明：session 内两次 pg_backend_pid() 必须一致
    let mut session = driver.begin_session().await.expect("begin_session 失败");
    assert!(session.in_transaction());
    let first = session
        .query(
            "SELECT pg_backend_pid()",
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("session 查询失败");
    let second = session
        .query(
            "SELECT pg_backend_pid()",
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("session 查询失败");
    assert_eq!(
        first.rows[0][0], second.rows[0][0],
        "session 内所有语句必须落同一物理连接"
    );

    // 事务内写入 → ROLLBACK → 表仍为空
    session
        .query(
            "INSERT INTO tx_session_probe VALUES (1)",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("事务内写入失败");
    session.rollback().await.expect("回滚失败");
    assert!(!session.in_transaction());
    assert_eq!(count_probe(&driver).await, "0", "回滚后表必须为空");

    // PG 特有：事务内出错进入 aborted，后续语句报错；ROLLBACK 后恢复可用
    session
        .query("BEGIN", read_opts(), CancellationToken::new())
        .await
        .expect("手写 BEGIN 应允许且免写确认");
    assert!(session.in_transaction());
    let aborted = session
        .query(
            "SELECT * FROM table_not_exists_12345",
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect_err("不存在的表必须报错");
    assert!(matches!(aborted, DriverError::QueryFailed(_)));
    assert!(
        session.in_transaction(),
        "aborted 事务仍应标记为进行中（待 ROLLBACK 恢复）"
    );
    let still_aborted = session
        .query("SELECT 1", read_opts(), CancellationToken::new())
        .await
        .expect_err("aborted 事务内任何语句都应报 QueryFailed");
    assert!(matches!(still_aborted, DriverError::QueryFailed(_)));
    session
        .rollback()
        .await
        .expect("ROLLBACK 应能恢复 aborted 事务");
    assert!(!session.in_transaction());
    session.close().await;

    // 事务内写入 → close（未提交）→ 自动回滚
    let mut session = driver.begin_session().await.expect("begin_session 失败");
    session
        .query(
            "INSERT INTO tx_session_probe VALUES (2)",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("事务内写入失败");
    session.close().await;
    assert_eq!(count_probe(&driver).await, "0", "close 未提交必须回滚");

    // 事务内写入 → COMMIT → 生效
    let mut session = driver.begin_session().await.expect("begin_session 失败");
    session
        .query(
            "INSERT INTO tx_session_probe VALUES (3)",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("事务内写入失败");
    session.commit().await.expect("提交失败");
    assert_eq!(count_probe(&driver).await, "1", "提交后必须可见");
    session.close().await;

    driver
        .query_with_options(
            "DROP TABLE tx_session_probe",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("清理失败");
    driver.close().await;
}

// === FR-242 表数据服务端筛选 / 排序 / 分页 ===

/// 浏览查询：筛选、排序、分页与总行数（PG 方言：$N 占位符、双引号引用、严格类型绑定）。
#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_browse_table_filters_sorts_and_paginates() {
    use db_driver::{FilterOp, TableBrowseQuery, TableFilter, TableOrder};
    let driver = connect().await;
    driver
        .query_with_options(
            "DROP TABLE IF EXISTS tx_browse_probe",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("清理旧表失败");
    driver
        .query_with_options(
            "CREATE TABLE tx_browse_probe (id INT PRIMARY KEY, name VARCHAR(50), note VARCHAR(50) NULL)",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("建表失败");
    let mut values = Vec::new();
    for i in 1..=15 {
        let note = if i % 5 == 0 {
            "NULL".to_string()
        } else {
            format!("'n{i}'")
        };
        values.push(format!("({i}, 'name{i}', {note})"));
    }
    driver
        .query_with_options(
            &format!("INSERT INTO tx_browse_probe VALUES {}", values.join(",")),
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("写入测试数据失败");

    // 当前 database / public schema
    let current_db = driver
        .query("SELECT current_database()")
        .await
        .expect("查询当前库失败");
    let db_name = current_db.rows[0][0].clone().expect("库名不为空");
    let scope = MetadataScope::postgresql(db_name, "public");

    // 筛选 id > 10（数值绑定）+ 降序：5 行
    let filtered = driver
        .browse_table(
            &scope,
            "tx_browse_probe",
            &TableBrowseQuery {
                filters: vec![TableFilter {
                    column: "id".to_string(),
                    op: FilterOp::Gt,
                    value: "10".to_string(),
                }],
                order: Some(TableOrder {
                    column: "id".to_string(),
                    descending: true,
                }),
                limit: 10,
                offset: 0,
            },
            CancellationToken::new(),
        )
        .await
        .expect("浏览失败");
    assert_eq!(filtered.total, Some(5));
    assert!(!filtered.has_next_page);
    assert_eq!(filtered.row_set.rows.len(), 5);
    assert_eq!(filtered.row_set.rows[0][0].as_deref(), Some("15"));

    // 文本筛选（LIKE）+ 分页
    let page = driver
        .browse_table(
            &scope,
            "tx_browse_probe",
            &TableBrowseQuery {
                filters: vec![TableFilter {
                    column: "name".to_string(),
                    op: FilterOp::Like,
                    value: "name1%".to_string(),
                }],
                order: Some(TableOrder {
                    column: "id".to_string(),
                    descending: false,
                }),
                limit: 5,
                offset: 0,
            },
            CancellationToken::new(),
        )
        .await
        .expect("浏览失败");
    // name1, name10..name15 共 7 行
    assert_eq!(page.total, Some(7));
    assert!(page.has_next_page);
    assert_eq!(page.row_set.rows.len(), 5);

    // 空结果集仍返回列头（list_columns 兜底）
    let empty = driver
        .browse_table(
            &scope,
            "tx_browse_probe",
            &TableBrowseQuery {
                filters: vec![TableFilter {
                    column: "id".to_string(),
                    op: FilterOp::Gt,
                    value: "99999".to_string(),
                }],
                order: None,
                limit: 10,
                offset: 0,
            },
            CancellationToken::new(),
        )
        .await
        .expect("浏览失败");
    assert_eq!(empty.total, Some(0));
    assert_eq!(empty.row_set.columns, vec!["id", "name", "note"]);
    assert!(empty.row_set.rows.is_empty());

    driver
        .query_with_options(
            "DROP TABLE tx_browse_probe",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("清理失败");
    driver.close().await;
}

// === FR-241 索引与约束 metadata ===

/// list_indexes / list_constraints：主键、唯一索引、外键引用与 CHECK 正确归组（PG 方言）。
#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_list_indexes_and_constraints() {
    let driver = connect().await;
    driver
        .query_with_options(
            "DROP TABLE IF EXISTS tx_meta_child",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("清理失败");
    driver
        .query_with_options(
            "DROP TABLE IF EXISTS tx_meta_parent",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("清理失败");
    driver
        .query_with_options(
            "CREATE TABLE tx_meta_parent (id INT PRIMARY KEY, code VARCHAR(20) NOT NULL UNIQUE)",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("建父表失败");
    driver
        .query_with_options(
            "CREATE TABLE tx_meta_child (\
                id INT PRIMARY KEY, \
                parent_id INT NOT NULL REFERENCES tx_meta_parent (id), \
                name VARCHAR(50) CHECK (name <> ''), \
                note VARCHAR(50) \
            )",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("建子表失败");
    driver
        .query_with_options(
            "CREATE INDEX idx_child_name ON tx_meta_child (name)",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("建索引失败");

    let current_db = driver
        .query("SELECT current_database()")
        .await
        .expect("查询当前库失败");
    let db_name = current_db.rows[0][0].clone().expect("库名不为空");
    let scope = MetadataScope::postgresql(db_name, "public");

    let indexes = driver
        .list_indexes(&scope, "tx_meta_child")
        .await
        .expect("list_indexes 失败");
    let primary = indexes
        .iter()
        .find(|i| i.index_type == "PRIMARY")
        .expect("应有主键索引");
    assert_eq!(primary.columns, vec!["id"]);
    let idx_name = indexes
        .iter()
        .find(|i| i.name == "idx_child_name")
        .expect("应有 idx_child_name");
    assert_eq!(idx_name.index_type, "INDEX");
    assert!(!idx_name.unique);
    assert_eq!(idx_name.columns, vec!["name"]);

    let constraints = driver
        .list_constraints(&scope, "tx_meta_child")
        .await
        .expect("list_constraints 失败");
    let pk = constraints
        .iter()
        .find(|c| c.constraint_type == "PRIMARY KEY")
        .expect("应有 PRIMARY KEY 约束");
    assert_eq!(pk.columns, vec!["id"]);
    let fk = constraints
        .iter()
        .find(|c| c.constraint_type == "FOREIGN KEY")
        .expect("应有 FOREIGN KEY 约束");
    assert_eq!(fk.columns, vec!["parent_id"]);
    assert!(
        fk.reference
            .as_deref()
            .is_some_and(|r| r.contains("tx_meta_parent")),
        "外键定义应含引用目标: {:?}",
        fk.reference
    );
    let has_name_check = constraints.iter().any(|c| {
        c.constraint_type == "CHECK" && c.reference.as_deref().is_some_and(|r| r.contains("name"))
    });
    assert!(
        has_name_check,
        "应存在含 name 表达式的 CHECK 约束: {constraints:?}"
    );

    driver
        .query_with_options(
            "DROP TABLE tx_meta_child",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("清理失败");
    driver
        .query_with_options(
            "DROP TABLE tx_meta_parent",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("清理失败");
    driver.close().await;
}

// === FR-243 多语句执行 ===

/// 多语句脚本：逐条执行、dollar-quoted 函数体不切分、首错中止（PG 方言）。
#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_query_many_handles_dollar_quotes_and_errors() {
    let driver = connect().await;

    // dollar-quoted body 内的分号不切
    let result = driver
        .query_many(
            "SELECT $$a;b$$ AS s; SELECT 2 AS n",
            QueryOptions::default(),
            CancellationToken::new(),
        )
        .await
        .expect("多语句执行失败");
    assert_eq!(result.statements.len(), 2);
    assert!(matches!(
        &result.statements[0].outcome,
        db_driver::StatementOutcome::Ok { row_set } if row_set.rows[0][0].as_deref() == Some("a;b")
    ));

    // 首错中止
    let result = driver
        .query_many(
            "SELECT 1; SELECT * FROM table_not_exists_999; SELECT 3",
            QueryOptions::default(),
            CancellationToken::new(),
        )
        .await
        .expect("多语句应返回部分结果");
    assert!(matches!(
        result.statements[0].outcome,
        db_driver::StatementOutcome::Ok { .. }
    ));
    assert!(matches!(
        result.statements[1].outcome,
        db_driver::StatementOutcome::Error { .. }
    ));
    assert!(matches!(
        result.statements[2].outcome,
        db_driver::StatementOutcome::Skipped
    ));

    driver.close().await;
}

// === FR-250 编辑内核：apply_table_edits ===

use db_driver::{EditCell, TableEdit};

fn pg_cell(column: &str, value: Option<&str>) -> EditCell {
    EditCell {
        column: column.to_string(),
        value: value.map(str::to_string),
    }
}

async fn pg_current_scope(driver: &PostgresDriver) -> MetadataScope {
    let current: String = driver
        .query("SELECT current_database()")
        .await
        .expect("取当前库失败")
        .rows[0][0]
        .clone()
        .expect("current_database 不为 NULL");
    MetadataScope::postgresql(current, "public".to_string())
}

/// 建一张编辑测试表（表名全局唯一，并发测试互不干扰）。
async fn pg_setup_edit_table(driver: &PostgresDriver, table: &str, ddl: &str) {
    for sql in [format!("DROP TABLE IF EXISTS {table}"), ddl.to_string()] {
        driver
            .query_with_options(&sql, write_opts(), CancellationToken::new())
            .await
            .unwrap_or_else(|e| panic!("建表语句失败 {sql}: {e:?}"));
    }
}

/// 编辑批全流程：混合 Insert/Update/Delete 提交生效；NULL 与空串区分。
#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_apply_table_edits_commits_mixed_batch() {
    let driver = connect().await;
    pg_setup_edit_table(
        &driver,
        "edit_batch",
        "CREATE TABLE edit_batch (id INT PRIMARY KEY, name VARCHAR(50), note VARCHAR(50) NULL)",
    )
    .await;
    let scope = pg_current_scope(&driver).await;
    let pk = vec!["id".to_string()];

    let edits = vec![
        TableEdit::Insert {
            values: vec![
                pg_cell("id", Some("1")),
                pg_cell("name", Some("alpha")),
                pg_cell("note", None),
            ],
        },
        TableEdit::Insert {
            values: vec![
                pg_cell("id", Some("2")),
                pg_cell("name", Some("")),
                pg_cell("note", Some("n2")),
            ],
        },
        TableEdit::Update {
            pk: vec![pg_cell("id", Some("1"))],
            changes: vec![
                pg_cell("name", Some("beta")),
                pg_cell("note", Some("含;分号")),
            ],
        },
        TableEdit::Insert {
            values: vec![
                pg_cell("id", Some("3")),
                pg_cell("name", Some("gamma")),
                pg_cell("note", None),
            ],
        },
        TableEdit::Delete {
            pk: vec![pg_cell("id", Some("3"))],
        },
    ];
    let result = driver
        .apply_table_edits(&scope, "edit_batch", &pk, &edits, CancellationToken::new())
        .await
        .expect("编辑批应成功");
    assert_eq!(result.applied, 5);

    let rows = driver
        .query_with_options(
            "SELECT id, name, note FROM edit_batch ORDER BY id",
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("读取失败");
    assert_eq!(rows.rows.len(), 2, "Delete 应移除 id=3");
    assert_eq!(
        rows.rows[0][1].as_deref(),
        Some("beta"),
        "id=1 Update 应生效"
    );
    assert_eq!(rows.rows[0][2].as_deref(), Some("含;分号"));
    assert_eq!(rows.rows[1][1].as_deref(), Some(""), "空串不能变成 NULL");
    assert_eq!(rows.rows[1][2].as_deref(), Some("n2"), "note 值应保留");

    driver.close().await;
}

/// 中途失败整体回滚；无主键与主键不符拒绝；复合主键 Update。
#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_apply_table_edits_rolls_back_and_rejects_bad_pk() {
    let driver = connect().await;
    pg_setup_edit_table(
        &driver,
        "edit_rollback",
        "CREATE TABLE edit_rollback (id INT PRIMARY KEY, name VARCHAR(50), note VARCHAR(50) NULL)",
    )
    .await;
    pg_setup_edit_table(
        &driver,
        "edit_nopk",
        "CREATE TABLE edit_nopk (id INT, name VARCHAR(50))",
    )
    .await;
    pg_setup_edit_table(
        &driver,
        "edit_composite",
        "CREATE TABLE edit_composite (a INT, b INT, val VARCHAR(50), PRIMARY KEY (a, b))",
    )
    .await;
    let scope = pg_current_scope(&driver).await;
    let pk = vec!["id".to_string()];

    driver
        .apply_table_edits(
            &scope,
            "edit_rollback",
            &pk,
            &[TableEdit::Insert {
                values: vec![
                    pg_cell("id", Some("9")),
                    pg_cell("name", Some("seed")),
                    pg_cell("note", None),
                ],
            }],
            CancellationToken::new(),
        )
        .await
        .expect("种子行应成功");

    let edits = vec![
        TableEdit::Insert {
            values: vec![
                pg_cell("id", Some("10")),
                pg_cell("name", Some("x")),
                pg_cell("note", None),
            ],
        },
        TableEdit::Insert {
            values: vec![
                pg_cell("id", Some("9")),
                pg_cell("name", Some("dup")),
                pg_cell("note", None),
            ],
        },
    ];
    let error = driver
        .apply_table_edits(
            &scope,
            "edit_rollback",
            &pk,
            &edits,
            CancellationToken::new(),
        )
        .await
        .expect_err("主键重复必须失败");
    match error {
        DriverError::EditApplyFailed { index, .. } => assert_eq!(index, 1, "失败序号应为第 2 条"),
        other => panic!("应为 EditApplyFailed，实际 {other:?}"),
    }

    let rows = driver
        .query_with_options(
            "SELECT COUNT(*) FROM edit_rollback",
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("读取失败");
    assert_eq!(rows.rows[0][0].as_deref(), Some("1"), "回滚后只剩种子行");

    // UPDATE 0 影响行 → EditConflict
    let error = driver
        .apply_table_edits(
            &scope,
            "edit_rollback",
            &pk,
            &[TableEdit::Update {
                pk: vec![pg_cell("id", Some("999"))],
                changes: vec![pg_cell("name", Some("ghost"))],
            }],
            CancellationToken::new(),
        )
        .await
        .expect_err("0 影响行必须报冲突");
    assert!(matches!(error, DriverError::EditConflict { index: 0 }));

    // 无主键表拒绝
    let error = driver
        .apply_table_edits(
            &scope,
            "edit_nopk",
            &["id".to_string()],
            &[TableEdit::Delete {
                pk: vec![pg_cell("id", Some("1"))],
            }],
            CancellationToken::new(),
        )
        .await
        .expect_err("无主键表必须拒绝");
    assert!(matches!(error, DriverError::NoPrimaryKey));

    // 主键列不符拒绝
    let error = driver
        .apply_table_edits(
            &scope,
            "edit_rollback",
            &["name".to_string()],
            &[TableEdit::Delete {
                pk: vec![pg_cell("id", Some("1"))],
            }],
            CancellationToken::new(),
        )
        .await
        .expect_err("主键列不符必须拒绝");
    assert!(matches!(error, DriverError::NoPrimaryKey));

    // 复合主键 Update
    let edits = vec![
        TableEdit::Insert {
            values: vec![
                pg_cell("a", Some("1")),
                pg_cell("b", Some("2")),
                pg_cell("val", Some("y")),
            ],
        },
        TableEdit::Update {
            pk: vec![pg_cell("a", Some("1")), pg_cell("b", Some("2"))],
            changes: vec![pg_cell("val", Some("y2"))],
        },
    ];
    let result = driver
        .apply_table_edits(
            &scope,
            "edit_composite",
            &["a".to_string(), "b".to_string()],
            &edits,
            CancellationToken::new(),
        )
        .await
        .expect("复合主键编辑批应成功");
    assert_eq!(result.applied, 2);

    driver.close().await;
}

// === FR-252 批量插入：bulk_insert_rows ===

/// 批量插入（PG）：中止模式回滚、跳过模式收集失败行、空值语义。
#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_bulk_insert_rows_modes() {
    let driver = connect().await;
    pg_setup_edit_table(
        &driver,
        "bulk_probe",
        "CREATE TABLE bulk_probe (id INT PRIMARY KEY, name VARCHAR(50), note VARCHAR(50) NULL)",
    )
    .await;
    let scope = pg_current_scope(&driver).await;
    let columns = vec!["id".to_string(), "name".to_string(), "note".to_string()];

    // 中止模式：主键重复整批回滚
    let rows = vec![
        vec![Some("1".into()), Some("a".into()), None],
        vec![Some("1".into()), Some("dup".into()), None],
    ];
    let error = driver
        .bulk_insert_rows(
            &scope,
            "bulk_probe",
            &columns,
            &rows,
            true,
            CancellationToken::new(),
        )
        .await
        .expect_err("中止模式主键重复必须失败");
    match error {
        DriverError::EditApplyFailed { index, .. } => assert_eq!(index, 1),
        other => panic!("应为 EditApplyFailed，实际 {other:?}"),
    }

    // 跳过模式
    let rows = vec![
        vec![Some("1".into()), Some("a".into()), None],
        vec![Some("2".into()), Some("".into()), Some("n2".into())],
        vec![Some("1".into()), Some("dup".into()), None],
    ];
    let result = driver
        .bulk_insert_rows(
            &scope,
            "bulk_probe",
            &columns,
            &rows,
            false,
            CancellationToken::new(),
        )
        .await
        .expect("跳过模式应返回报告");
    assert_eq!(result.inserted, 2);
    assert_eq!(result.failed_rows, vec![2]);

    let read = driver
        .query_with_options(
            "SELECT id, name, note FROM bulk_probe ORDER BY id",
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("读取失败");
    assert_eq!(read.rows.len(), 2);
    assert_eq!(read.rows[0][2], None, "NULL 保持 NULL");
    assert_eq!(read.rows[1][1].as_deref(), Some(""), "空串保持空串");

    driver.close().await;
}

/// dump 导出风格的多行 VALUES INSERT：PG 方言拆分执行后数据一致（含转义往返）。
#[tokio::test]
#[ignore = "需要本地 PostgreSQL"]
async fn postgres_dump_style_sql_roundtrip() {
    let driver = connect().await;
    pg_setup_edit_table(
        &driver,
        "dump_roundtrip",
        "CREATE TABLE dump_roundtrip (id INT PRIMARY KEY, val VARCHAR(100) NULL)",
    )
    .await;

    let dump = "DROP TABLE IF EXISTS \"dump_roundtrip\";\n\
                CREATE TABLE \"dump_roundtrip\" (\"id\" integer NOT NULL, \"val\" varchar(100), PRIMARY KEY (\"id\"));\n\
                INSERT INTO \"dump_roundtrip\" (\"id\", \"val\") VALUES\n  \
                  (1, 'it''s'),\n  \
                  (2, '含\\反斜杠'),\n  \
                  (3, '两行\n数据'),\n  \
                  (4, NULL),\n  \
                  (5, '');";
    let result = driver
        .query_many(dump, write_opts(), CancellationToken::new())
        .await
        .expect("dump 风格脚本应执行成功");
    assert_eq!(result.statements.len(), 3);

    let rows = driver
        .query_with_options(
            "SELECT id, val FROM dump_roundtrip ORDER BY id",
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("读取失败");
    assert_eq!(rows.rows.len(), 5);
    assert_eq!(rows.rows[0][1].as_deref(), Some("it's"), "单引号双写往返");
    // PG 标准字符串（standard_conforming_strings=on）：反斜杠是普通字符，导出原样写入
    assert_eq!(
        rows.rows[1][1].as_deref(),
        Some("含\\反斜杠"),
        "反斜杠转义往返"
    );
    assert_eq!(rows.rows[2][1].as_deref(), Some("两行\n数据"), "换行往返");
    assert_eq!(rows.rows[3][1], None, "NULL 往返");
    assert_eq!(rows.rows[4][1].as_deref(), Some(""), "空串往返");

    driver.close().await;
}
