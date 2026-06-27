"use client";

import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";

// vertical slice：错误 i18n key → 中文。Week 2-3 接 i18next 后替换
const ERROR_ZH: Record<string, string> = {
  "error.ssh.no_hops": "未配置 SSH 跳板",
  "error.ssh.connect_failed": "SSH 连接失败",
  "error.ssh.auth_failed": "SSH 认证失败",
  "error.ssh.invalid_passphrase": "私钥 passphrase 错误",
  "error.ssh.key_not_found": "私钥文件不存在",
  "error.ssh.channel_open_failed": "SSH 通道开启失败",
  "error.ssh.local_listen_failed": "本地端口监听失败",
  "error.ssh.invalid_auth_type": "SSH 认证方式非法",
  "error.driver.connect_failed": "MySQL 连接失败",
  "error.driver.query_failed": "SQL 执行失败",
};

interface HopInput {
  host: string;
  port: number;
  username: string;
  auth_type: "password";
  password: string;
}

interface ConnectInput {
  hops: HopInput[];
  mysql_host: string;
  mysql_port: number;
  user: string;
  password: string;
  database: string;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; msg: string }
  | { kind: "err"; msg: string };

export default function Home() {
  const [useSsh, setUseSsh] = useState(false);
  const [ssh, setSsh] = useState({ host: "", port: 22, username: "", password: "" });
  const [mysql, setMysql] = useState({
    host: "127.0.0.1",
    port: 3306,
    user: "root",
    password: "",
    database: "",
  });
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function onTest() {
    setStatus({ kind: "loading" });
    const input: ConnectInput = {
      hops: useSsh
        ? [
            {
              host: ssh.host,
              port: Number(ssh.port),
              username: ssh.username,
              auth_type: "password",
              password: ssh.password,
            },
          ]
        : [],
      mysql_host: mysql.host,
      mysql_port: Number(mysql.port),
      user: mysql.user,
      password: mysql.password,
      database: mysql.database,
    };
    try {
      const res = await invoke<string>("test_select_1", { input });
      setStatus({ kind: "ok", msg: res });
    } catch (e) {
      const key = typeof e === "string" ? e : String(e);
      setStatus({ kind: "err", msg: ERROR_ZH[key] ?? key });
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">tiny-sql</h1>
        <p className="text-sm text-neutral-500">
          vertical slice：配置连接 → 跑 <code>SELECT 1</code> → 验证整条链路
        </p>
      </header>

      <section className="flex flex-col gap-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={useSsh}
            onChange={(e) => setUseSsh(e.target.checked)}
          />
          通过 SSH 跳板连接（单跳，密码认证）
        </label>

        {useSsh && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="SSH 主机" value={ssh.host} onChange={(v) => setSsh({ ...ssh, host: v })} />
            <Field label="SSH 端口" value={String(ssh.port)} onChange={(v) => setSsh({ ...ssh, port: Number(v) })} />
            <Field label="SSH 用户" value={ssh.username} onChange={(v) => setSsh({ ...ssh, username: v })} />
            <Field label="SSH 密码" type="password" value={ssh.password} onChange={(v) => setSsh({ ...ssh, password: v })} />
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-3 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
        <Field label="MySQL 主机" value={mysql.host} onChange={(v) => setMysql({ ...mysql, host: v })} />
        <Field label="MySQL 端口" value={String(mysql.port)} onChange={(v) => setMysql({ ...mysql, port: Number(v) })} />
        <Field label="用户" value={mysql.user} onChange={(v) => setMysql({ ...mysql, user: v })} />
        <Field label="密码" type="password" value={mysql.password} onChange={(v) => setMysql({ ...mysql, password: v })} />
        <Field label="数据库（可空）" value={mysql.database} onChange={(v) => setMysql({ ...mysql, database: v })} />
      </section>

      <button
        onClick={onTest}
        disabled={status.kind === "loading"}
        className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {status.kind === "loading" ? "连接中…" : "测试连接 (SELECT 1)"}
      </button>

      {status.kind === "ok" && (
        <p className="rounded-md bg-green-100 px-4 py-2 text-green-800 dark:bg-green-950 dark:text-green-300">
          ✓ 连接成功：{status.msg}
        </p>
      )}
      {status.kind === "err" && (
        <p className="rounded-md bg-red-100 px-4 py-2 text-red-800 dark:bg-red-950 dark:text-red-300">
          ✗ {status.msg}
        </p>
      )}
    </main>
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
