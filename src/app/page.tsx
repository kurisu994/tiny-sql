"use client";

import { useEffect, useState } from "react";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { ConnectionDialogs } from "@/components/connection-dialogs";
import { ConnectionForm } from "@/components/connection-form";
import { ContextMenu, type ContextMenuItem } from "@/components/context-menu";
import { SchemaBrowser } from "@/components/schema-browser";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { StoredConnection } from "@/lib/tauri-api";
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
  // 右键菜单：记录位置与目标连接（null 表示未打开）
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    conn: StoredConnection;
  } | null>(null);

  const sessionStatus = useSessionStore((s) => s.status);
  const openId = useSessionStore((s) => s.openId);
  const activeConnection = useSessionStore((s) => s.activeConnection);
  const openConnection = useSessionStore((s) => s.open);
  const closeConnection = useSessionStore((s) => s.close);
  const confirm = useConfirmStore((s) => s.confirm);

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

  function openMenu(e: React.MouseEvent, c: StoredConnection) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, conn: c });
  }

  function buildMenuItems(c: StoredConnection): ContextMenuItem[] {
    const isOpen = openId === c.id;
    const connecting = sessionStatus === "connecting";
    return [
      {
        label: "连接",
        onClick: () => openSession(c),
        disabled: isOpen || connecting,
      },
      {
        label: "断开连接",
        onClick: () => closeConnection(),
        disabled: !isOpen,
      },
      {
        label: "进入命令列界面",
        onClick: () => openSession(c),
        disabled: connecting,
        divider: true,
      },
      {
        label: "编辑连接",
        onClick: () => openEdit(c),
        divider: true,
      },
      { label: "复制连接", onClick: () => duplicateConnection(c) },
      {
        label: "删除连接",
        onClick: () => deleteConnection(c),
        danger: true,
        divider: true,
      },
    ];
  }

  return (
    <main className="flex h-screen">
      <ConnectionDialogs />
      <ConfirmDialog />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.conn)}
          onClose={() => setMenu(null)}
        />
      )}

      {/* 新建 / 编辑连接弹窗 */}
      <Dialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
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
          <button
            onClick={startCreate}
            className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
          >
            + 新建
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && connections.length === 0 && (
            <p className="p-3 text-sm text-neutral-500">加载中…</p>
          )}
          {error && <p className="p-3 text-sm text-red-600">{error}</p>}
          {!loading && connections.length === 0 && !error && (
            <p className="p-3 text-sm text-neutral-500">还没有连接，点「+ 新建」开始。</p>
          )}
          <ul>
            {connections.map((c) => (
              <li
                key={c.id}
                className={`border-b border-neutral-100 dark:border-neutral-900 ${
                  selectedId === c.id || menu?.conn.id === c.id
                    ? "bg-blue-50 dark:bg-blue-950"
                    : ""
                }`}
              >
                <button
                  onClick={() => setSelectedId(c.id)}
                  onDoubleClick={() => openSession(c)}
                  onContextMenu={(e) => openMenu(e, c)}
                  className="flex w-full min-w-0 flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  title="双击连接，右键更多操作"
                >
                  <span className="truncate text-sm font-medium">
                    {c.name}
                    {openId === c.id && (
                      <span className="ml-1 text-green-600">●</span>
                    )}
                  </span>
                  <span className="truncate text-xs text-neutral-500">
                    {c.host}:{c.port}
                    {c.ssh.enabled ? ` · SSH×${c.ssh.hops.length}` : ""}
                  </span>
                </button>
              </li>
            ))}
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
