"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useConfirmStore } from "@/stores/confirm-store";

/**
 * 全局确认弹窗，挂在顶层即可。
 * 由 useConfirmStore.confirm() 命令式唤起，替代系统 window.confirm。
 */
export function ConfirmDialog() {
  const current = useConfirmStore((s) => s.current);
  const respond = useConfirmStore((s) => s.respond);

  return (
    <AlertDialog
      open={current !== null}
      onOpenChange={(open) => {
        // Esc / 取消按钮关闭都视为否定（确定按钮另行 respond(true)）
        if (!open) respond(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{current?.title ?? "确认操作"}</AlertDialogTitle>
          <AlertDialogDescription>{current?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{current?.cancelText ?? "取消"}</AlertDialogCancel>
          <AlertDialogAction
            variant={current?.danger ? "destructive" : "default"}
            onClick={() => respond(true)}
          >
            {current?.confirmText ?? "确定"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
