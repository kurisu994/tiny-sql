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
      : driver === "sqlite"
        ? ["SELECT", "VALUES", "PRAGMA", "EXPLAIN"]
        : ["SELECT", "SHOW", "EXPLAIN", "DESC", "DESCRIBE"];
  if (!safePrefixes.includes(first)) return true;
  // PRAGMA 的赋值形式（`= 值` 或 `(值)`）会改写数据库文件本身，必须确认；
  // 判定规则与后端 db-driver 的 sqlite_pragma_is_read 保持一致
  if (driver === "sqlite" && first === "PRAGMA") {
    return !sqlitePragmaIsRead(sql, tokens);
  }
  // EXPLAIN ANALYZE 会真正执行被分析的语句：分析写语句时仍需确认
  if (first === "EXPLAIN" && tokens[1] === "ANALYZE") {
    const analyzed =
      tokens.slice(2).find((t) => !EXPLAIN_FORMAT_TOKENS.has(t)) ?? "";
    return !["SELECT", "WITH", "TABLE"].includes(analyzed);
  }
  return false;
}

/** 带参数时仍确定只读的 SQLite PRAGMA（内省类）；与后端白名单保持一致。 */
const SQLITE_READONLY_PRAGMAS = new Set([
  "COLLATION_LIST",
  "COMPILE_OPTIONS",
  "DATABASE_LIST",
  "FOREIGN_KEY_CHECK",
  "FOREIGN_KEY_LIST",
  "FUNCTION_LIST",
  "INDEX_INFO",
  "INDEX_LIST",
  "INDEX_XINFO",
  "INTEGRITY_CHECK",
  "MODULE_LIST",
  "PRAGMA_LIST",
  "QUICK_CHECK",
  "TABLE_INFO",
  "TABLE_LIST",
  "TABLE_XINFO",
]);

/**
 * SQLite 的 PRAGMA 是否确定只读。
 *
 * 赋值有 `= 值` 和 `(值)` 两种写法，所以「有没有参数」才是可靠分界：
 * 完全不带参数的 `PRAGMA x` 一定是查询形式；带参数时只认内省类白名单。
 */
function sqlitePragmaIsRead(sql: string, tokens: string[]): boolean {
  const sanitized = stripLiteralsAndComments(sql);
  if (!sanitized.includes("=") && !sanitized.includes("(")) return true;
  // `PRAGMA name(...)` 与 `PRAGMA schema.name(...)` 都要覆盖
  return tokens.slice(1, 3).some((token) => SQLITE_READONLY_PRAGMAS.has(token));
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
