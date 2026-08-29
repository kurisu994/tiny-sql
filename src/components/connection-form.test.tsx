import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
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
      driver: "mysql",
      host: "h",
      port: 3306,
      user: "u",
      password: "",
      database: "",
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
    render(<ConnectionForm editing={conn} onDone={() => {}} />);
    expect(screen.getByText(/编辑连接：prod-db/)).toBeInTheDocument();
    expect(screen.getByText("删除")).toBeInTheDocument();
  });

  it("切换 PostgreSQL 时更新默认端口与用户", () => {
    render(<ConnectionForm editing={null} onDone={() => {}} />);

    fireEvent.change(screen.getByLabelText("数据库类型"), {
      target: { value: "postgresql" },
    });

    expect(screen.getByLabelText("端口")).toHaveValue(5432);
    expect(screen.getByLabelText("用户")).toHaveValue("postgres");
    expect(screen.getByText(/当前使用驱动默认 TLS 策略/)).toBeInTheDocument();
  });

  it("新建连接使用 60 秒与连续 3 次 keepalive 默认值", () => {
    render(<ConnectionForm editing={null} onDone={() => {}} />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "高级" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(
      screen.getByRole("checkbox", { name: "保持连接间隔（秒）" }),
    ).toBeChecked();
    expect(
      screen.getByRole("spinbutton", { name: "保持连接间隔（秒）" }),
    ).toHaveValue(60);
    expect(
      screen.getByRole("spinbutton", { name: "连续失败阈值（次）" }),
    ).toHaveValue(3);
  });

  it("测试连接会转发仅用于本次握手的私钥 passphrase", async () => {
    vi.mocked(invoke).mockResolvedValue({
      tunnelMs: 320,
      connectMs: 45,
      pingMs: 12,
      totalMs: 380,
    });
    render(<ConnectionForm editing={null} onDone={() => {}} />);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "SSH" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(screen.getByLabelText("通过 SSH 跳板连接"));
    fireEvent.click(screen.getByRole("button", { name: "+ 添加跳板" }));
    fireEvent.change(screen.getByLabelText("认证方式"), {
      target: { value: "privateKey" },
    });
    fireEvent.change(screen.getByLabelText("私钥 passphrase（仅测试）"), {
      target: { value: "test-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "connection_test",
        expect.objectContaining({ passphrase: "test-secret" }),
      ),
    );
  });

  it("测试连接成功后显示延迟与各段耗时", async () => {
    vi.mocked(invoke).mockResolvedValue({
      tunnelMs: 318.4,
      connectMs: 45.2,
      pingMs: 12.6,
      totalMs: 376.2,
    });
    render(<ConnectionForm editing={null} onDone={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("✓ 连接成功 · 延迟 13 ms")).toBeInTheDocument();
    expect(
      screen.getByText("SSH 隧道 318 ms · 建立连接 45 ms · 总计 376 ms"),
    ).toBeInTheDocument();
  });

  it("直连没有隧道段，且不足 10ms 的延迟保留一位小数", async () => {
    vi.mocked(invoke).mockResolvedValue({
      tunnelMs: null,
      connectMs: 8.32,
      pingMs: 0.44,
      totalMs: 9.1,
    });
    render(<ConnectionForm editing={null} onDone={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

    expect(await screen.findByText("✓ 连接成功 · 延迟 0.4 ms")).toBeInTheDocument();
    expect(screen.getByText("建立连接 8.3 ms · 总计 9.1 ms")).toBeInTheDocument();
  });
});
