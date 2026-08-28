//! 多级 SSH 跳板隧道
//!
//! 把入向 TCP 连接经过 N 跳 SSH 链路桥接到 `target_host:target_port`，在本地
//! `127.0.0.1` 绑定一个随机端口。上层（如 db-driver）拿到本地端口后，用普通
//! `mysql://127.0.0.1:port` 连接即可，完全不感知 SSH 的存在。
//!
//! 设计要点：
//! - 本 crate **不依赖 Tauri**，方便未来独立 publish 到 crates.io。运行期需要回调
//!   到上层（keepalive 断开通知、host key 校验）的地方，统一用 [`TunnelContext`]
//!   注入闭包，绝不引用 `tauri::*`。
//! - keepalive 走 russh 内置机制（默认 60s / 连续 3 次），间隔与失败阈值由
//!   [`KeepaliveConfig`] 配置；每跳再起一个只读监控 task 探测 session 是否已断，
//!   断开经 [`HopStatusCallback`] 上报。
//! - host key 校验（known_hosts + TOFU）由上层经 [`TunnelContext::verifier`] 注入；
//!   不注入时接受任意 key，仅限自动化测试等受信环境使用。
//!
//! russh 0.54 的多跳实现移植自 redis-desktop-client 的 `ssh_tunnel.rs`，
//! 剥离了 Tauri/known_hosts 耦合。

use russh::client::{self, AuthResult, Config, DisconnectReason, Handle, Handler};
use russh::keys::{load_secret_key, ssh_key, PrivateKeyWithHashAlg};
use russh::Channel;
use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{AbortHandle, JoinHandle};

/// SSH 隧道空闲超时（russh 心跳与断连判定的兜底）。
/// 注意：russh 在收到任意数据 / 发送 keepalive 时都会重置该计时器，
/// 所以活跃会话不会被它误杀，仅用于彻底空闲的兜底回收。
const TUNNEL_INACTIVITY: Duration = Duration::from_secs(3600);

/// 默认 keepalive 发包间隔（russh 内置 keepalive）。
const DEFAULT_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(60);

/// 默认连续失败阈值（≈ 60s × 3 = 180s）。
const DEFAULT_KEEPALIVE_FAILURE_THRESHOLD: usize = 3;

/// 监控 task 轮询 session 存活的间隔——探测 session 任务是否已因 keepalive 超时退出。
const KEEPALIVE_MONITOR_POLL: Duration = Duration::from_secs(20);

/// SSH 协议 RTT 采样间隔；低频采样避免给多跳堡垒机制造额外噪声。
/// 首个采样事件常被前端连接流程的守卫/初始化吞掉，间隔别太长，
/// 否则延迟标签要在连接后很久才出现。
const RTT_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

/// 首次采样延迟；隧道和数据库握手完成后再开始，不进入连接关键路径。
const RTT_INITIAL_DELAY: Duration = Duration::from_secs(1);

/// 单次 SSH global-request 探测超时；超时仅更新指标，不改变连接状态。
const RTT_SAMPLE_TIMEOUT: Duration = Duration::from_secs(2);

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

/// SSH keepalive 运行参数。
///
/// `interval=None` 表示关闭 keepalive；`failure_threshold` 表示连续多少次未响应后
/// 判定 session 断开。阈值会按 russh 的 `alive_timeouts > keepalive_max` 语义换算。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeepaliveConfig {
    pub interval: Option<Duration>,
    pub failure_threshold: usize,
}

impl KeepaliveConfig {
    /// 构造启用状态；间隔与失败阈值最小都按 1 处理。
    pub fn enabled(interval: Duration, failure_threshold: usize) -> Self {
        Self {
            interval: Some(interval.max(Duration::from_secs(1))),
            failure_threshold: failure_threshold.max(1),
        }
    }

    /// 构造关闭状态。
    pub fn disabled() -> Self {
        Self {
            interval: None,
            failure_threshold: DEFAULT_KEEPALIVE_FAILURE_THRESHOLD,
        }
    }

    fn russh_max_missed(self) -> usize {
        self.failure_threshold.max(1).saturating_sub(1)
    }
}

impl Default for KeepaliveConfig {
    fn default() -> Self {
        Self::enabled(
            DEFAULT_KEEPALIVE_INTERVAL,
            DEFAULT_KEEPALIVE_FAILURE_THRESHOLD,
        )
    }
}

/// SSH 隧道错误 —— 每个变体对应一个稳定的前端 i18n key，且尽量带 `hop_index`
/// 以把故障归因到具体某一跳（FR-013）。i18n key 是**公开 API 契约**，只能加不能改名。
#[derive(Debug, Error)]
pub enum SshTunnelError {
    /// 配置中 hops 为空
    #[error("error.ssh.no_hops")]
    NoHops,
    /// TCP 层连接失败（含 DNS 解析失败 / refused / timeout）
    #[error("error.ssh.connect_failed (hop {hop_index}): {reason}")]
    ConnectFailed { hop_index: usize, reason: String },
    /// 认证失败（密码错 / 私钥无权限）
    #[error("error.ssh.auth_failed (hop {hop_index})")]
    AuthFailed { hop_index: usize },
    /// 私钥 passphrase 错
    #[error("error.ssh.invalid_passphrase (hop {hop_index})")]
    InvalidPassphrase { hop_index: usize },
    /// 私钥文件不存在或不可读
    #[error("error.ssh.key_not_found (hop {hop_index})")]
    KeyNotFound { hop_index: usize },
    /// SSH direct-tcpip channel 开启失败
    #[error("error.ssh.channel_open_failed (hop {hop_index}): {reason}")]
    ChannelOpenFailed { hop_index: usize, reason: String },
    /// 本地 listener 绑定失败
    #[error("error.ssh.local_listen_failed")]
    LocalListenFailed,
    /// 配置里 auth_type 字段不是合法值
    #[error("error.ssh.invalid_auth_type (hop {hop_index})")]
    InvalidAuthType { hop_index: usize },
    /// 已信任 host 的公钥指纹被改 —— 硬拒绝，不允许 UI 忽略
    #[error("error.ssh.host_key_mismatch (hop {hop_index}): {host}:{port}")]
    HostKeyMismatch {
        hop_index: usize,
        host: String,
        port: u16,
    },
    /// 用户在 TOFU 弹窗里选了「拒绝」（或超时）
    #[error("error.ssh.host_key_rejected (hop {hop_index})")]
    HostKeyRejected { hop_index: usize },
    /// 已建立的隧道因 keepalive 连续失败而断开（FR-014，mid-session）
    #[error("error.ssh.tunnel_lost (hop {hop_index}): {reason}")]
    TunnelLost { hop_index: usize, reason: String },
    /// 运行中某跳的 channel 被对端主动关闭（可能跳板重启），需人工重连（mid-session）
    #[error("error.ssh.channel_dropped (hop {hop_index})")]
    ChannelDropped { hop_index: usize },
    /// 运行中某跳的 accept loop panic（代码 bug），需上报（mid-session）
    #[error("error.ssh.accept_loop_died (hop {hop_index})")]
    AcceptLoopDied { hop_index: usize },
}

impl SshTunnelError {
    /// 返回稳定的 i18n key（不含具体错误描述与 hop_index），供前端翻译。
    pub fn i18n_key(&self) -> &'static str {
        match self {
            Self::NoHops => "error.ssh.no_hops",
            Self::ConnectFailed { .. } => "error.ssh.connect_failed",
            Self::AuthFailed { .. } => "error.ssh.auth_failed",
            Self::InvalidPassphrase { .. } => "error.ssh.invalid_passphrase",
            Self::KeyNotFound { .. } => "error.ssh.key_not_found",
            Self::ChannelOpenFailed { .. } => "error.ssh.channel_open_failed",
            Self::LocalListenFailed => "error.ssh.local_listen_failed",
            Self::InvalidAuthType { .. } => "error.ssh.invalid_auth_type",
            Self::HostKeyMismatch { .. } => "error.ssh.host_key_mismatch",
            Self::HostKeyRejected { .. } => "error.ssh.host_key_rejected",
            Self::TunnelLost { .. } => "error.ssh.tunnel_lost",
            Self::ChannelDropped { .. } => "error.ssh.channel_dropped",
            Self::AcceptLoopDied { .. } => "error.ssh.accept_loop_died",
        }
    }

    /// 故障归因到哪一跳（无 hop 概念的错误返回 None）。
    pub fn hop_index(&self) -> Option<usize> {
        match self {
            Self::NoHops | Self::LocalListenFailed => None,
            Self::ConnectFailed { hop_index, .. }
            | Self::AuthFailed { hop_index }
            | Self::InvalidPassphrase { hop_index }
            | Self::KeyNotFound { hop_index }
            | Self::ChannelOpenFailed { hop_index, .. }
            | Self::InvalidAuthType { hop_index }
            | Self::HostKeyMismatch { hop_index, .. }
            | Self::HostKeyRejected { hop_index }
            | Self::TunnelLost { hop_index, .. }
            | Self::ChannelDropped { hop_index }
            | Self::AcceptLoopDied { hop_index } => Some(*hop_index),
        }
    }
}

/// 运行期某跳的状态变化（keepalive、嵌套 channel 或 accept loop 故障）。
#[derive(Debug, Clone)]
pub struct HopStatusEvent {
    pub hop_index: usize,
    pub status: HopStatus,
    /// 附带的 i18n key / 详情，供前端展示
    pub reason: Option<String>,
}

/// 运行期跳状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HopStatus {
    /// keepalive 连续失败，该跳已断（对应 [`SshTunnelError::TunnelLost`]）
    Lost,
}

/// 隧道运行期状态回调：由上层（src-tauri）注入，接 Tauri 事件总线。
/// ssh-multihop 自身**不依赖 Tauri**，故用闭包解耦。
pub type HopStatusCallback = Arc<dyn Fn(HopStatusEvent) + Send + Sync>;

/// 一次 SSH 协议探测结果。
///
/// 多跳时每个值是“从本机累计到该 SSH session”的 global-request 往返时间，
/// 不是 ICMP RTT，也不能相减后当作单段网络延迟。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HopRttSample {
    Measured(Duration),
    TimedOut,
    Unavailable,
}

/// 某一跳的 SSH 协议 RTT 采样事件。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HopRttEvent {
    pub hop_index: usize,
    pub sample: HopRttSample,
}

/// RTT 采样回调；由上层注入事件总线，None 表示不启动采样 task。
pub type HopRttCallback = Arc<dyn Fn(HopRttEvent) + Send + Sync>;

/// host key 校验请求 —— 传给上层注入的 [`HostKeyVerifier`]。
/// 只携带预计算的指纹字符串，**不暴露 russh / ssh_key 类型**，让上层无需依赖 SSH 库。
#[derive(Debug, Clone)]
pub struct HostKeyQuery {
    pub hop_index: usize,
    pub host: String,
    pub port: u16,
    /// OpenSSH 风格 sha256 指纹，如 `SHA256:abc...`
    pub fingerprint: String,
}

/// host key 校验结论
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyDecision {
    /// 信任，继续握手
    Trust,
    /// 拒绝握手。`mismatch=true` 表示「已信任 host 的指纹被改」（→ HostKeyMismatch），
    /// `false` 表示「未知 host 用户拒绝 / TOFU 超时」（→ HostKeyRejected）。
    Reject { mismatch: bool },
}

/// host key 校验器：由上层注入，内部接 known_hosts + TOFU 弹窗。
/// 返回 boxed future 而非 `async fn`，以保持 trait 对象安全且不引入 async-trait 依赖。
pub type HostKeyVerifier = Arc<
    dyn Fn(HostKeyQuery) -> Pin<Box<dyn Future<Output = HostKeyDecision> + Send>> + Send + Sync,
>;

/// 建立 / 运行隧道所需的回调上下文。保持 ssh-multihop 不依赖 Tauri：
/// 上层把「状态上报」「host key 校验」等以闭包注入。
#[derive(Clone, Default)]
pub struct TunnelContext {
    /// 跳状态回调（keepalive 断开等）；None = 不上报。
    pub status_cb: Option<HopStatusCallback>,
    /// SSH 协议 RTT 回调；None 时不产生额外探测流量。
    pub rtt_cb: Option<HopRttCallback>,
    /// host key 校验器；None = 接受任意 key，仅限自动化测试等受信环境，
    /// 应用内的连接路径（含测试连接）一律注入。
    pub verifier: Option<HostKeyVerifier>,
    /// russh keepalive 参数；默认 60s / 连续 3 次。
    pub keepalive: KeepaliveConfig,
}

/// 整条隧道共享的运行期上报状态。
#[derive(Clone)]
struct RuntimeReportContext {
    status_cb: Option<HopStatusCallback>,
    shutdown: Arc<AtomicBool>,
    enabled: Arc<AtomicBool>,
}

/// 单跳运行期故障上报器；共享上下文之外只额外保存 hop 与去重标记。
#[derive(Clone)]
struct SessionRuntimeReporter {
    hop_index: usize,
    context: RuntimeReportContext,
    emitted: Arc<AtomicBool>,
}

impl SessionRuntimeReporter {
    fn new(hop_index: usize, context: RuntimeReportContext) -> Self {
        Self {
            hop_index,
            context,
            emitted: Arc::new(AtomicBool::new(false)),
        }
    }

    fn report_loss(&self) {
        if self.context.shutdown.load(Ordering::Acquire)
            || !self.context.enabled.load(Ordering::Acquire)
            || self.emitted.swap(true, Ordering::AcqRel)
        {
            return;
        }

        let reason = if self.hop_index == 0 {
            "error.ssh.tunnel_lost"
        } else {
            "error.ssh.channel_dropped"
        };
        log::warn!("SSH 第 {} 跳运行期断开：{reason}", self.hop_index);
        if let Some(cb) = &self.context.status_cb {
            cb(HopStatusEvent {
                hop_index: self.hop_index,
                status: HopStatus::Lost,
                reason: Some(reason.to_string()),
            });
        }
    }
}

type DirectTcpipChannel = Channel<client::Msg>;

enum SessionCommand {
    OpenDirectTcpip {
        host: String,
        port: u32,
        reply: oneshot::Sender<Result<DirectTcpipChannel, String>>,
    },
    ProbeRtt {
        timeout: Duration,
        reply: oneshot::Sender<HopRttSample>,
    },
}

/// `Handle` 含非 Sync receiver，由单一 actor 独占；调用方只持可 Clone 的命令端。
/// RTT 等待在 actor 内用 `select!` 与 channel-open 命令并行，避免探测阻塞主链路。
#[derive(Clone)]
struct SharedSession {
    commands: mpsc::Sender<SessionCommand>,
    closed: Arc<AtomicBool>,
}

impl SharedSession {
    async fn open_direct_tcpip(&self, host: &str, port: u32) -> Result<DirectTcpipChannel, String> {
        let (reply, response) = oneshot::channel();
        self.commands
            .send(SessionCommand::OpenDirectTcpip {
                host: host.to_string(),
                port,
                reply,
            })
            .await
            .map_err(|_| "SSH session actor 已停止".to_string())?;
        response
            .await
            .map_err(|_| "SSH session actor 未返回 channel".to_string())?
    }

    async fn probe_rtt(&self, timeout: Duration) -> HopRttSample {
        let (reply, response) = oneshot::channel();
        if self
            .commands
            .send(SessionCommand::ProbeRtt { timeout, reply })
            .await
            .is_err()
        {
            return HopRttSample::Unavailable;
        }
        response.await.unwrap_or(HopRttSample::Unavailable)
    }

    fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }
}

fn spawn_session_actor(handle: Handle<TunnelHandler>) -> (SharedSession, JoinHandle<()>) {
    let (commands, mut receiver) = mpsc::channel(32);
    let closed = Arc::new(AtomicBool::new(false));
    let closed_for_task = closed.clone();
    let task = tokio::spawn(async move {
        let mut closed_poll = tokio::time::interval(Duration::from_secs(1));
        closed_poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                command = receiver.recv() => {
                    let Some(command) = command else { break };
                    match command {
                        SessionCommand::OpenDirectTcpip { host, port, reply } => {
                            let result = open_direct_tcpip(&handle, &host, port).await;
                            let _ = reply.send(result);
                        }
                        SessionCommand::ProbeRtt { timeout, reply } => {
                            if !run_rtt_probe(&handle, &mut receiver, &mut closed_poll, timeout, reply).await {
                                break;
                            }
                        }
                    }
                }
                _ = closed_poll.tick() => {
                    if handle.is_closed() {
                        break;
                    }
                }
            }
        }
        closed_for_task.store(true, Ordering::Release);
    });
    (SharedSession { commands, closed }, task)
}

async fn open_direct_tcpip(
    handle: &Handle<TunnelHandler>,
    host: &str,
    port: u32,
) -> Result<DirectTcpipChannel, String> {
    handle
        .channel_open_direct_tcpip(host, port, "127.0.0.1", 0)
        .await
        .map_err(|error| error.to_string())
}

/// 在等待 ping 回复时继续优先处理 direct-tcpip，RTT 不占住 session 主链路。
/// 返回 false 表示 actor 应退出。
async fn run_rtt_probe(
    handle: &Handle<TunnelHandler>,
    receiver: &mut mpsc::Receiver<SessionCommand>,
    closed_poll: &mut tokio::time::Interval,
    timeout: Duration,
    reply: oneshot::Sender<HopRttSample>,
) -> bool {
    let started = Instant::now();
    let ping = handle.send_ping();
    tokio::pin!(ping);
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            biased;
            command = receiver.recv() => {
                match command {
                    Some(SessionCommand::OpenDirectTcpip { host, port, reply }) => {
                        let result = open_direct_tcpip(handle, &host, port).await;
                        let _ = reply.send(result);
                    }
                    Some(SessionCommand::ProbeRtt { reply, .. }) => {
                        let _ = reply.send(HopRttSample::Unavailable);
                    }
                    None => {
                        let _ = reply.send(HopRttSample::Unavailable);
                        return false;
                    }
                }
            }
            result = &mut ping => {
                // russh 的 send_ping 会忽略 oneshot 被关闭；需同时检查 session sender。
                let sample = if result.is_ok() && !handle.is_closed() {
                    HopRttSample::Measured(started.elapsed())
                } else {
                    HopRttSample::Unavailable
                };
                let _ = reply.send(sample);
                return true;
            }
            _ = &mut deadline => {
                let _ = reply.send(HopRttSample::TimedOut);
                return true;
            }
            _ = closed_poll.tick() => {
                if handle.is_closed() {
                    let _ = reply.send(HopRttSample::Unavailable);
                    return false;
                }
            }
        }
    }
}

/// russh 客户端 handler：每跳一个，承载该跳的 host key 校验。
///
/// 无 verifier 时接受任意 key（仅限受信测试环境）；有 verifier 时把指纹交给
/// 上层判定，拒绝则把精确错误写进 `reject_slot` 供 [`open`] 在握手失败后读取。
struct TunnelHandler {
    hop_index: usize,
    host: String,
    port: u16,
    verifier: Option<HostKeyVerifier>,
    reject_slot: Arc<std::sync::Mutex<Option<SshTunnelError>>>,
    runtime_reporter: SessionRuntimeReporter,
}

impl Handler for TunnelHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let Some(verifier) = &self.verifier else {
            // 无校验器（仅限受信测试环境）：接受任意 key
            return Ok(true);
        };
        let fingerprint = server_public_key
            .fingerprint(ssh_key::HashAlg::Sha256)
            .to_string();
        let query = HostKeyQuery {
            hop_index: self.hop_index,
            host: self.host.clone(),
            port: self.port,
            fingerprint,
        };
        match verifier(query).await {
            HostKeyDecision::Trust => Ok(true),
            HostKeyDecision::Reject { mismatch } => {
                let err = if mismatch {
                    SshTunnelError::HostKeyMismatch {
                        hop_index: self.hop_index,
                        host: self.host.clone(),
                        port: self.port,
                    }
                } else {
                    SshTunnelError::HostKeyRejected {
                        hop_index: self.hop_index,
                    }
                };
                *self.reject_slot.lock().unwrap() = Some(err);
                Ok(false)
            }
        }
    }

    fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        self.runtime_reporter.report_loss();

        async move {
            match reason {
                DisconnectReason::ReceivedDisconnect(_) => Ok(()),
                DisconnectReason::Error(error) => Err(error),
            }
        }
    }
}

/// SSH 隧道句柄 —— drop 时关闭本地 listener、所有 keepalive 监控 task 与跳板 session
pub struct SshTunnel {
    local_addr: SocketAddr,
    /// 本地 accept worker 的中止句柄；worker 的 JoinHandle 由 monitor 持有。
    accept_abort: AbortHandle,
    /// 观察 accept worker 是否 panic / 意外退出，并上报 `AcceptLoopDied`。
    accept_monitor: JoinHandle<()>,
    /// 每跳一个 keepalive 监控 task，drop 时一起 abort，防 leak
    keepalive_tasks: Vec<JoinHandle<()>>,
    /// 每跳一个 RTT 采样 task；未注入回调时为空。
    rtt_tasks: Vec<JoinHandle<()>>,
    /// 每跳一个 session actor，负责串行 russh Handle 命令并让 RTT 等待不挡主链路。
    session_tasks: Vec<JoinHandle<()>>,
    /// 持有所有跳板 session 引用直到 drop；中间跳板若提前 drop，
    /// 派生在其上的下一跳 channel stream 会失活，因此必须整链保活
    _sessions: Vec<SharedSession>,
    /// 正常关闭标记，避免 drop 期间把主动终止误报为运行期故障。
    shutdown: Arc<AtomicBool>,
}

impl SshTunnel {
    /// 隧道在本地绑定的 `127.0.0.1:port`，可直接喂给 db-driver 建连
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);
        self.accept_abort.abort();
        self.accept_monitor.abort();
        for task in &self.keepalive_tasks {
            task.abort();
        }
        for task in &self.rtt_tasks {
            task.abort();
        }
        for task in &self.session_tasks {
            task.abort();
        }
    }
}

/// 建立一条 N 跳 SSH 隧道并在本地 `127.0.0.1` 绑定随机端口；所有入向 TCP
/// 连接经完整 SSH 链路桥接到 `target_host:target_port`。
///
/// `hops` 顺序即链路顺序：
/// - `hops[0]`：本地直连的 SSH 主机（堡垒机或唯一跳板）
/// - `hops[1..N-1]`：中间跳板，每跳通过上一跳的 SSH 通道连接
/// - `hops[N-1]`：出口主机，在其上发起 direct-tcpip 到目标
///
/// `ctx` 注入运行期回调（状态上报等），不需要时传 `&TunnelContext::default()`。
pub async fn open(
    hops: &[SshHop],
    target_host: &str,
    target_port: u16,
    ctx: &TunnelContext,
) -> Result<SshTunnel, SshTunnelError> {
    if hops.is_empty() {
        return Err(SshTunnelError::NoHops);
    }

    let config = Arc::new(build_russh_config(ctx.keepalive));

    let mut sessions: Vec<SharedSession> = Vec::with_capacity(hops.len());
    let mut session_tasks = Vec::with_capacity(hops.len());
    let shutdown = Arc::new(AtomicBool::new(false));
    let runtime_context = RuntimeReportContext {
        status_cb: ctx.status_cb.clone(),
        shutdown: shutdown.clone(),
        enabled: Arc::new(AtomicBool::new(false)),
    };
    let mut runtime_reporters = Vec::with_capacity(hops.len());

    // 第 1 跳：直接 TCP 连接到 SSH 主机
    let first = &hops[0];
    let tcp = TcpStream::connect((first.host.as_str(), first.port))
        .await
        .map_err(|e| SshTunnelError::ConnectFailed {
            hop_index: 0,
            reason: e.to_string(),
        })?;
    let first_reporter = SessionRuntimeReporter::new(0, runtime_context.clone());
    let current = connect_and_auth(
        config.clone(),
        tcp,
        first,
        0,
        &ctx.verifier,
        first_reporter.clone(),
    )
    .await?;
    let (current, session_task) = spawn_session_actor(current);
    sessions.push(current);
    session_tasks.push(session_task);
    runtime_reporters.push(first_reporter);

    // 第 2..N 跳：在前一跳 session 上开 direct-tcpip 到下一跳 SSH 端口，
    // 把 channel stream 作为下一跳 session 的 transport（等效 OpenSSH ProxyJump）
    for (hop_index, next_hop) in hops.iter().enumerate().skip(1) {
        let prev = sessions.last().expect("已建立至少一个 session").clone();
        let channel = prev
            .open_direct_tcpip(next_hop.host.as_str(), next_hop.port as u32)
            .await
            .map_err(|reason| SshTunnelError::ChannelOpenFailed { hop_index, reason })?;
        let stream = channel.into_stream();
        let runtime_reporter = SessionRuntimeReporter::new(hop_index, runtime_context.clone());
        let current = connect_and_auth(
            config.clone(),
            stream,
            next_hop,
            hop_index,
            &ctx.verifier,
            runtime_reporter.clone(),
        )
        .await?;
        let (current, session_task) = spawn_session_actor(current);
        sessions.push(current);
        session_tasks.push(session_task);
        runtime_reporters.push(runtime_reporter);
    }

    // 本地随机端口监听
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| SshTunnelError::LocalListenFailed)?;
    let local_addr = listener
        .local_addr()
        .map_err(|_| SshTunnelError::LocalListenFailed)?;

    // 链路和本地 listener 均准备完成后才开启运行期上报，避免握手失败被重复当成掉线。
    runtime_context.enabled.store(true, Ordering::Release);

    // 每跳起一个只读监控 task：探测 session 是否已断，断开经回调上报。
    let mut keepalive_tasks = Vec::with_capacity(sessions.len());
    for (session, runtime_reporter) in sessions.iter().zip(runtime_reporters.iter()) {
        keepalive_tasks.push(spawn_keepalive_monitor(
            session.clone(),
            runtime_reporter.clone(),
        ));
    }

    // RTT 首次采样延后到 open 返回之后；没有回调（如测试连接）则零额外流量。
    let mut rtt_tasks = Vec::new();
    if let Some(callback) = &ctx.rtt_cb {
        rtt_tasks.reserve(sessions.len());
        for (hop_index, session) in sessions.iter().enumerate() {
            rtt_tasks.push(spawn_rtt_monitor(
                session.clone(),
                hop_index,
                callback.clone(),
            ));
        }
    }

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
                let channel_res = last
                    .open_direct_tcpip(target_host.as_str(), target_port as u32)
                    .await;
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
    let (accept_abort, accept_monitor) =
        spawn_accept_monitor(accept_task, sessions.len() - 1, runtime_context);

    Ok(SshTunnel {
        local_addr,
        accept_abort,
        accept_monitor,
        keepalive_tasks,
        rtt_tasks,
        session_tasks,
        _sessions: sessions,
        shutdown,
    })
}

/// 把公共 keepalive 参数换算成 russh 的内部判定语义。
fn build_russh_config(keepalive: KeepaliveConfig) -> Config {
    Config {
        inactivity_timeout: Some(TUNNEL_INACTIVITY),
        keepalive_interval: keepalive.interval,
        // russh 使用 `alive_timeouts > keepalive_max`，所以连续 N 次失败对应 N-1。
        keepalive_max: keepalive.russh_max_missed(),
        ..Default::default()
    }
}

/// 监听 accept worker 的非预期退出；正常 drop 会先设置 `shutdown`，不会误报。
fn spawn_accept_monitor(
    accept_task: JoinHandle<()>,
    hop_index: usize,
    runtime_context: RuntimeReportContext,
) -> (AbortHandle, JoinHandle<()>) {
    let accept_abort = accept_task.abort_handle();
    let monitor = tokio::spawn(async move {
        let result = accept_task.await;
        if runtime_context.shutdown.load(Ordering::Acquire) {
            return;
        }

        let unexpectedly_stopped = match result {
            Ok(()) => true,
            Err(error) => !error.is_cancelled(),
        };
        if unexpectedly_stopped {
            log::error!("SSH 隧道本地 accept loop 意外退出（出口跳 {hop_index}）");
            if let Some(cb) = &runtime_context.status_cb {
                cb(HopStatusEvent {
                    hop_index,
                    status: HopStatus::Lost,
                    reason: Some("error.ssh.accept_loop_died".to_string()),
                });
            }
        }
    });
    (accept_abort, monitor)
}

/// 为一跳 session 起 keepalive 监控：周期性轻量探测 session 是否仍存活。
///
/// 真正的死链判定由 russh 内置 keepalive 完成（超时后 session 任务退出）；
/// 本 task 只读检查 session actor 的关闭标记，不会额外发送心跳或改变配置间隔。
fn spawn_keepalive_monitor(
    session: SharedSession,
    runtime_reporter: SessionRuntimeReporter,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(KEEPALIVE_MONITOR_POLL).await;
            if session.is_closed() {
                runtime_reporter.report_loss();
                break;
            }
        }
    })
}

/// 后台采样每跳 SSH global-request RTT；失败只上报指标，不改变连接状态。
fn spawn_rtt_monitor(
    session: SharedSession,
    hop_index: usize,
    callback: HopRttCallback,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(RTT_INITIAL_DELAY).await;
        loop {
            let sample = session.probe_rtt(RTT_SAMPLE_TIMEOUT).await;
            callback(HopRttEvent { hop_index, sample });
            if session.is_closed() {
                break;
            }
            tokio::time::sleep(RTT_SAMPLE_INTERVAL).await;
        }
    })
}

/// 在给定 transport 上建立一跳 SSH session：完成 host key 校验 + 认证。
///
/// host key 被校验器拒绝时，握手会失败；此处读取 handler 的 `reject_slot` 还原出
/// 精确错误（HostKeyMismatch / HostKeyRejected），而不是笼统的 ConnectFailed。
async fn connect_and_auth<S>(
    config: Arc<Config>,
    stream: S,
    hop: &SshHop,
    hop_index: usize,
    verifier: &Option<HostKeyVerifier>,
    runtime_reporter: SessionRuntimeReporter,
) -> Result<Handle<TunnelHandler>, SshTunnelError>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let reject_slot = Arc::new(std::sync::Mutex::new(None));
    let handler = TunnelHandler {
        hop_index,
        host: hop.host.clone(),
        port: hop.port,
        verifier: verifier.clone(),
        reject_slot: reject_slot.clone(),
        runtime_reporter,
    };
    let mut session = match client::connect_stream(config, stream, handler).await {
        Ok(h) => h,
        Err(e) => {
            if let Some(err) = reject_slot.lock().unwrap().take() {
                return Err(err);
            }
            return Err(SshTunnelError::ConnectFailed {
                hop_index,
                reason: e.to_string(),
            });
        }
    };
    authenticate_hop(&mut session, hop, hop_index).await?;
    Ok(session)
}

/// 对一个 SSH session 执行该跳的认证（密码 / 私钥），`hop_index` 用于错误归因
async fn authenticate_hop<H: Handler>(
    session: &mut Handle<H>,
    hop: &SshHop,
    hop_index: usize,
) -> Result<(), SshTunnelError> {
    let result: AuthResult = match &hop.auth {
        SshAuth::Password(pwd) => session
            .authenticate_password(hop.username.clone(), pwd.clone())
            .await
            .map_err(|_| SshTunnelError::AuthFailed { hop_index })?,
        SshAuth::PrivateKey { path, passphrase } => {
            let expanded_path =
                expand_home_path(path).ok_or(SshTunnelError::KeyNotFound { hop_index })?;
            if !expanded_path.exists() {
                return Err(SshTunnelError::KeyNotFound { hop_index });
            }
            let passphrase = passphrase.as_deref().filter(|s| !s.is_empty());
            let key = load_secret_key(&expanded_path, passphrase).map_err(|e| {
                let msg = e.to_string().to_lowercase();
                if msg.contains("passphrase")
                    || msg.contains("decrypt")
                    || msg.contains("incorrect password")
                {
                    SshTunnelError::InvalidPassphrase { hop_index }
                } else {
                    SshTunnelError::KeyNotFound { hop_index }
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
                .map_err(|_| SshTunnelError::AuthFailed { hop_index })?
        }
    };

    if result.success() {
        Ok(())
    } else {
        Err(SshTunnelError::AuthFailed { hop_index })
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
            SshTunnelError::AuthFailed { hop_index: 1 }.i18n_key(),
            "error.ssh.auth_failed"
        );
        // 三个 mid-session 变体的 i18n key（公开契约，不可改名）
        assert_eq!(
            SshTunnelError::TunnelLost {
                hop_index: 0,
                reason: "x".into()
            }
            .i18n_key(),
            "error.ssh.tunnel_lost"
        );
        assert_eq!(
            SshTunnelError::ChannelDropped { hop_index: 2 }.i18n_key(),
            "error.ssh.channel_dropped"
        );
        assert_eq!(
            SshTunnelError::AcceptLoopDied { hop_index: 2 }.i18n_key(),
            "error.ssh.accept_loop_died"
        );
    }

    #[test]
    fn error_reports_hop_index() {
        assert_eq!(SshTunnelError::NoHops.hop_index(), None);
        assert_eq!(SshTunnelError::LocalListenFailed.hop_index(), None);
        assert_eq!(
            SshTunnelError::ConnectFailed {
                hop_index: 2,
                reason: "refused".into()
            }
            .hop_index(),
            Some(2)
        );
        assert_eq!(
            SshTunnelError::HostKeyMismatch {
                hop_index: 1,
                host: "h".into(),
                port: 22
            }
            .hop_index(),
            Some(1)
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

    #[test]
    fn keepalive_config_maps_to_russh_threshold_semantics() {
        let config = build_russh_config(KeepaliveConfig::enabled(Duration::from_secs(17), 5));

        assert_eq!(config.keepalive_interval, Some(Duration::from_secs(17)));
        assert_eq!(config.keepalive_max, 4);
    }

    #[test]
    fn disabled_keepalive_has_no_interval_and_safe_threshold() {
        let config = build_russh_config(KeepaliveConfig::disabled());

        assert_eq!(config.keepalive_interval, None);
        assert_eq!(config.keepalive_max, 2);
    }

    #[test]
    fn keepalive_config_clamps_zero_values() {
        let config = KeepaliveConfig::enabled(Duration::ZERO, 0);

        assert_eq!(config.interval, Some(Duration::from_secs(1)));
        assert_eq!(config.failure_threshold, 1);
        assert_eq!(build_russh_config(config).keepalive_max, 0);
    }

    #[test]
    fn runtime_loss_reports_nested_channel_once() {
        let events = Arc::new(std::sync::Mutex::new(Vec::<HopStatusEvent>::new()));
        let captured = events.clone();
        let callback: HopStatusCallback = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        });
        let runtime_context = RuntimeReportContext {
            status_cb: Some(callback),
            shutdown: Arc::new(AtomicBool::new(false)),
            enabled: Arc::new(AtomicBool::new(true)),
        };
        let reporter = SessionRuntimeReporter::new(1, runtime_context);

        reporter.report_loss();
        reporter.report_loss();

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].hop_index, 1);
        assert_eq!(events[0].status, HopStatus::Lost);
        assert_eq!(
            events[0].reason.as_deref(),
            Some("error.ssh.channel_dropped")
        );
    }

    #[tokio::test]
    async fn accept_loop_panic_reports_runtime_failure() {
        let events = Arc::new(std::sync::Mutex::new(Vec::<HopStatusEvent>::new()));
        let captured = events.clone();
        let callback: HopStatusCallback = Arc::new(move |event| {
            captured.lock().unwrap().push(event);
        });
        let runtime_context = RuntimeReportContext {
            status_cb: Some(callback),
            shutdown: Arc::new(AtomicBool::new(false)),
            enabled: Arc::new(AtomicBool::new(true)),
        };
        let accept_task = tokio::spawn(async {
            panic!("模拟 accept loop panic");
        });

        let (_abort, monitor) = spawn_accept_monitor(accept_task, 2, runtime_context);
        monitor.await.unwrap();

        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].hop_index, 2);
        assert_eq!(
            events[0].reason.as_deref(),
            Some("error.ssh.accept_loop_died")
        );
    }
}
