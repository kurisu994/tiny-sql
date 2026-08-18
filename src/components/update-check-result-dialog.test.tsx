import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UpdateCheckResultDialog } from "@/components/update-check-result-dialog";

describe("UpdateCheckResultDialog", () => {
  it("没有新版本时给出明确提示", () => {
    const onDismiss = vi.fn();

    render(
      <UpdateCheckResultDialog
        notice="当前已是最新版本"
        error={null}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("当前已是最新版本")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("检查失败时展示错误原因", () => {
    render(
      <UpdateCheckResultDialog
        notice={null}
        error="网络不可用"
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByText("检查更新失败")).toBeInTheDocument();
    expect(screen.getByText("网络不可用")).toBeInTheDocument();
  });
});
