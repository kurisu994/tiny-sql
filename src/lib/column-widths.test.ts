import { beforeEach, describe, expect, it } from "vitest";

import {
  clampColumnWidth,
  clearColumnWidths,
  columnWidthsKey,
  DEFAULT_COLUMN_WIDTH,
  loadColumnWidths,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  saveColumnWidths,
} from "@/lib/column-widths";

const KEY = columnWidthsKey("c1", ["id", "name"]);

beforeEach(() => {
  localStorage.clear();
});

describe("column-widths", () => {
  it("保存并读回列宽", () => {
    saveColumnWidths(KEY, { 0: 220, 2: 120 });
    expect(loadColumnWidths(KEY)).toEqual({ 0: 220, 2: 120 });
  });

  it("列签名隔离：不同连接或列结构互不命中", () => {
    saveColumnWidths(KEY, { 0: 300 });
    expect(loadColumnWidths(columnWidthsKey("c1", ["id", "name"]))).toEqual({
      0: 300,
    });
    expect(loadColumnWidths(columnWidthsKey("c2", ["id", "name"]))).toEqual({});
    expect(loadColumnWidths(columnWidthsKey("c1", ["id"]))).toEqual({});
  });

  it("宽度 clamp 到合法区间并拒绝脏数据", () => {
    expect(clampColumnWidth(1)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(99999)).toBe(MAX_COLUMN_WIDTH);
    saveColumnWidths(KEY, { 0: 10, x: 100, 3: Number.NaN } as Record<
      number,
      number
    >);
    const loaded = loadColumnWidths(KEY);
    expect(loaded[0]).toBe(MIN_COLUMN_WIDTH);
    expect(loaded[3]).toBeUndefined();
    expect(loaded["x" as unknown as number]).toBeUndefined();
  });

  it("清除后恢复默认宽度", () => {
    saveColumnWidths(KEY, { 1: 400 });
    clearColumnWidths(KEY);
    expect(loadColumnWidths(KEY)).toEqual({});
    expect(DEFAULT_COLUMN_WIDTH).toBeGreaterThan(0);
  });

  it("空对象保存等价于清除（恢复默认）", () => {
    saveColumnWidths(KEY, { 0: 200 });
    saveColumnWidths(KEY, {});
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
