"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AsteriskIcon,
  HashIcon,
  KeyRoundIcon,
  Link2Icon,
  ListCollapseIcon,
  ListTreeIcon,
  MaximizeIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  Table2Icon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";

import {
  buildErGraph,
  layoutErGraph,
  parseForeignKey,
  ER_HEADER_HEIGHT,
  ER_ROW_HEIGHT,
  type ErColumn,
  type ErEdge,
  type ErNode,
} from "@/lib/schema-er";
import { metadataCache } from "@/lib/metadata-cache";
import { dbApi, translateError, type TableOverview } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import { useSessionStore } from "@/stores/session-store";

const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;
/** 超过这个表数默认折叠成表头，避免首屏一片密密麻麻 */
const COLLAPSE_THRESHOLD = 40;

type Point = { x: number; y: number };

/** 画布视图变换：缩放 + 平移量（内容层坐标 → 视口坐标） */
type View = { scale: number; x: number; y: number };

type DragState =
  | { kind: "pan"; startX: number; startY: number; origin: Point; moved: boolean }
  | { kind: "node"; id: string; startX: number; startY: number; origin: Point; moved: boolean };

/**
 * 当前库的只读 ER（FR-263）：自绘画布，实体按「表头 + 列清单」渲染，主键置顶。
 * 支持拖拽平移 / 滚轮缩放 / 拖动实体，坐标不持久化。
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
  const [collapsed, setCollapsed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [moved, setMoved] = useState<Record<string, Point>>({});
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  /** 手动刷新计数：+1 表示丢掉缓存重新拉结构 */
  const [reloadKey, setReloadKey] = useState(0);
  /**
   * 视图变换的低频镜像：只用来重算「哪些实体在可视区内」。
   *
   * 缩放 / 平移本身走 ref + rAF 直接改 DOM，不进 React 状态——触控板一次手势能发
   * 上百个 wheel 事件，每个都 setState 会把几百张卡片全量 diff 一遍，直接掉帧。
   */
  const [viewSync, setViewSync] = useState<View>({ scale: 1, x: 0, y: 0 });

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const paintRef = useRef<number | null>(null);
  const syncRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const draggedRef = useRef(false);
  const fittedRef = useRef<unknown>(null);

  useEffect(() => {
    if (!openId || !activeConnection || !selectedDb) {
      setNodes([]);
      setEdges([]);
      return;
    }
    let cancelled = false;
    const schema = activeConnection.driver === "postgresql" ? selectedSchema : null;
    const cacheKey = {
      connectionId: openId,
      driver: activeConnection.driver,
      database: selectedDb,
      schema,
      resource: "overview" as const,
    };
    if (reloadKey > 0) metadataCache.invalidateScope(cacheKey);
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        // 一次 db_schema_overview 拿回整库结构；逐表查在几百张表的库上要等十几秒。
        // 切走再切回按 metadata cache 的 5 分钟 TTL 命中，不重复拉。
        const tables =
          metadataCache.get<TableOverview[]>(cacheKey) ??
          (await dbApi.schemaOverview(openId, selectedDb, schema));
        if (cancelled) return;
        metadataCache.set(cacheKey, tables);
        const graph = buildErGraph(tables);
        const failed: string[] = [];
        for (const table of tables) {
          for (const constraint of table.constraints) {
            if (constraint.constraintType === "FOREIGN KEY" && !parseForeignKey(constraint)) {
              failed.push(`${table.name}.${constraint.name}`);
            }
          }
        }
        setNodes(graph.nodes);
        setEdges(graph.edges);
        setUnparsed(failed);
        setMoved({});
        setSelected(null);
        setSelectedEdge(null);
        setCollapsed(graph.nodes.length > COLLAPSE_THRESHOLD);
      } catch (e) {
        if (!cancelled) setError(translateError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openId, activeConnection, selectedDb, selectedSchema, reloadKey]);

  const related = useMemo(() => {
    const names = new Set<string>();
    for (const edge of edges) {
      names.add(edge.from);
      names.add(edge.to);
    }
    return names;
  }, [edges]);

  // 过滤后重新布局；拖动坐标单独叠加，拖一个实体不会触发整图重排
  const layout = useMemo(() => {
    const keyword = filter.trim().toLowerCase();
    const visible = nodes.filter((node) => {
      if (keyword && !node.name.toLowerCase().includes(keyword)) return false;
      if (hideIsolated && !related.has(node.name)) return false;
      return true;
    });
    const ids = new Set(visible.map((node) => node.id));
    const keptEdges = edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    return layoutErGraph(visible, keptEdges, { collapsed });
  }, [nodes, edges, filter, hideIsolated, collapsed, related]);

  const graph = useMemo(() => {
    const placed = layout.nodes.map((node) => {
      const override = moved[node.id];
      return override ? { ...node, x: override.x, y: override.y } : node;
    });
    // 表多时 Math.max(...spread) 会顶到参数上限，逐个归约
    let width = layout.width;
    let height = layout.height;
    for (const node of placed) {
      width = Math.max(width, node.x + node.width + 40);
      height = Math.max(height, node.y + node.height + 40);
    }
    return { nodes: placed, edges: layout.edges, width, height };
  }, [layout, moved]);

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );

  /** 把当前视图变换写进 DOM（每帧最多一次） */
  const paint = useCallback(() => {
    const { scale, x, y } = viewRef.current;
    if (contentRef.current) {
      contentRef.current.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }
    if (viewportRef.current) {
      viewportRef.current.style.backgroundSize = `${24 * scale}px ${24 * scale}px`;
      viewportRef.current.style.backgroundPosition = `${x}px ${y}px`;
    }
    if (zoomLabelRef.current) {
      zoomLabelRef.current.textContent = `${Math.round(scale * 100)}%`;
    }
  }, []);

  const applyView = useCallback(
    (next: View) => {
      viewRef.current = next;
      if (paintRef.current === null) {
        paintRef.current = requestAnimationFrame(() => {
          paintRef.current = null;
          paint();
        });
      }
      // 手势停下来再把结果同步给 React，触发一次可视区重算
      if (syncRef.current !== null) window.clearTimeout(syncRef.current);
      syncRef.current = window.setTimeout(() => {
        syncRef.current = null;
        setViewSync(viewRef.current);
      }, 120);
    },
    [paint],
  );

  /** 以视口内某点为锚缩放，保持锚点下的图形不动 */
  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      const current = viewRef.current;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
      if (scale === current.scale) return;
      const ratio = scale / current.scale;
      applyView({
        scale,
        x: cx - ratio * (cx - current.x),
        y: cy - ratio * (cy - current.y),
      });
    },
    [applyView],
  );

  const zoomByButton = useCallback(
    (factor: number) => {
      const view = viewportRef.current;
      zoomAt(factor, (view?.clientWidth ?? 0) / 2, (view?.clientHeight ?? 0) / 2);
    },
    [zoomAt],
  );

  /** 适应视图：把全部实体缩放居中到可视区 */
  const fitToView = useCallback(() => {
    const view = viewportRef.current;
    if (!view?.clientWidth || graph.nodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of graph.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }
    const boxWidth = Math.max(1, maxX - minX);
    const boxHeight = Math.max(1, maxY - minY);
    const padding = 24;
    const next = Math.min(
      MAX_SCALE,
      Math.max(
        MIN_SCALE,
        Math.min(
          (view.clientWidth - padding * 2) / boxWidth,
          (view.clientHeight - padding * 2) / boxHeight,
          1,
        ),
      ),
    );
    applyView({
      scale: next,
      x: (view.clientWidth - boxWidth * next) / 2 - minX * next,
      y: (view.clientHeight - boxHeight * next) / 2 - minY * next,
    });
  }, [applyView, graph.nodes]);

  useLayoutEffect(paint);

  // 回调保持稳定引用，配合 memo 让「拖一张卡片」只重渲染那一张
  const handleCardPointerDown = useCallback((event: React.PointerEvent, node: ErNode) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    dragRef.current = {
      kind: "node",
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: node.x, y: node.y },
      moved: false,
    };
  }, []);

  const handleCardClick = useCallback(
    (node: ErNode) => {
      if (draggedRef.current) return;
      setSelected(node.id);
      void selectTable(node.name);
    },
    [selectTable],
  );

  // 每次重新布局（首次加载、筛选、折叠切换）自动适应视图；拖动实体不触发
  useLayoutEffect(() => {
    const view = viewportRef.current;
    if (fittedRef.current === layout || layout.nodes.length === 0) return;
    if (!view?.clientWidth) return;
    fittedRef.current = layout;
    fitToView();
  }, [layout, fitToView]);

  useEffect(
    () => () => {
      if (paintRef.current !== null) cancelAnimationFrame(paintRef.current);
      if (syncRef.current !== null) window.clearTimeout(syncRef.current);
    },
    [],
  );

  useEffect(() => {
    const view = viewportRef.current;
    if (!view) return;
    const observer = new ResizeObserver(() => {
      setViewSize({ width: view.clientWidth, height: view.clientHeight });
    });
    observer.observe(view);
    setViewSize({ width: view.clientWidth, height: view.clientHeight });
    return () => observer.disconnect();
  }, []);

  // 滚轮：默认平移，Ctrl / ⌘ + 滚轮缩放（触控板手势同样走这里）
  useEffect(() => {
    const view = viewportRef.current;
    if (!view) return;
    function onWheel(event: WheelEvent) {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = view!.getBoundingClientRect();
        zoomAt(
          Math.exp(-event.deltaY / 240),
          event.clientX - rect.left,
          event.clientY - rect.top,
        );
        return;
      }
      const current = viewRef.current;
      applyView({
        scale: current.scale,
        x: current.x - event.deltaX,
        y: current.y - event.deltaY,
      });
    }
    view.addEventListener("wheel", onWheel, { passive: false });
    return () => view.removeEventListener("wheel", onWheel);
  }, [applyView, zoomAt]);

  // 拖拽：空白处平移画布，实体上拖动改单个实体坐标
  useEffect(() => {
    function onMove(event: PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.kind === "pan") {
        applyView({ scale: viewRef.current.scale, x: drag.origin.x + dx, y: drag.origin.y + dy });
        return;
      }
      const zoom = viewRef.current.scale;
      setMoved((prev) => ({
        ...prev,
        [drag.id]: { x: drag.origin.x + dx / zoom, y: drag.origin.y + dy / zoom },
      }));
    }
    function onUp() {
      const drag = dragRef.current;
      dragRef.current = null;
      if (!drag) return;
      draggedRef.current = drag.moved;
      // 空白处点一下（未拖动）清空高亮
      if (drag.kind === "pan" && !drag.moved) {
        setSelected(null);
        setSelectedEdge(null);
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [applyView]);

  const highlighted = useMemo(() => {
    if (!selected) return null;
    const names = new Set<string>([selected]);
    for (const edge of graph.edges) {
      if (edge.from === selected) names.add(edge.to);
      if (edge.to === selected) names.add(edge.from);
    }
    return names;
  }, [selected, graph.edges]);

  // 只渲染可视区内的实体（含一屏余量），大库下 DOM 不会爆
  const visibleNodes = useMemo(() => {
    if (viewSize.width === 0) return graph.nodes;
    const margin = 300;
    const { scale, x, y } = viewSync;
    const left = (-x - margin) / scale;
    const top = (-y - margin) / scale;
    const right = (-x + viewSize.width + margin) / scale;
    const bottom = (-y + viewSize.height + margin) / scale;
    return graph.nodes.filter(
      (node) =>
        node.x + node.width >= left &&
        node.x <= right &&
        node.y + node.height >= top &&
        node.y <= bottom,
    );
  }, [graph.nodes, viewSync, viewSize]);

  const activeEdge = graph.edges.find((edge) => edge.id === selectedEdge) ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col text-xs">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-neutral-400" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="筛选表名"
            className="h-6 w-40 rounded border border-neutral-300 bg-white pl-6 pr-2 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </div>
        <label className="flex items-center gap-1 text-neutral-500">
          <input
            type="checkbox"
            checked={hideIsolated}
            onChange={(e) => setHideIsolated(e.target.checked)}
          />
          仅看有关系的表
        </label>
        <div className="ml-auto flex items-center gap-0.5 text-neutral-500">
          <ToolButton label="重新拉取结构" onClick={() => setReloadKey((n) => n + 1)}>
            <RefreshCwIcon className={cn("size-3.5", loading && "animate-spin")} />
          </ToolButton>
          <ToolButton
            label={collapsed ? "展开列" : "折叠为表头"}
            onClick={() => {
              setCollapsed((v) => !v);
              setMoved({});
            }}
            active={collapsed}
          >
            {collapsed ? <ListTreeIcon className="size-3.5" /> : <ListCollapseIcon className="size-3.5" />}
          </ToolButton>
          <ToolButton label="缩小" onClick={() => zoomByButton(1 / 1.2)}>
            <ZoomOutIcon className="size-3.5" />
          </ToolButton>
          <span ref={zoomLabelRef} className="w-10 text-center tabular-nums text-neutral-400">
            100%
          </span>
          <ToolButton label="放大" onClick={() => zoomByButton(1.2)}>
            <ZoomInIcon className="size-3.5" />
          </ToolButton>
          <ToolButton label="适应视图" onClick={fitToView}>
            <MaximizeIcon className="size-3.5" />
          </ToolButton>
          <ToolButton
            label="复位布局"
            onClick={() => {
              setMoved({});
              applyView({ scale: 1, x: 0, y: 0 });
            }}
          >
            <RotateCcwIcon className="size-3.5" />
          </ToolButton>
        </div>
      </div>

      {error && <p className="shrink-0 px-3 py-1 text-red-600">{error}</p>}
      {!selectedDb && (
        <p className="shrink-0 px-3 py-1 text-neutral-500">请先在对象树选中 database / schema。</p>
      )}

      <div
        ref={viewportRef}
        data-testid="er-canvas"
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden overscroll-none bg-neutral-50 select-none touch-none active:cursor-grabbing dark:bg-neutral-950"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgb(163 163 163 / 0.25) 0.7px, transparent 0.8px)",
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          dragRef.current = {
            kind: "pan",
            startX: event.clientX,
            startY: event.clientY,
            origin: { x: viewRef.current.x, y: viewRef.current.y },
            moved: false,
          };
        }}
      >
        <div
          ref={contentRef}
          data-testid="er-canvas-content"
          className="absolute left-0 top-0 origin-top-left will-change-transform"
          style={{ width: graph.width, height: graph.height }}
        >
          <svg
            width={graph.width}
            height={graph.height}
            className="absolute left-0 top-0 overflow-visible"
          >
            {graph.edges.map((edge) => (
              <ErEdgeLine
                key={edge.id}
                edge={edge}
                from={nodeById.get(edge.from)}
                to={nodeById.get(edge.to)}
                collapsed={collapsed}
                active={selectedEdge === edge.id}
                dimmed={Boolean(highlighted) && edge.from !== selected && edge.to !== selected}
                onSelect={setSelectedEdge}
              />
            ))}
          </svg>
          {visibleNodes.map((node) => (
            <ErEntityCard
              key={node.id}
              node={node}
              collapsed={collapsed}
              selected={selected === node.id}
              dimmed={Boolean(highlighted) && !highlighted?.has(node.id)}
              onPointerDown={handleCardPointerDown}
              onClick={handleCardClick}
            />
          ))}
        </div>

        <div className="pointer-events-none absolute bottom-2 left-3 flex flex-col gap-1 rounded border border-neutral-200 bg-white/90 px-1.5 py-0.5 text-[11px] text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900/90">
          {loading && <span>加载关系…</span>}
          {!loading && nodes.length > 0 && (
            <span>
              {graph.nodes.length} 张表 · {graph.edges.length} 条外键
              {unparsed.length > 0 ? ` · ${unparsed.length} 个外键无法连线` : ""}
            </span>
          )}
          {!loading && selectedDb && nodes.length === 0 && <span>当前库没有可展示的表。</span>}
        </div>
      </div>

      {(activeEdge || unparsed.length > 0) && (
        <div
          data-testid="er-edge-detail"
          className="shrink-0 border-t border-neutral-200 px-3 py-1 text-neutral-500 dark:border-neutral-800"
        >
          {activeEdge ? (
            <span>
              {activeEdge.from}.{activeEdge.fromColumns.join(",")} → {activeEdge.to}.
              {activeEdge.toColumns.join(",")}
              <span className="ml-2 text-neutral-400">（{activeEdge.label}）</span>
            </span>
          ) : (
            <span>无法连线的外键：{unparsed.join("，")}</span>
          )}
        </div>
      )}
    </div>
  );
}

function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex size-6 items-center justify-center rounded",
        active
          ? "bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100"
          : "hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200",
      )}
    >
      {children}
    </button>
  );
}

/** 实体卡片：表头 + 列清单（主键已在建图时置顶） */
const ErEntityCard = memo(function ErEntityCard({
  node,
  collapsed,
  selected,
  dimmed,
  onPointerDown,
  onClick,
}: {
  node: ErNode;
  collapsed: boolean;
  selected: boolean;
  dimmed: boolean;
  onPointerDown: (event: React.PointerEvent, node: ErNode) => void;
  onClick: (node: ErNode) => void;
}) {
  return (
    <div
      data-testid={`er-entity-${node.name}`}
      onPointerDown={(event) => onPointerDown(event, node)}
      onClick={() => onClick(node)}
      className={cn(
        "absolute cursor-pointer overflow-hidden rounded-md border bg-white shadow-sm transition-opacity dark:bg-neutral-900",
        selected
          ? "border-blue-500 ring-1 ring-blue-500/40"
          : "border-neutral-300 dark:border-neutral-700",
        dimmed && "opacity-35",
      )}
      style={{ left: node.x, top: node.y, width: node.width, zIndex: selected ? 2 : 1 }}
    >
      <div
        className={cn(
          "flex items-center gap-1.5 border-b px-2",
          selected
            ? "border-blue-500/40 bg-blue-50 dark:bg-blue-950/40"
            : "border-neutral-200 bg-neutral-100 dark:border-neutral-800 dark:bg-neutral-800/60",
        )}
        style={{ height: ER_HEADER_HEIGHT }}
      >
        <Table2Icon className="size-3 shrink-0 text-neutral-400" />
        <span className="max-w-[70%] shrink-0 truncate font-medium text-neutral-800 dark:text-neutral-100">
          {node.name}
        </span>
        {node.comment && (
          <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-400">
            {node.comment}
          </span>
        )}
        <span className="ml-auto shrink-0 text-[10px] text-neutral-400">
          {node.columns.length}
        </span>
      </div>
      {!collapsed &&
        node.columns.map((column) => (
          <ErColumnRow key={column.name} column={column} />
        ))}
    </div>
  );
});

function ErColumnRow({ column }: { column: ErColumn }) {
  return (
    <div
      data-column={column.name}
      className="flex items-center gap-1.5 px-2 text-[11px]"
      style={{ height: ER_ROW_HEIGHT }}
      title={column.comment ?? undefined}
    >
      <ColumnKeyIcon column={column} />
      <span
        className={cn(
          "max-w-[65%] shrink-0 truncate",
          column.primary
            ? "font-medium text-neutral-800 dark:text-neutral-100"
            : "text-neutral-700 dark:text-neutral-300",
        )}
      >
        {column.name}
      </span>
      {column.comment && (
        <span className="min-w-0 flex-1 truncate text-[10px] text-neutral-400">
          {column.comment}
        </span>
      )}
      <span className="ml-auto shrink-0 font-mono text-[10px] text-neutral-400">
        {column.dataType}
        {!column.nullable && <span title="NOT NULL">*</span>}
      </span>
    </div>
  );
}

/** 行首键位图标：主键 / 外键 / 唯一 / 索引 / 普通列 */
function ColumnKeyIcon({ column }: { column: ErColumn }) {
  if (column.primary) {
    return <KeyRoundIcon className="size-3 shrink-0 text-amber-500" aria-label="主键" />;
  }
  if (column.foreign) {
    return <Link2Icon className="size-3 shrink-0 text-sky-500" aria-label="外键" />;
  }
  if (column.unique) {
    return <AsteriskIcon className="size-3 shrink-0 text-violet-500" aria-label="唯一" />;
  }
  if (column.indexed) {
    return <HashIcon className="size-3 shrink-0 text-neutral-400" aria-label="索引" />;
  }
  return <span className="size-3 shrink-0" />;
}

/** 外键连线：子表侧鸦爪（多），父表侧短横（一） */
const ErEdgeLine = memo(function ErEdgeLine({
  edge,
  from,
  to,
  collapsed,
  active,
  dimmed,
  onSelect,
}: {
  edge: ErEdge;
  from: ErNode | undefined;
  to: ErNode | undefined;
  collapsed: boolean;
  active: boolean;
  dimmed: boolean;
  onSelect: (id: string) => void;
}) {
  if (!from || !to) return null;
  const stroke = active ? "#2563eb" : "#94a3b8";
  const opacity = dimmed ? 0.25 : 1;

  if (from.id === to.id) {
    // 自引用：从右侧绕回右侧
    const y1 = portY(from, edge.fromColumns[0], collapsed);
    const y2 = portY(to, edge.toColumns[0], collapsed);
    const x = from.x + from.width;
    const d = `M ${x} ${y1} C ${x + 60} ${y1 + 10}, ${x + 60} ${y2 - 10}, ${x} ${y2}`;
    return (
      <g
        data-edge={edge.id}
        opacity={opacity}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onSelect(edge.id)}
      >
        <path d={d} fill="none" stroke={stroke} strokeWidth={active ? 2 : 1.2} />
        <path d={d} fill="none" stroke="transparent" strokeWidth={10} className="cursor-pointer" />
        <CrowFoot x={x} y={y1} dir={1} stroke={stroke} />
      </g>
    );
  }

  const centerFrom = from.x + from.width / 2;
  const centerTo = to.x + to.width / 2;
  // 两张卡片水平投影相交时（典型的上下分层父子表），从同一侧绕出去，避免横穿卡片
  const sameSide = to.x < from.x + from.width && from.x < to.x + to.width;
  const dir = sameSide ? (centerTo > centerFrom ? 1 : -1) : centerTo >= centerFrom ? 1 : -1;
  const y1 = portY(from, edge.fromColumns[0], collapsed);
  const y2 = portY(to, edge.toColumns[0], collapsed);
  const x1 = dir > 0 ? from.x + from.width : from.x;
  const x2 = sameSide
    ? dir > 0
      ? to.x + to.width
      : to.x
    : dir > 0
      ? to.x
      : to.x + to.width;
  let d: string;
  if (sameSide) {
    // 同侧回环统一贴着两张卡片最外侧走，长回环也不会甩出画布
    const outer =
      dir > 0
        ? Math.max(from.x + from.width, to.x + to.width) + 28
        : Math.min(from.x, to.x) - 28;
    d = `M ${x1} ${y1} C ${outer} ${y1}, ${outer} ${y2}, ${x2} ${y2}`;
  } else {
    const bend = Math.max(40, Math.abs(x2 - x1) * 0.4);
    d = `M ${x1} ${y1} C ${x1 + dir * bend} ${y1}, ${x2 - dir * bend} ${y2}, ${x2} ${y2}`;
  }

  return (
    <g
      data-edge={edge.id}
      opacity={opacity}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => onSelect(edge.id)}
    >
      <path d={d} fill="none" stroke={stroke} strokeWidth={active ? 2 : 1.2} />
      <path d={d} fill="none" stroke="transparent" strokeWidth={10} className="cursor-pointer" />
      <CrowFoot x={x1} y={y1} dir={dir} stroke={stroke} />
      <line
        x1={x2 + (sameSide ? dir : -dir) * 8}
        y1={y2 - 5}
        x2={x2 + (sameSide ? dir : -dir) * 8}
        y2={y2 + 5}
        stroke={stroke}
        strokeWidth={active ? 2 : 1.2}
      />
      {active && (
        <text
          x={(x1 + x2) / 2}
          y={(y1 + y2) / 2 - 6}
          fontSize={10}
          textAnchor="middle"
          fill="#2563eb"
        >
          {edge.fromColumns.join(",")} → {edge.toColumns.join(",")}
        </text>
      )}
    </g>
  );
});

/** 鸦爪：三条短线表示「多」的一端 */
function CrowFoot({ x, y, dir, stroke }: { x: number; y: number; dir: number; stroke: string }) {
  const tip = x + dir * 9;
  return (
    <g stroke={stroke} strokeWidth={1.2} fill="none">
      <line x1={x} y1={y} x2={tip} y2={y - 5} />
      <line x1={x} y1={y} x2={tip} y2={y} />
      <line x1={x} y1={y} x2={tip} y2={y + 5} />
    </g>
  );
}

/** 连线端口的纵坐标：对准该外键所在的列行，折叠时落在表头中部 */
function portY(node: ErNode, column: string | undefined, collapsed: boolean): number {
  if (collapsed || !column) return node.y + ER_HEADER_HEIGHT / 2;
  const index = node.columns.findIndex(
    (item) => item.name.toLowerCase() === column.toLowerCase(),
  );
  if (index < 0) return node.y + ER_HEADER_HEIGHT / 2;
  return node.y + ER_HEADER_HEIGHT + index * ER_ROW_HEIGHT + ER_ROW_HEIGHT / 2;
}
