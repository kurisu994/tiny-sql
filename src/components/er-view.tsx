"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { buildErGraph, parseForeignKey, type ErEdge, type ErNode } from "@/lib/schema-er";
import { loadSchemaSnapshot } from "@/lib/schema-snapshot";
import { translateError } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session-store";

/**
 * 当前库的只读 ER（FR-263）。点击节点打开浏览结构；不持久化坐标。
 */
export function ErView() {
  const openId = useSessionStore((s) => s.openId);
  const activeConnection = useSessionStore((s) => s.activeConnection);
  const selectedDb = useSessionStore((s) => s.selectedDb);
  const selectedSchema = useSessionStore((s) => s.selectedSchema);
  const selectTable = useSessionStore((s) => s.selectTable);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nodes, setNodes] = useState<ErNode[]>([]);
  const [edges, setEdges] = useState<ErEdge[]>([]);
  const [unparsed, setUnparsed] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [hideIsolated, setHideIsolated] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!openId || !activeConnection || !selectedDb) {
      setNodes([]);
      setEdges([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const snapshot = await loadSchemaSnapshot({
          connectionId: openId,
          connectionName: activeConnection.name,
          driver: activeConnection.driver,
          database: selectedDb,
          schema: activeConnection.driver === "postgresql" ? selectedSchema : null,
        });
        if (cancelled) return;
        const graph = buildErGraph(snapshot);
        const failed: string[] = [];
        for (const table of snapshot.tables) {
          for (const constraint of table.constraints) {
            if (
              constraint.constraintType === "FOREIGN KEY" &&
              !parseForeignKey(constraint)
            ) {
              failed.push(`${table.name}.${constraint.name}`);
            }
          }
        }
        setNodes(graph.nodes);
        setEdges(graph.edges);
        setUnparsed(failed);
      } catch (e) {
        if (!cancelled) setError(translateError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openId, activeConnection, selectedDb, selectedSchema]);

  const related = useMemo(() => {
    const names = new Set<string>();
    for (const edge of edges) {
      names.add(edge.from);
      names.add(edge.to);
    }
    return names;
  }, [edges]);

  const visibleNodes = nodes.filter((node) => {
    if (filter && !node.name.toLowerCase().includes(filter.toLowerCase())) return false;
    if (hideIsolated && !related.has(node.name)) return false;
    return true;
  });
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const visibleEdges = edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));

  const width = Math.max(800, ...visibleNodes.map((node) => node.x + 200), 800);
  const height = Math.max(480, ...visibleNodes.map((node) => node.y + 120), 480);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选表名"
          className="h-7 w-40 rounded border border-neutral-300 bg-white px-2 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={hideIsolated}
            onChange={(e) => setHideIsolated(e.target.checked)}
          />
          隐藏无关系表
        </label>
        <Button type="button" size="sm" variant="outline" onClick={() => setScale((n) => Math.min(2, n + 0.1))}>
          放大
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setScale((n) => Math.max(0.4, n - 0.1))}>
          缩小
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setScale(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          复位
        </Button>
        {loading && <span className="text-neutral-400">加载关系…</span>}
      </div>
      {error && <p className="text-red-600">{error}</p>}
      {unparsed.length > 0 && (
        <p className="text-neutral-500">无法连线的外键：{unparsed.join("，")}</p>
      )}
      {!selectedDb && <p className="text-neutral-500">请先在对象树选中 database / schema。</p>}
      <div
        className="min-h-0 flex-1 overflow-auto rounded border border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950"
        onMouseDown={(event) => {
          if (event.button !== 1 && event.currentTarget !== event.target) return;
        }}
      >
        <svg
          width={width}
          height={height}
          className="block"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: "0 0" }}
        >
          {visibleEdges.map((edge) => {
            const from = visibleNodes.find((node) => node.id === edge.from);
            const to = visibleNodes.find((node) => node.id === edge.to);
            if (!from || !to) return null;
            const x1 = from.x + 80;
            const y1 = from.y + 24;
            const x2 = to.x + 80;
            const y2 = to.y + 24;
            const active = selectedEdge === edge.id;
            return (
              <g key={edge.id}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke={active ? "#2563eb" : "#a3a3a3"}
                  strokeWidth={active ? 2 : 1}
                  markerEnd="url(#er-arrow)"
                  className="cursor-pointer"
                  onClick={() => setSelectedEdge(edge.id)}
                />
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} fontSize="10" fill="#737373">
                  {edge.fromColumns.join(",")}
                </text>
              </g>
            );
          })}
          <defs>
            <marker id="er-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#a3a3a3" />
            </marker>
          </defs>
          {visibleNodes.map((node) => (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              className="cursor-pointer"
              onClick={() => {
                setSelected(node.id);
                void selectTable(node.name);
              }}
            >
              <rect
                width="160"
                height="48"
                rx="6"
                className={cn(
                  selected === node.id ? "fill-blue-50 stroke-blue-500" : "fill-white stroke-neutral-300 dark:fill-neutral-900",
                )}
                strokeWidth="1"
              />
              <text x="8" y="20" fontSize="12" className="fill-neutral-800 dark:fill-neutral-100">
                {node.name}
              </text>
              <text x="8" y="36" fontSize="10" className="fill-neutral-400">
                {node.columns.slice(0, 3).join(", ")}
                {node.columns.length > 3 ? "…" : ""}
              </text>
            </g>
          ))}
        </svg>
      </div>
      {selectedEdge && (
        <p className="text-neutral-500">
          边 {selectedEdge}
          {visibleEdges
            .filter((edge) => edge.id === selectedEdge)
            .map((edge) => ` · ${edge.fromColumns.join(",")} → ${edge.toColumns.join(",")}`)}
        </p>
      )}
    </div>
  );
}
