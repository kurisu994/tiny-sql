// 单元格检查器（FR-273）：JSON 格式化，失败保持原文。

export function formatCellDisplay(value: string | null): {
  kind: "null" | "empty" | "json" | "text";
  text: string;
} {
  if (value === null) return { kind: "null", text: "NULL" };
  if (value === "") return { kind: "empty", text: "（空字符串）" };
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return { kind: "json", text: JSON.stringify(JSON.parse(trimmed), null, 2) };
    } catch {
      // 不是合法 JSON，按原文展示
    }
  }
  return { kind: "text", text: value };
}
