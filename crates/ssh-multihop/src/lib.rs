//! 多级 SSH 跳板隧道
//!
//! 把入向 TCP 连接经过 N 跳 SSH 链路桥接到 `target_host:target_port`，在本地
//! `127.0.0.1` 绑定一个随机端口。上层（如 db-driver）拿到本地端口后，用普通
//! `mysql://127.0.0.1:port` 连接即可，完全不感知 SSH 的存在。
//!
//! 设计要点（v0.1 vertical slice）：
//! - 本 crate **不依赖 Tauri**，方便未来独立 publish 到 crates.io。
//! - host key 校验 v0.1 先用 accept-all（见 [`AcceptAll`]）；TOFU + known_hosts
//!   留到 Week 3（届时通过 [`HostKeyVerifier`] 回调注入，不改 `open` 签名）。
//! - keepalive / 错误模型细分（ChannelDropped / AcceptLoopDied）留 Week 3。
//!
//! russh 0.54 的多跳实现移植自 redis-desktop-client 的 `ssh_tunnel.rs`，
//! 剥离了 Tauri/known_hosts 耦合。

use russh::client::{self, AuthResult, Config, Handle, Handler};
use russh::keys::{load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as TokioMutex;
use tokio::task::JoinHandle;

/// SSH 隧道空闲超时（russh 心跳与断连判定的兜底）
const TUNNEL_INACTIVITY: Duration = Duration::from_secs(3600);

/// 一跳 SSH 节点配置
#[derive(Debug, Clone)]
pub struct SshHop {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
}

/// 单跳认证方式
#[derive(Debug, Clone)]
pub enum SshAuth {
    Password(String),
    /// 私钥路径（支持 ~ 前缀）+ 可选 passphrase
    PrivateKey {
        path: String,
        passphrase: Option<String>,
    },
}

/// SSH 隧道错误 —— 每个变体对应一个稳定的前端 i18n key
#[derive(Debug, Error)]
pub enum SshTunnelError {
    #[error("error.ssh.no_hops")]
    NoHops,
    #[error("error.ssh.connect_failed: {0}")]
    ConnectFailed(String),
    #[error("error.ssh.auth_failed")]
    AuthFailed,
    #[error("error.ssh.invalid_passphrase")]
    InvalidPassphrase,
    #[error("error.ssh.key_not_found")]
    KeyNotFound,
    #[error("error.ssh.channel_open_failed: {0}")]
    ChannelOpenFailed(String),
    #[error("error.ssh.local_listen_failed")]
    LocalListenFailed,
}

impl SshTunnelError {
    /// 返回稳定的 i18n key（不含具体错误描述），供前端翻译
    pub fn i18n_key(&self) -> &'static str {
        match self {
            Self::NoHops => "error.ssh.no_hops",
            Self::ConnectFailed(_) => "error.ssh.connect_failed",
            Self::AuthFailed => "error.ssh.auth_failed",
            Self::InvalidPassphrase => "error.ssh.invalid_passphrase",
            Self::KeyNotFound => "error.ssh.key_not_found",
            Self::ChannelOpenFailed(_) => "error.ssh.channel_open_failed",
            Self::LocalListenFailed => "error.ssh.local_listen_failed",
        }
    }
}

/// `Handle` 含 `UnboundedReceiver` 不是 Sync，跨任务共享需走 Mutex
type SharedSession = Arc<TokioMutex<Handle<AcceptAll>>>;

/// v0.1 host key 校验器：接受任意公钥。
///
/// **不安全**，仅用于 vertical slice 打通链路。Week 3 替换为 known_hosts + TOFU。
struct AcceptAll;

impl Handler for AcceptAll {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO(Week3): 接 known_hosts 校验 + TOFU 弹窗回调
        Ok(true)
    }
}

/// SSH 隧道句柄 —— drop 时关闭本地 listener 与所有跳板 session
pub struct SshTunnel {
    local_addr: SocketAddr,
    accept_task: JoinHandle<()>,
    /// 持有所有跳板 session 引用直到 drop；中间跳板若提前 drop，
    /// 派生在其上的下一跳 channel stream 会失活，因此必须整链保活
    _sessions: Vec<SharedSession>,
}

impl SshTunnel {
    /// 隧道在本地绑定的 `127.0.0.1:port`，可直接喂给 db-driver 建连
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.accept_task.abort();
    }
}

/// 建立一条 N 跳 SSH 隧道并在本地 `127.0.0.1` 绑定随机端口；所有入向 TCP
/// 连接经完整 SSH 链路桥接到 `target_host:target_port`。
///
/// `hops` 顺序即链路顺序：
/// - `hops[0]`：本地直连的 SSH 主机（堡垒机或唯一跳板）
/// - `hops[1..N-1]`：中间跳板，每跳通过上一跳的 SSH 通道连接
/// - `hops[N-1]`：出口主机，在其上发起 direct-tcpip 到目标
pub async fn open(
    hops: &[SshHop],
    target_host: &str,
    target_port: u16,
) -> Result<SshTunnel, SshTunnelError> {
    if hops.is_empty() {
        return Err(SshTunnelError::NoHops);
    }

    let config = Arc::new(Config {
        inactivity_timeout: Some(TUNNEL_INACTIVITY),
        ..Default::default()
    });

    let mut sessions: Vec<SharedSession> = Vec::with_capacity(hops.len());

    // 第 1 跳：直接 TCP 连接到 SSH 主机
    let first = &hops[0];
    let tcp = TcpStream::connect((first.host.as_str(), first.port))
        .await
        .map_err(|e| SshTunnelError::ConnectFailed(e.to_string()))?;
    let mut current = client::connect_stream(config.clone(), tcp, AcceptAll)
        .await
        .map_err(|e| SshTunnelError::ConnectFailed(e.to_string()))?;
    authenticate_hop(&mut current, first).await?;
    sessions.push(Arc::new(TokioMutex::new(current)));

    // 第 2..N 跳：在前一跳 session 上开 direct-tcpip 到下一跳 SSH 端口，
    // 把 channel stream 作为下一跳 session 的 transport（等效 OpenSSH ProxyJump）
    for next_hop in hops.iter().skip(1) {
        let prev = sessions.last().expect("已建立至少一个 session").clone();
        let channel = {
            let prev_guard = prev.lock().await;
            prev_guard
                .channel_open_direct_tcpip(
                    next_hop.host.as_str(),
                    next_hop.port as u32,
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|e| SshTunnelError::ChannelOpenFailed(e.to_string()))?
        };
        let stream = channel.into_stream();
        let mut current = client::connect_stream(config.clone(), stream, AcceptAll)
            .await
            .map_err(|e| SshTunnelError::ConnectFailed(e.to_string()))?;
        authenticate_hop(&mut current, next_hop).await?;
        sessions.push(Arc::new(TokioMutex::new(current)));
    }

    // 本地随机端口监听
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| SshTunnelError::LocalListenFailed)?;
    let local_addr = listener
        .local_addr()
        .map_err(|_| SshTunnelError::LocalListenFailed)?;

    let last_session = sessions.last().expect("已建立至少一个 session").clone();
    let sessions_for_task = sessions.clone();
    let target_host = target_host.to_string();

    let accept_task = tokio::spawn(async move {
        // 持有所有跳板 session 引用直到任务结束（含中间跳板）
        let _keep_alive = sessions_for_task;
        loop {
            let (mut socket, _peer) = match listener.accept().await {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("SSH 隧道本地 accept 失败：{e}");
                    continue;
                }
            };
            let last = last_session.clone();
            let target_host = target_host.clone();
            tokio::spawn(async move {
                let channel_res = {
                    let guard = last.lock().await;
                    guard
                        .channel_open_direct_tcpip(
                            target_host.as_str(),
                            target_port as u32,
                            "127.0.0.1",
                            0,
                        )
                        .await
                };
                let channel = match channel_res {
                    Ok(c) => c,
                    Err(e) => {
                        log::warn!("SSH 隧道开 direct-tcpip 失败：{e}");
                        return;
                    }
                };
                let mut stream = channel.into_stream();
                if let Err(e) = tokio::io::copy_bidirectional(&mut socket, &mut stream).await {
                    log::debug!("SSH 隧道桥接结束：{e}");
                }
            });
        }
    });

    Ok(SshTunnel {
        local_addr,
        accept_task,
        _sessions: sessions,
    })
}

/// 对一个 SSH session 执行该跳的认证（密码 / 私钥）
async fn authenticate_hop<H: Handler>(
    session: &mut Handle<H>,
    hop: &SshHop,
) -> Result<(), SshTunnelError> {
    let result: AuthResult = match &hop.auth {
        SshAuth::Password(pwd) => session
            .authenticate_password(hop.username.clone(), pwd.clone())
            .await
            .map_err(|_| SshTunnelError::AuthFailed)?,
        SshAuth::PrivateKey { path, passphrase } => {
            let expanded_path = expand_home_path(path).ok_or(SshTunnelError::KeyNotFound)?;
            if !expanded_path.exists() {
                return Err(SshTunnelError::KeyNotFound);
            }
            let passphrase = passphrase.as_deref().filter(|s| !s.is_empty());
            let key = load_secret_key(&expanded_path, passphrase).map_err(|e| {
                let msg = e.to_string().to_lowercase();
                if msg.contains("passphrase")
                    || msg.contains("decrypt")
                    || msg.contains("incorrect password")
                {
                    SshTunnelError::InvalidPassphrase
                } else {
                    SshTunnelError::KeyNotFound
                }
            })?;
            // RSA 由服务端协商最合适的 hash 算法；非 RSA 自动忽略
            let hash_alg = match session.best_supported_rsa_hash().await {
                Ok(Some(alg)) => alg,
                _ => None,
            };
            let key_with_hash = PrivateKeyWithHashAlg::new(Arc::new(key), hash_alg);
            session
                .authenticate_publickey(hop.username.clone(), key_with_hash)
                .await
                .map_err(|_| SshTunnelError::AuthFailed)?
        }
    };

    if result.success() {
        Ok(())
    } else {
        Err(SshTunnelError::AuthFailed)
    }
}

/// 展开 `~` / `~/` 前缀为用户 home 目录
fn expand_home_path(path: &str) -> Option<PathBuf> {
    if path == "~" {
        return home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return home_dir().map(|home| home.join(rest));
    }
    Some(PathBuf::from(path))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                Some(PathBuf::from(format!(
                    "{}{}",
                    drive.to_string_lossy(),
                    path.to_string_lossy()
                )))
            })
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_maps_to_i18n_key() {
        assert_eq!(SshTunnelError::NoHops.i18n_key(), "error.ssh.no_hops");
        assert_eq!(
            SshTunnelError::AuthFailed.i18n_key(),
            "error.ssh.auth_failed"
        );
    }

    #[test]
    fn expand_home_path_supports_tilde_prefix() {
        let home = home_dir().expect("测试环境应有 home 目录");
        assert_eq!(expand_home_path("~").as_deref(), Some(home.as_path()));
        assert_eq!(
            expand_home_path("~/.ssh/id_rsa"),
            Some(home.join(".ssh/id_rsa"))
        );
        assert_eq!(
            expand_home_path("/tmp/id_rsa"),
            Some(PathBuf::from("/tmp/id_rsa"))
        );
    }
}
