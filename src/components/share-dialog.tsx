"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  connectionApi,
  translateError,
  type SharePreviewItem,
  type StoredConnection,
} from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";

interface ShareDialogProps {
  open: boolean;
  connections: StoredConnection[];
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<void>;
}

/**
 * 加密分享连接（FR-221）：独立口令导出 / 导入。
 * 不含 master.key；默认不打包私钥文件。
 */
export function ShareDialog({
  open,
  connections,
  onOpenChange,
  onImported,
}: ShareDialogProps) {
  const confirm = useConfirmStore((s) => s.confirm);
  const [selected, setSelected] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [includeKeys, setIncludeKeys] = useState(false);
  const [importPassword, setImportPassword] = useState("");
  const [preview, setPreview] = useState<SharePreviewItem[] | null>(null);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((items) =>
      items.includes(id) ? items.filter((item) => item !== id) : [...items, id],
    );
  }

  async function exportShare() {
    if (!password) {
      setError("分享口令不能为空");
      return;
    }
    if (includeKeys) {
      const ok = await confirm({
        title: "包含私钥内容",
        message:
          "分享文件将写入私钥原文。拿到口令的人可以复制这些钥匙。确定继续？",
        confirmText: "仍然包含",
        danger: true,
      });
      if (!ok) return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      title: "导出连接分享文件",
      defaultPath: "tiny-sql-share.json",
      filters: [{ name: "tiny-sql share", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await connectionApi.shareExport(selected, password, path, includeKeys);
      setMessage("已导出分享文件");
    } catch (e) {
      setError(translateError(e));
    } finally {
      setBusy(false);
    }
  }

  async function pickImport() {
    const { open: openFile } = await import("@tauri-apps/plugin-dialog");
    const path = await openFile({
      title: "打开连接分享文件",
      multiple: false,
      filters: [{ name: "tiny-sql share", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await connectionApi.sharePreview(path, importPassword);
      setImportPath(path);
      setPreview(result.connections);
    } catch (e) {
      setPreview(null);
      setImportPath(null);
      setError(translateError(e));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!importPath) return;
    const ok = await confirm({
      title: "导入连接",
      message: `将导入 ${preview?.length ?? 0} 条连接（新 id，不覆盖已有，不带入对方主机指纹）。`,
      confirmText: "导入",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const count = await connectionApi.shareImport(importPath, importPassword);
      setMessage(`已导入 ${count} 条连接`);
      await onImported();
    } catch (e) {
      setError(translateError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>加密分享连接</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-neutral-500">
          使用独立口令，不导出本机 master.key。对方首次连接仍走本机 TOFU。
        </p>
        <Tabs defaultValue="export">
          <TabsList className="grid w-48 grid-cols-2">
            <TabsTrigger value="export">导出</TabsTrigger>
            <TabsTrigger value="import">导入</TabsTrigger>
          </TabsList>
          <TabsContent value="export" className="flex flex-col gap-2 pt-2">
            <ul className="max-h-40 overflow-auto rounded border border-neutral-200 text-xs dark:border-neutral-800">
              {connections.map((connection) => (
                <li
                  key={connection.id}
                  className="flex items-center gap-2 border-b border-neutral-100 px-2 py-1 last:border-0 dark:border-neutral-800"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(connection.id)}
                    onChange={() => toggle(connection.id)}
                  />
                  <span className="truncate">{connection.name}</span>
                  <span className="text-neutral-400">{connection.driver}</span>
                </li>
              ))}
            </ul>
            <label className="flex flex-col gap-1 text-xs">
              分享口令
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-7 rounded border border-neutral-300 bg-white px-1.5 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={includeKeys}
                onChange={(e) => setIncludeKeys(e.target.checked)}
              />
              包含私钥文件内容（默认只保留路径）
            </label>
            <Button
              type="button"
              disabled={busy || selected.length === 0 || !password}
              onClick={() => void exportShare()}
            >
              导出分享文件
            </Button>
          </TabsContent>
          <TabsContent value="import" className="flex flex-col gap-2 pt-2">
            <label className="flex flex-col gap-1 text-xs">
              分享口令
              <input
                type="password"
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                className="h-7 rounded border border-neutral-300 bg-white px-1.5 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !importPassword}
              onClick={() => void pickImport()}
            >
              选择文件并预览
            </Button>
            {preview && (
              <ul className="rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800">
                {preview.map((item) => (
                  <li key={`${item.name}-${item.driver}`}>
                    {item.name} · {item.driver} · {item.hopCount} 跳
                  </li>
                ))}
              </ul>
            )}
            <Button
              type="button"
              disabled={busy || !importPath}
              onClick={() => void doImport()}
            >
              确认导入
            </Button>
          </TabsContent>
        </Tabs>
        {message && <p className="text-xs text-neutral-600">{message}</p>}
        {error && (
          <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
