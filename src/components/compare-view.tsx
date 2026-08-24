"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  diffSchemas,
  formatDiffReport,
  tableCounts,
  type SchemaDiffResult,
  type SchemaSnapshot,
  type TableDiff,
} from "@/lib/schema-diff";
import { loadSchemaSnapshot } from "@/lib/schema-snapshot";
import { buildSyncStatements, joinSyncSql, type SyncDirection } from "@/lib/schema-sync";
import { dbApi, sqlFileApi, translateError, type DatabaseMeta, type SchemaMeta } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { useConfirmStore } from "@/stores/confirm-store";
import { useSessionStore, type OpenSessionInfo } from "@/stores/session-store";

interface SidePick {
  connectionId: string;
  database: string;
  schema: string;
}

const emptyPick: SidePick = { connectionId: "", database: "", schema: "" };

/**
 * 双连接结构对比工作台（FR-220 / FR-261）。
 * 只使用已经打开的连接，不会偷偷 connection_open。
 */
export function CompareView() {
  const openSessions = useSessionStore((s) => s.openSessions);
  const confirm = useConfirmStore((s) => s.confirm);
  const [left, setLeft] = useState<SidePick>(emptyPick);
  const [right, setRight] = useState<SidePick>(emptyPick);
  const [leftDbs, setLeftDbs] = useState<DatabaseMeta[]>([]);
  const [rightDbs, setRightDbs] = useState<DatabaseMeta[]>([]);
  const [leftSchemas, setLeftSchemas] = useState<SchemaMeta[]>([]);
  const [rightSchemas, setRightSchemas] = useState<SchemaMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<SchemaDiffResult | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [hideEqual, setHideEqual] = useState(true);
  const [direction, setDirection] = useState<SyncDirection>("toRight");
  const compareGen = useRef(0);

  const leftSession = openSessions.find((item) => item.id === left.connectionId) ?? null;
  const rightSession = openSessions.find((item) => item.id === right.connectionId) ?? null;

  useEffect(() => {
    if (!left.connectionId) {
      setLeftDbs([]);
      return;
    }
    void dbApi.listDatabases(left.connectionId).then(setLeftDbs).catch(() => setLeftDbs([]));
  }, [left.connectionId]);

  useEffect(() => {
    if (!right.connectionId) {
      setRightDbs([]);
      return;
    }
    void dbApi.listDatabases(right.connectionId).then(setRightDbs).catch(() => setRightDbs([]));
  }, [right.connectionId]);

  useEffect(() => {
    const session = leftSession;
    if (!session || session.connection.driver !== "postgresql" || !left.database) {
      setLeftSchemas([]);
      return;
    }
    void dbApi
      .listSchemas(left.connectionId, left.database)
      .then(setLeftSchemas)
      .catch(() => setLeftSchemas([]));
  }, [left.connectionId, left.database, leftSession]);

  useEffect(() => {
    const session = rightSession;
    if (!session || session.connection.driver !== "postgresql" || !right.database) {
      setRightSchemas([]);
      return;
    }
    void dbApi
      .listSchemas(right.connectionId, right.database)
      .then(setRightSchemas)
      .catch(() => setRightSchemas([]));
  }, [right.connectionId, right.database, rightSession]);

  async function runCompare() {
    if (!leftSession || !rightSession || !left.database || !right.database) {
      setError("请选择两条已打开连接及其 database");
      return;
    }
    const token = ++compareGen.current;
    setLoading(true);
    setError(null);
    setDiff(null);
    setSelectedTable(null);
    try {
      const [leftSnap, rightSnap] = await Promise.all([
        loadSchemaSnapshot({
          connectionId: leftSession.id,
          connectionName: leftSession.connection.name,
          driver: leftSession.connection.driver,
          database: left.database,
          schema:
            leftSession.connection.driver === "postgresql"
              ? left.schema || "public"
              : null,
        }).catch((e) => {
          throw new Error(`左侧：${translateError(e)}`);
        }),
        loadSchemaSnapshot({
          connectionId: rightSession.id,
          connectionName: rightSession.connection.name,
          driver: rightSession.connection.driver,
          database: right.database,
          schema:
            rightSession.connection.driver === "postgresql"
              ? right.schema || "public"
              : null,
        }).catch((e) => {
          throw new Error(`右侧：${translateError(e)}`);
        }),
      ]);
      if (token !== compareGen.current) return;
      setDiff(diffSchemas(leftSnap, rightSnap));
    } catch (e) {
      if (token !== compareGen.current) return;
      setError(e instanceof Error ? e.message : translateError(e));
    } finally {
      if (token === compareGen.current) setLoading(false);
    }
  }

  function cancel() {
    compareGen.current += 1;
    setLoading(false);
  }

  const counts = diff ? tableCounts(diff) : null;
  const visibleTables = useMemo(() => {
    if (!diff) return [];
    return hideEqual ? diff.tables.filter((table) => table.status !== "equal") : diff.tables;
  }, [diff, hideEqual]);
  const selected: TableDiff | undefined = diff?.tables.find((table) => table.name === selectedTable);

  const sync = diff ? buildSyncStatements(diff, direction) : null;
  const target = direction === "toRight" ? diff?.right : diff?.left;

  async function exportReport() {
    if (!diff) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: "导出对比报告",
      defaultPath: "schema-diff.md",
      filters: [{ name: "Markdown", extensions: ["md", "txt"] }],
    });
    if (typeof path !== "string") return;
    await sqlFileApi.write(path, formatDiffReport(diff));
  }

  async function saveScript() {
    if (!sync || sync.error || sync.statements.length === 0) return;
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: "保存同步 SQL",
      defaultPath: "schema-sync.sql",
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (typeof path !== "string") return;
    await sqlFileApi.write(path, joinSyncSql(sync.statements));
  }

  async function executeScript() {
    if (!sync || sync.error || !target || sync.statements.length === 0) return;
    const sql = joinSyncSql(sync.statements);
    const ok = await confirm({
      title: "在目标连接执行同步脚本",
      message: `目标：${target.connectionName} / ${target.database}\nDDL 失败通常无法整体回滚。\n\n${sql}`,
      confirmText: "执行",
      danger: sync.statements.some((item) => item.dangerous),
    });
    if (!ok) return;
    try {
      const result = await dbApi.queryMany(target.connectionId, sql, {
        allowWrite: true,
        schema: target.schema,
      });
      const failed = result.statements.findIndex((item) => item.outcome.status === "error");
      if (failed >= 0) {
        const item = result.statements[failed];
        const key =
          item.outcome.status === "error" ? item.outcome.key : "error.driver.query_failed";
        setError(`第 ${failed + 1} 条已失败：${translateError(key)}（此前语句可能已生效）`);
      } else {
        setError(null);
      }
      await runCompare();
    } catch (e) {
      setError(translateError(e));
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden p-3 text-xs">
      {openSessions.length < 2 && (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          请先在左侧列表双击打开两条连接（切换焦点不会断开旧连接），再来对比。
        </p>
      )}
      <div className="grid shrink-0 grid-cols-2 gap-3">
        <SidePicker
          label="左侧（参考）"
          pick={left}
          sessions={openSessions}
          databases={leftDbs}
          schemas={leftSchemas}
          onChange={setLeft}
        />
        <SidePicker
          label="右侧（对照）"
          pick={right}
          sessions={openSessions}
          databases={rightDbs}
          schemas={rightSchemas}
          onChange={setRight}
        />
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={loading} onClick={() => void runCompare()}>
          {loading ? "对比中…" : "开始对比"}
        </Button>
        {loading && (
          <Button type="button" size="sm" variant="outline" onClick={cancel}>
            取消
          </Button>
        )}
        {diff && (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => void exportReport()}>
              导出报告
            </Button>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={hideEqual}
                onChange={(e) => setHideEqual(e.target.checked)}
              />
              隐藏一致表
            </label>
            {counts && (
              <span className="text-neutral-500">
                仅左 {counts.leftOnly} · 仅右 {counts.rightOnly} · 变更 {counts.changed} · 一致{" "}
                {counts.equal}
              </span>
            )}
            <span className="text-neutral-400">
              快照 {diff.left.capturedAt} / {diff.right.capturedAt}
            </span>
          </>
        )}
      </div>
      {diff?.crossDriver && (
        <p className="rounded border border-amber-200 px-3 py-1.5 text-amber-700 dark:border-amber-900 dark:text-amber-300">
          方言不同，仅供人工阅读，不能一键同步。
        </p>
      )}
      {error && <p className="text-red-600">{error}</p>}

      {diff && (
        <div className="grid min-h-0 flex-1 grid-cols-[16rem_1fr] gap-3">
          <ul className="min-h-0 overflow-auto rounded border border-neutral-200 dark:border-neutral-800">
            {visibleTables.map((table) => (
              <li key={table.name}>
                <button
                  type="button"
                  onClick={() => setSelectedTable(table.name)}
                  className={cn(
                    "flex w-full items-center justify-between px-2 py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900",
                    selectedTable === table.name && "bg-blue-50 dark:bg-blue-950",
                  )}
                >
                  <span className="truncate">{table.name}</span>
                  <span className="text-neutral-400">{statusLabel(table.status)}</span>
                </button>
              </li>
            ))}
            {visibleTables.length === 0 && (
              <li className="px-2 py-3 text-neutral-400">没有可见差异</li>
            )}
          </ul>
          <div className="min-h-0 overflow-auto rounded border border-neutral-200 p-2 dark:border-neutral-800">
            {selected ? (
              <TableDetail table={selected} />
            ) : (
              <p className="text-neutral-400">选择一张表查看列 / 索引 / 约束对照</p>
            )}
          </div>
        </div>
      )}

      {diff && (
        <div className="shrink-0 rounded border border-neutral-200 p-2 dark:border-neutral-800">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <span className="font-medium">结构同步脚本</span>
            <select
              value={direction}
              onChange={(e) => setDirection(e.target.value as SyncDirection)}
              className="h-7 rounded border border-neutral-300 bg-white px-1 dark:border-neutral-700 dark:bg-neutral-950"
            >
              <option value="toRight">把右侧改成与左侧一致</option>
              <option value="toLeft">把左侧改成与右侧一致</option>
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!sync || !!sync.error || sync.statements.length === 0}
              onClick={() => void saveScript()}
            >
              保存 SQL
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!sync || !!sync.error || sync.statements.length === 0 || !!diff.crossDriver}
              onClick={() => void executeScript()}
            >
              预览并执行
            </Button>
          </div>
          <pre className="max-h-40 overflow-auto bg-neutral-50 p-2 font-mono text-[11px] dark:bg-neutral-950">
            {sync?.error ??
              (sync && sync.statements.length > 0
                ? joinSyncSql(sync.statements)
                : "-- 没有可同步的结构变更")}
          </pre>
        </div>
      )}
    </div>
  );
}

function statusLabel(status: TableDiff["status"]): string {
  if (status === "leftOnly") return "仅左";
  if (status === "rightOnly") return "仅右";
  if (status === "changed") return "变更";
  return "一致";
}

function SidePicker({
  label,
  pick,
  sessions,
  databases,
  schemas,
  onChange,
}: {
  label: string;
  pick: SidePick;
  sessions: OpenSessionInfo[];
  databases: DatabaseMeta[];
  schemas: SchemaMeta[];
  onChange: (next: SidePick) => void;
}) {
  const session = sessions.find((item) => item.id === pick.connectionId);
  const pg = session?.connection.driver === "postgresql";
  return (
    <fieldset className="rounded border border-neutral-200 p-2 dark:border-neutral-800">
      <legend className="px-1 font-medium">{label}</legend>
      <div className="flex flex-col gap-1">
        <select
          value={pick.connectionId}
          onChange={(e) =>
            onChange({ connectionId: e.target.value, database: "", schema: "" })
          }
          className="h-7 rounded border border-neutral-300 bg-white px-1 dark:border-neutral-700 dark:bg-neutral-950"
        >
          <option value="">选择已打开连接</option>
          {sessions.map((item) => (
            <option key={item.id} value={item.id}>
              {item.connection.name}（{item.connection.driver}）
            </option>
          ))}
        </select>
        <select
          value={pick.database}
          onChange={(e) => onChange({ ...pick, database: e.target.value, schema: "" })}
          className="h-7 rounded border border-neutral-300 bg-white px-1 dark:border-neutral-700 dark:bg-neutral-950"
        >
          <option value="">database</option>
          {databases.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
        {pg && (
          <select
            value={pick.schema}
            onChange={(e) => onChange({ ...pick, schema: e.target.value })}
            className="h-7 rounded border border-neutral-300 bg-white px-1 dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">schema</option>
            {schemas.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        )}
      </div>
    </fieldset>
  );
}

function TableDetail({ table }: { table: TableDiff }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">
        {table.name} · {statusLabel(table.status)}
        {table.commentChanged ? " · 注释不同（可忽略）" : ""}
      </h3>
      <section>
        <h4 className="mb-1 font-medium text-neutral-500">列</h4>
        <table className="w-full border-collapse">
          <thead>
            <tr className="text-left text-neutral-400">
              <th className="py-0.5">名称</th>
              <th>左</th>
              <th>右</th>
              <th>变化</th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((column) => (
              <tr
                key={column.name}
                className={cn(
                  column.left === null ||
                    column.right === null ||
                    column.changes.some((c) => c !== "comment")
                    ? "bg-amber-50 dark:bg-amber-950/40"
                    : undefined,
                )}
              >
                <td className="py-0.5 font-mono">{column.name}</td>
                <td className="font-mono">{column.left?.dataType ?? "—"}</td>
                <td className="font-mono">{column.right?.dataType ?? "—"}</td>
                <td>{column.changes.filter((c) => c !== "comment").join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h4 className="mb-1 font-medium text-neutral-500">索引</h4>
        {table.indexes.map((index) => (
          <p key={index.name} className="font-mono">
            {index.name}
            {!index.left ? " +仅右" : !index.right ? " -仅左" : index.changed ? " ~变更" : ""}
          </p>
        ))}
      </section>
      <section>
        <h4 className="mb-1 font-medium text-neutral-500">约束</h4>
        {table.constraints.map((constraint) => (
          <p key={constraint.name} className="font-mono">
            {constraint.name} {constraint.left?.constraintType ?? constraint.right?.constraintType}
            {!constraint.left ? " +仅右" : !constraint.right ? " -仅左" : constraint.changed ? " ~变更" : ""}
          </p>
        ))}
      </section>
    </div>
  );
}
