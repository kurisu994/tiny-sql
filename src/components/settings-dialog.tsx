"use client";

import { useEffect, useState } from "react";
import { CheckIcon, KeyRoundIcon, RotateCcwIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { isTauriRuntime, updateApi } from "@/lib/tauri-api";
import { cn } from "@/lib/utils";
import {
  EDITOR_FONT_SIZE_CHOICES,
  isValidProxyUrl,
  PAGE_SIZE_CHOICES,
  useSettingsStore,
} from "@/stores/settings-store";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 「关于」页触发一次手动检查更新，复用应用菜单同一条链路 */
  onCheckUpdate: () => void;
  checkingUpdate: boolean;
  /** 打开主密码设置弹窗（先关掉本弹窗，避免两层 Dialog 抢焦点） */
  onOpenSecurity: () => void;
}

/** 一行设置：左侧标题 + 说明，右侧控件 */
function SettingRow({
  title,
  description,
  control,
}: {
  title: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-neutral-100 py-3 last:border-b-0 dark:border-neutral-800">
      <div className="min-w-0">
        <div className="text-sm font-medium">{title}</div>
        <p className="mt-0.5 text-xs text-neutral-500">{description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{control}</div>
    </div>
  );
}

const selectClass = cn(
  "rounded border border-neutral-300 bg-white px-2 py-1 text-sm",
  "dark:border-neutral-700 dark:bg-neutral-900",
);

/** 复选框：沿用原生 input，避免为一个开关引入新的 UI 依赖 */
function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className="size-4 accent-blue-600"
    />
  );
}

/** 应用设置弹窗：由 macOS 应用菜单「Settings...」（⌘,）唤起 */
export function SettingsDialog({
  open,
  onOpenChange,
  onCheckUpdate,
  checkingUpdate,
  onOpenSecurity,
}: SettingsDialogProps) {
  const {
    autoCheckUpdate,
    updateProxy,
    confirmWrite,
    defaultPageSize,
    editorFontSize,
    update,
    reset,
  } = useSettingsStore();
  const [version, setVersion] = useState("");
  // 代理地址是需要完整输入的文本，边输边存会不断落下半截的无效地址：
  // 这里按草稿处理，点 ✓ 才校验并写入 store，点 ✕ 丢弃回已保存值。
  const [proxyDraft, setProxyDraft] = useState(updateProxy);
  const [proxyError, setProxyError] = useState<string | null>(null);
  const proxyDirty = proxyDraft !== updateProxy;

  // 打开时才拉版本号：非 Tauri 环境（pnpm dev-web）回落到构建期注入的版本
  useEffect(() => {
    if (!open) return;
    void updateApi.getAppVersion().then(setVersion).catch(() => setVersion(""));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setProxyDraft(updateProxy);
    setProxyError(null);
  }, [open, updateProxy]);

  function commitProxy() {
    const value = proxyDraft.trim();
    if (!isValidProxyUrl(value)) {
      setProxyError(
        "地址无效：需要带 scheme 与主机的完整地址，如 socks5://127.0.0.1:7890",
      );
      return;
    }
    setProxyError(null);
    update({ updateProxy: value });
  }

  function revertProxy() {
    setProxyDraft(updateProxy);
    setProxyError(null);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
          <DialogDescription>
            修改即时生效并保存在本机，不随连接配置同步。
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="general">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="general">通用</TabsTrigger>
            <TabsTrigger value="editor">编辑器</TabsTrigger>
            <TabsTrigger value="security">安全</TabsTrigger>
            <TabsTrigger value="about">关于</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="min-h-56">
            <SettingRow
              title="自动检查更新"
              description="启动 5 秒后检查一次，之后每 24 小时一次；关闭后仍可从菜单手动检查。"
              control={
                <Toggle
                  label="自动检查更新"
                  checked={autoCheckUpdate}
                  onChange={(v) => update({ autoCheckUpdate: v })}
                />
              }
            />
            {/* 代理地址比其他控件宽，单独占一行而不塞进 SettingRow 右侧 */}
            <div className="border-b border-neutral-100 py-3 dark:border-neutral-800">
              <div className="text-sm font-medium">更新代理</div>
              <p className="mt-0.5 text-xs text-neutral-500">
                检查与下载更新都经此代理，支持 http / https / socks5；留空为直连。
                改完点 ✓ 生效，点 ✕ 放弃改动。
              </p>
              <div className="relative mt-2">
                <input
                  type="text"
                  inputMode="url"
                  spellCheck={false}
                  aria-label="更新代理地址"
                  aria-invalid={proxyError !== null}
                  placeholder="socks5://127.0.0.1:7890"
                  value={proxyDraft}
                  onChange={(e) => {
                    setProxyDraft(e.target.value);
                    // 只在点 ✓ 时校验，输入过程中不打扰
                    if (proxyError) setProxyError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitProxy();
                    if (e.key === "Escape" && proxyDirty) {
                      e.preventDefault();
                      e.stopPropagation();
                      revertProxy();
                    }
                  }}
                  className={cn(
                    "w-full rounded border py-1 pl-2 text-sm",
                    "dark:bg-neutral-900",
                    // 只有按钮出现时才给右侧让位，否则文字可用满宽
                    proxyDirty ? "pr-16" : "pr-2",
                    proxyError
                      ? "border-destructive"
                      : "border-neutral-300 dark:border-neutral-700",
                  )}
                />
                {/* 内嵌在输入框尾部，仅在有未保存改动时出现 */}
                {proxyDirty && (
                  <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
                    <button
                      type="button"
                      aria-label="保存代理地址"
                      title="保存（Enter）"
                      onClick={commitProxy}
                      className="rounded p-1 text-green-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      <CheckIcon className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label="放弃代理地址改动"
                      title="放弃改动（Esc）"
                      onClick={revertProxy}
                      className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      <XIcon className="size-4" />
                    </button>
                  </div>
                )}
              </div>
              {proxyError && (
                <p className="mt-1 text-xs text-destructive">{proxyError}</p>
              )}
            </div>
            <SettingRow
              title="默认每页行数"
              description="新打开的表数据浏览页的初始分页大小，单个 tab 内仍可临时调整。"
              control={
                <select
                  aria-label="默认每页行数"
                  className={selectClass}
                  value={defaultPageSize}
                  onChange={(e) =>
                    update({ defaultPageSize: Number(e.target.value) })
                  }
                >
                  {PAGE_SIZE_CHOICES.map((size) => (
                    <option key={size} value={size}>
                      {size} 行 / 页
                    </option>
                  ))}
                </select>
              }
            />
          </TabsContent>

          <TabsContent value="editor" className="min-h-56">
            <SettingRow
              title="SQL 编辑器字号"
              description="即时生效，作用于所有 SQL 编辑框。"
              control={
                <select
                  aria-label="SQL 编辑器字号"
                  className={selectClass}
                  value={editorFontSize}
                  onChange={(e) =>
                    update({ editorFontSize: Number(e.target.value) })
                  }
                >
                  {EDITOR_FONT_SIZE_CHOICES.map((size) => (
                    <option key={size} value={size}>
                      {size} px
                    </option>
                  ))}
                </select>
              }
            />
            <div
              className="mt-3 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 font-mono text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400"
              style={{ fontSize: `${editorFontSize}px` }}
            >
              SELECT id, name FROM users WHERE status = 1;
            </div>
          </TabsContent>

          <TabsContent value="security" className="min-h-56">
            <SettingRow
              title="写操作二次确认"
              description="执行 INSERT / UPDATE / DELETE / DDL 前弹确认框。关闭后写语句直接执行——只读连接与后端护栏不受影响。"
              control={
                <Toggle
                  label="写操作二次确认"
                  checked={confirmWrite}
                  onChange={(v) => update({ confirmWrite: v })}
                />
              }
            />
            <SettingRow
              title="主密码"
              description="用主密码加密连接配置与 SQL 历史，锁定后需解锁才能读取。"
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    onOpenSecurity();
                  }}
                >
                  <KeyRoundIcon />
                  管理
                </Button>
              }
            />
          </TabsContent>

          <TabsContent value="about" className="min-h-56">
            <SettingRow
              title="当前版本"
              description="tiny-sql — 多级跳板机友好的 MySQL / PostgreSQL / SQLite 桌面客户端。"
              control={
                <span className="font-mono text-sm">
                  {version ? `v${version}` : "—"}
                </span>
              }
            />
            <SettingRow
              title="检查更新"
              description={
                isTauriRuntime()
                  ? "立即向更新服务器查询新版本。"
                  : "仅桌面应用可用。"
              }
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={checkingUpdate || !isTauriRuntime()}
                  onClick={onCheckUpdate}
                >
                  {checkingUpdate ? "检查中…" : "立即检查"}
                </Button>
              }
            />
            <SettingRow
              title="恢复默认设置"
              description="仅重置本页偏好，不影响连接配置、SQL 历史与主密码。"
              control={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={reset}
                >
                  <RotateCcwIcon />
                  恢复默认
                </Button>
              }
            />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          {/* 设置项 onChange 即写入 store 并落盘，这里只负责关闭弹窗 */}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
