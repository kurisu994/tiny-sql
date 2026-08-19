import { render, screen } from "@testing-library/react";
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
  it("显示累计 SSH 协议 RTT 并明确不是 ICMP", () => {
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

    expect(screen.getByText("SSH 13 ms")).toHaveAttribute(
      "title",
      expect.stringContaining("不是 ICMP"),
    );
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

    expect(screen.getByText("SSH 超时")).toBeInTheDocument();
    expect(screen.getAllByText("正常")).toHaveLength(3);
  });
});
