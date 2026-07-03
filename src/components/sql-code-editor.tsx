"use client";

import { sql, MySQL, type SQLNamespace } from "@codemirror/lang-sql";
import { forceLinting, linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useMemo, useRef } from "react";

import {
  analyzeSqlEditorText,
  extractSqlErrorLine,
  type SqlDiagnostic,
} from "@/lib/sql-editor";
import type { DatabaseMeta, TableMeta } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";

interface SqlCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  disabled: boolean;
  queryErrorMsg: string | null;
  databases: DatabaseMeta[];
  selectedDb: string | null;
  tables: TableMeta[];
}

const editableCompartment = new Compartment();
const languageCompartment = new Compartment();
const lintCompartment = new Compartment();

const editorTheme = EditorView.theme({
  "&": {
    height: "96px",
    border: "1px solid var(--tiny-sql-editor-border)",
    borderRadius: "6px",
    backgroundColor: "var(--tiny-sql-editor-bg)",
    color: "var(--tiny-sql-editor-fg)",
    fontSize: "12px",
  },
  "&.cm-focused": {
    borderColor: "var(--tiny-sql-editor-focus)",
    outline: "none",
  },
  ".cm-scroller": {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    lineHeight: "1.55",
    overflow: "auto",
  },
  ".cm-content": {
    minHeight: "94px",
    padding: "8px 0",
    caretColor: "var(--tiny-sql-editor-caret)",
  },
  ".cm-line": {
    padding: "0 12px",
  },
  ".cm-gutters": {
    borderRight: "1px solid var(--tiny-sql-editor-gutter-border)",
    backgroundColor: "var(--tiny-sql-editor-gutter-bg)",
    color: "var(--tiny-sql-editor-gutter-fg)",
  },
  ".cm-activeLine": {
    backgroundColor: "var(--tiny-sql-editor-active-line)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--tiny-sql-editor-active-line)",
  },
  ".cm-tooltip": {
    border: "1px solid var(--tiny-sql-editor-border)",
    backgroundColor: "var(--tiny-sql-editor-tooltip-bg)",
    color: "var(--tiny-sql-editor-fg)",
    boxShadow: "0 10px 30px rgb(15 23 42 / 0.12)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--tiny-sql-editor-selection)",
    color: "var(--tiny-sql-editor-fg)",
  },
  ".cm-diagnostic-error": {
    borderLeft: "3px solid rgb(220 38 38)",
  },
  ".cm-lintRange-error": {
    backgroundImage:
      "linear-gradient(45deg, transparent 65%, rgb(220 38 38) 80%, transparent 90%)",
    backgroundPosition: "left bottom",
    backgroundRepeat: "repeat-x",
    backgroundSize: "6px 3px",
  },
});

/** CodeMirror 6 SQL 编辑器：MySQL 高亮、schema 补全、错误 gutter。 */
export function SqlCodeEditor({
  value,
  onChange,
  onRun,
  disabled,
  queryErrorMsg,
  databases,
  selectedDb,
  tables,
}: SqlCodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);

  const schema = useMemo(
    () => buildSqlSchema(databases, selectedDb, tables),
    [databases, selectedDb, tables],
  );

  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  useEffect(() => {
    if (!containerRef.current || viewRef.current) return;

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          editorTheme,
          lintGutter(),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                onRunRef.current();
                return true;
              },
            },
          ]),
          editableCompartment.of(editableExtensions(disabled)),
          languageCompartment.of(sqlExtension(schema, selectedDb)),
          lintCompartment.of(sqlLintExtension(queryErrorMsg)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });

    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartment.reconfigure(editableExtensions(disabled)),
    });
  }, [disabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.reconfigure(sqlExtension(schema, selectedDb)),
    });
  }, [schema, selectedDb]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: lintCompartment.reconfigure(sqlLintExtension(queryErrorMsg)),
    });
    forceLinting(view);
  }, [queryErrorMsg]);

  return (
    <div
      className={cn("tiny-sql-editor", disabled && "tiny-sql-editor-disabled")}
      ref={containerRef}
    />
  );
}

function editableExtensions(disabled: boolean): Extension {
  return [
    EditorState.readOnly.of(disabled),
    EditorView.editable.of(!disabled),
  ];
}

function sqlExtension(schema: SQLNamespace, selectedDb: string | null): Extension {
  return sql({
    dialect: MySQL,
    schema,
    defaultSchema: selectedDb ?? undefined,
    upperCaseKeywords: true,
  });
}

function sqlLintExtension(queryErrorMsg: string | null): Extension {
  return linter((view) => {
    const diagnostics = analyzeSqlEditorText(view.state.doc.toString())
      .diagnostics.map((diagnostic) => toCodeMirrorDiagnostic(view, diagnostic));
    const serverLine = extractSqlErrorLine(queryErrorMsg);
    if (serverLine) {
      diagnostics.push(serverErrorDiagnostic(view, serverLine, queryErrorMsg ?? ""));
    }
    return diagnostics;
  });
}

function toCodeMirrorDiagnostic(
  view: EditorView,
  diagnostic: SqlDiagnostic,
): Diagnostic {
  const from = posFromLineColumn(view, diagnostic.line, diagnostic.column);
  const to = Math.min(view.state.doc.length, from + Math.max(1, diagnostic.length));
  return {
    from,
    to,
    severity: "error",
    message: diagnostic.message,
    source: "tiny-sql",
  };
}

function serverErrorDiagnostic(
  view: EditorView,
  lineNumber: number,
  message: string,
): Diagnostic {
  const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines));
  const to = Math.min(
    view.state.doc.length,
    Math.max(line.to, line.from + 1),
  );
  return {
    from: line.from,
    to,
    severity: "error",
    message,
    source: "MySQL",
  };
}

function posFromLineColumn(view: EditorView, lineNumber: number, column: number) {
  const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines));
  return Math.min(line.to, line.from + Math.max(0, column - 1));
}

function buildSqlSchema(
  databases: DatabaseMeta[],
  selectedDb: string | null,
  tables: TableMeta[],
): SQLNamespace {
  const schema: Record<string, SQLNamespace> = {};
  for (const db of databases) {
    schema[db.name] = [];
  }
  if (selectedDb) {
    schema[selectedDb] = Object.fromEntries(
      tables.map((table) => [table.name, []]),
    );
  }
  return schema;
}
