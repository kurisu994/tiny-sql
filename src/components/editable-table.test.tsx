import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom 无布局高度，Virtuoso 不会渲染行；mock 为简单列表逐行渲染 itemContent
vi.mock("react-virtuoso", () => ({
  Virtuoso: ({
    data,
    itemContent,
  }: {
    data: unknown[];
    itemContent: (index: number, item: unknown) => React.ReactNode;
  }) => <div>{data.map((item, i) => itemContent(i, item))}</div>,
}));

import { EditableTable } from "@/components/editable-table";
import type { RowSet } from "@/lib/tauri-api";
import type { PendingEdit } from "@/stores/session-store";

const rowSet: RowSet = {
  columns: ["id", "name", "note"],
  rows: [
    ["1", "alpha", null],
    ["2", "beta", "n2"],
  ],
  truncated: false,
};

function renderTable(pendingEdits: PendingEdit[] = []) {
  const onCellEdit = vi.fn();
  const onToggleDelete = vi.fn();
  const onAddRow = vi.fn();
  render(
    <EditableTable
      rowSet={rowSet}
      connectionId="c1"
      pkColumns={["id"]}
      pendingEdits={pendingEdits}
      onCellEdit={onCellEdit}
      onToggleDelete={onToggleDelete}
      onAddRow={onAddRow}
    />,
  );
  return { onCellEdit, onToggleDelete, onAddRow };
}

beforeEach(() => {
  localStorage.clear();
});

describe("EditableTable（FR-250）", () => {
  it("双击单元格进入编辑，Enter 保存为变更", () => {
    const { onCellEdit } = renderTable();
    // id 是主键列，不可编辑；双击 name 列
    fireEvent.doubleClick(screen.getByText("alpha"));
    const input = screen.getByDisplayValue("alpha");
    fireEvent.change(input, { target: { value: "gamma" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCellEdit).toHaveBeenCalledWith('"1"', "name", "gamma");
  });

  it("Shift+Enter 置为 NULL；Esc 取消不写回", () => {
    const { onCellEdit } = renderTable();
    fireEvent.doubleClick(screen.getByText("beta"));
    const input = screen.getByDisplayValue("beta");
    fireEvent.change(input, { target: { value: "whatever" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onCellEdit).toHaveBeenCalledWith('"2"', "name", null);

    // Esc：不产生调用
    onCellEdit.mockClear();
    fireEvent.doubleClick(screen.getByText("beta"));
    const input2 = screen.getByDisplayValue("beta");
    fireEvent.keyDown(input2, { key: "Escape" });
    expect(onCellEdit).not.toHaveBeenCalled();
  });

  it("主键列双击不进入编辑", () => {
    renderTable();
    // 数据单元格带 title（序号列无 title），精确定位 id 列的 "1"
    fireEvent.doubleClick(screen.getByTitle("1"));
    expect(screen.queryByDisplayValue("1")).toBeNull();
  });

  it("删除按钮触发 onToggleDelete；delete 行划线且不可编辑", () => {
    const deleted: PendingEdit[] = [
      {
        rowKey: '"2"',
        kind: "delete",
        original: { id: "2", name: "beta", note: "n2" },
        values: {},
      },
    ];
    const { onToggleDelete } = renderTable(deleted);
    const deleteButtons = screen.getAllByRole("button", { name: /删除行|撤销删除/ });
    fireEvent.click(deleteButtons[0]);
    expect(onToggleDelete).toHaveBeenCalledWith('"1"');

    // delete 行（第 2 行）双击不进入编辑
    fireEvent.doubleClick(screen.getByText("beta"));
    expect(screen.queryByDisplayValue("beta")).toBeNull();
  });

  it("update dirty 覆盖显示变更值并高亮", () => {
    const dirty: PendingEdit[] = [
      {
        rowKey: '"1"',
        kind: "update",
        original: { id: "1", name: "alpha", note: null },
        values: { name: "gamma" },
      },
    ];
    renderTable(dirty);
    expect(screen.getByText("gamma")).toBeTruthy();
    expect(screen.queryByText("alpha")).toBeNull();
  });

  it("新增草稿行可编辑并提交 insert 值；+ 新增行触发 onAddRow", () => {
    const drafts: PendingEdit[] = [
      { rowKey: "__new_1", kind: "insert", original: null, values: {} },
    ];
    const { onCellEdit, onAddRow } = renderTable(drafts);
    // 草稿行的 name 列（显示 NULL 占位）
    const nullCells = screen.getAllByText("NULL");
    // 草稿行有三列全 NULL；找最后一组（草稿行在最后）
    fireEvent.doubleClick(nullCells[nullCells.length - 1]);
    const input = screen.getByDisplayValue("");
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCellEdit).toHaveBeenCalledWith("__new_1", "note", "hello");

    fireEvent.click(screen.getByText("+ 新增行"));
    expect(onAddRow).toHaveBeenCalled();
  });

  it("新增行允许编辑主键列（已有行不允许）", () => {
    const drafts: PendingEdit[] = [
      { rowKey: "__new_1", kind: "insert", original: null, values: {} },
    ];
    const { onCellEdit } = renderTable(drafts);
    // 草稿行第一列是 id（主键列）：NULL 占位可双击
    const nullCells = screen.getAllByText("NULL");
    fireEvent.doubleClick(nullCells[nullCells.length - 3]);
    const input = screen.getByDisplayValue("");
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCellEdit).toHaveBeenCalledWith("__new_1", "id", "99");
  });
});
