//! 连真实 PostgreSQL 的 integration 测试。
//!
//! 测试默认忽略；配置 `TINY_SQL_TEST_POSTGRES_URL` 后用
//! `just test-postgres-integration` 执行。项目不为 integration 测试启动 Docker。

use std::str::FromStr;
use std::time::Duration;

use bigdecimal::BigDecimal;
use db_driver::{Driver, DriverError, MetadataScope, PostgresDriver, QueryOptions, QUERY_RESULT_LIMIT};
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
        .query("SELECT pg_backend_pid()", read_opts(), CancellationToken::new())
        .await
        .expect("session 查询失败");
    let second = session
        .query("SELECT pg_backend_pid()", read_opts(), CancellationToken::new())
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
        .query("SELECT * FROM table_not_exists_12345", read_opts(), CancellationToken::new())
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
