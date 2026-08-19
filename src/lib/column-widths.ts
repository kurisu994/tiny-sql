// 结果表格列宽持久化（FR-111）
//
// 按「连接 + 列签名」存到 localStorage：同一结果结构（列名序列相同）共享列宽；
// 不存任何业务数据，只有像素宽度。提供恢复默认（清除）能力。

const PREFIX = "tiny-sql:col-widths:v1:";

export const DEFAULT_COLUMN_WIDTH = 160;
export const MIN_COLUMN_WIDTH = 64;
export const MAX_COLUMN_WIDTH = 640;

/** 列签名：列名序列是同一结果结构的稳定标识（用不可见分隔符防列名拼接歧义）。 */
export function columnWidthsKey(connectionId: string, columns: string[]): string {
  return `${PREFIX}${connectionId}:${columns.join("\u001f")}`;
}

/** 读取持久化列宽（列下标 → 像素宽度）。 */
export function loadColumnWidths(key: string): Record<number, number> {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const widths: Record<number, number> = {};
    for (const [index, width] of Object.entries(parsed)) {
      const i = Number(index);
      if (
        Number.isInteger(i) &&
        i >= 0 &&
        typeof width === "number" &&
        Number.isFinite(width)
      ) {
        widths[i] = clampColumnWidth(width);
      }
    }
    return widths;
  } catch {
    return {};
  }
}

/** 持久化列宽；空对象时直接移除 key，等价恢复默认。 */
export function saveColumnWidths(key: string, widths: Record<number, number>): void {
  try {
    if (Object.keys(widths).length === 0) {
      globalThis.localStorage?.removeItem(key);
      return;
    }
    globalThis.localStorage?.setItem(key, JSON.stringify(widths));
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级为会话内有效
  }
}

/** 清除持久化列宽（恢复默认）。 */
export function clearColumnWidths(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // 同上，静默降级
  }
}

export function clampColumnWidth(width: number): number {
  return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.round(width)));
}
