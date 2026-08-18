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
