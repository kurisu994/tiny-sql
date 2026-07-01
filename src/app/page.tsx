"use client";

import { useEffect, useState } from "react";
import { PlusIcon, RefreshCwIcon } from "lucide-react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { ConnectionDialogs } from "@/components/connection-dialogs";
import { ConnectionForm } from "@/components/connection-form";
import { SchemaBrowser } from "@/components/schema-browser";
import { UpdateDialog } from "@/components/update-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useUpdateChecker } from "@/hooks/use-update-checker";
import type { StoredConnection } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { useConfirmStore } from "@/stores/confirm-store";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";

/** 连接表单弹窗的状态：新建、编辑某条，或关闭 */
type FormState =
  | { mode: "create" }
  | { mode: "edit"; conn: StoredConnection }
  | null;

export default function Home() {
  const { connections, loading, error, load, create, remove } =
    useConnectionStore();
  // 列表高亮选中（仅视觉），与表单弹窗解耦
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // 表单弹窗状态
  const [form, setForm] = useState<FormState>(null);

  const sessionStatus = useSessionStore((s) => s.status);
  const openId = useSessionStore((s) => s.openId);
  const activeConnection = useSessionStore((s) => s.activeConnection);
  const openConnection = useSessionStore((s) => s.open);
  const closeConnection = useSessionStore((s) => s.close);
  const confirm = useConfirmStore((s) => s.confirm);
  const {
    updateInfo,
    checking: checkingUpdate,
    checkError,
    checkNotice,
    manualCheck,
    dismissUpdate,
  } = useUpdateChecker();

  useEffect(() => {
    load();
  }, [load]);

  const showingSession =
    activeConnection !== null &&
    (sessionStatus === "connecting" ||
      sessionStatus === "connected" ||
      sessionStatus === "error");
  const openConn =
    activeConnection ?? connections.find((c) => c.id === openId) ?? null;

  function startCreate() {
    setForm({ mode: "create" });
    setSelectedId(null);
  }

  function openEdit(c: StoredConnection) {
    setForm({ mode: "edit", conn: c });
    setSelectedId(c.id);
  }

  function closeForm() {
    setForm(null);
  }

  // 连接 / 进入命令列界面：已连接到该连接则不重连，控制台已在右侧
  function openSession(c: StoredConnection) {
    if (openId !== c.id) openConnection(c.id, undefined, c);
  }

  // 复制连接：克隆配置另存为「副本」，由用户再改名
  async function duplicateConnection(c: StoredConnection) {
    await create({
      name: `${c.name} 副本`,
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database,
      ssh: c.ssh,
      ssl: c.ssl,
      advanced: c.advanced,
    });
  }

  // 删除连接：先断开正在使用的会话，再清理选中态与表单
  async function deleteConnection(c: StoredConnection) {
    const ok = await confirm({
      title: "删除连接",
      message: `确定删除连接「${c.name}」？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
    if (openId === c.id) await closeConnection();
    await remove(c.id);
    if (selectedId === c.id) setSelectedId(null);
    if (form?.mode === "edit" && form.conn.id === c.id) setForm(null);
  }

  return (
    <main className="flex h-screen">
      <ConnectionDialogs />
      <ConfirmDialog />
      <UpdateDialog updateInfo={updateInfo} onDismiss={dismissUpdate} />

      {/* 新建 / 编辑连接弹窗 */}
      <Dialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
          <DialogTitle className="sr-only">
            {form?.mode === "edit" ? "编辑连接" : "新建连接"}
          </DialogTitle>
          {form && (
            <ConnectionForm
              key={form.mode === "edit" ? form.conn.id : "new"}
              editing={form.mode === "edit" ? form.conn : null}
              onDone={closeForm}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* 左侧连接列表 */}
      <aside className="flex w-72 flex-col border-r border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center justify-between border-b border-neutral-200 p-3 dark:border-neutral-800">
          <h1 className="flex min-w-0 items-center">
            <img
              src="/logo.svg"
              alt="tiny-sql"
              className="h-8 w-auto"
              draggable={false}
            />
          </h1>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              title={checkingUpdate ? "正在检查更新" : "检查更新"}
              onClick={() => void manualCheck()}
              disabled={checkingUpdate}
            >
              <RefreshCwIcon
                data-icon="inline-start"
                className={cn(checkingUpdate && "animate-spin")}
              />
              <span className="sr-only">检查更新</span>
            </Button>
            <Button type="button" size="sm" onClick={startCreate}>
              <PlusIcon data-icon="inline-start" />
              新建
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {(checkError || checkNotice) && (
            <p
              className={cn(
                "border-b px-3 py-2 text-xs",
                checkError
                  ? "border-destructive/20 text-destructive"
                  : "border-neutral-100 text-neutral-500 dark:border-neutral-900",
              )}
            >
              {checkError ? `检查更新失败：${checkError}` : checkNotice}
            </p>
          )}
          {loading && connections.length === 0 && (
            <p className="p-3 text-sm text-neutral-500">加载中…</p>
          )}
          {error && <p className="p-3 text-sm text-red-600">{error}</p>}
          {!loading && connections.length === 0 && !error && (
            <p className="p-3 text-sm text-neutral-500">还没有连接，点「+ 新建」开始。</p>
          )}
          <ul>
            {connections.map((c) => {
              const isOpen = openId === c.id;
              const connecting = sessionStatus === "connecting";
              return (
                <li
                  key={c.id}
                  className="border-b border-neutral-100 dark:border-neutral-900"
                >
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <button
                        onClick={() => setSelectedId(c.id)}
                        onDoubleClick={() => openSession(c)}
                        title="双击连接，右键更多操作"
                        className={cn(
                          "flex w-full min-w-0 flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-neutral-50 data-[state=open]:bg-blue-50 dark:hover:bg-neutral-900 dark:data-[state=open]:bg-blue-950",
                          selectedId === c.id && "bg-blue-50 dark:bg-blue-950",
                        )}
                      >
                        <span className="truncate text-sm font-medium">
                          {c.name}
                          {isOpen && (
                            <span className="ml-1 text-green-600">●</span>
                          )}
                        </span>
                        <span className="truncate text-xs text-neutral-500">
                          {c.host}:{c.port}
                          {c.ssh.enabled ? ` · SSH×${c.ssh.hops.length}` : ""}
                        </span>
                      </button>
                    </ContextMenuTrigger>
                    {/* 阻止菜单关闭时把焦点拉回触发器，避免与随后打开的弹窗抢焦点 */}
                    <ContextMenuContent
                      className="w-44"
                      onCloseAutoFocus={(e) => e.preventDefault()}
                    >
                      <ContextMenuItem
                        disabled={isOpen || connecting}
                        onSelect={() => openSession(c)}
                      >
                        连接
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={!isOpen}
                        onSelect={() => closeConnection()}
                      >
                        断开连接
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        disabled={connecting}
                        onSelect={() => openSession(c)}
                      >
                        进入命令列界面
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem onSelect={() => openEdit(c)}>
                        编辑连接
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => duplicateConnection(c)}>
                        复制连接
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem
                        variant="destructive"
                        onSelect={() => deleteConnection(c)}
                      >
                        删除连接
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </li>
              );
            })}
          </ul>
        </div>
      </aside>

      {/* 右侧：已连接 → schema 浏览；否则空状态 */}
      <section className="min-w-0 flex-1">
        {showingSession && openConn ? (
          <SchemaBrowser connection={openConn} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            选择左侧连接（双击或右键连接），或点「+ 新建」创建一个。
          </div>
        )}
      </section>
    </main>
  );
}
