//! 连真实 MySQL 的 integration 测试
//!
//! 全部标 `#[ignore]`，默认 `cargo test` 不跑；用 `just test-integration`
//! （= `cargo test -p db-driver -- --include-ignored`）执行。
//!
//! 需设环境变量 `TINY_SQL_TEST_MYSQL_URL`（见 .env.example）；显式运行门禁但未配置
//! 时必须失败，不能把跳过误记为通过。
//! CI 不跑本文件（无 MySQL 服务器）；MySQL 5.7 兼容验证推 Week 5 dogfooding。

use std::time::Duration;

use db_driver::{Driver, DriverError, MetadataScope, MySqlDriver, QueryOptions};
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;

/// 读取测试用 MySQL URL；显式运行 integration 时未配置必须失败。
fn test_url() -> String {
    std::env::var("TINY_SQL_TEST_MYSQL_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .expect("未设置 TINY_SQL_TEST_MYSQL_URL，不能把 MySQL integration 记为通过")
}

#[tokio::test]
#[ignore = "需要本地 MySQL：设 TINY_SQL_TEST_MYSQL_URL 后 just test-integration"]
async fn ping_returns_one() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    assert_eq!(driver.ping().await.expect("ping 失败"), 1);
    driver.close().await;
}

#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn list_databases_contains_information_schema() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    let dbs = Driver::list_databases(&driver)
        .await
        .expect("list_databases 失败");
    assert!(
        dbs.iter()
            .any(|d| d.name.eq_ignore_ascii_case("information_schema")),
        "应至少包含 information_schema，实际: {:?}",
        dbs.iter().map(|d| &d.name).collect::<Vec<_>>()
    );
    let schemas = Driver::list_schemas(&driver, "information_schema")
        .await
        .expect("list_schemas 失败");
    assert_eq!(schemas.len(), 1);
    assert_eq!(schemas[0].name, "information_schema");
    driver.close().await;
}

#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn query_decodes_basic_types_and_enforces_guards() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    let rs = driver
        .query(
            "SELECT 1 AS n, 'hello' AS s, NULL AS nil, \
                    DATE('2026-08-18') AS date_value, \
                    CAST(12.34 AS DECIMAL(10, 2)) AS numeric_value, \
                    JSON_OBJECT('ok', TRUE) AS json_value",
        )
        .await
        .expect("query 失败");
    assert_eq!(
        rs.columns,
        vec!["n", "s", "nil", "date_value", "numeric_value", "json_value",]
    );
    assert_eq!(rs.rows.len(), 1);
    assert_eq!(rs.rows[0][0].as_deref(), Some("1"));
    assert_eq!(rs.rows[0][1].as_deref(), Some("hello"));
    assert_eq!(rs.rows[0][2], None, "NULL 应解码为 None");
    assert_eq!(rs.rows[0][3].as_deref(), Some("2026-08-18"));
    assert_eq!(rs.rows[0][4].as_deref(), Some("12.34"));
    let json = rs.rows[0][5].as_deref().expect("JSON 不应为空");
    assert!(json.contains("\"ok\""), "JSON 对象应保留 key，实际: {json}");

    let write_error = driver
        .query_with_options(
            "SET @tiny_sql_integration = 1",
            QueryOptions::default(),
            CancellationToken::new(),
        )
        .await
        .expect_err("未确认写操作必须拒绝");
    assert!(matches!(
        write_error,
        DriverError::WriteRequiresConfirmation
    ));
    driver
        .query_with_options(
            "SET @tiny_sql_integration = 1",
            QueryOptions {
                row_limit: 10,
                allow_write: true,
            },
            CancellationToken::new(),
        )
        .await
        .expect("确认后的写操作应执行");
    driver.close().await;
}

#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn list_tables_and_columns_on_information_schema() {
    // 用 information_schema.tables 这张必然存在的表验证 list_tables / list_columns
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");

    let scope = MetadataScope::mysql("information_schema");
    let tables = Driver::list_tables(&driver, &scope)
        .await
        .expect("list_tables 失败");
    assert!(!tables.is_empty(), "information_schema 应有表");

    let columns = Driver::list_columns(&driver, &scope, "tables")
        .await
        .expect("list_columns 失败");
    assert!(
        columns
            .iter()
            .any(|c| c.name.eq_ignore_ascii_case("table_name")),
        "tables 表应有 table_name 列"
    );
    driver.close().await;
}

#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn cancel_long_query_returns_query_cancelled() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    let query_driver = driver.clone();
    let cancel_token = CancellationToken::new();
    let query_token = cancel_token.clone();

    let query_task = tokio::spawn(async move {
        query_driver
            .query_with_options("SELECT SLEEP(10)", QueryOptions::default(), query_token)
            .await
    });
    sleep(Duration::from_millis(100)).await;
    cancel_token.cancel();

    let result = timeout(Duration::from_secs(5), query_task)
        .await
        .expect("取消后查询应在 5 秒内结束")
        .expect("查询任务不应 panic");
    assert!(
        matches!(result, Err(DriverError::QueryCancelled)),
        "取消应返回稳定 QueryCancelled，实际: {result:?}"
    );
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

async fn count_probe(driver: &MySqlDriver) -> String {
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
#[ignore = "需要本地 MySQL"]
async fn pool_rejects_tx_control_statements() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
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

/// session 全流程：同连接证明、回滚、未提交 close 自动回滚、提交生效。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn session_pins_connection_and_commits_or_rolls_back() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
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

    // 同一连接证明：session 内两次 CONNECTION_ID() 必须一致
    let mut session = driver.begin_session().await.expect("begin_session 失败");
    assert!(session.in_transaction());
    let first = session
        .query(
            "SELECT CONNECTION_ID()",
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("session 查询失败");
    let second = session
        .query(
            "SELECT CONNECTION_ID()",
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
    assert!(!session.in_transaction());
    assert_eq!(count_probe(&driver).await, "1", "提交后必须可见");

    // 无事务时 commit / rollback 返回稳定错误
    let missing = session.commit().await.expect_err("无事务 commit 必须报错");
    assert!(matches!(missing, DriverError::SessionNotInTransaction));
    let missing = session
        .rollback()
        .await
        .expect_err("无事务 rollback 必须报错");
    assert!(matches!(missing, DriverError::SessionNotInTransaction));
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

/// 未经 close 直接 drop 的 session：后台清理必须回滚未提交事务。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn session_drop_rolls_back_uncommitted() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    driver
        .query_with_options(
            "DROP TABLE IF EXISTS tx_session_probe_drop",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("清理旧表失败");
    driver
        .query_with_options(
            "CREATE TABLE tx_session_probe_drop (id INT PRIMARY KEY)",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("建表失败");

    let mut session = driver.begin_session().await.expect("begin_session 失败");
    session
        .query(
            "INSERT INTO tx_session_probe_drop VALUES (4)",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("事务内写入失败");
    drop(session);
    // 等后台 RESET CONNECTION 清理完成
    sleep(Duration::from_millis(800)).await;
    assert_eq!(count_probe(&driver).await, "0", "drop 未提交必须回滚");

    driver
        .query_with_options(
            "DROP TABLE tx_session_probe_drop",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("清理失败");
    driver.close().await;
}

// === FR-242 表数据服务端筛选 / 排序 / 分页 ===

/// 浏览查询：筛选、排序、分页、总行数、空结果列头与取消。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn browse_table_filters_sorts_and_paginates() {
    use db_driver::{FilterOp, TableBrowseQuery, TableFilter, TableOrder};
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
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
    for i in 1..=25 {
        let note = if i % 5 == 0 {
            "NULL"
        } else {
            &format!("'n{i}'")
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

    let scope = MetadataScope::mysql(
        test_url()
            .rsplit('/')
            .next()
            .expect("URL 应含 database")
            .split('?')
            .next()
            .expect("database 名"),
    );

    // 第一页 10 行：total=25、has_next、按 id 升序
    let page1 = driver
        .browse_table(
            &scope,
            "tx_browse_probe",
            &TableBrowseQuery {
                filters: vec![],
                order: Some(TableOrder {
                    column: "id".to_string(),
                    descending: false,
                }),
                limit: 10,
                offset: 0,
            },
            CancellationToken::new(),
        )
        .await
        .expect("浏览失败");
    assert_eq!(page1.total, Some(25));
    assert!(page1.has_next_page);
    assert_eq!(page1.row_set.rows.len(), 10);
    assert_eq!(page1.row_set.rows[0][0].as_deref(), Some("1"));
    assert_eq!(page1.row_set.columns, vec!["id", "name", "note"]);

    // 第二页：offset 生效
    let page2 = driver
        .browse_table(
            &scope,
            "tx_browse_probe",
            &TableBrowseQuery {
                filters: vec![],
                order: Some(TableOrder {
                    column: "id".to_string(),
                    descending: false,
                }),
                limit: 10,
                offset: 10,
            },
            CancellationToken::new(),
        )
        .await
        .expect("浏览失败");
    assert_eq!(page2.row_set.rows[0][0].as_deref(), Some("11"));

    // 筛选 id > 20：5 行无下一页；降序首行最大
    let filtered = driver
        .browse_table(
            &scope,
            "tx_browse_probe",
            &TableBrowseQuery {
                filters: vec![TableFilter {
                    column: "id".to_string(),
                    op: FilterOp::Gt,
                    value: "20".to_string(),
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
    assert_eq!(filtered.row_set.rows[0][0].as_deref(), Some("25"));

    // IsNull 筛选（5 的倍数共 5 行）+ LIKE
    let nulls = driver
        .browse_table(
            &scope,
            "tx_browse_probe",
            &TableBrowseQuery {
                filters: vec![
                    TableFilter {
                        column: "note".to_string(),
                        op: FilterOp::IsNull,
                        value: String::new(),
                    },
                    TableFilter {
                        column: "name".to_string(),
                        op: FilterOp::Like,
                        value: "name%".to_string(),
                    },
                ],
                order: None,
                limit: 10,
                offset: 0,
            },
            CancellationToken::new(),
        )
        .await
        .expect("浏览失败");
    assert_eq!(nulls.total, Some(5));

    // 空结果集仍返回列头
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

/// list_indexes / list_constraints：主键、唯一索引、普通索引、外键引用正确归组。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn list_indexes_and_constraints() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    let db = url
        .rsplit('/')
        .next()
        .expect("URL 应含 database")
        .split('?')
        .next()
        .expect("database 名");
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
            "CREATE TABLE tx_meta_parent (id INT PRIMARY KEY, code VARCHAR(20) NOT NULL, UNIQUE KEY uq_code (code))",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("建父表失败");
    driver
        .query_with_options(
            "CREATE TABLE tx_meta_child (\
                id INT PRIMARY KEY, \
                parent_id INT NOT NULL, \
                name VARCHAR(50), \
                KEY idx_name (name), \
                KEY idx_parent_name (parent_id, name), \
                CONSTRAINT fk_child_parent FOREIGN KEY (parent_id) REFERENCES tx_meta_parent (id) \
            )",
            write_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("建子表失败");

    let indexes = driver
        .list_indexes(db, "tx_meta_child")
        .await
        .expect("list_indexes 失败");
    let primary = indexes
        .iter()
        .find(|i| i.index_type == "PRIMARY")
        .expect("应有主键索引");
    assert_eq!(primary.columns, vec!["id"]);
    assert!(primary.unique);
    let idx_name = indexes
        .iter()
        .find(|i| i.name == "idx_name")
        .expect("应有 idx_name");
    assert_eq!(idx_name.index_type, "INDEX");
    assert!(!idx_name.unique);
    let composite = indexes
        .iter()
        .find(|i| i.name == "idx_parent_name")
        .expect("应有联合索引");
    assert_eq!(composite.columns, vec!["parent_id", "name"]);

    let constraints = driver
        .list_constraints(db, "tx_meta_child")
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
    assert_eq!(
        fk.reference.as_deref(),
        Some(format!("{db}.tx_meta_parent(id)").as_str()),
        "外键引用目标"
    );
    let uq = driver
        .list_constraints(db, "tx_meta_parent")
        .await
        .expect("list_constraints 失败")
        .into_iter()
        .find(|c| c.constraint_type == "UNIQUE")
        .expect("父表应有 UNIQUE 约束");
    assert_eq!(uq.columns, vec!["code"]);

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

/// 多语句脚本：逐条执行、首错中止、写确认、事务语句拒绝。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn query_many_executes_statements_and_stops_on_error() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");

    // 全读脚本：两条结果
    let result = driver
        .query_many(
            "SELECT 1 AS a; SELECT ';' AS semi",
            QueryOptions::default(),
            CancellationToken::new(),
        )
        .await
        .expect("多语句执行失败");
    assert_eq!(result.statements.len(), 2);
    assert!(matches!(
        &result.statements[0].outcome,
        db_driver::StatementOutcome::Ok { row_set } if row_set.rows[0][0].as_deref() == Some("1")
    ));
    assert!(matches!(
        &result.statements[1].outcome,
        db_driver::StatementOutcome::Ok { row_set } if row_set.rows[0][0].as_deref() == Some(";")
    ));

    // 首错中止：第二条失败后第三条 skipped
    let result = driver
        .query_many(
            "SELECT 1; SELECT * FROM table_not_exists_999; SELECT 3",
            QueryOptions::default(),
            CancellationToken::new(),
        )
        .await
        .expect("多语句应返回部分结果而非整体失败");
    assert!(matches!(
        result.statements[0].outcome,
        db_driver::StatementOutcome::Ok { .. }
    ));
    assert!(matches!(
        &result.statements[1].outcome,
        db_driver::StatementOutcome::Error { key, .. } if key == "error.driver.query_failed"
    ));
    assert!(matches!(
        result.statements[2].outcome,
        db_driver::StatementOutcome::Skipped
    ));

    // 含写语句未确认 → 整体拒绝且不执行任何语句
    let error = driver
        .query_many(
            "SELECT 1; DELETE FROM tx_session_probe",
            QueryOptions::default(),
            CancellationToken::new(),
        )
        .await
        .expect_err("写语句未确认必须整体拒绝");
    assert!(matches!(error, DriverError::WriteRequiresConfirmation));

    // 含事务语句 → 整体拒绝
    let error = driver
        .query_many("SELECT 1; COMMIT", write_opts(), CancellationToken::new())
        .await
        .expect_err("事务语句必须拒绝");
    assert!(matches!(error, DriverError::TxRequiresSession));

    driver.close().await;
}

// === FR-250 编辑内核：apply_table_edits ===

use db_driver::{EditCell, TableEdit};

fn cell(column: &str, value: Option<&str>) -> EditCell {
    EditCell {
        column: column.to_string(),
        value: value.map(str::to_string),
    }
}

fn probe_scope() -> MetadataScope {
    let url = test_url();
    let database = url.rsplit('/').next().expect("URL 必含 database");
    MetadataScope::mysql(database)
}

/// 建一张编辑测试表（DROP IF EXISTS 保证可重复执行；表名全局唯一，并发测试互不干扰）。
async fn setup_edit_table(driver: &MySqlDriver, table: &str, ddl: &str) {
    for sql in [format!("DROP TABLE IF EXISTS {table}"), ddl.to_string()] {
        driver
            .query_with_options(&sql, write_opts(), CancellationToken::new())
            .await
            .unwrap_or_else(|e| panic!("建表语句失败 {sql}: {e:?}"));
    }
}

async fn count_rows(driver: &MySqlDriver, table: &str) -> String {
    driver
        .query_with_options(
            &format!("SELECT COUNT(*) FROM {table}"),
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("COUNT 读取失败")
        .rows[0][0]
        .clone()
        .expect("COUNT 不应为 NULL")
}

/// 编辑批全流程：Insert×2 + Update + Delete 混合提交生效；NULL 与空串区分。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn apply_table_edits_commits_mixed_batch() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    setup_edit_table(
        &driver,
        "edit_batch",
        "CREATE TABLE edit_batch (id INT PRIMARY KEY, name VARCHAR(50), note VARCHAR(50) NULL)",
    )
    .await;
    let scope = probe_scope();
    let pk = vec!["id".to_string()];

    let edits = vec![
        TableEdit::Insert {
            values: vec![
                cell("id", Some("1")),
                cell("name", Some("alpha")),
                cell("note", None),
            ],
        },
        TableEdit::Insert {
            values: vec![
                cell("id", Some("2")),
                cell("name", Some("")),
                cell("note", Some("n2")),
            ],
        },
        TableEdit::Update {
            pk: vec![cell("id", Some("1"))],
            changes: vec![cell("name", Some("beta")), cell("note", Some("含;分号"))],
        },
        TableEdit::Insert {
            values: vec![
                cell("id", Some("3")),
                cell("name", Some("gamma")),
                cell("note", None),
            ],
        },
        TableEdit::Delete {
            pk: vec![cell("id", Some("3"))],
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

/// 中途失败整体回滚：第二条 Insert 主键重复，第一条也不能残留。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn apply_table_edits_rolls_back_on_mid_failure() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    setup_edit_table(
        &driver,
        "edit_rollback",
        "CREATE TABLE edit_rollback (id INT PRIMARY KEY, name VARCHAR(50), note VARCHAR(50) NULL)",
    )
    .await;
    let scope = probe_scope();
    let pk = vec!["id".to_string()];

    driver
        .apply_table_edits(
            &scope,
            "edit_rollback",
            &pk,
            &[TableEdit::Insert {
                values: vec![
                    cell("id", Some("9")),
                    cell("name", Some("seed")),
                    cell("note", None),
                ],
            }],
            CancellationToken::new(),
        )
        .await
        .expect("种子行应成功");

    let edits = vec![
        TableEdit::Insert {
            values: vec![
                cell("id", Some("10")),
                cell("name", Some("x")),
                cell("note", None),
            ],
        },
        TableEdit::Insert {
            values: vec![
                cell("id", Some("9")),
                cell("name", Some("dup")),
                cell("note", None),
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

    assert_eq!(
        count_rows(&driver, "edit_rollback").await,
        "1",
        "回滚后只剩种子行"
    );

    driver.close().await;
}

/// UPDATE 命中 0 行（他端已删）报 EditConflict 并整体回滚。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn apply_table_edits_conflict_rolls_back_batch() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    setup_edit_table(
        &driver,
        "edit_conflict",
        "CREATE TABLE edit_conflict (id INT PRIMARY KEY, name VARCHAR(50), note VARCHAR(50) NULL)",
    )
    .await;
    let scope = probe_scope();
    let pk = vec!["id".to_string()];

    let edits = vec![
        TableEdit::Insert {
            values: vec![
                cell("id", Some("1")),
                cell("name", Some("a")),
                cell("note", None),
            ],
        },
        TableEdit::Update {
            pk: vec![cell("id", Some("999"))],
            changes: vec![cell("name", Some("ghost"))],
        },
    ];
    let error = driver
        .apply_table_edits(
            &scope,
            "edit_conflict",
            &pk,
            &edits,
            CancellationToken::new(),
        )
        .await
        .expect_err("0 影响行必须报冲突");
    match error {
        DriverError::EditConflict { index } => assert_eq!(index, 1),
        other => panic!("应为 EditConflict，实际 {other:?}"),
    }

    assert_eq!(
        count_rows(&driver, "edit_conflict").await,
        "0",
        "冲突必须整体回滚"
    );

    driver.close().await;
}

/// 无主键表与主键列不符均拒绝 NoPrimaryKey。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn apply_table_edits_rejects_missing_or_mismatched_pk() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    setup_edit_table(
        &driver,
        "edit_nopk",
        "CREATE TABLE edit_nopk (id INT, name VARCHAR(50))",
    )
    .await;
    setup_edit_table(
        &driver,
        "edit_pk_check",
        "CREATE TABLE edit_pk_check (id INT PRIMARY KEY, name VARCHAR(50), note VARCHAR(50) NULL)",
    )
    .await;
    let scope = probe_scope();
    let edits = vec![TableEdit::Delete {
        pk: vec![cell("id", Some("1"))],
    }];

    let error = driver
        .apply_table_edits(
            &scope,
            "edit_nopk",
            &["id".to_string()],
            &edits,
            CancellationToken::new(),
        )
        .await
        .expect_err("无主键表必须拒绝");
    assert!(matches!(error, DriverError::NoPrimaryKey));

    let error = driver
        .apply_table_edits(
            &scope,
            "edit_pk_check",
            &["name".to_string()],
            &edits,
            CancellationToken::new(),
        )
        .await
        .expect_err("主键列不符必须拒绝");
    assert!(matches!(error, DriverError::NoPrimaryKey));

    driver.close().await;
}

/// 复合主键：按 (a, b) 定位 Update / Delete。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn apply_table_edits_supports_composite_pk() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    setup_edit_table(
        &driver,
        "edit_composite",
        "CREATE TABLE edit_composite (a INT, b INT, val VARCHAR(50), PRIMARY KEY (a, b))",
    )
    .await;
    let scope = probe_scope();
    let pk = vec!["a".to_string(), "b".to_string()];

    let edits = vec![
        TableEdit::Insert {
            values: vec![
                cell("a", Some("1")),
                cell("b", Some("1")),
                cell("val", Some("x")),
            ],
        },
        TableEdit::Insert {
            values: vec![
                cell("a", Some("1")),
                cell("b", Some("2")),
                cell("val", Some("y")),
            ],
        },
        TableEdit::Update {
            pk: vec![cell("a", Some("1")), cell("b", Some("2"))],
            changes: vec![cell("val", Some("y2"))],
        },
        TableEdit::Delete {
            pk: vec![cell("a", Some("1")), cell("b", Some("1"))],
        },
    ];
    let result = driver
        .apply_table_edits(
            &scope,
            "edit_composite",
            &pk,
            &edits,
            CancellationToken::new(),
        )
        .await
        .expect("复合主键编辑批应成功");
    assert_eq!(result.applied, 4);

    let rows = driver
        .query_with_options(
            "SELECT a, b, val FROM edit_composite",
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("读取失败");
    assert_eq!(rows.rows.len(), 1);
    assert_eq!(rows.rows[0][2].as_deref(), Some("y2"));

    driver.close().await;
}

// === FR-252 批量插入：bulk_insert_rows ===

/// 批量插入：无主键表也可导入；NULL 与空串区分。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn bulk_insert_rows_into_no_pk_table() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    setup_edit_table(
        &driver,
        "bulk_probe",
        "CREATE TABLE bulk_probe (id INT, name VARCHAR(50), note VARCHAR(50) NULL)",
    )
    .await;
    let scope = probe_scope();

    let rows = vec![
        vec![Some("1".into()), Some("a".into()), None],
        vec![Some("2".into()), Some("".into()), Some("n".into())],
        vec![Some("3".into()), Some("含;分号".into()), None],
    ];
    let result = driver
        .bulk_insert_rows(
            &scope,
            "bulk_probe",
            &["id".into(), "name".into(), "note".into()],
            &rows,
            true,
            CancellationToken::new(),
        )
        .await
        .expect("批量插入应成功");
    assert_eq!(result.inserted, 3);
    assert!(result.failed_rows.is_empty());

    let read = driver
        .query_with_options(
            "SELECT id, name, note FROM bulk_probe ORDER BY id",
            read_opts(),
            CancellationToken::new(),
        )
        .await
        .expect("读取失败");
    assert_eq!(read.rows.len(), 3);
    assert_eq!(read.rows[0][2], None, "NULL 保持 NULL");
    assert_eq!(read.rows[1][1].as_deref(), Some(""), "空串保持空串");

    driver.close().await;
}

/// 中止模式：批内失败整体回滚；跳过模式：失败行收集行号继续。
#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn bulk_insert_rows_abort_and_skip_modes() {
    let url = test_url();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    setup_edit_table(
        &driver,
        "bulk_modes",
        "CREATE TABLE bulk_modes (id INT PRIMARY KEY, name VARCHAR(50))",
    )
    .await;
    let scope = probe_scope();
    let columns = vec!["id".to_string(), "name".to_string()];

    // 中止模式：第 3 行主键重复 → 整批回滚
    let rows = vec![
        vec![Some("1".into()), Some("a".into())],
        vec![Some("2".into()), Some("b".into())],
        vec![Some("1".into()), Some("dup".into())],
    ];
    let error = driver
        .bulk_insert_rows(
            &scope,
            "bulk_modes",
            &columns,
            &rows,
            true,
            CancellationToken::new(),
        )
        .await
        .expect_err("中止模式主键重复必须失败");
    match error {
        DriverError::EditApplyFailed { index, .. } => assert_eq!(index, 2, "失败应为批内第 3 行"),
        other => panic!("应为 EditApplyFailed，实际 {other:?}"),
    }
    assert_eq!(
        count_rows(&driver, "bulk_modes").await,
        "0",
        "中止模式整批回滚"
    );

    // 跳过模式：同样的批，前两行成功、第 3 行失败行号收集
    let result = driver
        .bulk_insert_rows(
            &scope,
            "bulk_modes",
            &columns,
            &rows,
            false,
            CancellationToken::new(),
        )
        .await
        .expect("跳过模式应返回报告");
    assert_eq!(result.inserted, 2);
    assert_eq!(result.failed_rows, vec![2], "第 3 行（下标 2）失败");
    assert_eq!(
        count_rows(&driver, "bulk_modes").await,
        "2",
        "跳过模式保留成功行"
    );

    driver.close().await;
}
