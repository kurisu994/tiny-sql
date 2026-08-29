import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { ErView } from "@/components/er-view";
import { metadataCache } from "@/lib/metadata-cache";
import type { StoredConnection, TableOverview } from "@/lib/tauri-api";
import { useSessionStore } from "@/stores/session-store";

const connection: StoredConnection = {
  id: "c1",
  name: "local",
  driver: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "tester",
  password: "",
  database: "app",
  ssh: { enabled: false, hops: [] },
  ssl: { mode: "disabled", caPath: "", clientCertPath: "", clientKeyPath: "" },
  advanced: {
    keepAliveEnabled: false,
    keepAliveIntervalSeconds: 240,
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

const tables: TableOverview[] = [
  {
    name: "orders",
    comment: "订单表",
    columns: [
      { name: "user_id", dataType: "bigint(20)", nullable: false, columnKey: "MUL", defaultValue: null, comment: "下单用户" },
      { name: "id", dataType: "bigint(20)", nullable: false, columnKey: "PRI", defaultValue: null, comment: null },
    ],
    constraints: [
      { name: "PRIMARY", constraintType: "PRIMARY KEY", columns: ["id"], reference: null },
      { name: "fk_user", constraintType: "FOREIGN KEY", columns: ["user_id"], reference: "app.users(id)" },
    ],
  },
  {
    name: "users",
    comment: null,
    columns: [
      { name: "id", dataType: "bigint(20)", nullable: false, columnKey: "PRI", defaultValue: null, comment: null },
    ],
    constraints: [
      { name: "PRIMARY", constraintType: "PRIMARY KEY", columns: ["id"], reference: null },
    ],
  },
];

beforeEach(() => {
  // jsdom 没有 ResizeObserver / 布局尺寸，补最小实现让画布逻辑跑通
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  metadataCache.clear();
  vi.mocked(invoke).mockResolvedValue(tables);
  useSessionStore.setState({
    openId: "c1",
    activeConnection: connection,
    selectedDb: "app",
    selectedSchema: null,
    selectTable: vi.fn(),
  });
});

describe("ErView", () => {
  it("实体按表头 + 列清单渲染，主键排在最上", async () => {
    render(<ErView />);
    const orders = await screen.findByTestId("er-entity-orders");
    const columns = [...orders.querySelectorAll("[data-column]")].map(
      (el) => el.getAttribute("data-column"),
    );
    expect(columns).toEqual(["id", "user_id"]);
    expect(orders).toHaveTextContent("订单表");
    expect(orders).toHaveTextContent("bigint(20)");
    expect(orders).toHaveTextContent("下单用户");
  });

  it("外键画出连线，点击后显示引用明细", async () => {
    const { container } = render(<ErView />);
    await screen.findByTestId("er-entity-orders");
    const edge = container.querySelector("[data-edge]");
    expect(edge).not.toBeNull();
    fireEvent.click(edge!);
    await waitFor(() =>
      expect(screen.getByTestId("er-edge-detail").textContent).toContain(
        "orders.user_id → users.id",
      ),
    );
  });

  it("折叠后只留表头", async () => {
    render(<ErView />);
    const orders = await screen.findByTestId("er-entity-orders");
    expect(orders.querySelectorAll("[data-column]")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("折叠为表头"));
    await waitFor(() =>
      expect(
        screen.getByTestId("er-entity-orders").querySelectorAll("[data-column]"),
      ).toHaveLength(0),
    );
  });

  it("缩放直接改画布 transform，不经 React 状态", async () => {
    render(<ErView />);
    await screen.findByTestId("er-entity-orders");
    const content = screen.getByTestId("er-canvas-content");
    const before = content.style.transform;
    fireEvent.wheel(screen.getByTestId("er-canvas"), { deltaY: -200, ctrlKey: true });
    await waitFor(() => expect(content.style.transform).not.toBe(before));
    expect(content.style.transform).toMatch(/scale\(/);
  });
});
