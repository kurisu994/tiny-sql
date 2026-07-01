"use client";

import { useState } from "react";

import { EyeIcon, EyeOffIcon } from "@/components/icons";
import {
  connectionApi,
  translateError,
  type AdvancedConfig,
  type ConnectionInput,
  type SslConfig,
  type SslMode,
  type SshConfig,
  type SshHopConfig,
  type StoredConnection,
} from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { useConfirmStore } from "@/stores/confirm-store";
import { useConnectionStore } from "@/stores/connection-store";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

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

const DEFAULT_SSH: SshConfig = { enabled: false, hops: [] };

const DEFAULT_SSL: SslConfig = {
  mode: "disabled",
  caPath: "",
  clientCertPath: "",
  clientKeyPath: "",
};

const DEFAULT_ADVANCED: AdvancedConfig = {
  keepAliveEnabled: false,
  keepAliveIntervalSeconds: 240,
  connectTimeoutEnabled: true,
  connectTimeoutSeconds: 30,
  readTimeoutEnabled: false,
  readTimeoutSeconds: 30,
  writeTimeoutEnabled: true,
  writeTimeoutSeconds: 30,
  compressionEnabled: false,
  autoConnect: false,
};

const SSL_MODE_OPTIONS: { value: SslMode; label: string }[] = [
  { value: "disabled", label: "禁用" },
  { value: "preferred", label: "优先使用" },
  { value: "required", label: "必须使用" },
  { value: "verify_ca", label: "验证 CA" },
  { value: "verify_identity", label: "验证主机名" },
];

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "err"; msg: string };

/**
 * 连接编辑表单 —— 新建（editing=null）或编辑已有连接。
 *
 * 父组件用 key 强制重挂载以重置表单。
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
    () => editing?.ssh ?? DEFAULT_SSH,
  );
  const [ssl, setSsl] = useState<SslConfig>(
    () => ({ ...DEFAULT_SSL, ...editing?.ssl }),
  );
  const [advanced, setAdvanced] = useState<AdvancedConfig>(
    () => ({ ...DEFAULT_ADVANCED, ...editing?.advanced }),
  );

  const toInput = (): ConnectionInput => ({
    name: form.name,
    host: form.host,
    port: Number(form.port),
    user: form.user,
    password: form.password,
    database: form.database,
    ssh,
    ssl,
    advanced,
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

      <Tabs defaultValue="general">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="general">常规</TabsTrigger>
          <TabsTrigger value="ssh">SSH</TabsTrigger>
          <TabsTrigger value="ssl">SSL</TabsTrigger>
          <TabsTrigger value="advanced">高级</TabsTrigger>
        </TabsList>

        <TabsContent value="general">
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="连接名称"
              value={form.name}
              onChange={(v) => set("name", v)}
            />
            <Field
              label="数据库（可空）"
              value={form.database}
              onChange={(v) => set("database", v)}
            />
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
        </TabsContent>

        <TabsContent value="ssh">
          <SshSection ssh={ssh} onChange={setSsh} />
        </TabsContent>

        <TabsContent value="ssl">
          <SslSection ssl={ssl} onChange={setSsl} />
        </TabsContent>

        <TabsContent value="advanced">
          <AdvancedSection advanced={advanced} onChange={setAdvanced} />
        </TabsContent>
      </Tabs>

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onTest}
          disabled={test.kind === "testing"}
        >
          {test.kind === "testing" ? "测试中…" : "测试连接"}
        </Button>
        <Button
          type="button"
          onClick={onSave}
          disabled={!canSave || saving}
        >
          {saving ? "保存中…" : "保存"}
        </Button>
        {editing && (
          <Button
            type="button"
            variant="destructive"
            onClick={onDelete}
            className="ml-auto"
          >
            删除
          </Button>
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
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  disabled?: boolean;
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
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          // 关闭 WKWebView 的自动首字母大写 / 纠错 / 自动填充 / 拼写检查
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "w-full rounded-md border border-neutral-300 px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-900",
            isPassword && "pr-9",
          )}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            tabIndex={-1}
            title={show ? "隐藏" : "显示"}
            disabled={disabled}
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

/** SSL 配置区 —— v0.1 默认禁用；启用后传给 sqlx MySQL SSL mode。 */
function SslSection({
  ssl,
  onChange,
}: {
  ssl: SslConfig;
  onChange: (ssl: SslConfig) => void;
}) {
  const enabled = ssl.mode !== "disabled";
  const set = <K extends keyof SslConfig>(key: K, value: SslConfig[K]) =>
    onChange({ ...ssl, [key]: value });

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-neutral-600 dark:text-neutral-400">SSL 模式</span>
        <select
          value={ssl.mode}
          onChange={(e) => set("mode", e.target.value as SslMode)}
          className="rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900"
        >
          {SSL_MODE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field
          label="CA 证书路径"
          value={ssl.caPath}
          disabled={!enabled}
          onChange={(v) => set("caPath", v)}
        />
        <Field
          label="客户端证书路径"
          value={ssl.clientCertPath}
          disabled={!enabled}
          onChange={(v) => set("clientCertPath", v)}
        />
        <Field
          label="客户端私钥路径"
          value={ssl.clientKeyPath}
          disabled={!enabled}
          onChange={(v) => set("clientKeyPath", v)}
        />
      </div>
    </div>
  );
}

/** 高级连接参数区 —— 保存截图中的 MySQL 客户端常见连接选项。 */
function AdvancedSection({
  advanced,
  onChange,
}: {
  advanced: AdvancedConfig;
  onChange: (advanced: AdvancedConfig) => void;
}) {
  const set = <K extends keyof AdvancedConfig>(
    key: K,
    value: AdvancedConfig[K],
  ) => onChange({ ...advanced, [key]: value });

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <AdvancedNumberOption
        label="保持连接间隔（秒）"
        enabled={advanced.keepAliveEnabled}
        value={advanced.keepAliveIntervalSeconds}
        onEnabledChange={(checked) => set("keepAliveEnabled", checked)}
        onValueChange={(value) => set("keepAliveIntervalSeconds", value)}
      />
      <AdvancedNumberOption
        label="连接超时（秒）"
        enabled={advanced.connectTimeoutEnabled}
        value={advanced.connectTimeoutSeconds}
        onEnabledChange={(checked) => set("connectTimeoutEnabled", checked)}
        onValueChange={(value) => set("connectTimeoutSeconds", value)}
      />
      <AdvancedNumberOption
        label="读取超时（秒）"
        enabled={advanced.readTimeoutEnabled}
        value={advanced.readTimeoutSeconds}
        onEnabledChange={(checked) => set("readTimeoutEnabled", checked)}
        onValueChange={(value) => set("readTimeoutSeconds", value)}
      />
      <AdvancedNumberOption
        label="写入超时（秒）"
        enabled={advanced.writeTimeoutEnabled}
        value={advanced.writeTimeoutSeconds}
        onEnabledChange={(checked) => set("writeTimeoutEnabled", checked)}
        onValueChange={(value) => set("writeTimeoutSeconds", value)}
      />
      <AdvancedToggle
        label="使用压缩"
        checked={advanced.compressionEnabled}
        onChange={(checked) => set("compressionEnabled", checked)}
      />
      <AdvancedToggle
        label="自动连接"
        checked={advanced.autoConnect}
        onChange={(checked) => set("autoConnect", checked)}
      />
    </div>
  );
}

function AdvancedNumberOption({
  label,
  enabled,
  value,
  onEnabledChange,
  onValueChange,
}: {
  label: string;
  enabled: boolean;
  value: number;
  onEnabledChange: (checked: boolean) => void;
  onValueChange: (value: number) => void;
}) {
  return (
    <label className="grid grid-cols-[1rem_minmax(0,1fr)_8rem] items-center gap-3 text-sm">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onEnabledChange(e.target.checked)}
        className="size-4 accent-primary"
      />
      <span
        className={cn(
          "font-medium",
          !enabled && "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <input
        type="number"
        min={1}
        value={value}
        disabled={!enabled}
        onChange={(e) => onValueChange(normalizePositiveInt(e.target.value, value))}
        className="h-8 rounded-md border border-neutral-300 px-2 text-right disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-900"
      />
    </label>
  );
}

function AdvancedToggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="grid grid-cols-[1rem_minmax(0,1fr)] items-center gap-3 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-primary"
      />
      <span
        className={cn(
          "font-medium",
          !checked && "text-muted-foreground",
        )}
      >
        {label}
      </span>
    </label>
  );
}

function normalizePositiveInt(value: string, fallback: number): number {
  const next = Number(value);
  if (!Number.isFinite(next) || next < 1) return fallback;
  return Math.floor(next);
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
