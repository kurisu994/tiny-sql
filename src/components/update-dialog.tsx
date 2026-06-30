"use client";

import { useEffect, useMemo, useState } from "react";
import { DownloadIcon, RefreshCwIcon, RotateCwIcon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  translateError,
  updateApi,
  type UpdateDownloadEvent,
  type UpdateInfo,
} from "@/lib/tauri-api";

type InstallState = "idle" | "downloading" | "ready" | "error";

interface UpdateDialogProps {
  updateInfo: UpdateInfo | null;
  onDismiss: () => void;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function UpdateDialog({ updateInfo, onDismiss }: UpdateDialogProps) {
  const [installState, setInstallState] = useState<InstallState>("idle");
  const [downloaded, setDownloaded] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!updateInfo) return;
    setInstallState("idle");
    setDownloaded(0);
    setTotal(null);
    setError(null);
  }, [updateInfo]);

  const progress = useMemo(() => {
    if (!total) return null;
    return Math.min(100, Math.round((downloaded / total) * 100));
  }, [downloaded, total]);

  if (!updateInfo) return null;

  function handleDownloadEvent(event: UpdateDownloadEvent) {
    if (event.event === "Started") {
      setDownloaded(0);
      setTotal(event.data.contentLength ?? null);
      return;
    }

    if (event.event === "Progress") {
      setDownloaded((current) => current + event.data.chunkLength);
      return;
    }

    setInstallState("ready");
  }

  async function startDownload() {
    setInstallState("downloading");
    setDownloaded(0);
    setTotal(null);
    setError(null);

    try {
      await updateApi.downloadAndInstall(handleDownloadEvent);
      setInstallState("ready");
    } catch (e) {
      setInstallState("error");
      setError(translateError(e));
    }
  }

  async function relaunch() {
    setError(null);
    try {
      await updateApi.relaunch();
    } catch (e) {
      setInstallState("error");
      setError(translateError(e));
    }
  }

  const notes = updateInfo.body?.trim();
  const downloading = installState === "downloading";

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open && !downloading) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>发现新版本 {updateInfo.version}</DialogTitle>
          <DialogDescription>
            当前版本 {updateInfo.currentVersion}，更新完成后需要重启应用生效。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {notes ? (
            <div className="max-h-56 overflow-y-auto rounded-lg border bg-muted/30 p-3 text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
              {notes}
            </div>
          ) : (
            <p className="rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
              这个版本没有附带更新说明。
            </p>
          )}

          {downloading && (
            <div className="space-y-2">
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progress ?? 25}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {progress === null
                  ? "正在下载更新包…"
                  : `正在下载 ${progress}% (${formatBytes(downloaded)} / ${formatBytes(total ?? downloaded)})`}
              </p>
            </div>
          )}

          {installState === "ready" && (
            <p className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs text-primary">
              更新已安装，重启应用后将进入新版本。
            </p>
          )}

          {error && (
            <p className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">
              更新失败：{error}
            </p>
          )}
        </div>

        <DialogFooter>
          {installState === "ready" ? (
            <Button onClick={relaunch}>
              <RotateCwIcon data-icon="inline-start" />
              重启完成更新
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={onDismiss}
                disabled={downloading}
              >
                稍后
              </Button>
              <Button onClick={startDownload} disabled={downloading}>
                {downloading ? (
                  <RefreshCwIcon
                    data-icon="inline-start"
                    className="animate-spin"
                  />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                {downloading ? "下载中" : "下载并安装"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
