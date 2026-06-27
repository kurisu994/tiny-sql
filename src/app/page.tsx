"use client";

import { useEffect, useState } from "react";

import { ConnectionForm } from "@/components/connection-form";
import { useConnectionStore } from "@/stores/connection-store";

export default function Home() {
  const { connections, loading, error, load } = useConnectionStore();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    load();
  }, [load]);

  const selected = connections.find((c) => c.id === selectedId) ?? null;
  const showForm = creating || selected !== null;

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
      {/* 左侧连接列表 */}
      <aside className="flex w-72 flex-col border-r border-neutral-200 dark:border-neutral-800">
        <div className="flex items-center justify-between border-b border-neutral-200 p-3 dark:border-neutral-800">
          <h1 className="font-semibold">tiny-sql</h1>
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
              <li key={c.id}>
                <button
                  onClick={() => selectConnection(c.id)}
                  className={`flex w-full flex-col items-start gap-0.5 border-b border-neutral-100 px-3 py-2 text-left hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900 ${
                    selectedId === c.id ? "bg-blue-50 dark:bg-blue-950" : ""
                  }`}
                >
                  <span className="text-sm font-medium">{c.name}</span>
                  <span className="text-xs text-neutral-500">
                    {c.host}:{c.port}
                    {c.ssh.enabled ? " · SSH" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* 右侧表单 / 空状态 */}
      <section className="flex-1 overflow-y-auto p-6">
        {showForm ? (
          <ConnectionForm
            key={selected?.id ?? "new"}
            editing={selected}
            onDone={onFormDone}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            选择左侧连接，或点「+ 新建」创建一个。
          </div>
        )}
      </section>
    </main>
  );
}
