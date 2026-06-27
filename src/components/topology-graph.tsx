"use client";

import { useMemo } from "react";

import {
  Background,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";

import { translateError, type StoredConnection } from "@/lib/tauri-api";
import type { TopologyHopStatus } from "@/stores/session-store";

type NodeStatus = "pending" | "connected" | "failed" | "lost";

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: "连接中",
  connected: "正常",
  failed: "失败",
  lost: "断开",
};

const STATUS_CLASS: Record<NodeStatus, string> = {
  pending: "border-neutral-300 bg-white text-neutral-600 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300",
  connected: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  failed: "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200",
  lost: "border-red-400 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
};

export function TopologyGraph({
  connection,
  sessionStatus,
  hopStatuses,
}: {
  connection: StoredConnection;
  sessionStatus: "idle" | "connecting" | "connected" | "error";
  hopStatuses: Record<number, TopologyHopStatus>;
}) {
  const { nodes, edges } = useMemo(
    () => buildGraph(connection, sessionStatus, hopStatuses),
    [connection, sessionStatus, hopStatuses],
  );

  return (
    <div className="h-40 border-b border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        fitViewOptions={{ padding: 0.16 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        preventScrolling={false}
      >
        <Background gap={18} size={1} color="rgba(120, 120, 120, 0.16)" />
      </ReactFlow>
    </div>
  );
}

function buildGraph(
  connection: StoredConnection,
  sessionStatus: "idle" | "connecting" | "connected" | "error",
  hopStatuses: Record<number, TopologyHopStatus>,
): { nodes: Node[]; edges: Edge[] } {
  const hops = connection.ssh.enabled ? connection.ssh.hops : [];
  const statuses: NodeStatus[] = [
    "connected",
    ...hops.map((_, index) => {
      const tracked = hopStatuses[index]?.status;
      if (tracked) return tracked;
      return sessionStatus === "connected" ? "connected" : "pending";
    }),
    sessionStatus === "connected"
      ? "connected"
      : sessionStatus === "error" && !Object.values(hopStatuses).some((s) => s.status === "failed")
        ? "failed"
        : "pending",
  ];

  const nodeDefs = [
    {
      id: "local",
      title: "本机",
      subtitle: "127.0.0.1",
      status: statuses[0],
      reason: null,
    },
    ...hops.map((hop, index) => ({
      id: `hop-${index}`,
      title: `第 ${index + 1} 跳`,
      subtitle: `${hop.host}:${hop.port}`,
      status: statuses[index + 1],
      reason: hopStatuses[index]?.reason ?? null,
    })),
    {
      id: "mysql",
      title: "MySQL",
      subtitle: `${connection.host}:${connection.port}`,
      status: statuses[statuses.length - 1],
      reason: null,
    },
  ];

  const nodes: Node[] = nodeDefs.map((node, index) => ({
    id: node.id,
    type: "default",
    position: { x: index * 190, y: 34 },
    data: {
      label: (
        <TopologyLabel
          title={node.title}
          subtitle={node.subtitle}
          status={node.status}
          reason={node.reason}
        />
      ),
    },
    style: {
      width: 156,
      border: "none",
      borderRadius: 8,
      padding: 0,
      background: "transparent",
      boxShadow: "none",
    },
  }));

  const edges: Edge[] = nodeDefs.slice(0, -1).map((node, index) => {
    const target = nodeDefs[index + 1];
    const targetStatus = target.status;
    const connected = node.status === "connected" && targetStatus === "connected";
    const broken = targetStatus === "failed" || targetStatus === "lost";
    return {
      id: `${node.id}-${target.id}`,
      source: node.id,
      target: target.id,
      type: "bezier",
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        strokeWidth: 2,
        stroke: broken ? "#dc2626" : connected ? "#059669" : "#a3a3a3",
      },
      animated: targetStatus === "pending",
    };
  });

  return { nodes, edges };
}

function TopologyLabel({
  title,
  subtitle,
  status,
  reason,
}: {
  title: string;
  subtitle: string;
  status: NodeStatus;
  reason: string | null;
}) {
  return (
    <div
      title={reason ? translateError(reason) : undefined}
      className={`flex h-20 w-[156px] flex-col justify-between rounded-lg border px-3 py-2 text-left shadow-sm ${STATUS_CLASS[status]}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold">{title}</span>
        <span className="shrink-0 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium dark:bg-black/20">
          {STATUS_LABEL[status]}
        </span>
      </div>
      <div className="truncate font-mono text-[11px] opacity-80">{subtitle}</div>
    </div>
  );
}
