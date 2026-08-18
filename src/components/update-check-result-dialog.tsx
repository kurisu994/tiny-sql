"use client";

import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface UpdateCheckResultDialogProps {
  notice: string | null;
  error: string | null;
  onDismiss: () => void;
}

/** 展示应用菜单手动检查更新后的成功或失败结果。 */
export function UpdateCheckResultDialog({
  notice,
  error,
  onDismiss,
}: UpdateCheckResultDialogProps) {
  const open = Boolean(notice || error);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {error ? (
              <CircleAlertIcon className="text-destructive" />
            ) : (
              <CircleCheckIcon className="text-green-600" />
            )}
            {error ? "检查更新失败" : "检查更新"}
          </DialogTitle>
          <DialogDescription>{error ?? notice}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" onClick={onDismiss}>
            知道了
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
