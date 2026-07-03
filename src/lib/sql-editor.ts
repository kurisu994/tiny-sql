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
    | "multiple_statements"
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
  let hasCodeBeforeStatementEnd = false;
  let statementEnd: SqlToken | null = null;

  for (const token of tokens) {
    if (token.kind === "error") {
      diagnostics.push(errorDiagnosticForToken(token));
      continue;
    }

    if (token.kind === "comment" || token.kind === "whitespace") continue;

    if (statementEnd) {
      diagnostics.push({
        code: "multiple_statements",
        line: statementEnd.line,
        column: statementEnd.column,
        length: statementEnd.text.length,
        message: "一次只能执行一条 SQL",
      });
      statementEnd = null;
      continue;
    }

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
    } else if (token.text === ";" && hasCodeBeforeStatementEnd) {
      statementEnd = token;
    } else {
      hasCodeBeforeStatementEnd = true;
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
