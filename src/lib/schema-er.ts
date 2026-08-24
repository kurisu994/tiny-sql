// 只读 ER：从 FK 元数据构图（FR-263），不引入图编辑器依赖。

import type { ConstraintMeta } from "@/lib/tauri-api";
import type { SchemaSnapshot, TableSnapshot } from "@/lib/schema-diff";

export interface ErNode {
  id: string;
  name: string;
  x: number;
  y: number;
  columns: string[];
}

export interface ErEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  fromColumns: string[];
  toColumns: string[];
}

export interface ErGraph {
  nodes: ErNode[];
  edges: ErEdge[];
}

/** 解析 MySQL `schema.table(col, col)` 或 PG `FOREIGN KEY (a) REFERENCES t(b)` */
export function parseForeignKey(
  constraint: ConstraintMeta,
): { table: string; columns: string[] } | null {
  if (constraint.constraintType !== "FOREIGN KEY") return null;
  const text = constraint.reference ?? "";
  const mysql = text.match(/^(?:[`"]?[\w$]+[`"]?\.)?[`"]?([\w$]+)[`"]?\(([^)]+)\)$/);
  if (mysql) {
    return {
      table: mysql[1],
      columns: mysql[2].split(",").map((part) => part.trim().replace(/[`"]/g, "")),
    };
  }
  const pg = text.match(/REFERENCES\s+(?:[\w."]+\.)?"?([\w$]+)"?\s*\(([^)]+)\)/i);
  if (pg) {
    return {
      table: pg[1],
      columns: pg[2].split(",").map((part) => part.trim().replace(/["`]/g, "")),
    };
  }
  return null;
}

function tableByName(tables: TableSnapshot[], name: string): TableSnapshot | undefined {
  const lower = name.toLowerCase();
  return tables.find((table) => table.name === name || table.name.toLowerCase() === lower);
}

/** 分层布局：被引用的表靠上，引用方靠下 */
export function buildErGraph(snapshot: SchemaSnapshot): ErGraph {
  const nodes: ErNode[] = [];
  const edges: ErEdge[] = [];
  const incoming = new Map<string, number>();
  for (const table of snapshot.tables) incoming.set(table.name, 0);

  const pending: { from: string; to: string; label: string; fromColumns: string[]; toColumns: string[] }[] = [];
  for (const table of snapshot.tables) {
    for (const constraint of table.constraints) {
      const parsed = parseForeignKey(constraint);
      if (!parsed) continue;
      const target = tableByName(snapshot.tables, parsed.table);
      if (!target) continue;
      pending.push({
        from: table.name,
        to: target.name,
        label: constraint.name,
        fromColumns: constraint.columns,
        toColumns: parsed.columns,
      });
      incoming.set(target.name, (incoming.get(target.name) ?? 0) + 1);
    }
  }

  const levels = new Map<string, number>();
  for (const table of snapshot.tables) {
    const refs = table.constraints.filter((c) => c.constraintType === "FOREIGN KEY").length;
    levels.set(table.name, refs === 0 ? 0 : 1);
  }
  for (const edge of pending) {
    const fromLevel = (levels.get(edge.to) ?? 0) + 1;
    levels.set(edge.from, Math.max(levels.get(edge.from) ?? 0, fromLevel));
  }

  const byLevel = new Map<number, TableSnapshot[]>();
  for (const table of snapshot.tables) {
    const level = levels.get(table.name) ?? 0;
    const list = byLevel.get(level) ?? [];
    list.push(table);
    byLevel.set(level, list);
  }

  const width = 220;
  const height = 140;
  for (const [level, list] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    list.forEach((table, index) => {
      nodes.push({
        id: table.name,
        name: table.name,
        x: 40 + index * width,
        y: 40 + level * height,
        columns: table.columns.map((column) => column.name),
      });
    });
  }

  for (const edge of pending) {
    edges.push({
      id: `${edge.from}->${edge.to}:${edge.label}`,
      from: edge.from,
      to: edge.to,
      label: edge.label,
      fromColumns: edge.fromColumns,
      toColumns: edge.toColumns,
    });
  }

  return { nodes, edges };
}
