// 只读 ER（FR-263）：从表结构与 FK 元数据构图，配合自绘画布渲染，不引入图编辑器依赖。

import type { ColumnMeta, ConstraintMeta, IndexMeta } from "@/lib/tauri-api";

/**
 * 建图所需的最小表结构。
 *
 * 后端 `db_schema_overview` 的 TableOverview 与结构对比用的 TableSnapshot 都满足；
 * 索引可选——键位标记优先看约束与 `columnKey`，ER 图不为它多查一轮。
 */
export interface ErTableInput {
  name: string;
  comment: string | null;
  columns: ColumnMeta[];
  constraints: ConstraintMeta[];
  indexes?: IndexMeta[];
}

/** 实体卡片里的一列（主键排在最前，见 buildErColumns） */
export interface ErColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  comment: string | null;
  /** 主键列 */
  primary: boolean;
  /** 外键列 */
  foreign: boolean;
  /** 唯一约束 / 唯一索引覆盖的列 */
  unique: boolean;
  /** 非唯一索引覆盖的列 */
  indexed: boolean;
}

/** 实体卡片；x/y/width/height 由 layoutErGraph 填充 */
export interface ErNode {
  id: string;
  name: string;
  comment: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  columns: ErColumn[];
}

/** 外键连线：from 为引用方（子表），to 为被引用方（父表） */
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
  /** 布局后的画布尺寸，供视图做适应缩放 */
  width: number;
  height: number;
}

/** 卡片表头高度（px），视图与连线端口共用同一常量 */
export const ER_HEADER_HEIGHT = 30;
/** 卡片单列行高（px） */
export const ER_ROW_HEIGHT = 22;
/** 卡片底部留白（px） */
export const ER_NODE_PADDING = 4;
const ER_NODE_MIN_WIDTH = 200;
const ER_NODE_MAX_WIDTH = 340;
const GAP_X = 56;
const GAP_Y = 48;
const CANVAS_PADDING = 40;

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

function tableByName(tables: ErTableInput[], name: string): ErTableInput | undefined {
  const lower = name.toLowerCase();
  return tables.find((table) => table.name === name || table.name.toLowerCase() === lower);
}

/** 把一张表的列整理成 ER 行：标注键类型，主键提到最前 */
export function buildErColumns(table: ErTableInput): ErColumn[] {
  const lower = (name: string) => name.toLowerCase();
  const primary = new Set<string>();
  const foreign = new Set<string>();
  const unique = new Set<string>();
  const indexed = new Set<string>();

  for (const constraint of table.constraints) {
    const target =
      constraint.constraintType === "PRIMARY KEY"
        ? primary
        : constraint.constraintType === "FOREIGN KEY"
          ? foreign
          : constraint.constraintType === "UNIQUE"
            ? unique
            : null;
    if (!target) continue;
    for (const column of constraint.columns) target.add(lower(column));
  }
  for (const index of table.indexes ?? []) {
    const isPrimary = index.indexType.toUpperCase() === "PRIMARY" || index.name === "PRIMARY";
    for (const column of index.columns) {
      if (isPrimary) primary.add(lower(column));
      else if (index.unique) unique.add(lower(column));
      else indexed.add(lower(column));
    }
  }

  const columns = table.columns.map<ErColumn>((column) => {
    const key = lower(column.name);
    const columnKey = (column.columnKey ?? "").toUpperCase();
    return {
      name: column.name,
      dataType: column.dataType,
      nullable: column.nullable,
      comment: column.comment,
      primary: primary.has(key) || columnKey === "PRI",
      foreign: foreign.has(key),
      unique: unique.has(key) || columnKey === "UNI",
      indexed: indexed.has(key) || columnKey === "MUL",
    };
  });

  // 主键置顶（组内保持原始列序），其余列顺序不变
  return [...columns.filter((c) => c.primary), ...columns.filter((c) => !c.primary)];
}

/** 粗估文本像素宽（11px 字号），中日韩字符按双宽计 */
function textWidth(text: string, unit = 6.3): number {
  let width = 0;
  for (const ch of text) width += ch.charCodeAt(0) > 0x2e7f ? unit * 1.85 : unit;
  return width;
}

function nodeWidth(node: ErNode): number {
  let widest = textWidth(node.name, 7) + 44;
  for (const column of node.columns) {
    widest = Math.max(widest, 18 + textWidth(column.name) + 14 + textWidth(column.dataType, 5.6) + 22);
  }
  // 有注释的表多留一段位置，注释才不至于把列名挤没
  const commented = Boolean(node.comment) || node.columns.some((column) => Boolean(column.comment));
  return Math.round(
    Math.min(ER_NODE_MAX_WIDTH, Math.max(ER_NODE_MIN_WIDTH, widest + (commented ? 36 : 0))),
  );
}

/** 折叠时只留表头 */
export function nodeHeight(node: ErNode, collapsed: boolean): number {
  if (collapsed || node.columns.length === 0) return ER_HEADER_HEIGHT;
  return ER_HEADER_HEIGHT + node.columns.length * ER_ROW_HEIGHT + ER_NODE_PADDING;
}

/** 无向连通分量：把互相有外键的表分到一组 */
function connectedGroups(nodes: ErNode[], edges: ErEdge[]): ErNode[][] {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const edge of edges) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined || b === undefined) continue;
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const buckets = new Map<number, ErNode[]>();
  nodes.forEach((node, i) => {
    const root = find(i);
    const list = buckets.get(root) ?? [];
    list.push(node);
    buckets.set(root, list);
  });
  return [...buckets.values()];
}

/** 组内分层：被引用的父表靠上，引用方逐层下沉（有环时按迭代上限收敛） */
function levelsOf(group: ErNode[], edges: ErEdge[]): Map<string, number> {
  const ids = new Set(group.map((node) => node.id));
  const inner = edges.filter((e) => e.from !== e.to && ids.has(e.from) && ids.has(e.to));
  const levels = new Map(group.map((node) => [node.id, 0]));
  for (let round = 0; round < group.length; round += 1) {
    let changed = false;
    for (const edge of inner) {
      const next = (levels.get(edge.to) ?? 0) + 1;
      if (next > (levels.get(edge.from) ?? 0)) {
        levels.set(edge.from, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return levels;
}

/**
 * 布局：先按连通分量拆组，组内分层水平排布，组之间按目标宽度折行铺开。
 * 折叠模式下只算表头高度，切换时会重新紧凑排列。
 */
export function layoutErGraph(
  nodes: ErNode[],
  edges: ErEdge[],
  options: { collapsed?: boolean } = {},
): ErGraph {
  const collapsed = options.collapsed ?? false;
  const sized = nodes.map((node) => ({
    ...node,
    width: nodeWidth(node),
    height: nodeHeight(node, collapsed),
  }));
  if (sized.length === 0) return { nodes: [], edges, width: 800, height: 480 };

  // 组内布局：坐标先相对组原点，记录组的包围盒
  const groups = connectedGroups(sized, edges)
    .map((group) => {
      const levels = levelsOf(group, edges);
      const rows = new Map<number, ErNode[]>();
      for (const node of group) {
        const level = levels.get(node.id) ?? 0;
        const list = rows.get(level) ?? [];
        list.push(node);
        rows.set(level, list);
      }
      const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
      const rowWidths = ordered.map(([, list]) =>
        list.reduce((sum, node, i) => sum + node.width + (i > 0 ? GAP_X : 0), 0),
      );
      const groupWidth = Math.max(...rowWidths, 0);
      let y = 0;
      ordered.forEach(([, list], rowIndex) => {
        list.sort((a, b) => a.name.localeCompare(b.name));
        let x = (groupWidth - rowWidths[rowIndex]) / 2;
        let tallest = 0;
        for (const node of list) {
          node.x = x;
          node.y = y;
          x += node.width + GAP_X;
          tallest = Math.max(tallest, node.height);
        }
        y += tallest + GAP_Y;
      });
      return { nodes: group, width: groupWidth, height: Math.max(0, y - GAP_Y) };
    })
    // 关系多的大组排在前面，孤立表铺到后面
    .sort((a, b) => b.nodes.length - a.nodes.length || b.height - a.height);

  const totalArea = groups.reduce((sum, g) => sum + (g.width + GAP_X) * (g.height + GAP_Y), 0);
  const targetWidth = Math.max(960, Math.round(Math.sqrt(totalArea * 2.4)));

  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  const place = (group: { nodes: ErNode[]; width: number; height: number }) => {
    if (cursorX > 0 && cursorX + group.width > targetWidth) {
      cursorX = 0;
      cursorY += rowHeight + GAP_Y * 1.5;
      rowHeight = 0;
    }
    for (const node of group.nodes) {
      node.x += cursorX + CANVAS_PADDING;
      node.y += cursorY + CANVAS_PADDING;
    }
    cursorX += group.width + GAP_X * 1.5;
    rowHeight = Math.max(rowHeight, group.height);
  };

  // 有外键的表按关系块铺在上方；孤立表按表名另起网格，避免关系块旁边留大片空白
  for (const group of groups.filter((g) => g.nodes.length > 1)) place(group);
  const isolated = groups
    .filter((g) => g.nodes.length === 1)
    .sort((a, b) => a.nodes[0].name.localeCompare(b.nodes[0].name));
  if (isolated.length > 0 && cursorX > 0) {
    cursorX = 0;
    cursorY += rowHeight + GAP_Y * 1.5;
    rowHeight = 0;
  }
  for (const group of isolated) place(group);

  // 表多时 Math.max(...spread) 会顶到参数上限，逐个归约
  let right = 0;
  let bottom = 0;
  for (const node of sized) {
    right = Math.max(right, node.x + node.width);
    bottom = Math.max(bottom, node.y + node.height);
  }
  const width = Math.round(right + CANVAS_PADDING);
  const height = Math.round(bottom + CANVAS_PADDING);
  return { nodes: sized, edges, width, height };
}

/** 从表结构构图：解析外键连边，列按主键置顶整理，并给出默认布局 */
export function buildErGraph(tables: ErTableInput[]): ErGraph {
  const nodes: ErNode[] = tables.map((table) => ({
    id: table.name,
    name: table.name,
    comment: table.comment,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    columns: buildErColumns(table),
  }));

  const edges: ErEdge[] = [];
  for (const table of tables) {
    for (const constraint of table.constraints) {
      const parsed = parseForeignKey(constraint);
      if (!parsed) continue;
      const target = tableByName(tables, parsed.table);
      if (!target) continue;
      edges.push({
        id: `${table.name}->${target.name}:${constraint.name}`,
        from: table.name,
        to: target.name,
        label: constraint.name,
        fromColumns: constraint.columns,
        toColumns: parsed.columns,
      });
    }
  }

  return layoutErGraph(nodes, edges);
}
