import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/components/sql-code-editor", () => ({
  SqlCodeEditor: () => <div data-testid="sql-editor" />,
}));
vi.mock("@/components/topology-graph", () => ({
  TopologyGraph: () => <div data-testid="topology" />,
}));

import { invoke } from "@tauri-apps/api/core";

import { SchemaBrowser } from "@/components/schema-browser";
import { metadataCache } from "@/lib/metadata-cache";
import type { StoredConnection } from "@/lib/tauri-api";
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
  ssl: {
    mode: "disabled",
    caPath: "",
    clientCertPath: "",
    clientKeyPath: "",
  },
  advanced: {
    keepAliveEnabled: false,
    keepAliveIntervalSeconds: 240,
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

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  metadataCache.clear();
  useSessionStore.setState({
    openId: "c1",
    activeConnection: connection,
    status: "connected",
    databases: [{ name: "app", isCurrent: true }],
    expandedDb: "app",
    selectedDb: "app",
    schemas: [],
    expandedSchema: null,
    selectedSchema: null,
    tables: [
      { name: "users", tableType: "BASE TABLE", rows: 1, comment: "用户表" },
    ],
    expandedTable: "users",
    tableColumns: [
      {
        name: "id",
        dataType: "bigint unsigned",
        nullable: false,
        columnKey: "PRI",
        defaultValue: "0",
        comment: "用户编号",
      },
    ],
    columnsByTable: {
      users: [
        {
          name: "id",
          dataType: "bigint unsigned",
          nullable: false,
          columnKey: "PRI",
          defaultValue: "0",
          comment: "用户编号",
        },
      ],
    },
    loadingColumns: false,
    refreshingMetadata: false,
    selectedTable: null,
    rowSet: null,
    loadingData: false,
    errorMsg: null,
    queryErrorMsg: null,
    queryRunning: false,
  });
});

describe("SchemaBrowser column tree", () => {
  it("展示列类型、nullable、key、default 与 comment", () => {
    render(<SchemaBrowser connection={connection} />);

    expect(screen.getByText("id")).toBeInTheDocument();
    expect(screen.getByText("bigint unsigned")).toBeInTheDocument();
    expect(screen.getByText("NOT NULL")).toBeInTheDocument();
    expect(screen.getByText("PRI")).toBeInTheDocument();
    expect(screen.getByText("默认 0")).toBeInTheDocument();
    expect(screen.getByText("用户编号")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "收起 users 的列" }),
    ).toBeInTheDocument();
  });

  it("手动刷新当前数据库对象", async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      const result: Record<string, unknown> = {
        db_list_databases: [{ name: "app", isCurrent: true }],
        db_list_tables: [
          { name: "users", tableType: "BASE TABLE", rows: 1, comment: null },
        ],
        db_list_columns: [
          {
            name: "fresh_column",
            dataType: "text",
            nullable: true,
            columnKey: "",
            defaultValue: null,
            comment: null,
          },
        ],
      };
      return Promise.resolve(result[command]);
    });
    render(<SchemaBrowser connection={connection} />);

    fireEvent.click(screen.getByRole("button", { name: "刷新数据库对象" }));

    await waitFor(() =>
      expect(screen.getByText("fresh_column")).toBeInTheDocument(),
    );
  });
});
