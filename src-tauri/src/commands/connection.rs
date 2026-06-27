//! 连接管理命令 —— CRUD + 测试连接
//!
//! Week 2：纯本地连接 CRUD 与测试。connection_test 已支持可选多跳 SSH（复用
//! ssh-multihop），但 SSH 配置 UI 留 Week 3，所以 UI 此阶段只填直连字段。

use serde::Deserialize;
use ssh_multihop::{SshAuth, SshHop};
use tauri::State;

use crate::config::store::{self, SshConfig, StoredConnection};
use crate::state::AppState;

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
        input
            .ssh
            .hops
            .iter()
            .map(to_runtime_hop)
            .collect::<Result<_, _>>()?
    } else {
        Vec::new()
    };

    // 直连用真实 host:port；走隧道时换成隧道的本地端口
    let (host, port, _tunnel) = if hops.is_empty() {
        (input.host.clone(), input.port, None)
    } else {
        let tunnel = ssh_multihop::open(&hops, &input.host, input.port)
            .await
            .map_err(|e| e.i18n_key().to_string())?;
        let addr = tunnel.local_addr();
        (addr.ip().to_string(), addr.port(), Some(tunnel))
    };

    let driver =
        db_driver::MySqlDriver::connect(&host, port, &input.user, &input.password, &input.database)
            .await
            .map_err(|e| e.i18n_key().to_string())?;
    let result = driver.ping().await;
    driver.close().await;
    result.map_err(|e| e.i18n_key().to_string())?;
    Ok(())
    // _tunnel 在此 drop，关闭 listener 与 session
}

/// 把持久化的 SSH 跳转换成 ssh-multihop 运行时跳。
///
/// passphrase 不落盘，所以这里恒为 None；带 passphrase 的私钥测试留 Week 3
/// （配 passphrase 输入弹窗后再补）。
fn to_runtime_hop(hop: &store::SshHop) -> Result<SshHop, String> {
    let auth = match hop.auth_type.as_str() {
        "password" => SshAuth::Password(hop.password.clone().unwrap_or_default()),
        "privateKey" => SshAuth::PrivateKey {
            path: hop.private_key_path.clone().unwrap_or_default(),
            passphrase: None,
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
