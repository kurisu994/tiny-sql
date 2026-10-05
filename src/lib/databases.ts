import type { DatabaseMeta } from "@/lib/tauri-api";

/**
 * 对比页默认库：当前库优先，跳过 SQLite 的 temp。
 * 没有可选库时返回空串，交给下拉框的占位项。
 */
export function preferredDatabase(databases: DatabaseMeta[]): string {
  const current = databases.find((item) => item.isCurrent && !item.temporary);
  if (current) return current.name;
  const user = databases.find((item) => !item.temporary);
  return user?.name ?? "";
}
