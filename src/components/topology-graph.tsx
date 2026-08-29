"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  driverLabel,
  isFileBasedDriver,
  translateError,
  type StoredConnection,
} from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import type { TopologyHopStatus, TopologyRttMetric } from "@/stores/session-store";

type NodeStatus = "pending" | "connected" | "failed" | "lost";
type RttKind = "ssh" | "db";

type TopologyNode = {
  id: string;
  title: string;
  subtitle: string;
  status: NodeStatus;
  reason: string | null;
  rttKind: RttKind;
  rttState: TopologyHopStatus["rttState"];
  rttMs: number | null;
};

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: "连接中",
  connected: "正常",
  failed: "失败",
  lost: "断开",
};

const NODE_CLASS: Record<NodeStatus, string> = {
  pending: "border-neutral-300 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300",
  connected: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  failed: "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
  lost: "border-red-400 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
};

const LINE_CLASS: Record<NodeStatus, string> = {
  pending: "bg-neutral-300 dark:bg-neutral-700",
  connected: "bg-emerald-500",
  failed: "bg-red-500",
  lost: "bg-red-500",
};

const IDLE_RTT: TopologyRttMetric = { rttState: "idle", rttMs: null };

export function TopologyGraph({
  connection,
  sessionStatus,
  hopStatuses,
  databaseRtt = IDLE_RTT,
}: {
  connection: StoredConnection;
  sessionStatus: "idle" | "connecting" | "connected" | "error";
  hopStatuses: Record<number, TopologyHopStatus>;
  databaseRtt?: TopologyRttMetric;
}) {
  const nodes = useMemo(
    () => buildNodes(connection, sessionStatus, hopStatuses, databaseRtt),
    [connection, sessionStatus, hopStatuses, databaseRtt],
  );

  return (
    <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 dark:border-neutral-800 dark:bg-neutral-950">
      <TopologyCanvas>
        {nodes.map((node, index) => (
          <TopologySegment
            key={node.id}
            node={node}
            nextNode={nodes[index + 1] ?? null}
            isLast={index === nodes.length - 1}
          />
        ))}
      </TopologyCanvas>
    </div>
  );
}

function TopologyCanvas({ children }: { children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [grabbing, setGrabbing] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    function clampOffset(next: { x: number; y: number }) {
      const view = viewportRef.current;
      const content = contentRef.current;
      if (!view?.clientWidth || !content?.offsetWidth) return next;
      const keep = 80;
      const minX = Math.min(keep, view.clientWidth - keep) - content.offsetWidth;
      const maxX = Math.max(0, view.clientWidth - keep);
      const minY = Math.min(keep, view.clientHeight - keep) - content.offsetHeight;
      const maxY = Math.max(0, view.clientHeight - keep);
      return {
        x: Math.min(maxX, Math.max(minX, next.x)),
        y: Math.min(maxY, Math.max(minY, next.y)),
      };
    }

    function applyOffset(next: { x: number; y: number }) {
      const clamped = clampOffset(next);
      offsetRef.current = clamped;
      setOffset(clamped);
    }

    function onDown(event: globalThis.PointerEvent) {
      if (event.button !== 0) return;
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        originX: offsetRef.current.x,
        originY: offsetRef.current.y,
      };
      setGrabbing(true);
    }

    function onMove(event: globalThis.PointerEvent) {
      const drag = dragRef.current;
      if (!drag) return;
      applyOffset({
        x: drag.originX + (event.clientX - drag.startX),
        y: drag.originY + (event.clientY - drag.startY),
      });
    }

    function onUp() {
      if (!dragRef.current) return;
      dragRef.current = null;
      setGrabbing(false);
    }

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      applyOffset({
        x: offsetRef.current.x - event.deltaX - (event.shiftKey ? event.deltaY : 0),
        y: offsetRef.current.y - (event.shiftKey ? 0 : event.deltaY),
      });
    }

    viewport.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      viewport.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      viewport.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div
      ref={viewportRef}
      data-testid="topology-canvas"
      className={cn(
        "h-20 overflow-hidden overscroll-none select-none touch-none",
        grabbing ? "cursor-grabbing" : "cursor-grab",
      )}
      style={{
        backgroundImage:
          "radial-gradient(circle, rgb(163 163 163 / 0.28) 0.6px, transparent 0.7px)",
        backgroundSize: "10px 10px",
      }}
    >
      <div
        ref={contentRef}
        data-testid="topology-canvas-content"
        className="flex h-full w-max items-center"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        {children}
      </div>
    </div>
  );
}

function buildNodes(
  connection: StoredConnection,
  sessionStatus: "idle" | "connecting" | "connected" | "error",
  hopStatuses: Record<number, TopologyHopStatus>,
  databaseRtt: TopologyRttMetric,
): TopologyNode[] {
  const hops = connection.ssh.enabled ? connection.ssh.hops : [];
  const hasFailedHop = Object.values(hopStatuses).some((s) => s.status === "failed");
  const mysqlStatus: NodeStatus =
    sessionStatus === "connected"
      ? "connected"
      : sessionStatus === "error" && !hasFailedHop
        ? "failed"
        : "pending";

  return [
    {
      id: "local",
      title: "本机",
      subtitle: "127.0.0.1",
      status: "connected",
      reason: null,
      rttKind: "ssh",
      rttState: "idle",
      rttMs: null,
    },
    ...hops.map((hop, index) => {
      const tracked = hopStatuses[index];
      return {
        id: `hop-${index}`,
        title: `第 ${index + 1} 跳`,
        subtitle: `${hop.host}:${hop.port}`,
        status: tracked?.status ?? (sessionStatus === "connected" ? "connected" : "pending"),
        reason: tracked?.reason ?? null,
        rttKind: "ssh" as const,
        rttState: tracked?.rttState ?? "idle",
        rttMs: tracked?.rttMs ?? null,
      } satisfies TopologyNode;
    }),
    {
      id: "database",
      title: driverLabel(connection.driver),
      subtitle: isFileBasedDriver(connection.driver)
        ? connection.database
        : `${connection.host}:${connection.port}`,
      status: mysqlStatus,
      reason: null,
      rttKind: "db",
      rttState: databaseRtt.rttState,
      rttMs: databaseRtt.rttMs,
    },
  ];
}

function TopologySegment({
  node,
  nextNode,
  isLast,
}: {
  node: TopologyNode;
  nextNode: TopologyNode | null;
  isLast: boolean;
}) {
  return (
    <>
      <TopologyCard node={node} />
      {!isLast && (
        <div className="relative flex w-14 shrink-0 items-center px-2">
          {nextNode && <RttLabel node={nextNode} />}
          <div
            aria-hidden="true"
            className={`h-0.5 w-full rounded-full ${
              nextNode ? LINE_CLASS[nextNode.status] : LINE_CLASS.pending
            }`}
          />
        </div>
      )}
    </>
  );
}

function RttLabel({ node }: { node: TopologyNode }) {
  if (node.rttState === "idle") return null;
  const label =
    node.rttState === "measured" && node.rttMs !== null
      ? node.rttMs < 1
        ? "<1 ms"
        : `${Math.round(node.rttMs)} ms`
      : node.rttState === "timeout"
        ? "超时"
        : "不可用";
  const title =
    node.rttKind === "db"
      ? `累计到${node.title}的 SELECT 1 往返时间；经过整条链路，不是单段延迟`
      : `累计到${node.title}的 SSH 协议探测 RTT；不是 ICMP，也不是单段链路延迟`;
  return (
    <span
      title={title}
      className={cn(
        "absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-1 text-[10px] font-medium",
        node.rttState === "measured"
          ? "text-emerald-700 dark:text-emerald-300"
          : "text-amber-700 dark:text-amber-300",
      )}
    >
      {label}
    </span>
  );
}

function TopologyCard({ node }: { node: TopologyNode }) {
  return (
    <div
      title={node.reason ? translateError(node.reason) : undefined}
      className={`flex h-11 w-auto min-w-28 max-w-72 shrink-0 flex-col justify-between rounded-md border px-2.5 py-1.5 text-left shadow-sm ${NODE_CLASS[node.status]}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold leading-none">{node.title}</span>
        <span className="shrink-0 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium leading-none dark:bg-black/20">
          {STATUS_LABEL[node.status]}
        </span>
      </div>
      <div
        title={node.subtitle}
        className="truncate font-mono text-[11px] leading-none opacity-80"
      >
        {node.subtitle}
      </div>
    </div>
  );
}
