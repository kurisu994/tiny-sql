import { describe, expect, it } from "vitest";

import { analyzeSqlEditorText, extractSqlErrorLine } from "@/lib/sql-editor";

describe("analyzeSqlEditorText", () => {
  it("marks multiple executable statements after a semicolon", () => {
    const analysis = analyzeSqlEditorText("SELECT 1; SELECT 2");

    expect(analysis.diagnostics).toEqual([
      expect.objectContaining({
        code: "multiple_statements",
        line: 1,
        column: 9,
      }),
    ]);
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
