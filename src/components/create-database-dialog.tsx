"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { translateError, type StoredConnection } from "@/lib/tauri-api";
import { useSessionStore } from "@/stores/session-store";

const CHARSET_OPTIONS = [
  {
    value: "utf8mb4",
    label: "utf8mb4",
    collations: ["utf8mb4_general_ci", "utf8mb4_unicode_ci", "utf8mb4_bin"],
  },
  {
    value: "utf8",
    label: "utf8",
    collations: ["utf8_general_ci", "utf8_unicode_ci", "utf8_bin"],
  },
  {
    value: "latin1",
    label: "latin1",
    collations: ["latin1_swedish_ci", "latin1_general_ci", "latin1_bin"],
  },
  {
    value: "gbk",
    label: "gbk",
    collations: ["gbk_chinese_ci", "gbk_bin"],
  },
] as const;

interface CreateDatabaseDialogProps {
  open: boolean;
  connection: StoredConnection | null;
  onOpenChange: (open: boolean) => void;
}

export function CreateDatabaseDialog({
  open,
  connection,
  onOpenChange,
}: CreateDatabaseDialogProps) {
  const createDatabase = useSessionStore((s) => s.createDatabase);
  const [name, setName] = useState("");
  const [charset, setCharset] = useState("");
  const [collation, setCollation] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setCharset("");
    setCollation("");
    setSaving(false);
    setError(null);
  }, [open, connection?.id]);

  const collationOptions = useMemo(
    () =>
      CHARSET_OPTIONS.find((option) => option.value === charset)?.collations ??
      [],
    [charset],
  );
  const sqlPreview = useMemo(
    () => buildCreateDatabaseSqlPreview(name, charset, collation),
    [name, charset, collation],
  );
  const canSubmit = name.trim().length > 0 && !saving && connection !== null;

  function updateCharset(next: string) {
    setCharset(next);
    const nextCollations =
      CHARSET_OPTIONS.find((option) => option.value === next)?.collations ?? [];
    setCollation((current) =>
      current === "" || nextCollations.some((value) => value === current)
        ? current
        : "",
    );
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!connection || !canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await createDatabase(connection.id, {
        name,
        charset: charset || null,
        collation: collation || null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(translateError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open && connection !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>新建数据库</DialogTitle>
          </DialogHeader>

          <Tabs defaultValue="general">
            <TabsList className="grid w-48 grid-cols-2">
              <TabsTrigger value="general">常规</TabsTrigger>
              <TabsTrigger value="sql">SQL 预览</TabsTrigger>
            </TabsList>

            <TabsContent value="general">
              <div className="mx-auto flex w-full max-w-xl flex-col gap-3 py-2">
                <LabeledInput
                  label="数据库名称"
                  value={name}
                  onChange={setName}
                  autoFocus
                />
                <LabeledSelect
                  label="字符集"
                  value={charset}
                  onChange={updateCharset}
                  options={CHARSET_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                />
                <LabeledSelect
                  label="排序规则"
                  value={collation}
                  onChange={setCollation}
                  options={collationOptions.map((value) => ({
                    value,
                    label: value,
                  }))}
                  disabled={charset === ""}
                />
              </div>
            </TabsContent>

            <TabsContent value="sql">
              <pre className="min-h-36 overflow-auto rounded-md border border-neutral-200 bg-neutral-50 p-3 font-mono text-xs leading-5 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">
                {sqlPreview}
              </pre>
            </TabsContent>
          </Tabs>

          {error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              取消
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {saving ? "创建中…" : "好"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <label className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 text-sm">
      <span className="text-right font-medium">{label}:</span>
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="h-9 rounded-md border border-neutral-300 bg-white px-2 outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-950"
      />
    </label>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3 text-sm">
      <span className="text-right font-medium">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="h-9 rounded-md border border-neutral-300 bg-white px-2 outline-none focus:border-blue-500 focus:ring-3 focus:ring-blue-500/20 disabled:bg-neutral-100 disabled:text-neutral-400 dark:border-neutral-700 dark:bg-neutral-950 dark:disabled:bg-neutral-900"
      >
        <option value="">服务器默认</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function buildCreateDatabaseSqlPreview(
  name: string,
  charset: string,
  collation: string,
) {
  const lines = [
    `CREATE DATABASE ${quotePreviewIdentifier(name.trim() || "数据库名称")}`,
  ];
  if (charset) lines.push(`  DEFAULT CHARACTER SET = ${charset}`);
  if (collation) lines.push(`  DEFAULT COLLATE = ${collation}`);
  return `${lines.join("\n")};`;
}

function quotePreviewIdentifier(value: string) {
  return "`" + value.replace(/`/g, "``") + "`";
}
