//! 官方工具备份 / 恢复（FR-260）。
//!
//! 编排本机 `mysqldump` / `mysql` / `pg_dump` / `pg_restore`，经已打开连接的
//! 直连地址或 SSH 隧道本地端口读写文件。凭据只写入 0600 临时文件，禁止出现在
//! argv。找不到官方工具时返回明确错误，不回退成 FR-252 dump。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use db_driver::{Driver, DriverKind};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::commands::query::QueryCommandError;
use crate::config::store::StoredConnection;
use crate::state::{ActiveQuery, AppState};

/// 备份进度事件（已写入 / 已读取字节）。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupProgressPayload {
    query_id: String,
    bytes: u64,
}

/// 工具探测结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupToolInfo {
    pub path: String,
    pub version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProbeResult {
    pub dump: Option<BackupToolInfo>,
    pub client: Option<BackupToolInfo>,
    /// 不含密码的命令模板，供确认框展示
    pub export_preview: String,
    pub restore_preview: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProbeInput {
    pub dump_path: Option<String>,
    pub client_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupExportInput {
    pub database: String,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub path: String,
    pub dump_path: Option<String>,
    pub query_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRestoreInput {
    pub database: String,
    /// 用户手输的目标库名，必须与 database 完全一致
    pub confirm_database: String,
    pub schema: Option<String>,
    pub path: String,
    pub client_path: Option<String>,
    pub query_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupJobResult {
    pub bytes: u64,
    pub tool_version: String,
    pub log: String,
}

struct SecretFile(PathBuf);

impl Drop for SecretFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn err(key: &str) -> QueryCommandError {
    QueryCommandError::from_key(key)
}

/// 在 PATH 或用户指定路径解析可执行文件。
pub fn resolve_tool(name: &str, override_path: Option<&str>) -> Result<PathBuf, QueryCommandError> {
    if let Some(raw) = override_path.map(str::trim).filter(|s| !s.is_empty()) {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return Ok(path);
        }
        return Err(err("error.backup.tool_not_found"));
    }
    let names = tool_names(name);
    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        for candidate in &names {
            let path = dir.join(candidate);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    Err(err("error.backup.tool_not_found"))
}

fn tool_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        vec![format!("{name}.exe"), name.to_string()]
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

fn read_version(path: &Path) -> String {
    std::process::Command::new(path)
        .arg("--version")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|text| {
            text.lines()
                .next()
                .unwrap_or("")
                .trim()
                .chars()
                .take(160)
                .collect()
        })
        .filter(|text: &String| !text.is_empty())
        .unwrap_or_else(|| path.display().to_string())
}

/// MySQL defaults-extra-file 内容（密码加引号并转义）。
pub fn mysql_defaults_file(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
) -> Result<String, QueryCommandError> {
    if password.contains('\n') || password.contains('\r') {
        return Err(err("error.backup.failed"));
    }
    let escaped = password.replace('\\', "\\\\").replace('"', "\\\"");
    Ok(format!(
        "[client]\nhost={host}\nport={port}\nuser={user}\npassword=\"{escaped}\"\n"
    ))
}

/// pgpass 一行：`:` `\` 转义。
pub fn pgpass_line(
    host: &str,
    port: u16,
    database: &str,
    user: &str,
    password: &str,
) -> Result<String, QueryCommandError> {
    if password.contains('\n') || password.contains('\r') {
        return Err(err("error.backup.failed"));
    }
    fn esc(value: &str) -> String {
        value.replace('\\', "\\\\").replace(':', "\\:")
    }
    Ok(format!(
        "{}:{}:{}:{}:{}",
        esc(host),
        port,
        esc(database),
        esc(user),
        esc(password)
    ))
}

fn write_secret_file(contents: &str) -> Result<SecretFile, QueryCommandError> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("tiny-sql-backup-{nanos}"));
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(&path).map_err(|_| err("error.backup.io"))?;
    file.write_all(contents.as_bytes())
        .map_err(|_| err("error.backup.io"))?;
    file.sync_all().map_err(|_| err("error.backup.io"))?;
    Ok(SecretFile(path))
}

fn stored_of(state: &AppState, id: &str) -> Result<StoredConnection, QueryCommandError> {
    let store = state
        .store
        .lock()
        .map_err(|_| err("error.connection.not_found"))?;
    store
        .load()
        .map_err(QueryCommandError::from_key)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| err("error.connection.not_found"))
}

async fn endpoint_of(
    state: &AppState,
    id: &str,
    stored: &StoredConnection,
) -> Result<(String, u16, DriverKind), QueryCommandError> {
    let conns = state.connections.lock().await;
    let open = conns
        .get(id)
        .ok_or_else(|| err("error.connection.not_open"))?;
    let kind = Driver::kind(&open.driver);
    if let Some(tunnel) = &open.tunnel {
        let addr = tunnel.local_addr();
        Ok((addr.ip().to_string(), addr.port(), kind))
    } else {
        Ok((stored.host.clone(), stored.port, kind))
    }
}

fn dump_tool_name(kind: DriverKind) -> &'static str {
    match kind {
        DriverKind::MySql => "mysqldump",
        DriverKind::PostgreSql => "pg_dump",
        // SQLite 导出与导入都用官方 sqlite3 shell
        DriverKind::Sqlite => "sqlite3",
    }
}

fn client_tool_name(kind: DriverKind) -> &'static str {
    match kind {
        DriverKind::MySql => "mysql",
        DriverKind::PostgreSql => "pg_restore",
        DriverKind::Sqlite => "sqlite3",
    }
}

fn sanitize_log(text: &str) -> String {
    text.chars().take(800).collect()
}

struct ProcessIo<'a> {
    program: &'a Path,
    args: &'a [String],
    envs: &'a [(String, String)],
    stdout_path: Option<&'a Path>,
    stdin_path: Option<&'a Path>,
    token: CancellationToken,
    app: &'a AppHandle,
    query_id: &'a str,
}

async fn run_process(io: ProcessIo<'_>) -> Result<(u64, String), QueryCommandError> {
    let ProcessIo {
        program,
        args,
        envs,
        stdout_path,
        stdin_path,
        token,
        app,
        query_id,
    } = io;
    let mut command = Command::new(program);
    command
        .args(args)
        .envs(envs.iter().cloned())
        .kill_on_drop(true);
    if stdout_path.is_some() {
        command.stdout(Stdio::piped());
    } else {
        command.stdout(Stdio::null());
    }
    command.stderr(Stdio::piped());
    if stdin_path.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|_| err("error.backup.failed"))?;
    let mut bytes = 0u64;
    let mut stderr_buf = Vec::new();

    if let (Some(path), Some(mut stdout)) = (stdout_path, child.stdout.take()) {
        let mut file = tokio::fs::File::create(path)
            .await
            .map_err(|_| err("error.backup.io"))?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            tokio::select! {
                _ = token.cancelled() => {
                    let _ = child.start_kill();
                    return Err(err("error.backup.cancelled"));
                }
                read = stdout.read(&mut buf) => {
                    match read {
                        Ok(0) => break,
                        Ok(n) => {
                            file.write_all(&buf[..n]).await.map_err(|_| err("error.backup.io"))?;
                            bytes += n as u64;
                            let _ = app.emit(
                                "backup:progress",
                                BackupProgressPayload {
                                    query_id: query_id.to_string(),
                                    bytes,
                                },
                            );
                        }
                        Err(_) => {
                            let _ = child.start_kill();
                            return Err(err("error.backup.failed"));
                        }
                    }
                }
            }
        }
        file.flush().await.map_err(|_| err("error.backup.io"))?;
    } else if let (Some(path), Some(mut stdin)) = (stdin_path, child.stdin.take()) {
        let mut file = tokio::fs::File::open(path)
            .await
            .map_err(|_| err("error.backup.io"))?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            tokio::select! {
                _ = token.cancelled() => {
                    let _ = child.start_kill();
                    return Err(err("error.backup.cancelled"));
                }
                read = file.read(&mut buf) => {
                    match read {
                        Ok(0) => break,
                        Ok(n) => {
                            stdin.write_all(&buf[..n]).await.map_err(|_| err("error.backup.failed"))?;
                            bytes += n as u64;
                            let _ = app.emit(
                                "backup:progress",
                                BackupProgressPayload {
                                    query_id: query_id.to_string(),
                                    bytes,
                                },
                            );
                        }
                        Err(_) => {
                            let _ = child.start_kill();
                            return Err(err("error.backup.io"));
                        }
                    }
                }
            }
        }
        drop(stdin);
    }

    if let Some(mut stderr) = child.stderr.take() {
        let _ = stderr.read_to_end(&mut stderr_buf).await;
    }
    let status = child.wait().await.map_err(|_| err("error.backup.failed"))?;
    let log = sanitize_log(&String::from_utf8_lossy(&stderr_buf));
    if token.is_cancelled() {
        return Err(err("error.backup.cancelled"));
    }
    if !status.success() {
        return Err(err("error.backup.failed"));
    }
    Ok((bytes, log))
}

fn mysql_dump_args(defaults: &Path, database: &str, table: Option<&str>) -> Vec<String> {
    let mut args = vec![
        format!("--defaults-extra-file={}", defaults.display()),
        "--single-transaction".into(),
        "--routines".into(),
        "--events".into(),
        database.to_string(),
    ];
    if let Some(table) = table.filter(|s| !s.is_empty()) {
        args.push(table.to_string());
    }
    args
}

fn mysql_restore_args(defaults: &Path, database: &str) -> Vec<String> {
    vec![
        format!("--defaults-extra-file={}", defaults.display()),
        database.to_string(),
    ]
}

fn pg_dump_args(
    host: &str,
    port: u16,
    user: &str,
    database: &str,
    schema: Option<&str>,
    table: Option<&str>,
    file: &str,
) -> Vec<String> {
    let mut args = vec![
        "--format=custom".into(),
        format!("--host={host}"),
        format!("--port={port}"),
        format!("--username={user}"),
        format!("--dbname={database}"),
        format!("--file={file}"),
    ];
    if let Some(schema) = schema.filter(|s| !s.is_empty()) {
        args.push(format!("--schema={schema}"));
        if let Some(table) = table.filter(|s| !s.is_empty()) {
            args.push(format!("--table={schema}.{table}"));
        }
    } else if let Some(table) = table.filter(|s| !s.is_empty()) {
        args.push(format!("--table={table}"));
    }
    args
}

/// `sqlite3 <file> ".dump"`：**整库**导出为 SQL 文本，由调用方重定向 stdout。
///
/// 不支持限定单表：`.dump` 的参数是 LIKE 模式而非表名，`_` / `%` 都是通配符
/// （`.dump "user_data"` 会连 `userXdata` 一起带出），而 `.dump` 没有 ESCAPE 可用。
/// 单表导出请走内置 dump 导出（`commands::dump`），那条路是按表名精确取的。
fn sqlite_dump_args(db_path: &str) -> Vec<String> {
    vec![db_path.to_string(), ".dump".to_string()]
}

/// `sqlite3 <file>`：SQL 文本从 stdin 灌入。
fn sqlite_restore_args(db_path: &str) -> Vec<String> {
    vec![db_path.to_string()]
}

fn pg_restore_args(host: &str, port: u16, user: &str, database: &str, file: &str) -> Vec<String> {
    vec![
        format!("--host={host}"),
        format!("--port={port}"),
        format!("--username={user}"),
        format!("--dbname={database}"),
        "--clean".into(),
        "--if-exists".into(),
        file.to_string(),
    ]
}

/// 探测官方客户端是否在 PATH / 指定路径。
#[tauri::command]
pub async fn backup_probe_tools(
    state: State<'_, AppState>,
    id: String,
    input: BackupProbeInput,
) -> Result<BackupProbeResult, QueryCommandError> {
    let stored = stored_of(&state, &id)?;
    let kind = stored.driver;
    let dump = resolve_tool(dump_tool_name(kind), input.dump_path.as_deref()).ok();
    let client = resolve_tool(client_tool_name(kind), input.client_path.as_deref()).ok();
    let export_preview = match kind {
        DriverKind::MySql => "mysqldump --defaults-extra-file=<secret> --single-transaction <database> [table]".into(),
        DriverKind::PostgreSql => {
            "pg_dump --format=custom --host=<endpoint> --username=<user> --dbname=<database> --file=<path>".into()
        }
        DriverKind::Sqlite => "sqlite3 <file> \".dump\" > <path>（仅整库）".into(),
    };
    let restore_preview = match kind {
        DriverKind::MySql => "mysql --defaults-extra-file=<secret> <database>".into(),
        DriverKind::PostgreSql => {
            "pg_restore --host=<endpoint> --username=<user> --dbname=<database> --clean --if-exists <path>".into()
        }
        DriverKind::Sqlite => "sqlite3 <file> < <path>".into(),
    };
    Ok(BackupProbeResult {
        dump: dump.map(|path| BackupToolInfo {
            version: read_version(&path),
            path: path.display().to_string(),
        }),
        client: client.map(|path| BackupToolInfo {
            version: read_version(&path),
            path: path.display().to_string(),
        }),
        export_preview,
        restore_preview,
    })
}

/// 官方工具导出备份文件。
#[tauri::command]
pub async fn db_backup_export(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    input: BackupExportInput,
) -> Result<BackupJobResult, QueryCommandError> {
    let stored = stored_of(&state, &id)?;
    let (host, port, kind) = endpoint_of(&state, &id, &stored).await?;
    let dump = resolve_tool(dump_tool_name(kind), input.dump_path.as_deref())?;
    let version = read_version(&dump);
    let query_id = input.query_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let token = CancellationToken::new();
    state.queries.lock().await.insert(
        query_id.clone(),
        ActiveQuery {
            connection_id: id.clone(),
            cancel_token: token.clone(),
        },
    );
    let database = input.database.trim().to_string();
    let table = input.table.filter(|s| !s.trim().is_empty());
    // SQLite 的 .dump 只能整库：宁可明确拒绝，也不能悄悄导出一个「超集」备份
    if kind == DriverKind::Sqlite && table.is_some() {
        state.queries.lock().await.remove(&query_id);
        return Err(err("error.backup.table_scope_unsupported"));
    }
    let result = async {
        match kind {
            DriverKind::MySql => {
                let defaults = write_secret_file(&mysql_defaults_file(
                    &host,
                    port,
                    &stored.user,
                    &stored.password,
                )?)?;
                let args = mysql_dump_args(&defaults.0, &database, table.as_deref());
                run_process(ProcessIo {
                    program: &dump,
                    args: &args,
                    envs: &[],
                    stdout_path: Some(Path::new(&input.path)),
                    stdin_path: None,
                    token: token.clone(),
                    app: &app,
                    query_id: &query_id,
                })
                .await
            }
            DriverKind::PostgreSql => {
                let pass = write_secret_file(&pgpass_line(
                    &host,
                    port,
                    &database,
                    &stored.user,
                    &stored.password,
                )?)?;
                let args = pg_dump_args(
                    &host,
                    port,
                    &stored.user,
                    &database,
                    input.schema.as_deref(),
                    table.as_deref(),
                    &input.path,
                );
                let envs = [("PGPASSFILE".into(), pass.0.display().to_string())];
                run_process(ProcessIo {
                    program: &dump,
                    args: &args,
                    envs: &envs,
                    stdout_path: None,
                    stdin_path: None,
                    token: token.clone(),
                    app: &app,
                    query_id: &query_id,
                })
                .await
            }
            // SQLite 的目标是文件本身：database 字段存的就是路径，无凭据文件
            DriverKind::Sqlite => {
                let args = sqlite_dump_args(stored.database.trim());
                run_process(ProcessIo {
                    program: &dump,
                    args: &args,
                    envs: &[],
                    stdout_path: Some(Path::new(&input.path)),
                    stdin_path: None,
                    token: token.clone(),
                    app: &app,
                    query_id: &query_id,
                })
                .await
            }
        }
    }
    .await;
    state.queries.lock().await.remove(&query_id);
    let (mut bytes, log) = result?;
    if bytes == 0 {
        if let Ok(meta) = std::fs::metadata(&input.path) {
            bytes = meta.len();
        }
    }
    Ok(BackupJobResult {
        bytes,
        tool_version: version,
        log,
    })
}

/// 官方工具恢复。必须手输目标库名。
#[tauri::command]
pub async fn db_backup_restore(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    input: BackupRestoreInput,
) -> Result<BackupJobResult, QueryCommandError> {
    crate::commands::query::reject_if_read_only(&state, &id)?;
    if input.confirm_database.trim() != input.database.trim() {
        return Err(err("error.backup.target_mismatch"));
    }
    let stored = stored_of(&state, &id)?;
    let (host, port, kind) = endpoint_of(&state, &id, &stored).await?;
    let client = resolve_tool(client_tool_name(kind), input.client_path.as_deref())?;
    let version = read_version(&client);
    let query_id = input.query_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    let token = CancellationToken::new();
    state.queries.lock().await.insert(
        query_id.clone(),
        ActiveQuery {
            connection_id: id.clone(),
            cancel_token: token.clone(),
        },
    );
    let database = input.database.trim().to_string();
    let result = async {
        match kind {
            DriverKind::MySql => {
                let defaults = write_secret_file(&mysql_defaults_file(
                    &host,
                    port,
                    &stored.user,
                    &stored.password,
                )?)?;
                let args = mysql_restore_args(&defaults.0, &database);
                run_process(ProcessIo {
                    program: &client,
                    args: &args,
                    envs: &[],
                    stdout_path: None,
                    stdin_path: Some(Path::new(&input.path)),
                    token: token.clone(),
                    app: &app,
                    query_id: &query_id,
                })
                .await
            }
            DriverKind::PostgreSql => {
                let pass = write_secret_file(&pgpass_line(
                    &host,
                    port,
                    &database,
                    &stored.user,
                    &stored.password,
                )?)?;
                let args = pg_restore_args(&host, port, &stored.user, &database, &input.path);
                let envs = [("PGPASSFILE".into(), pass.0.display().to_string())];
                run_process(ProcessIo {
                    program: &client,
                    args: &args,
                    envs: &envs,
                    stdout_path: None,
                    stdin_path: None,
                    token: token.clone(),
                    app: &app,
                    query_id: &query_id,
                })
                .await
            }
            DriverKind::Sqlite => {
                let args = sqlite_restore_args(stored.database.trim());
                run_process(ProcessIo {
                    program: &client,
                    args: &args,
                    envs: &[],
                    stdout_path: None,
                    stdin_path: Some(Path::new(&input.path)),
                    token: token.clone(),
                    app: &app,
                    query_id: &query_id,
                })
                .await
            }
        }
    }
    .await;
    state.queries.lock().await.remove(&query_id);
    let (bytes, log) = result?;
    Ok(BackupJobResult {
        bytes,
        tool_version: version,
        log,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SQLite 的 `.dump` 参数是 LIKE 模式不是表名，没有 ESCAPE 可用，
    /// 所以这里只能整库导出；单表由 `commands::dump` 的内置导出负责。
    #[test]
    fn sqlite_dump_args_are_whole_database_only() {
        assert_eq!(
            sqlite_dump_args("/tmp/app.db"),
            vec!["/tmp/app.db".to_string(), ".dump".to_string()]
        );
    }

    #[test]
    fn sqlite_restore_args_take_only_the_database_file() {
        assert_eq!(
            sqlite_restore_args("/tmp/app.db"),
            vec!["/tmp/app.db".to_string()]
        );
    }

    #[test]
    fn sqlite_uses_official_sqlite3_shell_for_both_directions() {
        assert_eq!(dump_tool_name(DriverKind::Sqlite), "sqlite3");
        assert_eq!(client_tool_name(DriverKind::Sqlite), "sqlite3");
    }

    #[test]
    fn mysql_defaults_quotes_password_and_keeps_password_out_of_argv() {
        let body = mysql_defaults_file("127.0.0.1", 3306, "root", r#"p"w\x"#).unwrap();
        assert!(body.contains("host=127.0.0.1"));
        assert!(body.contains("port=3306"));
        assert!(body.contains(r#"password="p\"w\\x""#));
        let args = mysql_dump_args(Path::new("/tmp/x.cnf"), "app", Some("users"));
        assert!(args.iter().all(|a| !a.contains("p\"w")));
        assert_eq!(args.last().unwrap(), "users");
    }

    #[test]
    fn pgpass_escapes_colon() {
        let line = pgpass_line("127.0.0.1", 5432, "app", "u", "a:b\\c").unwrap();
        assert_eq!(line, r"127.0.0.1:5432:app:u:a\:b\\c");
    }

    #[test]
    fn resolve_tool_missing_is_stable_key() {
        let error = resolve_tool("definitely-not-a-real-backup-tool-xyz", None).unwrap_err();
        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["key"], "error.backup.tool_not_found");
    }

    #[test]
    fn restore_preview_has_no_password() {
        let args = mysql_restore_args(Path::new("/tmp/x.cnf"), "app");
        assert_eq!(args[1], "app");
        assert!(args.iter().all(|a| !a.to_lowercase().contains("password=")));
    }
}
