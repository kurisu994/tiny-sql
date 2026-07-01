//! 连接管理命令 —— CRUD + 测试连接
//!
//! 负责纯本地连接 CRUD 与测试。connection_test 支持可选多跳 SSH，并把
//! SSL / 高级连接参数转换给 db-driver。

use std::{sync::Arc, time::Duration};

use db_driver::{MySqlConnectSettings, MySqlTlsMode};
use serde::{Deserialize, Serialize};
use ssh_multihop::{
    HopStatusCallback, HopStatusEvent, HostKeyDecision, HostKeyQuery, HostKeyVerifier, SshAuth,
    SshHop, TunnelContext,
};
use tauri::{AppHandle, Emitter, State};

use crate::config::store::{self, AdvancedConfig, SshConfig, SslConfig, StoredConnection};
use crate::state::{AppState, OpenConnection};

/// 前端传入的连接配置（create / test 用，不含 id 与 last_used_at）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    pub name: String,
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
}

/// 列出所有连接，按最近使用时间倒序（FR-003）。
///
/// Week 2 简化：返回完整配置（含明文 password）供前端编辑回显——本地单机工具，
/// 内存明文可接受，落盘已整体加密（NFR-010）。后续要收紧可改为 meta + 单独 get。
#[tauri::command]
pub async fn connection_list(state: State<'_, AppState>) -> Result<Vec<StoredConnection>, String> {
    let mut conns = state.store.lock().unwrap().load()?;
    // None（从未使用）排在最后，最近使用的排最前
    conns.sort_by(|a, b| b.last_used_at.cmp(&a.last_used_at));
    Ok(conns)
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
        host: input.host,
        port: input.port,
        user: input.user,
        password: input.password,
        database: input.database,
        ssh: input.ssh,
        ssl: input.ssl,
        advanced: input.advanced,
        last_used_at: None,
    };
    state.store.lock().unwrap().upsert(conn.clone())?;
    Ok(conn)
}

/// 更新连接（前端传完整含 id 的记录）。
#[tauri::command]
pub async fn connection_update(
    state: State<'_, AppState>,
    connection: StoredConnection,
) -> Result<(), String> {
    state.store.lock().unwrap().upsert(connection)
}

/// 删除连接。
#[tauri::command]
pub async fn connection_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.store.lock().unwrap().delete(&id)
}

/// 测试连接：建立完整链路（可选 SSH 隧道 + MySQL 握手 + SELECT 1）后立即销毁。
/// 成功返回 ()，失败返回 i18n key 由前端翻译（FR-002）。
#[tauri::command]
pub async fn connection_test(input: ConnectionInput) -> Result<(), String> {
    let hops: Vec<SshHop> = if input.ssh.enabled {
        // 测试连接不带会话 passphrase 缓存，私钥 passphrase 测试留连接打开路径
        build_runtime_hops(&input.ssh, None)?
    } else {
        Vec::new()
    };

    // 直连用真实 host:port；走隧道时换成隧道的本地端口。
    // 测试连接是瞬时建链立即销毁，无需 keepalive 上报，故传 default ctx。
    let (host, port, _tunnel) = if hops.is_empty() {
        (input.host.clone(), input.port, None)
    } else {
        let tunnel = ssh_multihop::open(&hops, &input.host, input.port, &TunnelContext::default())
            .await
            .map_err(|e| e.i18n_key().to_string())?;
        let addr = tunnel.local_addr();
        (addr.ip().to_string(), addr.port(), Some(tunnel))
    };

    let settings = build_mysql_settings(&input.ssl, &input.advanced)?;
    let driver = db_driver::MySqlDriver::connect_with_settings(
        &host,
        port,
        &input.user,
        &input.password,
        &input.database,
        settings,
    )
    .await
    .map_err(|e| e.i18n_key().to_string())?;
    let result = driver.ping().await;
    driver.close().await;
    result.map_err(|e| e.i18n_key().to_string())?;
    Ok(())
    // _tunnel 在此 drop，关闭 listener 与 session
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
    let connect_timeout = advanced
        .connect_timeout_enabled
        .then(|| Duration::from_secs(advanced.connect_timeout_seconds.max(1)));

    Ok(MySqlConnectSettings {
        ssl_mode,
        ssl_ca_path: non_empty_owned(&ssl.ca_path),
        ssl_client_cert_path: non_empty_owned(&ssl.client_cert_path),
        ssl_client_key_path: non_empty_owned(&ssl.client_key_path),
        connect_timeout,
    })
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
    hop_index: usize,
    /// "pending" / "connected" / "failed" / "lost"
    status: String,
    reason: Option<String>,
}

/// 打开一条已保存的连接：建立（可选）SSH 隧道 + MySQL 连接池，存入活跃注册表。
///
/// `passphrase` 为本次提供的私钥口令（仅会话内存）；成功后缓存，下次打开同一连接
/// 自动复用（FR-011：首次弹窗、本会话第二次静默）。已打开则幂等返回。
#[tauri::command]
pub async fn connection_open(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    passphrase: Option<String>,
) -> Result<(), String> {
    // 已打开则幂等
    if state.connections.lock().await.contains_key(&id) {
        return Ok(());
    }

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
    let effective_passphrase = passphrase
        .clone()
        .or_else(|| state.passphrases.lock().unwrap().get(&id).cloned());

    // 直连用真实 host:port；走隧道时换隧道的本地端口
    let (host, port, tunnel) = if conn.ssh.enabled {
        let hops = build_runtime_hops(&conn.ssh, effective_passphrase.as_deref())?;
        for hop_index in 0..hops.len() {
            emit_hop_status(&app, &id, hop_index, "pending", None);
        }
        let ctx = TunnelContext {
            status_cb: Some(build_status_callback(app.clone(), id.clone())),
            verifier: Some(build_verifier(&app, &state, id.clone())),
        };
        let tunnel = match ssh_multihop::open(&hops, &conn.host, conn.port, &ctx).await {
            Ok(tunnel) => tunnel,
            Err(e) => {
                if let Some(hop_index) = e.hop_index() {
                    emit_hop_status(&app, &id, hop_index, "failed", Some(e.i18n_key()));
                }
                return Err(e.i18n_key().to_string());
            }
        };
        for hop_index in 0..hops.len() {
            emit_hop_status(&app, &id, hop_index, "connected", None);
        }
        let addr = tunnel.local_addr();
        (addr.ip().to_string(), addr.port(), Some(tunnel))
    } else {
        (conn.host.clone(), conn.port, None)
    };

    let settings = build_mysql_settings(&conn.ssl, &conn.advanced)?;
    let driver = db_driver::MySqlDriver::connect_with_settings(
        &host,
        port,
        &conn.user,
        &conn.password,
        &conn.database,
        settings,
    )
    .await
    .map_err(|e| e.i18n_key().to_string())?;
    // 立即 ping 确认握手成功（隧道桥接 + MySQL 认证）
    driver.ping().await.map_err(|e| e.i18n_key().to_string())?;

    // 成功：缓存本次 passphrase + 落注册表 + 刷新最近使用
    if let Some(pp) = passphrase {
        state.passphrases.lock().unwrap().insert(id.clone(), pp);
    }
    state
        .connections
        .lock()
        .await
        .insert(id.clone(), OpenConnection { driver, tunnel });
    let now = chrono::Utc::now().to_rfc3339();
    let _ = state.store.lock().unwrap().touch_last_used(&id, now);
    Ok(())
}

/// 关闭一条活跃连接（先关 pool 再关隧道）。未打开时静默成功。
#[tauri::command]
pub async fn connection_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.connections.lock().await.remove(&id);
    if let Some(conn) = conn {
        conn.close().await;
    }
    Ok(())
}

/// 构造 keepalive 断开回调：把 ssh-multihop 的状态事件转成 Tauri `ssh:hop-status` 事件。
fn build_status_callback(app: AppHandle, connection_id: String) -> HopStatusCallback {
    Arc::new(move |ev: HopStatusEvent| {
        let status = match ev.status {
            ssh_multihop::HopStatus::Lost => "lost",
        };
        emit_hop_status(
            &app,
            &connection_id,
            ev.hop_index,
            status,
            ev.reason.as_deref(),
        );
    })
}

fn emit_hop_status(
    app: &AppHandle,
    connection_id: &str,
    hop_index: usize,
    status: &str,
    reason: Option<&str>,
) {
    let _ = app.emit(
        "ssh:hop-status",
        HopStatusPayload {
            connection_id: connection_id.to_string(),
            hop_index,
            status: status.to_string(),
            reason: reason.map(ToString::to_string),
        },
    );
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
