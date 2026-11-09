import { describe, expect, it } from "vitest";

import {
  analyzeSqlEditorText,
  extractSqlErrorLine,
  splitSqlStatementSpans,
  sqlToExecute,
} from "@/lib/sql-editor";

describe("analyzeSqlEditorText", () => {
  it("allows multiple statements because scripts run statement by statement", () => {
    const analysis = analyzeSqlEditorText("SELECT 1; SELECT (2");

    expect(analysis.diagnostics.map((d) => d.code)).toEqual(["unclosed_parenthesis"]);
  });

  it("allows a single statement with a trailing semicolon", () => {
    const analysis = analyzeSqlEditorText("SELECT 1; -- ok");

    expect(analysis.diagnostics).toHaveLength(0);
  });

  it("marks unclosed strings and parentheses", () => {
    const analysis = analyzeSqlEditorText("SELECT ('a, `b, /* c");

    expect(analysis.diagnostics.map((d) => d.code)).toEqual([
      "unclosed_string",
      "unclosed_parenthesis",
    ]);
  });

  it("marks unclosed quoted identifiers and block comments", () => {
    expect(analyzeSqlEditorText("SELECT `name").diagnostics[0]).toEqual(
      expect.objectContaining({ code: "unclosed_identifier" }),
    );
    expect(analyzeSqlEditorText("SELECT /* note").diagnostics[0]).toEqual(
      expect.objectContaining({ code: "unclosed_block_comment" }),
    );
  });
});

describe("sqlToExecute", () => {
  const script = "SELECT 1;\nSELECT ';';\nSELECT 3";

  it("runs the statement under the cursor", () => {
    expect(sqlToExecute(script, script.indexOf("SELECT 3"))).toBe("SELECT 3");
    expect(sqlToExecute(script, 0)).toBe("SELECT 1");
  });

  it("does not split on semicolons inside strings, comments, or dollar quotes", () => {
    const sql = "SELECT ';'; /* ; */ SELECT $$a;b$$; -- ;\nSELECT 2";
    expect(splitSqlStatementSpans(sql)?.map((span) => sql.slice(span.from, span.to).trim())).toEqual([
      "SELECT ';'",
      "/* ; */ SELECT $$a;b$$",
      "-- ;\nSELECT 2",
    ]);
  });

  it("prefers a non-empty selection", () => {
    const sql = "SELECT 1; SELECT 2";
    expect(sqlToExecute(sql, 0, sql.indexOf("SELECT 2"), sql.length)).toBe("SELECT 2");
  });

  it("returns the whole text when a literal is unclosed", () => {
    expect(sqlToExecute("SELECT 'abc; SELECT 2", 0)).toBe("SELECT 'abc; SELECT 2");
    expect(splitSqlStatementSpans("SELECT /* abc")).toBeNull();
  });
});

describe("extractSqlErrorLine", () => {
  it("extracts MySQL style line numbers", () => {
    expect(
      extractSqlErrorLine(
        "You have an error in your SQL syntax; check the manual near 'FROM' at line 3",
      ),
    ).toBe(3);
  });

  it("ignores cancellation messages", () => {
    expect(extractSqlErrorLine("SQL 已取消")).toBeNull();
  });
});
