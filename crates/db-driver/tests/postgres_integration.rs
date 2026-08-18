//! 连真实 PostgreSQL 的最窄 vertical slice integration 测试。
//!
//! 测试默认忽略；配置 `TINY_SQL_TEST_POSTGRES_URL` 后用 `just test-integration`
//! 执行。项目不为 integration 测试启动 Docker。

use db_driver::PostgresDriver;

#[tokio::test]
#[ignore = "需要本地 PostgreSQL：设置 TINY_SQL_TEST_POSTGRES_URL 后运行 just test-integration"]
async fn postgres_ping_returns_one() {
    let url = std::env::var("TINY_SQL_TEST_POSTGRES_URL")
        .ok()
        .filter(|value| !value.is_empty())
        .expect("未设置 TINY_SQL_TEST_POSTGRES_URL，不能把 PostgreSQL integration 记为通过");

    let driver = PostgresDriver::connect_url(&url)
        .await
        .expect("PostgreSQL 连接失败");
    assert_eq!(driver.ping().await.expect("PostgreSQL ping 失败"), 1);
    driver.close().await;
}
