//! 连接管理命令 —— CRUD + 测试连接
//!
//! 负责纯本地连接 CRUD 与测试。connection_test 支持可选多跳 SSH，并把
//! SSL / 高级连接参数转换给 db-driver。

use std::{
    cmp::Ordering,
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::task::JoinHandle;

use db_driver::{
    Driver, DriverKind, MySqlConnectSettings, MySqlTlsMode, PostgresConnectSettings,
    SqliteConnectSettings,
};
use serde::{Deserialize, Serialize};
use ssh_multihop::{
    HopRttCallback, HopRttEvent, HopRttSample, HopStatusCallback, HopStatusEvent, HostKeyDecision,
    HostKeyQuery, HostKeyVerifier, KeepaliveConfig, SshAuth, SshHop, TunnelContext,
};
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroizing;

use crate::config::store::{self, AdvancedConfig, SshConfig, SslConfig, StoredConnection};
use crate::state::{ActiveDriver, ActiveQuery, ActiveSession, AppState, OpenConnection};

/// 前端传入的连接配置（create / test 用，不含 id 与 last_used_at）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub name: String,
    /// 数据库类型；旧前端未传时默认 MySQL。
    #[serde(default)]
    pub driver: DriverKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub ssh: SshConfig,
    #[serde(default)]
    pub ssl: SslConfig,
    #[serde(default)]
    pub advanced: AdvancedConfig,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub env: String,
}

/// 列出所有连接，按用户手动排序（FR-003）。
///
/// 排序规则：有 `sort_order` 的按序号升序排在前面；从未手动排过的（旧记录、
/// 新建、导入）落在后面，彼此之间仍按最近使用时间倒序，保持升级前的观感。
///
/// Week 2 简化：返回完整配置（含明文 password）供前端编辑回显——本地单机工具，
/// 内存明文可接受，落盘已整体加密（NFR-010）。后续要收紧可改为 meta + 单独 get。
#[tauri::command]
pub async fn connection_list(state: State<'_, AppState>) -> Result<Vec<StoredConnection>, String> {
    let mut conns = state.store.lock().unwrap().load()?;
    conns.sort_by(|a, b| match (a.sort_order, b.sort_order) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        // 都没排过：最近使用的排最前，从未使用（None）排最后
        (None, None) => b.last_used_at.cmp(&a.last_used_at),
    });
    Ok(conns)
}

/// 按前端拖拽后的完整 id 顺序重写排序序号（FR-003）。
#[tauri::command]
pub async fn connection_reorder(
    state: State<'_, AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    state.store.lock().unwrap().reorder(&ids)
}

/// 新建连接，后端生成 uuid id 并返回完整记录。
#[tauri::command]
pub async fn connection_create(
    state: State<'_, AppState>,
    input: ConnectionInput,
) -> Result<StoredConnection, String> {
    let conn = StoredConnection {
        id: uuid::Uuid::new_v4().to_string(),
        name: input.name,
        driver: input.driver,
        host: input.host,
        port: input.port,
        user: input.user,
        password: input.password,
        database: input.database,
        ssh: input.ssh,
        ssl: input.ssl,
        advanced: input.advanced,
        last_used_at: None,
        // 新建的连接排在列表末尾，直到用户手动拖动
        sort_order: None,
        read_only: input.read_only,
        env: store::normalize_env(&input.env),
    };
    state.store.lock().unwrap().upsert(conn.clone())?;
    Ok(conn)
}

/// 更新连接（前端传完整含 id 的记录）。
#[tauri::command]
pub async fn connection_update(
    state: State<'_, AppState>,
    mut connection: StoredConnection,
) -> Result<(), String> {
    connection.env = store::normalize_env(&connection.env);
    state.store.lock().unwrap().upsert(connection)
}

/// 删除连接，同时清理会话缓存与已持久化的 passphrase。
#[tauri::command]
pub async fn connection_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.passphrases.lock().unwrap().remove(&id);
    // secrets 清理失败不阻塞连接删除（例如当前处于锁定状态，解锁后可再清理）
    let _ = state.security.remove_secret(&id);
    state.store.lock().unwrap().delete(&id)
}

/// 连接测试的耗时明细（毫秒，保留小数——本地库和内网库常常不到 1ms）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestReport {
    /// SSH 隧道建链耗时；直连或文件型 driver 为 None
    pub tunnel_ms: Option<f64>,
    /// 数据库握手耗时（TCP + TLS + 认证；连接池是 eager 的，这里就是真实握手）
    pub connect_ms: f64,
    /// 握手后跑一条 `SELECT 1` 的往返延迟——用热连接测，才是链路延迟
    pub ping_ms: f64,
    /// 从开始到 ping 结束的总耗时
    pub total_ms: f64,
}

/// 测试连接：建立完整链路（可选 SSH 隧道 + 数据库握手 + SELECT 1）后立即销毁。
/// `passphrase` 仅用于本次测试，不写入持久化文件或会话缓存。
/// 成功返回各段耗时（FR-002），失败返回 i18n key 由前端翻译。
#[tauri::command]
pub async fn connection_test(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ConnectionInput,
    passphrase: Option<String>,
) -> Result<ConnectionTestReport, String> {
    let started = Instant::now();
    // SQLite 等文件型 driver 连的是本地文件，隧道配置一律忽略
    let hops: Vec<SshHop> = if input.ssh.enabled && !input.driver.is_file_based() {
        build_runtime_hops(&input.ssh, passphrase.as_deref())?
    } else {
        Vec::new()
    };

    // 直连用真实 host:port；走隧道时换成隧道的本地端口。
    // 测试连接同样必须走 known_hosts + TOFU 校验：verifier 缺省会接受任意
    // host key，SSH 凭据会发给未经校验的主机。瞬时链路无需 keepalive 上报。
    let (host, port, _tunnel, tunnel_ms) = if hops.is_empty() {
        (input.host.clone(), input.port, None, None)
    } else {
        let tunnel_started = Instant::now();
        let test_id = format!("test-{}", uuid::Uuid::new_v4());
        let ctx = TunnelContext {
            status_cb: None,
            rtt_cb: None,
            verifier: Some(build_verifier(&app, &state, test_id)),
            keepalive: build_tunnel_keepalive(&input.advanced),
        };
        let tunnel = ssh_multihop::open(&hops, &input.host, input.port, &ctx)
            .await
            .map_err(|e| e.i18n_key().to_string())?;
        let tunnel_ms = elapsed_ms(tunnel_started);
        let addr = tunnel.local_addr();
        (
            addr.ip().to_string(),
            addr.port(),
            Some(tunnel),
            Some(tunnel_ms),
        )
    };

    let connect_started = Instant::now();
    let driver = connect_database_driver(RuntimeDatabaseTarget {
        kind: input.driver,
        host: &host,
        port,
        user: &input.user,
        password: &input.password,
        database: &input.database,
        ssl: &input.ssl,
        advanced: &input.advanced,
        read_only: input.read_only,
    })
    .await?;
    let connect_ms = elapsed_ms(connect_started);

    let ping_started = Instant::now();
    let result = Driver::ping(&driver).await;
    let ping_ms = elapsed_ms(ping_started);
    Driver::close(&driver).await;
    result.map_err(|e| e.i18n_key().to_string())?;
    Ok(ConnectionTestReport {
        tunnel_ms,
        connect_ms,
        ping_ms,
        total_ms: elapsed_ms(started),
    })
    // _tunnel 在此 drop，关闭 listener 与 session
}

/// 统一把计时转成毫秒
fn elapsed_ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

/// 把持久化的 SSH 配置转换成 ssh-multihop 运行时跳数组。
///
/// passphrase 不落盘（NFR-011），由调用方从会话缓存传入，统一应用到所有私钥跳。
fn build_runtime_hops(ssh: &SshConfig, passphrase: Option<&str>) -> Result<Vec<SshHop>, String> {
    ssh.hops
        .iter()
        .map(|h| to_runtime_hop(h, passphrase))
        .collect()
}

/// 单跳转换：`passphrase` 仅对 privateKey 跳生效（会话内存，不落盘）。
fn to_runtime_hop(hop: &store::SshHop, passphrase: Option<&str>) -> Result<SshHop, String> {
    let auth = match hop.auth_type.as_str() {
        "password" => SshAuth::Password(hop.password.clone().unwrap_or_default()),
        "privateKey" => SshAuth::PrivateKey {
            path: hop.private_key_path.clone().unwrap_or_default(),
            passphrase: passphrase.map(|s| s.to_string()),
        },
        _ => return Err("error.ssh.invalid_auth_type".to_string()),
    };
    Ok(SshHop {
        host: hop.host.clone(),
        port: hop.port,
        username: hop.username.clone(),
        auth,
    })
}

/// 把前端连接配置里的 SSL/高级设置转成 db-driver 连接参数。
fn build_mysql_settings(
    ssl: &SslConfig,
    advanced: &AdvancedConfig,
) -> Result<MySqlConnectSettings, String> {
    let ssl_mode = ssl
        .mode
        .parse::<MySqlTlsMode>()
        .map_err(|e| e.i18n_key().to_string())?;
    Ok(MySqlConnectSettings {
        ssl_mode,
        ssl_ca_path: non_empty_owned(&ssl.ca_path),
        ssl_client_cert_path: non_empty_owned(&ssl.client_cert_path),
        ssl_client_key_path: non_empty_owned(&ssl.client_key_path),
        connect_timeout: build_connect_timeout(advanced),
    })
}

fn build_postgres_settings(advanced: &AdvancedConfig) -> PostgresConnectSettings {
    PostgresConnectSettings {
        connect_timeout: build_connect_timeout(advanced),
    }
}

/// SQLite 连接参数。客户端不做隐式建库：路径不存在直接报连接失败。
fn build_sqlite_settings(advanced: &AdvancedConfig, read_only: bool) -> SqliteConnectSettings {
    SqliteConnectSettings {
        create_if_missing: false,
        read_only,
        connect_timeout: build_connect_timeout(advanced),
    }
}

fn build_connect_timeout(advanced: &AdvancedConfig) -> Option<Duration> {
    advanced
        .connect_timeout_enabled
        .then(|| Duration::from_secs(advanced.connect_timeout_seconds.max(1)))
}

/// 把持久化高级设置转换成独立 SSH crate 的 keepalive 参数。
fn build_tunnel_keepalive(advanced: &AdvancedConfig) -> KeepaliveConfig {
    if !advanced.keep_alive_enabled {
        return KeepaliveConfig::disabled();
    }
    let failure_threshold = usize::try_from(advanced.keep_alive_failure_threshold)
        .unwrap_or(usize::MAX)
        .max(1);
    KeepaliveConfig::enabled(
        Duration::from_secs(advanced.keep_alive_interval_seconds.max(1)),
        failure_threshold,
    )
}

struct RuntimeDatabaseTarget<'a> {
    kind: DriverKind,
    host: &'a str,
    port: u16,
    user: &'a str,
    password: &'a str,
    /// 网络型 driver 是库名；SQLite 等文件型 driver 是数据库文件路径。
    database: &'a str,
    ssl: &'a SslConfig,
    advanced: &'a AdvancedConfig,
    /// 只读连接：SQLite 直接以只读模式打开文件，比应用层 guard 更硬。
    read_only: bool,
}

async fn connect_database_driver(
    target: RuntimeDatabaseTarget<'_>,
) -> Result<ActiveDriver, String> {
    match target.kind {
        DriverKind::MySql => {
            let settings = build_mysql_settings(target.ssl, target.advanced)?;
            db_driver::MySqlDriver::connect_with_settings(
                target.host,
                target.port,
                target.user,
                target.password,
                target.database,
                settings,
            )
            .await
            .map(ActiveDriver::MySql)
            .map_err(|error| error.i18n_key().to_string())
        }
        DriverKind::PostgreSql => db_driver::PostgresDriver::connect_with_settings(
            target.host,
            target.port,
            target.user,
            target.password,
            target.database,
            build_postgres_settings(target.advanced),
        )
        .await
        .map(ActiveDriver::PostgreSql)
        .map_err(|error| error.i18n_key().to_string()),
        // SQLite 用 database 字段承载文件路径，host/port/账号一律不参与
        DriverKind::Sqlite => db_driver::SqliteDriver::connect_with_settings(
            target.database,
            build_sqlite_settings(target.advanced, target.read_only),
        )
        .await
        .map(ActiveDriver::Sqlite)
        .map_err(|error| error.i18n_key().to_string()),
    }
}

fn non_empty_owned(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// keepalive 断开等运行期跳状态，emit 给前端的载荷
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HopStatusPayload {
    connection_id: String,
    /// 每次成功打开前生成的新代号，隔离重连前后同 connection_id 的迟到事件。
    session_id: String,
    hop_index: usize,
    /// "pending" / "connected" / "failed" / "lost"
    status: String,
    reason: Option<String>,
}

/// SSH 协议 RTT 采样事件载荷；数值为累计到该 session 的 global-request RTT。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HopRttPayload {
    connection_id: String,
    session_id: String,
    hop_index: usize,
    /// "measured" / "timeout" / "unavailable"
    state: String,
    rtt_ms: Option<f64>,
}

/// 数据库节点 RTT 采样事件；数值为累计 SELECT 1 往返，经过整条链路。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DbRttPayload {
    connection_id: String,
    session_id: String,
    /// "measured" / "timeout" / "unavailable"
    state: String,
    rtt_ms: Option<f64>,
}

/// 首次采样延迟；握手完成后再开始，不进入连接关键路径。
const DB_RTT_INITIAL_DELAY: Duration = Duration::from_secs(1);
/// 低频采样，避免给业务连接池制造额外噪声。
const DB_RTT_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);
/// 单次 SELECT 1 探测超时；超时只更新指标，不改变连接状态。
const DB_RTT_SAMPLE_TIMEOUT: Duration = Duration::from_secs(2);

/// 打开一条已保存的连接：建立（可选）SSH 隧道 + 对应数据库连接池，存入注册表。
///
/// `passphrase` 为本次提供的私钥口令；优先级：本次传入 > 会话缓存 > 已持久化
/// secrets（需主密码已解锁）。`remember_passphrase=true` 且主密码解锁时，把本次
/// passphrase 加密落盘（FR-102）；否则仅缓存到会话内存（NFR-011）。已打开则幂等返回。
#[tauri::command]
pub async fn connection_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    passphrase: Option<String>,
    remember_passphrase: Option<bool>,
) -> Result<String, String> {
    let lifecycle = state.connection_lifecycle(&id);
    let _lifecycle = lifecycle.lock().await;
    if let Some(existing) = state.connections.lock().await.get(&id) {
        return Ok(existing.session_id.clone());
    }
    open_connection_locked(
        &app,
        &state,
        &id,
        passphrase,
        remember_passphrase.unwrap_or(false),
        None,
    )
    .await
}

/// 手动重连：按连接取消旧查询，关闭旧 pool/tunnel，再建立一个新 session。
///
/// `expected_session_id` 防止两个迟到的重连请求依次关闭彼此的新 session；不匹配时
/// 直接返回当前 session，保持命令幂等。`database_override` 仅本次 session 生效
///（PostgreSQL 一键切库），不写回持久化配置，重新打开仍是原 database。
#[tauri::command]
pub async fn connection_reconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    expected_session_id: Option<String>,
    passphrase: Option<String>,
    database_override: Option<String>,
) -> Result<String, String> {
    let lifecycle = state.connection_lifecycle(&id);
    let _lifecycle = lifecycle.lock().await;
    let old = {
        let mut connections = state.connections.lock().await;
        if let (Some(expected), Some(current)) =
            (expected_session_id.as_deref(), connections.get(&id))
        {
            if !expected_session_matches(&current.session_id, Some(expected)) {
                return Ok(current.session_id.clone());
            }
        }
        connections.remove(&id)
    };
    cancel_connection_queries(&state.queries, &id).await;
    close_connection_sessions(&state.sessions, &id).await;
    if let Some(old) = old {
        old.close().await;
    }
    // 重连不持久化新 passphrase（remember 语义只在显式 open 时生效）
    open_connection_locked(&app, &state, &id, passphrase, false, database_override).await
}

/// 生命周期锁内建立并注册连接；调用方必须先持有 `connection_lifecycle`。
/// `database_override` 只影响本次建立的连接池，不修改持久化配置。
async fn open_connection_locked(
    app: &AppHandle,
    state: &State<'_, AppState>,
    id: &str,
    passphrase: Option<String>,
    remember_passphrase: bool,
    database_override: Option<String>,
) -> Result<String, String> {
    let session_id = uuid::Uuid::new_v4().to_string();

    // 取出目标连接配置（brief lock）
    let conn = {
        let store = state.store.lock().unwrap();
        store
            .load()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or("error.connection.not_found")?
    };

    // passphrase：本次传入优先，否则用会话缓存
    // passphrase：本次传入优先，其次会话缓存，最后已持久化 secrets（需已解锁）
    let effective_passphrase = passphrase
        .clone()
        .or_else(|| {
            state
                .passphrases
                .lock()
                .unwrap()
                .get(id)
                .map(|p| p.to_string())
        })
        .or_else(|| state.security.secret_for(id));

    // 直连用真实 host:port；走隧道时换隧道的本地端口
    let (host, port, tunnel) = if conn.ssh.enabled && !conn.driver.is_file_based() {
        let hops = build_runtime_hops(&conn.ssh, effective_passphrase.as_deref())?;
        for hop_index in 0..hops.len() {
            emit_hop_status(app, id, &session_id, hop_index, "pending", None);
        }
        let ctx = TunnelContext {
            status_cb: Some(build_status_callback(
                app.clone(),
                id.to_string(),
                session_id.clone(),
            )),
            rtt_cb: Some(build_rtt_callback(
                app.clone(),
                id.to_string(),
                session_id.clone(),
            )),
            verifier: Some(build_verifier(app, state, id.to_string())),
            keepalive: build_tunnel_keepalive(&conn.advanced),
        };
        let tunnel = match ssh_multihop::open(&hops, &conn.host, conn.port, &ctx).await {
            Ok(tunnel) => tunnel,
            Err(e) => {
                if let Some(hop_index) = e.hop_index() {
                    emit_hop_status(
                        app,
                        id,
                        &session_id,
                        hop_index,
                        "failed",
                        Some(e.i18n_key()),
                    );
                }
                return Err(e.i18n_key().to_string());
            }
        };
        for hop_index in 0..hops.len() {
            emit_hop_status(app, id, &session_id, hop_index, "connected", None);
        }
        let addr = tunnel.local_addr();
        (addr.ip().to_string(), addr.port(), Some(tunnel))
    } else {
        (conn.host.clone(), conn.port, None)
    };

    // session 级 database 覆盖（PG 一键切库）优先于持久化配置，空串视为未覆盖；
    // 文件型 driver 的 database 是文件路径，覆盖会把路径换成 ATTACH 名，直接忽略
    let database = database_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && !conn.driver.is_file_based())
        .unwrap_or(&conn.database);

    let driver = connect_database_driver(RuntimeDatabaseTarget {
        kind: conn.driver,
        host: &host,
        port,
        user: &conn.user,
        password: &conn.password,
        database,
        ssl: &conn.ssl,
        advanced: &conn.advanced,
        read_only: conn.read_only,
    })
    .await?;
    // 立即 ping 确认握手成功（隧道桥接 + 数据库认证）
    if let Err(error) = Driver::ping(&driver).await {
        Driver::close(&driver).await;
        drop(tunnel);
        return Err(error.i18n_key().to_string());
    }

    // 成功：缓存本次 passphrase + 按需持久化 + 落注册表 + 刷新最近使用
    if let Some(pp) = passphrase {
        if remember_passphrase {
            // 仅在主密码解锁时允许落盘；失败不阻塞连接（仅本次会话生效）
            let _ = state.security.save_secret(id, &pp);
        }
        state
            .passphrases
            .lock()
            .unwrap()
            .insert(id.to_string(), Zeroizing::new(pp));
    }
    let db_rtt_task = spawn_db_rtt_monitor(
        driver.clone(),
        app.clone(),
        id.to_string(),
        session_id.clone(),
    );
    state.connections.lock().await.insert(
        id.to_string(),
        OpenConnection {
            driver,
            tunnel,
            session_id: session_id.clone(),
            db_rtt_task: Some(db_rtt_task),
        },
    );
    let now = chrono::Utc::now().to_rfc3339();
    let _ = state.store.lock().unwrap().touch_last_used(id, now);
    Ok(session_id)
}

/// 关闭一条活跃连接（先关 pool 再关隧道）。未打开时静默成功。
/// `expected_session_id` 不匹配时说明这是旧 UI 操作，不能关闭重连后的新 session。
#[tauri::command]
pub async fn connection_close(
    state: State<'_, AppState>,
    id: String,
    expected_session_id: Option<String>,
) -> Result<(), String> {
    let lifecycle = state.connection_lifecycle(&id);
    let _lifecycle = lifecycle.lock().await;
    let conn = {
        let mut connections = state.connections.lock().await;
        if let (Some(expected), Some(current)) =
            (expected_session_id.as_deref(), connections.get(&id))
        {
            if !expected_session_matches(&current.session_id, Some(expected)) {
                return Ok(());
            }
        }
        connections.remove(&id)
    };
    cancel_connection_queries(&state.queries, &id).await;
    close_connection_sessions(&state.sessions, &id).await;
    if let Some(conn) = conn {
        conn.close().await;
    }
    Ok(())
}

fn expected_session_matches(current_session_id: &str, expected_session_id: Option<&str>) -> bool {
    expected_session_id
        .map(|expected| expected == current_session_id)
        .unwrap_or(true)
}

/// 关闭并移除一条连接名下的全部事务 session（FR-244）：未提交事务随 close 回滚。
/// 与 `cancel_connection_queries` 一样在 close/reconnect 的生命周期锁内调用。
async fn close_connection_sessions(
    sessions: &tokio::sync::Mutex<HashMap<String, std::sync::Arc<ActiveSession>>>,
    connection_id: &str,
) -> usize {
    let doomed: Vec<std::sync::Arc<ActiveSession>> = {
        let mut sessions = sessions.lock().await;
        let keys: Vec<String> = sessions
            .iter()
            .filter(|(_, session)| session.connection_id == connection_id)
            .map(|(key, _)| key.clone())
            .collect();
        keys.iter().filter_map(|key| sessions.remove(key)).collect()
    };
    let count = doomed.len();
    for session in doomed {
        session.session.lock().await.close().await;
    }
    count
}

/// 取消并移除一条连接名下的全部执行中查询。
async fn cancel_connection_queries(
    queries: &tokio::sync::Mutex<HashMap<String, ActiveQuery>>,
    connection_id: &str,
) -> usize {
    let mut cancelled = 0;
    queries.lock().await.retain(|_, query| {
        if query.connection_id == connection_id {
            query.cancel_token.cancel();
            cancelled += 1;
            false
        } else {
            true
        }
    });
    cancelled
}

/// 构造 keepalive 断开回调：把 ssh-multihop 的状态事件转成 Tauri `ssh:hop-status` 事件。
fn build_status_callback(
    app: AppHandle,
    connection_id: String,
    session_id: String,
) -> HopStatusCallback {
    Arc::new(move |ev: HopStatusEvent| {
        let status = match ev.status {
            ssh_multihop::HopStatus::Lost => "lost",
        };
        emit_hop_status(
            &app,
            &connection_id,
            &session_id,
            ev.hop_index,
            status,
            ev.reason.as_deref(),
        );
    })
}

fn emit_hop_status(
    app: &AppHandle,
    connection_id: &str,
    session_id: &str,
    hop_index: usize,
    status: &str,
    reason: Option<&str>,
) {
    let _ = app.emit(
        "ssh:hop-status",
        HopStatusPayload {
            connection_id: connection_id.to_string(),
            session_id: session_id.to_string(),
            hop_index,
            status: status.to_string(),
            reason: reason.map(ToString::to_string),
        },
    );
}

/// 后台采样累计到数据库的 SELECT 1 RTT；失败只上报指标，不改变连接状态。
fn spawn_db_rtt_monitor(
    driver: ActiveDriver,
    app: AppHandle,
    connection_id: String,
    session_id: String,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(DB_RTT_INITIAL_DELAY).await;
        loop {
            let started = Instant::now();
            let (state, rtt_ms) =
                match tokio::time::timeout(DB_RTT_SAMPLE_TIMEOUT, Driver::ping(&driver)).await {
                    Ok(Ok(_)) => ("measured", Some(started.elapsed().as_secs_f64() * 1000.0)),
                    Ok(Err(_)) => ("unavailable", None),
                    Err(_) => ("timeout", None),
                };
            let _ = app.emit(
                "db:rtt",
                DbRttPayload {
                    connection_id: connection_id.clone(),
                    session_id: session_id.clone(),
                    state: state.to_string(),
                    rtt_ms,
                },
            );
            tokio::time::sleep(DB_RTT_SAMPLE_INTERVAL).await;
        }
    })
}

/// 构造 RTT 回调；测量的是 SSH global-request 往返，不等同 ICMP 或单段延迟。
fn build_rtt_callback(app: AppHandle, connection_id: String, session_id: String) -> HopRttCallback {
    Arc::new(move |event: HopRttEvent| {
        let (state, rtt_ms) = match event.sample {
            HopRttSample::Measured(duration) => ("measured", Some(duration.as_secs_f64() * 1000.0)),
            HopRttSample::TimedOut => ("timeout", None),
            HopRttSample::Unavailable => ("unavailable", None),
        };
        let _ = app.emit(
            "ssh:hop-rtt",
            HopRttPayload {
                connection_id: connection_id.clone(),
                session_id: session_id.clone(),
                hop_index: event.hop_index,
                state: state.to_string(),
                rtt_ms,
            },
        );
    })
}

/// 构造 host key 校验器：known_hosts 命中比对，未知走 TOFU 弹窗，指纹变更硬拒绝。
fn build_verifier(
    app: &AppHandle,
    state: &State<'_, AppState>,
    connection_id: String,
) -> HostKeyVerifier {
    let known_hosts = state.known_hosts.clone();
    let tofu = state.tofu.clone();
    let app = app.clone();
    Arc::new(move |q: HostKeyQuery| {
        let known_hosts = known_hosts.clone();
        let tofu = tofu.clone();
        let app = app.clone();
        let connection_id = connection_id.clone();
        Box::pin(async move {
            match known_hosts.get(&q.host, q.port) {
                // 已信任且一致
                Some(fp) if fp == q.fingerprint => HostKeyDecision::Trust,
                // 已信任但指纹变了 → 硬拒绝（NFR：不给「忽略」按钮）
                Some(_) => HostKeyDecision::Reject { mismatch: true },
                // 未知 host → TOFU 弹窗
                None => {
                    let accept = tofu
                        .request(
                            &app,
                            &connection_id,
                            q.hop_index,
                            &q.host,
                            q.port,
                            &q.fingerprint,
                        )
                        .await;
                    if accept {
                        let _ = known_hosts.insert(&q.host, q.port, &q.fingerprint);
                        HostKeyDecision::Trust
                    } else {
                        HostKeyDecision::Reject { mismatch: false }
                    }
                }
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = HostKeyDecision> + Send>>
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn private_key_ssh_config() -> SshConfig {
        SshConfig {
            enabled: true,
            hops: vec![store::SshHop {
                host: "bastion.example.com".to_string(),
                port: 22,
                username: "deploy".to_string(),
                auth_type: "privateKey".to_string(),
                password: None,
                private_key_path: Some("~/.ssh/id_ed25519".to_string()),
            }],
        }
    }

    #[test]
    fn test_connection_passphrase_is_forwarded_to_private_key_hop() {
        let hops = build_runtime_hops(&private_key_ssh_config(), Some("test-secret")).unwrap();

        match &hops[0].auth {
            SshAuth::PrivateKey { path, passphrase } => {
                assert_eq!(path, "~/.ssh/id_ed25519");
                assert_eq!(passphrase.as_deref(), Some("test-secret"));
            }
            SshAuth::Password(_) => panic!("应构造私钥认证"),
        }
    }

    #[test]
    fn advanced_keepalive_is_forwarded_and_zero_values_are_clamped() {
        let advanced = AdvancedConfig {
            keep_alive_interval_seconds: 0,
            keep_alive_failure_threshold: 0,
            ..Default::default()
        };

        assert_eq!(
            build_tunnel_keepalive(&advanced),
            KeepaliveConfig::enabled(Duration::from_secs(1), 1)
        );
    }

    #[test]
    fn disabled_advanced_keepalive_is_forwarded() {
        let advanced = AdvancedConfig {
            keep_alive_enabled: false,
            ..Default::default()
        };

        assert_eq!(
            build_tunnel_keepalive(&advanced),
            KeepaliveConfig::disabled()
        );
    }

    #[tokio::test]
    async fn reconnect_cancels_only_queries_from_target_connection() {
        let target_token = tokio_util::sync::CancellationToken::new();
        let other_token = tokio_util::sync::CancellationToken::new();
        let queries = tokio::sync::Mutex::new(HashMap::from([
            (
                "q-target".to_string(),
                ActiveQuery {
                    connection_id: "c1".to_string(),
                    cancel_token: target_token.clone(),
                },
            ),
            (
                "q-other".to_string(),
                ActiveQuery {
                    connection_id: "c2".to_string(),
                    cancel_token: other_token.clone(),
                },
            ),
        ]));

        assert_eq!(cancel_connection_queries(&queries, "c1").await, 1);
        assert!(target_token.is_cancelled());
        assert!(!other_token.is_cancelled());
        assert_eq!(queries.lock().await.len(), 1);
        assert!(queries.lock().await.contains_key("q-other"));
    }

    #[test]
    fn hop_status_payload_contains_runtime_session_id() {
        let payload = HopStatusPayload {
            connection_id: "c1".to_string(),
            session_id: "session-new".to_string(),
            hop_index: 1,
            status: "lost".to_string(),
            reason: Some("error.ssh.channel_dropped".to_string()),
        };

        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["connectionId"], "c1");
        assert_eq!(value["sessionId"], "session-new");
    }

    #[test]
    fn hop_rtt_payload_keeps_measurement_scope_fields() {
        let payload = HopRttPayload {
            connection_id: "c1".to_string(),
            session_id: "session-new".to_string(),
            hop_index: 2,
            state: "measured".to_string(),
            rtt_ms: Some(12.5),
        };

        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["connectionId"], "c1");
        assert_eq!(value["sessionId"], "session-new");
        assert_eq!(value["hopIndex"], 2);
        assert_eq!(value["state"], "measured");
        assert_eq!(value["rttMs"], 12.5);
    }

    #[test]
    fn db_rtt_payload_omits_hop_index() {
        let payload = DbRttPayload {
            connection_id: "c1".to_string(),
            session_id: "session-new".to_string(),
            state: "measured".to_string(),
            rtt_ms: Some(18.2),
        };

        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["connectionId"], "c1");
        assert_eq!(value["sessionId"], "session-new");
        assert_eq!(value["state"], "measured");
        assert_eq!(value["rttMs"], 18.2);
        assert!(value.get("hopIndex").is_none());
    }

    #[test]
    fn stale_expected_session_does_not_match_reconnected_session() {
        assert!(expected_session_matches("session-new", None));
        assert!(expected_session_matches("session-new", Some("session-new")));
        assert!(!expected_session_matches(
            "session-new",
            Some("session-old")
        ));
    }

    #[test]
    fn test_connection_without_passphrase_keeps_private_key_optional() {
        let hops = build_runtime_hops(&private_key_ssh_config(), None).unwrap();

        match &hops[0].auth {
            SshAuth::PrivateKey { passphrase, .. } => assert!(passphrase.is_none()),
            SshAuth::Password(_) => panic!("应构造私钥认证"),
        }
    }
}
