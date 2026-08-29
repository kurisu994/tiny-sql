import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TopologyGraph } from "@/components/topology-graph";
import type { StoredConnection } from "@/lib/tauri-api";

const connection: StoredConnection = {
  id: "c1",
  name: "prod",
  driver: "postgresql",
  host: "db.internal",
  port: 5432,
  user: "postgres",
  password: "",
  database: "app",
  ssh: {
    enabled: true,
    hops: [
      {
        host: "bastion.internal",
        port: 22,
        username: "deploy",
        authType: "password",
        password: "",
      },
    ],
  },
  ssl: {
    mode: "disabled",
    caPath: "",
    clientCertPath: "",
    clientKeyPath: "",
  },
  advanced: {
    keepAliveEnabled: true,
    keepAliveIntervalSeconds: 60,
    keepAliveFailureThreshold: 3,
    connectTimeoutEnabled: true,
    connectTimeoutSeconds: 30,
    readTimeoutEnabled: false,
    readTimeoutSeconds: 30,
    writeTimeoutEnabled: true,
    writeTimeoutSeconds: 30,
    compressionEnabled: false,
    autoConnect: false,
  },
};

describe("TopologyGraph SSH RTT", () => {
  it("显示累计协议 RTT 且标签不含 SSH 前缀", () => {
    render(
      <TopologyGraph
        connection={connection}
        sessionStatus="connected"
        hopStatuses={{
          0: {
            status: "connected",
            reason: null,
            rttState: "measured",
            rttMs: 12.6,
          },
        }}
      />,
    );

    expect(screen.getByText("13 ms")).toHaveAttribute(
      "title",
      expect.stringContaining("不是 ICMP"),
    );
    expect(screen.queryByText("SSH 13 ms")).not.toBeInTheDocument();
    expect(screen.getByText("PostgreSQL")).toBeInTheDocument();
  });

  it("RTT 超时独立显示且不把节点改成断开", () => {
    render(
      <TopologyGraph
        connection={connection}
        sessionStatus="connected"
        hopStatuses={{
          0: {
            status: "connected",
            reason: null,
            rttState: "timeout",
            rttMs: null,
          },
        }}
      />,
    );

    expect(screen.getByText("超时")).toBeInTheDocument();
    expect(screen.queryByText("SSH 超时")).not.toBeInTheDocument();
    expect(screen.getAllByText("正常")).toHaveLength(3);
  });

  it("数据库节点显示 SELECT 1 累计延迟", () => {
    render(
      <TopologyGraph
        connection={connection}
        sessionStatus="connected"
        hopStatuses={{
          0: {
            status: "connected",
            reason: null,
            rttState: "measured",
            rttMs: 12.6,
          },
        }}
        databaseRtt={{ rttState: "measured", rttMs: 18.2 }}
      />,
    );

    expect(screen.getByText("18 ms")).toHaveAttribute(
      "title",
      expect.stringContaining("SELECT 1"),
    );
  });

  it("拖动画布会平移内容", () => {
    render(
      <TopologyGraph
        connection={connection}
        sessionStatus="connected"
        hopStatuses={{}}
      />,
    );
    const canvas = screen.getByTestId("topology-canvas");
    const content = screen.getByTestId("topology-canvas-content");
    fireEvent.pointerDown(canvas, { button: 0, clientX: 120, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 80, clientY: 10 });
    expect(content.style.transform).toBe("translate(-40px, 0px)");
  });
});
