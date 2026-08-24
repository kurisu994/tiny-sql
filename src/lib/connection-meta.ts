import type { ConnectionEnv, StoredConnection } from "@/lib/tauri-api";

export function isReadOnly(connection?: Pick<StoredConnection, "readOnly"> | null): boolean {
  return Boolean(connection?.readOnly);
}

export function connectionEnv(connection?: Pick<StoredConnection, "env"> | null): ConnectionEnv {
  const env = connection?.env;
  return env === "prod" || env === "staging" || env === "dev" ? env : "none";
}

export function envLabel(env?: ConnectionEnv | string | null): string {
  switch (env) {
    case "prod":
      return "生产";
    case "staging":
      return "预发";
    case "dev":
      return "开发";
    default:
      return "";
  }
}

export function envDotClass(env?: ConnectionEnv | string | null): string {
  switch (env) {
    case "prod":
      return "bg-red-500";
    case "staging":
      return "bg-amber-500";
    case "dev":
      return "bg-sky-500";
    default:
      return "bg-neutral-300 dark:bg-neutral-600";
  }
}

export function envTextClass(env?: ConnectionEnv | string | null): string {
  switch (env) {
    case "prod":
      return "text-red-700 dark:text-red-300";
    case "staging":
      return "text-amber-700 dark:text-amber-300";
    case "dev":
      return "text-sky-700 dark:text-sky-300";
    default:
      return "text-neutral-500";
  }
}

/** 确认框里重复环境 / 只读，避免连错库。 */
export function connectionSafetyLine(connection?: StoredConnection | null): string {
  if (!connection) return "";
  const bits = [
    connection.name,
    envLabel(connectionEnv(connection)),
    isReadOnly(connection) ? "应用只读" : "",
  ].filter(Boolean);
  return bits.join(" · ");
}
