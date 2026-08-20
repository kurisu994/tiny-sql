//! 独占 session 契约（FR-244）：从事务开始到结束绑定同一条物理连接。
//!
//! 通过 [`crate::Driver::begin_session`] 获取，session 建立时已执行 BEGIN。
//! `close` / `Drop` 时未提交事务自动回滚：MySQL 用 `RESET CONNECTION`、
//! PostgreSQL 用 `ROLLBACK` + `RESET ALL; CLOSE ALL; DISCARD TEMP`（避开会清掉
//! sqlx prepared statement cache 的 `DISCARD ALL`）清理会话状态后归还连接池；
//! 清理失败则销毁连接，由服务端在连接关闭时兜底回滚。

use tokio_util::sync::CancellationToken;

use super::{DriverCloseFuture, DriverFuture, QueryOptions, RowSet};

/// 绑定单条物理连接的独占 session（FR-244）。
///
/// - `query` 复用与 [`crate::Driver::query`] 相同的 guard、行数上限与取消语义；
///   事务控制语句（BEGIN / COMMIT / ROLLBACK / SAVEPOINT）免写确认，执行后自动
///   跟踪事务开关状态。
/// - `commit` / `rollback`：无进行中事务时返回
///   [`crate::DriverError::SessionNotInTransaction`]。
/// - 同一时刻只有一条语句在执行（`&mut self` 编译期互斥）。
/// - 连接断开（SSH 掉线、服务端关闭）后 session 不可恢复：后续调用返回
///   [`crate::DriverError::SessionBroken`]，未提交事务已由服务端回滚，前端应引导用户重建。
pub trait DriverSession: Send {
    /// 在 session 绑定的连接上执行 SQL。
    fn query<'a>(
        &'a mut self,
        sql: &'a str,
        options: QueryOptions,
        cancel_token: CancellationToken,
    ) -> DriverFuture<'a, RowSet>;

    /// 提交当前事务；无进行中事务时返回 [`crate::DriverError::SessionNotInTransaction`]。
    fn commit(&mut self) -> DriverFuture<'_, ()>;

    /// 回滚当前事务；无进行中事务时返回 [`crate::DriverError::SessionNotInTransaction`]。
    fn rollback(&mut self) -> DriverFuture<'_, ()>;

    /// 结束 session：未提交事务先回滚再归还/销毁连接；幂等。
    fn close(&mut self) -> DriverCloseFuture<'_>;

    /// 当前是否有进行中的事务（含 PostgreSQL 出错后的 aborted 状态，需 ROLLBACK 恢复）。
    fn in_transaction(&self) -> bool;
}
