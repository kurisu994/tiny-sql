import type { DriverKind } from "@/lib/tauri-api";

/** EXPLAIN ANALYZE 的 FORMAT 修饰 token，定位被分析语句时跳过 */
const EXPLAIN_FORMAT_TOKENS = new Set(["FORMAT", "TREE", "JSON", "TRADITIONAL"]);
const METADATA_MUTATION_TOKENS = new Set([
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "COMMENT",
]);

/**
 * best-effort 写操作识别：与后端按首 token 分类保持一致——SELECT/WITH 与
 * SHOW/EXPLAIN/DESC 等元数据语句不需要确认，其余一律弹写操作二次确认。
 * 只用于前端交互，后端 allow_write 护栏仍会重新校验。
 */
export function needsWriteConfirmation(
  sql: string,
  driver: DriverKind = "mysql",
): boolean {
  const tokens = sqlTokens(stripLiteralsAndComments(sql));
  const first = tokens[0];
  // 空 / 纯注释：不弹确认，交给后端报 invalid_sql
  if (!first) return false;
  if (first === "WITH") {
    return tokens
      .slice(1)
      .some((token) => ["INSERT", "UPDATE", "DELETE", "MERGE"].includes(token));
  }
  const safePrefixes =
    driver === "postgresql"
      ? ["SELECT", "TABLE", "VALUES", "SHOW", "EXPLAIN"]
      : ["SELECT", "SHOW", "EXPLAIN", "DESC", "DESCRIBE"];
  if (!safePrefixes.includes(first)) return true;
  // EXPLAIN ANALYZE 会真正执行被分析的语句：分析写语句时仍需确认
  if (first === "EXPLAIN" && tokens[1] === "ANALYZE") {
    const analyzed =
      tokens.slice(2).find((t) => !EXPLAIN_FORMAT_TOKENS.has(t)) ?? "";
    return !["SELECT", "WITH", "TABLE"].includes(analyzed);
  }
  return false;
}

/** 成功执行后需要失效 schema metadata cache 的 DDL 首 token。 */
export function invalidatesMetadataCache(sql: string): boolean {
  const first = sqlTokens(stripLiteralsAndComments(sql))[0];
  return first ? METADATA_MUTATION_TOKENS.has(first) : false;
}

function stripLiteralsAndComments(sql: string): string {
  let out = "";
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += " ";
      let escaped = false;
      i += 1;
      for (; i < sql.length; i += 1) {
        const c = sql[i];
        out += c === "\n" ? "\n" : " ";
        if (c === quote && !escaped) break;
        escaped = c === "\\" && !escaped;
        if (c !== "\\") escaped = false;
      }
      continue;
    }

    if (ch === "`") {
      out += " ";
      i += 1;
      for (; i < sql.length; i += 1) {
        const c = sql[i];
        out += c === "\n" ? "\n" : " ";
        if (c === "`") {
          if (sql[i + 1] === "`") {
            out += " ";
            i += 1;
            continue;
          }
          break;
        }
      }
      continue;
    }

    if (ch === "-" && next === "-") {
      out += "  ";
      i += 2;
      for (; i < sql.length; i += 1) {
        const c = sql[i];
        if (c === "\n") {
          out += "\n";
          break;
        }
        out += " ";
      }
      continue;
    }

    if (ch === "#") {
      out += " ";
      i += 1;
      for (; i < sql.length; i += 1) {
        const c = sql[i];
        if (c === "\n") {
          out += "\n";
          break;
        }
        out += " ";
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      for (; i < sql.length; i += 1) {
        const c = sql[i];
        out += c === "\n" ? "\n" : " ";
        if (sql[i - 1] === "*" && c === "/") break;
      }
      continue;
    }

    out += ch;
  }
  return out;
}

function sqlTokens(sql: string): string[] {
  return sql
    .split(/[^A-Za-z0-9_]+/)
    .filter(Boolean)
    .map((token) => token.toUpperCase());
}
