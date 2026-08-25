"use client";

import { useMemo } from "react";

import {
  driverLabel,
  isFileBasedDriver,
  translateError,
  type StoredConnection,
} from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import type { TopologyHopStatus } from "@/stores/session-store";

type NodeStatus = "pending" | "connected" | "failed" | "lost";

type TopologyNode = {
  id: string;
  title: string;
  subtitle: string;
  status: NodeStatus;
  reason: string | null;
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

export function TopologyGraph({
  connection,
  sessionStatus,
  hopStatuses,
}: {
  connection: StoredConnection;
  sessionStatus: "idle" | "connecting" | "connected" | "error";
  hopStatuses: Record<number, TopologyHopStatus>;
}) {
  const nodes = useMemo(
    () => buildNodes(connection, sessionStatus, hopStatuses),
    [connection, sessionStatus, hopStatuses],
  );

  return (
    <div className="border-b border-neutral-200 bg-neutral-50 px-5 py-3 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex h-16 items-center overflow-x-auto overflow-y-hidden">
        {nodes.map((node, index) => (
          <TopologySegment
            key={node.id}
            node={node}
            nextNode={nodes[index + 1] ?? null}
            isLast={index === nodes.length - 1}
          />
        ))}
      </div>
    </div>
  );
}

function buildNodes(
  connection: StoredConnection,
  sessionStatus: "idle" | "connecting" | "connected" | "error",
  hopStatuses: Record<number, TopologyHopStatus>,
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
      rttState: "idle",
      rttMs: null,
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
        <div className="relative flex w-20 shrink-0 items-center px-2">
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
        ? "SSH <1 ms"
        : `SSH ${Math.round(node.rttMs)} ms`
      : node.rttState === "timeout"
        ? "SSH 超时"
        : "SSH 不可用";
  return (
    <span
      title={`累计到${node.title}的 SSH 协议探测 RTT；不是 ICMP，也不是单段链路延迟`}
      className={cn(
        "absolute -top-4 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-1 text-[10px] font-medium",
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
      className={`flex h-14 w-36 shrink-0 flex-col justify-between rounded-md border px-3 py-2 text-left shadow-sm ${NODE_CLASS[node.status]}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-sm font-semibold leading-none">{node.title}</span>
        <span className="shrink-0 rounded-full bg-white/70 px-1.5 py-0.5 text-[10px] font-medium leading-none dark:bg-black/20">
          {STATUS_LABEL[node.status]}
        </span>
      </div>
      <div className="truncate font-mono text-[11px] leading-none opacity-80">{node.subtitle}</div>
    </div>
  );
}
