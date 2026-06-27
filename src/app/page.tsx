"use client";

import { useEffect, useState } from "react";

import { ConnectionDialogs } from "@/components/connection-dialogs";
import { ConnectionForm } from "@/components/connection-form";
import { SchemaBrowser } from "@/components/schema-browser";
import { useConnectionStore } from "@/stores/connection-store";
import { useSessionStore } from "@/stores/session-store";

export default function Home() {
  const { connections, loading, error, load } = useConnectionStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const sessionStatus = useSessionStore((s) => s.status);
  const openId = useSessionStore((s) => s.openId);
  const activeConnection = useSessionStore((s) => s.activeConnection);
  const openConnection = useSessionStore((s) => s.open);

  useEffect(() => {
    load();
  }, [load]);

  const selected = connections.find((c) => c.id === selectedId) ?? null;
  const showForm = creating || selected !== null;
  const showingSession =
    activeConnection !== null &&
    (sessionStatus === "connecting" ||
      sessionStatus === "connected" ||
      sessionStatus === "error");
  const openConn =
    activeConnection ?? connections.find((c) => c.id === openId) ?? null;

  function startCreate() {
    setCreating(true);
    setSelectedId(null);
  }

  function selectConnection(id: string) {
    setSelectedId(id);
    setCreating(false);
  }

  function onFormDone() {
    setCreating(false);
    setSelectedId(null);
  }

  return (
    <main className="flex h-screen">
      <ConnectionDialogs />

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
                className={`flex items-center gap-1 border-b border-neutral-100 pr-2 dark:border-neutral-900 ${
                  selectedId === c.id ? "bg-blue-50 dark:bg-blue-950" : ""
                }`}
              >
                <button
                  onClick={() => selectConnection(c.id)}
                  className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
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
                <button
                  onClick={() => openConnection(c.id, undefined, c)}
                  disabled={sessionStatus === "connecting"}
                  className="shrink-0 rounded border border-neutral-300 px-1.5 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
                  title="连接并浏览"
                >
                  连接
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* 右侧：已连接 → schema 浏览；否则编辑表单 / 空状态 */}
      <section className="min-w-0 flex-1">
        {showingSession && openConn ? (
          <SchemaBrowser connection={openConn} />
        ) : showForm ? (
          <div className="h-full overflow-y-auto p-6">
            <ConnectionForm
              key={selected?.id ?? "new"}
              editing={selected}
              onDone={onFormDone}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            选择左侧连接，或点「+ 新建」创建一个。
          </div>
        )}
      </section>
    </main>
  );
}
