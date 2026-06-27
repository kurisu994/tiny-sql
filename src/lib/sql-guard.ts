const WRITE_KEYWORDS = new Set([
  "DROP",
  "DELETE",
  "UPDATE",
  "INSERT",
  "TRUNCATE",
  "ALTER",
  "GRANT",
  "CREATE",
  "REPLACE",
]);

/** best-effort 写操作识别：只用于前端二次确认，后端仍会重新校验。 */
export function needsWriteConfirmation(sql: string): boolean {
  return sqlTokens(stripLiteralsAndComments(sql)).some((token) =>
    WRITE_KEYWORDS.has(token),
  );
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
