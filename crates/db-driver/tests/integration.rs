//! 连真实 MySQL 的 integration 测试
//!
//! 全部标 `#[ignore]`，默认 `cargo test` 不跑；用 `just test-integration`
//! （= `cargo test -p db-driver -- --include-ignored`）执行。
//!
//! 需设环境变量 `TINY_SQL_TEST_MYSQL_URL`（见 .env.example），未设时单测内提前返回。
//! CI 不跑本文件（无 MySQL 服务器）；MySQL 5.7 兼容验证推 Week 5 dogfooding。

use db_driver::MySqlDriver;

/// 读取测试用 MySQL URL；未配置则返回 None
fn test_url() -> Option<String> {
    std::env::var("TINY_SQL_TEST_MYSQL_URL")
        .ok()
        .filter(|s| !s.is_empty())
}

/// 取 URL，未配置则打印提示并提前结束（视为通过，便于无 MySQL 环境直接 run）
macro_rules! url_or_skip {
    () => {
        match test_url() {
            Some(u) => u,
            None => {
                eprintln!("跳过：未设置 TINY_SQL_TEST_MYSQL_URL");
                return;
            }
        }
    };
}

#[tokio::test]
#[ignore = "需要本地 MySQL：设 TINY_SQL_TEST_MYSQL_URL 后 just test-integration"]
async fn ping_returns_one() {
    let url = url_or_skip!();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    assert_eq!(driver.ping().await.expect("ping 失败"), 1);
    driver.close().await;
}

#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn list_databases_contains_information_schema() {
    let url = url_or_skip!();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    let dbs = driver.list_databases().await.expect("list_databases 失败");
    assert!(
        dbs.iter()
            .any(|d| d.name.eq_ignore_ascii_case("information_schema")),
        "应至少包含 information_schema，实际: {:?}",
        dbs.iter().map(|d| &d.name).collect::<Vec<_>>()
    );
    driver.close().await;
}

#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn query_decodes_columns_and_null() {
    let url = url_or_skip!();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");
    let rs = driver
        .query("SELECT 1 AS n, 'hello' AS s, NULL AS nil")
        .await
        .expect("query 失败");
    assert_eq!(rs.columns, vec!["n", "s", "nil"]);
    assert_eq!(rs.rows.len(), 1);
    assert_eq!(rs.rows[0][0].as_deref(), Some("1"));
    assert_eq!(rs.rows[0][1].as_deref(), Some("hello"));
    assert_eq!(rs.rows[0][2], None, "NULL 应解码为 None");
    driver.close().await;
}

#[tokio::test]
#[ignore = "需要本地 MySQL"]
async fn list_tables_and_columns_on_information_schema() {
    // 用 information_schema.tables 这张必然存在的表验证 list_tables / list_columns
    let url = url_or_skip!();
    let driver = MySqlDriver::connect_url(&url).await.expect("连接失败");

    let tables = driver
        .list_tables("information_schema")
        .await
        .expect("list_tables 失败");
    assert!(!tables.is_empty(), "information_schema 应有表");

    let columns = driver
        .list_columns("information_schema", "tables")
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
