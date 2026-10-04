const SQL_KEYWORDS = new Set([
  "ADD",
  "ALL",
  "ALTER",
  "AND",
  "AS",
  "ASC",
  "BETWEEN",
  "BY",
  "CASE",
  "CREATE",
  "DATABASE",
  "DELETE",
  "DESC",
  "DISTINCT",
  "DROP",
  "ELSE",
  "END",
  "EXISTS",
  "FALSE",
  "FROM",
  "FULL",
  "GRANT",
  "GROUP",
  "HAVING",
  "IF",
  "IN",
  "INDEX",
  "INNER",
  "INSERT",
  "INTO",
  "IS",
  "JOIN",
  "KEY",
  "LEFT",
  "LIKE",
  "LIMIT",
  "NOT",
  "NULL",
  "ON",
  "OR",
  "ORDER",
  "OUTER",
  "PRIMARY",
  "REFERENCES",
  "REPLACE",
  "RIGHT",
  "SELECT",
  "SET",
  "SHOW",
  "TABLE",
  "THEN",
  "TRUE",
  "TRUNCATE",
  "UNION",
  "UPDATE",
  "USE",
  "VALUES",
  "WHEN",
  "WHERE",
  "WITH",
]);

export type SqlTokenKind =
  | "comment"
  | "function"
  | "identifier"
  | "keyword"
  | "number"
  | "operator"
  | "punctuation"
  | "quotedIdentifier"
  | "string"
  | "whitespace"
  | "error";

export interface SqlToken {
  text: string;
  kind: SqlTokenKind;
  line: number;
  column: number;
}

export interface SqlDiagnostic {
  code:
    | "unclosed_block_comment"
    | "unclosed_identifier"
    | "unclosed_parenthesis"
    | "unclosed_string"
    | "unexpected_parenthesis";
  line: number;
  column: number;
  length: number;
  message: string;
}

export interface SqlEditorAnalysis {
  tokens: SqlToken[];
  diagnostics: SqlDiagnostic[];
  lineCount: number;
}

export function analyzeSqlEditorText(sql: string): SqlEditorAnalysis {
  const tokens = tokenizeSql(sql);
  return {
    tokens,
    diagnostics: collectDiagnostics(tokens),
    lineCount: countSqlLines(sql),
  };
}

export interface SqlStatementSpan {
  /** 语句起点（含前导空白），不含结尾分号 */
  from: number;
  /** 语句终点，不含结尾分号 */
  to: number;
}

/**
 * 按顶层分号切开语句。字符串、标识符、注释和 PostgreSQL dollar-quote 里的分号不切。
 * 字面量或块注释没闭合时返回 null，调用方应退回整段文本，避免切出半句去执行。
 */
export function splitSqlStatementSpans(sql: string): SqlStatementSpan[] | null {
  const spans: SqlStatementSpan[] = [];
  let index = 0;
  let start = 0;
  let hasCode = false;

  const push = (end: number) => {
    if (!hasCode) return;
    spans.push({ from: start, to: end });
    hasCode = false;
  };

  while (index < sql.length) {
    const ch = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (ch === "-" && next === "-") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "#") {
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === "*" && sql[index + 1] === "/") {
          index += 2;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return null;
      continue;
    }

    const dollar = readDollarQuote(sql, index);
    if (dollar) {
      const closeAt = sql.indexOf(dollar.tag, dollar.contentFrom);
      if (closeAt < 0) return null;
      index = closeAt + dollar.tag.length;
      hasCode = true;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if ((quote === "'" || quote === '"') && sql[index] === "\\") {
          index += index + 1 < sql.length ? 2 : 1;
          continue;
        }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) return null;
      hasCode = true;
      continue;
    }

    if (ch === ";") {
      push(index);
      index += 1;
      start = index;
      continue;
    }

    if (!/\s/.test(ch)) hasCode = true;
    index += 1;
  }

  push(sql.length);
  return spans;
}

/**
 * 决定这次要执行的 SQL：有非空选区就执行选区，否则执行光标所在语句。
 * 切分失败（字面量未闭合）时退回整段，交给后端报错。
 */
export function sqlToExecute(
  sql: string,
  cursor: number,
  selectionFrom = cursor,
  selectionTo = cursor,
): string {
  const from = Math.min(selectionFrom, selectionTo);
  const to = Math.max(selectionFrom, selectionTo);
  if (to > from) {
    const selected = sql.slice(from, to).trim();
    if (selected) return selected;
  }

  const spans = splitSqlStatementSpans(sql);
  if (!spans || spans.length === 0) return sql.trim();

  const clamped = Math.max(0, Math.min(cursor, sql.length));
  const hit =
    spans.find((span) => clamped >= span.from && clamped <= span.to) ??
    spans.find((span) => span.from > clamped) ??
    [...spans].reverse().find((span) => span.to < clamped) ??
    spans[0];
  return sql.slice(hit.from, hit.to).trim();
}

/** `$tag$` / `$$` 起始标签。`$1` 这种占位符不是 dollar-quote。 */
function readDollarQuote(sql: string, index: number): { tag: string; contentFrom: number } | null {
  if (sql[index] !== "$") return null;
  let end = index + 1;
  while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end] ?? "")) end += 1;
  if (sql[end] !== "$") return null;
  const tag = sql.slice(index, end + 1);
  return { tag, contentFrom: end + 1 };
}

export function extractSqlErrorLine(message: string | null | undefined) {
  if (!message || message === "SQL 已取消") return null;
  const patterns = [
    /\bat\s+line\s+(\d+)\b/i,
    /\bline\s+(\d+)\b/i,
    /第\s*(\d+)\s*行/,
    /行\s*(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) {
      const line = Number.parseInt(match[1], 10);
      if (Number.isInteger(line) && line > 0) return line;
    }
  }
  return null;
}

function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  function push(text: string, kind: SqlTokenKind, startLine: number, startColumn: number) {
    tokens.push({ text, kind, line: startLine, column: startColumn });
  }

  function advance() {
    const ch = sql[index];
    index += 1;
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return ch;
  }

  function peek(offset = 0) {
    return sql[index + offset] ?? "";
  }

  while (index < sql.length) {
    const startLine = line;
    const startColumn = column;
    const ch = peek();
    const next = peek(1);

    if (/\s/.test(ch)) {
      let text = "";
      while (index < sql.length && /\s/.test(peek())) text += advance();
      push(text, "whitespace", startLine, startColumn);
      continue;
    }

    if (ch === "-" && next === "-") {
      let text = "";
      while (index < sql.length && peek() !== "\n") text += advance();
      push(text, "comment", startLine, startColumn);
      continue;
    }

    if (ch === "#") {
      let text = "";
      while (index < sql.length && peek() !== "\n") text += advance();
      push(text, "comment", startLine, startColumn);
      continue;
    }

    if (ch === "/" && next === "*") {
      let text = advance() + advance();
      let closed = false;
      while (index < sql.length) {
        const current = advance();
        text += current;
        if (current === "*" && peek() === "/") {
          text += advance();
          closed = true;
          break;
        }
      }
      push(text, closed ? "comment" : "error", startLine, startColumn);
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      let text = advance();
      let closed = false;
      while (index < sql.length) {
        const current = advance();
        text += current;
        if (current === "\\") {
          if (index < sql.length) text += advance();
          continue;
        }
        if (current === quote) {
          if (peek() === quote) {
            text += advance();
            continue;
          }
          closed = true;
          break;
        }
      }
      push(text, closed ? "string" : "error", startLine, startColumn);
      continue;
    }

    if (ch === "`") {
      let text = advance();
      let closed = false;
      while (index < sql.length) {
        const current = advance();
        text += current;
        if (current === "`") {
          if (peek() === "`") {
            text += advance();
            continue;
          }
          closed = true;
          break;
        }
      }
      push(text, closed ? "quotedIdentifier" : "error", startLine, startColumn);
      continue;
    }

    if (/\d/.test(ch)) {
      let text = "";
      while (index < sql.length && /[\d.]/.test(peek())) text += advance();
      push(text, "number", startLine, startColumn);
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let text = "";
      while (index < sql.length && /[A-Za-z0-9_$]/.test(peek())) {
        text += advance();
      }
      const upper = text.toUpperCase();
      const nextCode = nextNonSpace(sql, index);
      push(
        text,
        SQL_KEYWORDS.has(upper) ? "keyword" : nextCode === "(" ? "function" : "identifier",
        startLine,
        startColumn,
      );
      continue;
    }

    const three = sql.slice(index, index + 3);
    if (three === "<=>" || three === "->>") {
      push(advance() + advance() + advance(), "operator", startLine, startColumn);
      continue;
    }

    const two = sql.slice(index, index + 2);
    if (["!=", "<>", "<=", ">=", ":=", "&&", "||", "->", "::"].includes(two)) {
      push(advance() + advance(), "operator", startLine, startColumn);
      continue;
    }

    push(
      advance(),
      "(),.;".includes(ch) ? "punctuation" : "operator",
      startLine,
      startColumn,
    );
  }

  return tokens;
}

function collectDiagnostics(tokens: SqlToken[]): SqlDiagnostic[] {
  const diagnostics: SqlDiagnostic[] = [];
  const parentheses: SqlToken[] = [];

  for (const token of tokens) {
    if (token.kind === "error") {
      diagnostics.push(errorDiagnosticForToken(token));
      continue;
    }

    if (token.kind === "comment" || token.kind === "whitespace") continue;

    // 多条语句已由查询路径拆开执行，编辑器不再把分号后的下一条标成错误。
    if (token.text === "(") {
      parentheses.push(token);
    } else if (token.text === ")") {
      if (parentheses.length === 0) {
        diagnostics.push({
          code: "unexpected_parenthesis",
          line: token.line,
          column: token.column,
          length: token.text.length,
          message: "括号没有匹配的开始位置",
        });
      } else {
        parentheses.pop();
      }
    }
  }

  for (const token of parentheses) {
    diagnostics.push({
      code: "unclosed_parenthesis",
      line: token.line,
      column: token.column,
      length: token.text.length,
      message: "括号未闭合",
    });
  }

  return diagnostics;
}

function errorDiagnosticForToken(token: SqlToken): SqlDiagnostic {
  if (token.text.startsWith("/*")) {
    return {
      code: "unclosed_block_comment",
      line: token.line,
      column: token.column,
      length: token.text.length,
      message: "块注释未闭合",
    };
  }
  if (token.text.startsWith("`")) {
    return {
      code: "unclosed_identifier",
      line: token.line,
      column: token.column,
      length: token.text.length,
      message: "反引号标识符未闭合",
    };
  }
  return {
    code: "unclosed_string",
    line: token.line,
    column: token.column,
    length: token.text.length,
    message: "字符串未闭合",
  };
}

function countSqlLines(sql: string) {
  return Math.max(1, sql.split("\n").length);
}

function nextNonSpace(sql: string, start: number) {
  for (let i = start; i < sql.length; i += 1) {
    if (!/\s/.test(sql[i])) return sql[i];
  }
  return "";
}
