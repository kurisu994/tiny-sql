"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  buildCreateUserSql,
  buildDropUserSql,
  buildGrantSql,
  buildRevokeSql,
} from "@/lib/privilege";
import {
  dbApi,
  translateError,
  type PrivilegeAccount,
  type PrivilegeListResult,
} from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";
import { isReadOnly } from "@/lib/connection-meta";
import { useSessionStore } from "@/stores/session-store";

/**
 * 库内权限（FR-262）：MySQL 可预览执行 GRANT；PG 只读角色列表。
 */
export function PrivilegeView() {
  const openId = useSessionStore((s) => s.openId);
  const driver = useSessionStore((s) => s.activeConnection?.driver ?? "mysql");
  const appReadOnly = isReadOnly(useSessionStore((s) => s.activeConnection));
  const confirm = useConfirmStore((s) => s.confirm);
  const [list, setList] = useState<PrivilegeListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [grants, setGrants] = useState<string[]>([]);
  const [selected, setSelected] = useState<PrivilegeAccount | null>(null);
  const [user, setUser] = useState("app");
  const [host, setHost] = useState("%");
  const [password, setPassword] = useState("");
  const [privilege, setPrivilege] = useState("SELECT");
  const [database, setDatabase] = useState("*");

  async function reload() {
    if (!openId) return;
    setError(null);
    try {
      setList(await dbApi.listAccounts(openId));
    } catch (e) {
      setList(null);
      setError(translateError(e));
    }
  }

  useEffect(() => {
    void reload();
  }, [openId]);

  async function openGrants(account: PrivilegeAccount) {
    if (!openId) return;
    setSelected(account);
    setUser(account.name);
    setHost(account.host ?? "%");
    if (driver !== "mysql") {
      setGrants([]);
      return;
    }
    try {
      setGrants(await dbApi.showGrants(openId, account.name, account.host));
    } catch (e) {
      setError(translateError(e));
    }
  }

  async function runSql(sql: string | null, title: string) {
    if (appReadOnly) {
      setError("该连接已设为应用只读，已拒绝权限变更。");
      return;
    }
    if (!sql || !openId) {
      setError("参数不合法");
      return;
    }
    const ok = await confirm({
      title,
      message: sql,
      confirmText: "执行",
      danger: sql.startsWith("DROP") || sql.startsWith("REVOKE"),
    });
    if (!ok) return;
    try {
      await dbApi.query(openId, sql, { allowWrite: true });
      await reload();
      if (selected && driver === "mysql") {
        setGrants(await dbApi.showGrants(openId, selected.name, selected.host));
      }
    } catch (e) {
      setError(translateError(e));
    }
  }

  if (!openId) {
    return <p className="p-3 text-xs text-neutral-500">请先打开连接。</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3 text-xs">
      {error && <p className="text-red-600">{error}</p>}
      {list?.readOnly && (
        <p className="rounded border border-amber-200 px-2 py-1 text-amber-700 dark:border-amber-900 dark:text-amber-300">
          PostgreSQL 本版只读列出角色，变更请回 SQL 编辑器。
        </p>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-[18rem_1fr] gap-3">
        <ul className="overflow-auto rounded border border-neutral-200 dark:border-neutral-800">
          {(list?.accounts ?? []).map((account) => (
            <li key={`${account.name}@${account.host ?? ""}`}>
              <button
                type="button"
                onClick={() => void openGrants(account)}
                className="w-full px-2 py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                {account.name}
                {account.host ? `@${account.host}` : ""}
                {!account.canLogin ? "（不可登录）" : ""}
              </button>
            </li>
          ))}
        </ul>
        <pre className="overflow-auto rounded border border-neutral-200 bg-neutral-50 p-2 font-mono dark:border-neutral-800 dark:bg-neutral-950">
          {grants.join("\n") || "选择账号查看 SHOW GRANTS"}
        </pre>
      </div>
      {driver === "mysql" && !list?.readOnly && !appReadOnly && (
        <div className="flex flex-wrap items-end gap-2 rounded border border-neutral-200 p-2 dark:border-neutral-800">
          <label>
            用户
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              className="ml-1 h-7 rounded border px-1 font-mono dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label>
            主机
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="ml-1 h-7 w-24 rounded border px-1 font-mono dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="ml-1 h-7 rounded border px-1 dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <select
            value={privilege}
            onChange={(e) => setPrivilege(e.target.value)}
            className="h-7 rounded border dark:border-neutral-700 dark:bg-neutral-950"
          >
            {["SELECT", "INSERT", "UPDATE", "DELETE", "ALL PRIVILEGES"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <label>
            库
            <input
              value={database}
              onChange={(e) => setDatabase(e.target.value)}
              className="ml-1 h-7 w-24 rounded border px-1 font-mono dark:border-neutral-700 dark:bg-neutral-950"
            />
          </label>
          <Button
            type="button"
            size="sm"
            onClick={() => void runSql(buildCreateUserSql(user, host, password), "创建用户")}
          >
            创建用户
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void runSql(buildGrantSql(user, host, privilege, database), "授权")}
          >
            GRANT
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void runSql(buildRevokeSql(user, host, privilege, database), "收回权限")}
          >
            REVOKE
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => void runSql(buildDropUserSql(user, host), "删除用户")}
          >
            删除用户
          </Button>
        </div>
      )}
    </div>
  );
}
