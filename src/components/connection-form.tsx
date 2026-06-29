"use client";

import { useState } from "react";

import { EyeIcon, EyeOffIcon } from "@/components/icons";
import {
  connectionApi,
  translateError,
  type ConnectionInput,
  type SshConfig,
  type SshHopConfig,
  type StoredConnection,
} from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";
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
  const confirm = useConfirmStore((s) => s.confirm);
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
  const [ssh, setSsh] = useState<SshConfig>(
    () => editing?.ssh ?? { enabled: false, hops: [] },
  );

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
    const ok = await confirm({
      title: "删除连接",
      message: `确定删除连接「${editing.name}」？此操作不可撤销。`,
      confirmText: "删除",
      danger: true,
    });
    if (!ok) return;
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

      <SshSection ssh={ssh} onChange={setSsh} />

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
  const isPassword = type === "password";
  const [show, setShow] = useState(false);
  // 密码框可切换明文；其余沿用传入 type
  const inputType = isPassword ? (show ? "text" : "password") : type;
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-neutral-600 dark:text-neutral-400">{label}</span>
      <div className="relative">
        <input
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          // 关闭 WKWebView 的自动首字母大写 / 纠错 / 自动填充 / 拼写检查
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className={`w-full rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900 ${
            isPassword ? "pr-9" : ""
          }`}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            tabIndex={-1}
            title={show ? "隐藏" : "显示"}
            className="absolute inset-y-0 right-0 flex items-center px-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          >
            {show ? (
              <EyeOffIcon className="h-4 w-4" />
            ) : (
              <EyeIcon className="h-4 w-4" />
            )}
          </button>
        )}
      </div>
    </label>
  );
}

const EMPTY_HOP: SshHopConfig = {
  host: "",
  port: 22,
  username: "",
  authType: "password",
  password: "",
  privateKeyPath: "",
};

/**
 * SSH 跳板配置区 —— 开关 + N 跳数组编辑器（增删 / 调序）。
 *
 * hops 顺序即链路顺序：第 1 跳本地直连，最后一跳对目标库开转发。
 * passphrase 不在此收集（仅会话内存，连接时按需弹窗）。
 */
function SshSection({
  ssh,
  onChange,
}: {
  ssh: SshConfig;
  onChange: (ssh: SshConfig) => void;
}) {
  const setHop = (i: number, patch: Partial<SshHopConfig>) =>
    onChange({
      ...ssh,
      hops: ssh.hops.map((h, idx) => (idx === i ? { ...h, ...patch } : h)),
    });

  const addHop = () =>
    onChange({ ...ssh, hops: [...ssh.hops, { ...EMPTY_HOP }] });

  const removeHop = (i: number) =>
    onChange({ ...ssh, hops: ssh.hops.filter((_, idx) => idx !== i) });

  const moveHop = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= ssh.hops.length) return;
    const hops = [...ssh.hops];
    [hops[i], hops[j]] = [hops[j], hops[i]];
    onChange({ ...ssh, hops });
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={ssh.enabled}
          onChange={(e) => onChange({ ...ssh, enabled: e.target.checked })}
        />
        通过 SSH 跳板连接
      </label>

      {ssh.enabled && (
        <div className="flex flex-col gap-3">
          {ssh.hops.length === 0 && (
            <p className="text-xs text-neutral-500">
              还没有跳板，点下方「+ 添加跳板」。第 1 跳为本地直连的堡垒机。
            </p>
          )}
          {ssh.hops.map((hop, i) => (
            <HopEditor
              key={i}
              index={i}
              total={ssh.hops.length}
              hop={hop}
              onChange={(patch) => setHop(i, patch)}
              onRemove={() => removeHop(i)}
              onMove={(dir) => moveHop(i, dir)}
            />
          ))}
          <button
            onClick={addHop}
            className="self-start rounded-md border border-dashed border-neutral-400 px-3 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
          >
            + 添加跳板
          </button>
          <p className="text-xs text-neutral-500">
            私钥 passphrase 仅在连接时按需输入，不会保存。
          </p>
        </div>
      )}
    </div>
  );
}

/** 单跳编辑器 */
function HopEditor({
  index,
  total,
  hop,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  total: number;
  hop: SshHopConfig;
  onChange: (patch: Partial<SshHopConfig>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md bg-neutral-50 p-2 dark:bg-neutral-900">
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        <span className="font-medium">第 {index + 1} 跳</span>
        <button
          onClick={() => onMove(-1)}
          disabled={index === 0}
          className="rounded px-1 hover:bg-neutral-200 disabled:opacity-30 dark:hover:bg-neutral-700"
          title="上移"
        >
          ↑
        </button>
        <button
          onClick={() => onMove(1)}
          disabled={index === total - 1}
          className="rounded px-1 hover:bg-neutral-200 disabled:opacity-30 dark:hover:bg-neutral-700"
          title="下移"
        >
          ↓
        </button>
        <button
          onClick={onRemove}
          className="ml-auto rounded px-1 text-red-600 hover:bg-red-100 dark:hover:bg-red-950"
          title="删除该跳"
        >
          ✕
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="主机" value={hop.host} onChange={(v) => onChange({ host: v })} />
        <Field
          label="端口"
          type="number"
          value={String(hop.port)}
          onChange={(v) => onChange({ port: Number(v) })}
        />
        <Field
          label="用户"
          value={hop.username}
          onChange={(v) => onChange({ username: v })}
        />
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">认证方式</span>
          <select
            value={hop.authType}
            onChange={(e) =>
              onChange({ authType: e.target.value as SshHopConfig["authType"] })
            }
            className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900"
          >
            <option value="password">密码</option>
            <option value="privateKey">私钥</option>
          </select>
        </label>
        {hop.authType === "password" ? (
          <Field
            label="SSH 密码"
            type="password"
            value={hop.password ?? ""}
            onChange={(v) => onChange({ password: v })}
          />
        ) : (
          <Field
            label="私钥路径（支持 ~）"
            value={hop.privateKeyPath ?? ""}
            onChange={(v) => onChange({ privateKeyPath: v })}
          />
        )}
      </div>
    </div>
  );
}
