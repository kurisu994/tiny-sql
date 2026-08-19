import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";

import { HistoryPanel } from "@/components/history-panel";

const mockInvoke = vi.mocked(invoke);

const sampleEntries = [
  {
    id: "h1",
    connectionId: "c1",
    connectionName: "生产读库",
    driver: "mysql",
    database: "app",
    schema: null,
    sql: "SELECT * FROM users LIMIT 10",
    executedAt: "2026-08-19T10:00:00Z",
    success: true,
  },
  {
    id: "h2",
    connectionId: "c2",
    connectionName: "分析库",
    driver: "postgresql",
    database: "analytics",
    schema: "public",
    sql: "SELECT count(*) FROM events",
    executedAt: "2026-08-19T09:00:00Z",
    success: false,
  },
];

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("HistoryPanel", () => {
  it("加载并展示历史条目，点击回填", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "history_list") return Promise.resolve(sampleEntries);
      return Promise.resolve(undefined);
    });
    const onPick = vi.fn();
    render(<HistoryPanel onPick={onPick} onClose={() => {}} />);

    await waitFor(() =>
      expect(screen.getByText(/SELECT \* FROM users/)).toBeInTheDocument(),
    );
    expect(screen.getByText("生产读库 · app")).toBeInTheDocument();
    // PostgreSQL 条目带 schema 前缀
    expect(screen.getByText(/analytics\.public/)).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();

    fireEvent.click(screen.getByText(/SELECT \* FROM users/));
    expect(onPick).toHaveBeenCalledWith("SELECT * FROM users LIMIT 10");
  });

  it("历史为空与加载失败都有兜底展示", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "history_list") return Promise.resolve([]);
      return Promise.resolve(undefined);
    });
    const { unmount } = render(
      <HistoryPanel onPick={() => {}} onClose={() => {}} />,
    );
    await waitFor(() =>
      expect(screen.getByText("暂无历史记录")).toBeInTheDocument(),
    );
    unmount();

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "history_list")
        return Promise.reject("error.security.locked");
      return Promise.resolve(undefined);
    });
    render(<HistoryPanel onPick={() => {}} onClose={() => {}} />);
    await waitFor(() =>
      expect(
        screen.getByText("已锁定，请先输入主密码解锁"),
      ).toBeInTheDocument(),
    );
  });
});
