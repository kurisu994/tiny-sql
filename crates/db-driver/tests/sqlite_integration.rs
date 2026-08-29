//! SQLite driver 的 integration 测试。
//!
//! 与 MySQL / PostgreSQL 不同，SQLite 不需要外部服务：每个用例在系统临时目录
//! 建一份独立的库文件，跑完即删，因此**不加 `#[ignore]`**，`just test` 直接覆盖。

use std::path::PathBuf;

use db_driver::{
    ApplyEditsResult, Driver, DriverError, EditCell, FilterOp, MetadataScope, QueryOptions,
    SqliteConnectSettings, SqliteDriver, StatementOutcome, TableBrowseQuery, TableEdit,
    TableFilter, TableOrder,
};
use tokio_util::sync::CancellationToken;

/// 一份用完即删的临时库文件。`Drop` 里连 `-wal` / `-shm` 一起清掉。
struct TempDb {
    path: PathBuf,
}

impl TempDb {
    fn new(name: &str) -> Self {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "tiny-sql-sqlite-{name}-{}-{:?}.db",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        Self { path }
    }

    fn as_str(&self) -> &str {
        self.path.to_str().expect("临时路径应是合法 UTF-8")
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut path = self.path.clone().into_os_string();
            path.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(path));
        }
    }
}

fn write_options() -> QueryOptions {
    QueryOptions {
        row_limit: db_driver::QUERY_RESULT_LIMIT,
        allow_write: true,
    }
}

fn scope() -> MetadataScope {
    MetadataScope::sqlite("main")
}

async fn open(db: &TempDb) -> SqliteDriver {
    SqliteDriver::connect_with_settings(
        db.as_str(),
        SqliteConnectSettings {
            create_if_missing: true,
            ..Default::default()
        },
    )
    .await
    .expect("SQLite 建库失败")
}

/// 建一份带主键 / 索引 / 外键的样例库。
async fn open_with_seed(db: &TempDb) -> SqliteDriver {
    let driver = open(db).await;
    let script = "
        CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL,
            age INTEGER,
            score REAL DEFAULT 0
        );
        CREATE UNIQUE INDEX idx_users_email ON users (email);
        CREATE TABLE orders (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users (id),
            amount REAL NOT NULL
        );
        CREATE INDEX idx_orders_user ON orders (user_id);
        CREATE VIEW active_users AS SELECT id, email FROM users WHERE age IS NOT NULL;
        INSERT INTO users (email, age, score) VALUES
            ('a@example.com', 20, 1.5),
            ('b@example.com', 30, 2.5),
            ('c@example.com', NULL, 3.5);
        INSERT INTO orders (id, user_id, amount) VALUES (1, 1, 9.9), (2, 2, 19.9);
    ";
    let result = driver
        .query_many(script, write_options(), CancellationToken::new())
        .await
        .expect("初始化脚本执行失败");
    for statement in &result.statements {
        assert!(
            matches!(statement.outcome, StatementOutcome::Ok { .. }),
            "初始化语句失败：{}",
            statement.sql
        );
    }
    driver
}

#[tokio::test]
async fn sqlite_ping_returns_one() {
    let db = TempDb::new("ping");
    let driver = open(&db).await;
    assert_eq!(driver.ping().await.expect("ping 失败"), 1);
    driver.close().await;
}

#[tokio::test]
async fn sqlite_refuses_missing_file_instead_of_creating_it() {
    let db = TempDb::new("missing");
    let Err(error) = SqliteDriver::connect(db.as_str()).await else {
        panic!("文件不存在时应报连接失败");
    };
    assert_eq!(error.i18n_key(), "error.driver.connect_failed");
    assert!(!db.path.exists(), "连接失败不应留下空库文件");
}

#[tokio::test]
async fn sqlite_lists_main_database_and_user_objects() {
    let db = TempDb::new("metadata");
    let driver = open_with_seed(&db).await;

    let databases = driver
        .list_databases()
        .await
        .expect("database metadata 失败");
    assert!(databases.iter().any(|d| d.name == "main" && d.is_current));

    // SQLite 没有 schema 层级
    assert!(driver
        .list_schemas("main")
        .await
        .expect("schema metadata 失败")
        .is_empty());

    let tables = driver
        .list_tables(&scope())
        .await
        .expect("table metadata 失败");
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"users"));
    assert!(names.contains(&"orders"));
    assert!(names.contains(&"active_users"));
    // sqlite_sequence 等内部表不进列表
    assert!(!names.iter().any(|name| name.starts_with("sqlite_")));
    assert_eq!(
        tables
            .iter()
            .find(|t| t.name == "active_users")
            .map(|t| t.table_type.as_str()),
        Some("VIEW")
    );

    driver.close().await;
}

#[tokio::test]
async fn sqlite_columns_carry_key_markers_and_defaults() {
    let db = TempDb::new("columns");
    let driver = open_with_seed(&db).await;

    let columns = driver
        .list_columns(&scope(), "users")
        .await
        .expect("column metadata 失败");
    let by_name = |name: &str| {
        columns
            .iter()
            .find(|column| column.name == name)
            .unwrap_or_else(|| panic!("缺少列 {name}"))
    };

    assert_eq!(by_name("id").column_key, "PRI");
    assert!(!by_name("id").nullable);
    // 唯一索引单列 → UNI（与 MySQL 语义对齐）
    assert_eq!(by_name("email").column_key, "UNI");
    assert!(!by_name("email").nullable);
    assert!(by_name("age").nullable);
    assert_eq!(by_name("score").default_value.as_deref(), Some("0"));

    let order_columns = driver
        .list_columns(&scope(), "orders")
        .await
        .expect("orders column metadata 失败");
    let user_id = order_columns
        .iter()
        .find(|column| column.name == "user_id")
        .expect("缺少 user_id");
    assert_eq!(user_id.column_key, "MUL");

    driver.close().await;
}

#[tokio::test]
async fn sqlite_indexes_include_implicit_rowid_primary_key() {
    let db = TempDb::new("indexes");
    let driver = open_with_seed(&db).await;

    let indexes = driver
        .list_indexes(&scope(), "users")
        .await
        .expect("index metadata 失败");
    // INTEGER PRIMARY KEY 是 rowid 别名，index_list 里查不到，需要补出来
    let primary = indexes
        .iter()
        .find(|index| index.index_type == "PRIMARY")
        .expect("应补出隐式主键索引");
    assert_eq!(primary.columns, vec!["id".to_string()]);
    assert!(primary.unique);

    let unique = indexes
        .iter()
        .find(|index| index.name == "idx_users_email")
        .expect("缺少唯一索引");
    assert_eq!(unique.index_type, "UNIQUE");
    assert!(unique.unique);
    assert_eq!(unique.columns, vec!["email".to_string()]);

    driver.close().await;
}

#[tokio::test]
async fn sqlite_constraints_expose_primary_key_and_foreign_key() {
    let db = TempDb::new("constraints");
    let driver = open_with_seed(&db).await;

    let constraints = driver
        .list_constraints(&scope(), "orders")
        .await
        .expect("constraint metadata 失败");

    let pk = constraints
        .iter()
        .find(|c| c.constraint_type == "PRIMARY KEY")
        .expect("缺少主键约束");
    assert_eq!(pk.columns, vec!["id".to_string()]);

    let fk = constraints
        .iter()
        .find(|c| c.constraint_type == "FOREIGN KEY")
        .expect("缺少外键约束");
    assert_eq!(fk.columns, vec!["user_id".to_string()]);
    // 与 MySQL 同款 `目标表(列)` 文本，前端 ER / 外键跳转直接复用解析规则
    assert_eq!(fk.reference.as_deref(), Some("users(id)"));

    driver.close().await;
}

#[tokio::test]
async fn sqlite_schema_overview_returns_all_tables_with_columns_and_constraints() {
    let db = TempDb::new("overview");
    let driver = open_with_seed(&db).await;

    let overview = driver
        .schema_overview(&scope())
        .await
        .expect("schema overview 失败");

    let names: Vec<&str> = overview.iter().map(|table| table.name.as_str()).collect();
    assert!(names.contains(&"users"), "应包含 users：{names:?}");
    assert!(names.contains(&"orders"), "应包含 orders：{names:?}");

    let orders = overview
        .iter()
        .find(|table| table.name == "orders")
        .expect("缺少 orders");
    let id = orders
        .columns
        .iter()
        .find(|column| column.name == "id")
        .expect("缺少 id 列");
    assert_eq!(id.column_key, "PRI", "主键列应标 PRI");
    assert!(
        orders.columns.iter().any(|column| column.name == "user_id"),
        "应带出全部列"
    );

    let fk = orders
        .constraints
        .iter()
        .find(|c| c.constraint_type == "FOREIGN KEY")
        .expect("缺少外键约束");
    assert_eq!(fk.columns, vec!["user_id".to_string()]);
    assert_eq!(fk.reference.as_deref(), Some("users(id)"));

    driver.close().await;
}

#[tokio::test]
async fn sqlite_query_applies_row_limit_and_marks_truncation() {
    let db = TempDb::new("limit");
    let driver = open_with_seed(&db).await;

    let row_set = driver
        .query_with_options(
            "SELECT id, email FROM users ORDER BY id",
            QueryOptions {
                row_limit: 2,
                allow_write: false,
            },
            CancellationToken::new(),
        )
        .await
        .expect("查询失败");
    assert_eq!(row_set.columns, vec!["id".to_string(), "email".to_string()]);
    assert_eq!(row_set.rows.len(), 2);
    assert!(row_set.truncated, "行数超上限应标记截断");

    driver.close().await;
}

#[tokio::test]
async fn sqlite_query_decodes_null_and_value_types() {
    let db = TempDb::new("decode");
    let driver = open_with_seed(&db).await;

    let row_set = driver
        .query("SELECT age, score, email FROM users WHERE email = 'c@example.com'")
        .await
        .expect("查询失败");
    let row = &row_set.rows[0];
    assert_eq!(row[0], None, "SQL NULL 应解码为 None");
    assert_eq!(row[1].as_deref(), Some("3.5"));
    assert_eq!(row[2].as_deref(), Some("c@example.com"));

    driver.close().await;
}

#[tokio::test]
async fn sqlite_write_requires_confirmation_and_pragma_reads_freely() {
    let db = TempDb::new("guard");
    let driver = open_with_seed(&db).await;

    let error = driver
        .query_with_options(
            "DELETE FROM users",
            QueryOptions::default(),
            CancellationToken::new(),
        )
        .await
        .expect_err("未确认的写语句应被拒绝");
    assert!(matches!(error, DriverError::WriteRequiresConfirmation));

    // PRAGMA / EXPLAIN QUERY PLAN 按元数据读处理，不要求写确认
    driver
        .query_with_options(
            "PRAGMA table_info('users')",
            QueryOptions::default(),
            CancellationToken::new(),
        )
        .await
        .expect("PRAGMA 应可直接执行");
    driver
        .query_with_options(
            "EXPLAIN QUERY PLAN SELECT * FROM users",
            QueryOptions::default(),
            CancellationToken::new(),
        )
        .await
        .expect("EXPLAIN QUERY PLAN 应可直接执行");

    driver.close().await;
}

/// 回归：裸 VALUES 曾被追加 `LIMIT n`，而 SQLite 不接受该后缀，执行必报语法错误。
#[tokio::test]
async fn sqlite_bare_values_statement_executes() {
    let db = TempDb::new("values");
    let driver = open(&db).await;

    let row_set = driver
        .query_with_options(
            "VALUES (1), (2), (3)",
            QueryOptions {
                row_limit: 2,
                allow_write: false,
            },
            CancellationToken::new(),
        )
        .await
        .expect("裸 VALUES 应能执行");
    // 服务端不能封顶，靠客户端截断
    assert_eq!(row_set.rows.len(), 2);
    assert!(row_set.truncated);

    driver.close().await;
}

/// 回归：PRAGMA 曾被一律当元数据读放行，赋值形式会绕过写确认改写数据库文件。
#[tokio::test]
async fn sqlite_pragma_assignment_requires_write_confirmation() {
    let db = TempDb::new("pragma");
    let driver = open(&db).await;

    for sql in ["PRAGMA user_version = 42", "PRAGMA journal_mode = WAL"] {
        let error = driver
            .query_with_options(sql, QueryOptions::default(), CancellationToken::new())
            .await
            .expect_err("赋值形式的 PRAGMA 应要求写确认");
        assert!(
            matches!(error, DriverError::WriteRequiresConfirmation),
            "{sql}"
        );
    }
    // 未确认就被拦下，库没被改动
    let row_set = driver
        .query("PRAGMA user_version")
        .await
        .expect("查询形式的 PRAGMA 应直接放行");
    assert_eq!(row_set.rows[0][0].as_deref(), Some("0"));

    driver.close().await;
}

#[tokio::test]
async fn sqlite_transaction_control_requires_session() {
    let db = TempDb::new("txguard");
    let driver = open_with_seed(&db).await;

    let error = driver
        .query_with_options("BEGIN", write_options(), CancellationToken::new())
        .await
        .expect_err("pool 路径不能执行事务控制语句");
    assert!(matches!(error, DriverError::TxRequiresSession));

    driver.close().await;
}

#[tokio::test]
async fn sqlite_browse_table_filters_orders_and_pages() {
    let db = TempDb::new("browse");
    let driver = open_with_seed(&db).await;

    let query = TableBrowseQuery {
        filters: vec![TableFilter {
            column: "age".to_string(),
            op: FilterOp::IsNotNull,
            value: String::new(),
        }],
        order: Some(TableOrder {
            column: "age".to_string(),
            descending: true,
        }),
        limit: 1,
        offset: 0,
    };
    let result = driver
        .browse_table(&scope(), "users", &query, CancellationToken::new())
        .await
        .expect("浏览失败");
    assert_eq!(result.total, Some(2));
    assert!(result.has_next_page);
    assert_eq!(result.row_set.rows.len(), 1);
    let email_index = result
        .row_set
        .columns
        .iter()
        .position(|column| column == "email")
        .expect("缺少 email 列");
    assert_eq!(
        result.row_set.rows[0][email_index].as_deref(),
        Some("b@example.com"),
        "降序应先返回年龄最大的行"
    );

    driver.close().await;
}

#[tokio::test]
async fn sqlite_browse_table_keeps_headers_on_empty_result() {
    let db = TempDb::new("browse-empty");
    let driver = open_with_seed(&db).await;

    let query = TableBrowseQuery {
        filters: vec![TableFilter {
            column: "email".to_string(),
            op: FilterOp::Eq,
            value: "missing@example.com".to_string(),
        }],
        order: None,
        limit: 50,
        offset: 0,
    };
    let result = driver
        .browse_table(&scope(), "users", &query, CancellationToken::new())
        .await
        .expect("浏览失败");
    assert!(result.row_set.rows.is_empty());
    assert_eq!(result.total, Some(0));
    assert!(!result.has_next_page);
    assert_eq!(
        result.row_set.columns,
        vec![
            "id".to_string(),
            "email".to_string(),
            "age".to_string(),
            "score".to_string()
        ],
        "0 行也要给出表头"
    );

    driver.close().await;
}

#[tokio::test]
async fn sqlite_apply_table_edits_commits_batch() {
    let db = TempDb::new("edits");
    let driver = open_with_seed(&db).await;

    let edits = vec![
        TableEdit::Insert {
            values: vec![
                EditCell {
                    column: "email".to_string(),
                    value: Some("d@example.com".to_string()),
                },
                EditCell {
                    column: "age".to_string(),
                    value: Some("40".to_string()),
                },
            ],
        },
        TableEdit::Update {
            pk: vec![EditCell {
                column: "id".to_string(),
                value: Some("1".to_string()),
            }],
            changes: vec![EditCell {
                column: "age".to_string(),
                value: None,
            }],
        },
        TableEdit::Delete {
            pk: vec![EditCell {
                column: "id".to_string(),
                value: Some("3".to_string()),
            }],
        },
    ];
    let ApplyEditsResult { applied } = driver
        .apply_table_edits(
            &scope(),
            "users",
            &["id".to_string()],
            &edits,
            CancellationToken::new(),
        )
        .await
        .expect("编辑批应用失败");
    assert_eq!(applied, 3);

    let row_set = driver
        .query("SELECT COUNT(*) FROM users WHERE age IS NULL")
        .await
        .expect("校验查询失败");
    assert_eq!(row_set.rows[0][0].as_deref(), Some("1"));

    driver.close().await;
}

#[tokio::test]
async fn sqlite_apply_table_edits_rejects_wrong_primary_key() {
    let db = TempDb::new("edits-pk");
    let driver = open_with_seed(&db).await;

    let error = driver
        .apply_table_edits(
            &scope(),
            "users",
            &["email".to_string()],
            &[TableEdit::Delete {
                pk: vec![EditCell {
                    column: "email".to_string(),
                    value: Some("a@example.com".to_string()),
                }],
            }],
            CancellationToken::new(),
        )
        .await
        .expect_err("传入非真实主键应被拒绝");
    assert!(matches!(error, DriverError::NoPrimaryKey));

    driver.close().await;
}

#[tokio::test]
async fn sqlite_apply_table_edits_reports_conflict_and_rolls_back() {
    let db = TempDb::new("edits-conflict");
    let driver = open_with_seed(&db).await;

    let edits = vec![
        TableEdit::Update {
            pk: vec![EditCell {
                column: "id".to_string(),
                value: Some("1".to_string()),
            }],
            changes: vec![EditCell {
                column: "age".to_string(),
                value: Some("99".to_string()),
            }],
        },
        // 不存在的行：影响行数 0，应整体回滚
        TableEdit::Update {
            pk: vec![EditCell {
                column: "id".to_string(),
                value: Some("9999".to_string()),
            }],
            changes: vec![EditCell {
                column: "age".to_string(),
                value: Some("1".to_string()),
            }],
        },
    ];
    let error = driver
        .apply_table_edits(
            &scope(),
            "users",
            &["id".to_string()],
            &edits,
            CancellationToken::new(),
        )
        .await
        .expect_err("命中 0 行应报冲突");
    assert!(matches!(error, DriverError::EditConflict { index: 1 }));

    let row_set = driver
        .query("SELECT age FROM users WHERE id = 1")
        .await
        .expect("校验查询失败");
    assert_eq!(
        row_set.rows[0][0].as_deref(),
        Some("20"),
        "冲突应整体回滚，前一条 UPDATE 不能留下"
    );

    driver.close().await;
}

#[tokio::test]
async fn sqlite_bulk_insert_skips_failed_rows_without_transaction() {
    let db = TempDb::new("bulk");
    let driver = open_with_seed(&db).await;

    let rows = vec![
        vec![Some("e@example.com".to_string()), Some("50".to_string())],
        // email 上有唯一索引，重复值这一行会失败
        vec![Some("a@example.com".to_string()), Some("60".to_string())],
        vec![Some("f@example.com".to_string()), None],
    ];
    let result = driver
        .bulk_insert_rows(
            &scope(),
            "users",
            &["email".to_string(), "age".to_string()],
            &rows,
            false,
            CancellationToken::new(),
        )
        .await
        .expect("批量插入失败");
    assert_eq!(result.inserted, 2);
    assert_eq!(result.failed_rows, vec![1]);

    driver.close().await;
}

#[tokio::test]
async fn sqlite_bulk_insert_rolls_back_whole_batch_when_transactional() {
    let db = TempDb::new("bulk-tx");
    let driver = open_with_seed(&db).await;

    let before = driver
        .query("SELECT COUNT(*) FROM users")
        .await
        .expect("计数失败")
        .rows[0][0]
        .clone();

    let rows = vec![
        vec![Some("g@example.com".to_string())],
        vec![Some("a@example.com".to_string())],
    ];
    let error = driver
        .bulk_insert_rows(
            &scope(),
            "users",
            &["email".to_string()],
            &rows,
            true,
            CancellationToken::new(),
        )
        .await
        .expect_err("事务模式下失败行应整体回滚");
    assert!(matches!(
        error,
        DriverError::EditApplyFailed { index: 1, .. }
    ));

    let after = driver
        .query("SELECT COUNT(*) FROM users")
        .await
        .expect("计数失败")
        .rows[0][0]
        .clone();
    assert_eq!(before, after, "回滚后行数不变");

    driver.close().await;
}

#[tokio::test]
async fn sqlite_query_many_stops_at_first_error_and_skips_rest() {
    let db = TempDb::new("multi");
    let driver = open_with_seed(&db).await;

    let result = driver
        .query_many(
            "UPDATE users SET age = 21 WHERE id = 1; SELECT * FROM missing_table; SELECT 1;",
            write_options(),
            CancellationToken::new(),
        )
        .await
        .expect("多语句执行返回失败");
    assert_eq!(result.statements.len(), 3);
    assert!(matches!(
        result.statements[0].outcome,
        StatementOutcome::Ok { .. }
    ));
    assert!(matches!(
        result.statements[1].outcome,
        StatementOutcome::Error { .. }
    ));
    assert!(matches!(
        result.statements[2].outcome,
        StatementOutcome::Skipped
    ));

    driver.close().await;
}

#[tokio::test]
async fn sqlite_session_rolls_back_uncommitted_transaction_on_close() {
    let db = TempDb::new("session");
    let driver = open_with_seed(&db).await;

    let mut session = driver.begin_session().await.expect("开启 session 失败");
    assert!(session.in_transaction());
    // 先清子表再清父表：driver 显式开了外键约束，直接删 users 会被数据库挡下
    for sql in ["DELETE FROM orders", "DELETE FROM users"] {
        session
            .query(sql, write_options(), CancellationToken::new())
            .await
            .expect("session 内写入失败");
    }
    session.close().await;

    let row_set = driver
        .query("SELECT COUNT(*) FROM users")
        .await
        .expect("计数失败");
    assert_eq!(
        row_set.rows[0][0].as_deref(),
        Some("3"),
        "未提交事务应在 close 时回滚"
    );

    driver.close().await;
}

#[tokio::test]
async fn sqlite_session_commit_persists_and_clears_transaction_flag() {
    let db = TempDb::new("session-commit");
    let driver = open_with_seed(&db).await;

    let mut session = driver.begin_session().await.expect("开启 session 失败");
    session
        .query(
            "DELETE FROM users WHERE id = 3",
            write_options(),
            CancellationToken::new(),
        )
        .await
        .expect("session 内写入失败");
    session.commit().await.expect("提交失败");
    assert!(!session.in_transaction());
    assert!(matches!(
        session.commit().await,
        Err(DriverError::SessionNotInTransaction)
    ));
    session.close().await;

    let row_set = driver
        .query("SELECT COUNT(*) FROM users")
        .await
        .expect("计数失败");
    assert_eq!(row_set.rows[0][0].as_deref(), Some("2"));

    driver.close().await;
}

#[tokio::test]
async fn sqlite_enforces_foreign_keys() {
    let db = TempDb::new("fk");
    let driver = open_with_seed(&db).await;

    // SQLite 自身默认关闭外键约束，driver 显式打开：删父行应被数据库挡下
    let error = driver
        .query_with_options(
            "DELETE FROM users WHERE id = 1",
            write_options(),
            CancellationToken::new(),
        )
        .await
        .expect_err("被引用的父行不应删得掉");
    assert_eq!(error.i18n_key(), "error.driver.query_failed");

    driver.close().await;
}

#[tokio::test]
async fn sqlite_cancelled_token_short_circuits_query() {
    let db = TempDb::new("cancel");
    let driver = open_with_seed(&db).await;

    let token = CancellationToken::new();
    token.cancel();
    let error = driver
        .query_with_options("SELECT * FROM users", QueryOptions::default(), token)
        .await
        .expect_err("已取消的 token 应直接短路");
    assert!(matches!(error, DriverError::QueryCancelled));

    // 取消不应污染连接池：后续查询照常可用
    assert_eq!(driver.ping().await.expect("ping 失败"), 1);

    driver.close().await;
}

#[tokio::test]
async fn sqlite_read_only_connection_rejects_writes() {
    let db = TempDb::new("readonly");
    {
        let driver = open_with_seed(&db).await;
        driver.close().await;
    }

    let driver = SqliteDriver::connect_with_settings(
        db.as_str(),
        SqliteConnectSettings {
            read_only: true,
            ..Default::default()
        },
    )
    .await
    .expect("只读打开失败");

    // 读正常
    assert_eq!(
        driver
            .query("SELECT COUNT(*) FROM users")
            .await
            .expect("只读查询失败")
            .rows[0][0]
            .as_deref(),
        Some("3")
    );
    // 写被 SQLite 自身拒绝
    let error = driver
        .query_with_options(
            "DELETE FROM users",
            write_options(),
            CancellationToken::new(),
        )
        .await
        .expect_err("只读连接不应允许写入");
    assert_eq!(error.i18n_key(), "error.driver.query_failed");

    driver.close().await;
}
