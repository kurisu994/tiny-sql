import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import type { StoredConnection } from "@/lib/tauri-api";
import { ConnectionForm } from "@/components/connection-form";

describe("ConnectionForm", () => {
  it("新建模式渲染标题与字段", () => {
    render(<ConnectionForm editing={null} onDone={() => {}} />);
    expect(screen.getByText("新建连接")).toBeInTheDocument();
    expect(screen.getByText("连接名称")).toBeInTheDocument();
    expect(screen.getByText("主机")).toBeInTheDocument();
  });

  it("编辑模式显示连接名与删除按钮", () => {
    const conn: StoredConnection = {
      id: "1",
      name: "prod-db",
      host: "h",
      port: 3306,
      user: "u",
      password: "",
      database: "",
      ssh: { enabled: false, hops: [] },
    };
    render(<ConnectionForm editing={conn} onDone={() => {}} />);
    expect(screen.getByText(/编辑连接：prod-db/)).toBeInTheDocument();
    expect(screen.getByText("删除")).toBeInTheDocument();
  });
});
