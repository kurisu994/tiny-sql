"use client";

import { useState } from "react";

import {
  connectionApi,
  translateError,
  type ConnectionInput,
  type SshConfig,
  type StoredConnection,
} from "@/lib/tauri-api";
import { useConnectionStore } from "@/stores/connection-store";

interface FormFields {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const EMPTY: FormFields = {
  name: "",
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",
  database: "",
};

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "err"; msg: string };

/**
 * 连接编辑表单 —— 新建（editing=null）或编辑已有连接。
 *
 * Week 2 仅直连字段，SSH 跳板配置留 Week 3。父组件用 key 强制重挂载以重置表单。
 */
export function ConnectionForm({
  editing,
  onDone,
}: {
  editing: StoredConnection | null;
  onDone: () => void;
}) {
  const { create, update, remove } = useConnectionStore();
  const [form, setForm] = useState<FormFields>(() =>
    editing
      ? {
          name: editing.name,
          host: editing.host,
          port: editing.port,
          user: editing.user,
          password: editing.password,
          database: editing.database,
        }
      : EMPTY,
  );
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);

  // 编辑时保留原 SSH 配置（Week 3 才在 UI 暴露）；新建为空
  const ssh: SshConfig = editing?.ssh ?? { enabled: false, hops: [] };

  const toInput = (): ConnectionInput => ({
    name: form.name,
    host: form.host,
    port: Number(form.port),
    user: form.user,
    password: form.password,
    database: form.database,
    ssh,
  });

  const set = <K extends keyof FormFields>(key: K, value: FormFields[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function onTest() {
    setTest({ kind: "testing" });
    try {
      await connectionApi.test(toInput());
      setTest({ kind: "ok" });
    } catch (e) {
      setTest({ kind: "err", msg: translateError(e) });
    }
  }

  async function onSave() {
    setSaving(true);
    setTest({ kind: "idle" });
    try {
      if (editing) {
        await update({ ...editing, ...toInput() });
      } else {
        await create(toInput());
      }
      onDone();
    } catch (e) {
      setTest({ kind: "err", msg: translateError(e) });
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (!editing) return;
    await remove(editing.id);
    onDone();
  }

  const canSave = form.name.trim() !== "" && form.host.trim() !== "";

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">
        {editing ? `编辑连接：${editing.name}` : "新建连接"}
      </h2>

      <div className="grid grid-cols-2 gap-3">
        <Field label="连接名称" value={form.name} onChange={(v) => set("name", v)} />
        <Field label="数据库（可空）" value={form.database} onChange={(v) => set("database", v)} />
        <Field label="主机" value={form.host} onChange={(v) => set("host", v)} />
        <Field
          label="端口"
          type="number"
          value={String(form.port)}
          onChange={(v) => set("port", Number(v))}
        />
        <Field label="用户" value={form.user} onChange={(v) => set("user", v)} />
        <Field
          label="密码"
          type="password"
          value={form.password}
          onChange={(v) => set("password", v)}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onTest}
          disabled={test.kind === "testing"}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          {test.kind === "testing" ? "测试中…" : "测试连接"}
        </button>
        <button
          onClick={onSave}
          disabled={!canSave || saving}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {editing && (
          <button
            onClick={onDelete}
            className="ml-auto rounded-md px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
          >
            删除
          </button>
        )}
      </div>

      {test.kind === "ok" && (
        <p className="rounded-md bg-green-100 px-3 py-2 text-sm text-green-800 dark:bg-green-950 dark:text-green-300">
          ✓ 连接成功
        </p>
      )}
      {test.kind === "err" && (
        <p className="rounded-md bg-red-100 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-300">
          ✗ {test.msg}
        </p>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900"
      />
    </label>
  );
}
