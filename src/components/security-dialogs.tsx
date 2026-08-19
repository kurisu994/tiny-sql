"use client";

import { useState } from "react";

import { Overlay } from "@/components/connection-dialogs";
import { translateError } from "@/lib/tauri-api";
import { useConfirmStore } from "@/stores/confirm-store";
import { useSecurityStore } from "@/stores/security-store";

/**
 * 主密码解锁对话框（FR-102）：启动后处于 Locked 时强制展示。
 * 忘记主密码可走重置路径，会明确告知数据不可恢复。
 */
export function UnlockDialog() {
  const unlock = useSecurityStore((s) => s.unlock);
  const reset = useSecurityStore((s) => s.reset);
  const confirm = useConfirmStore((s) => s.confirm);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
    } catch (e) {
      setError(translateError(e));
      setBusy(false);
    }
  }

  async function forgotPassword() {
    const ok = await confirm({
      title: "忘记主密码",
      message:
        "重置将永久删除全部已保存连接、已保存的 SSH passphrase 与 SQL 历史，且无法恢复。确定继续？",
      confirmText: "全部删除并重置",
      danger: true,
    });
    if (!ok) return;
    try {
      await reset();
    } catch (e) {
      setError(translateError(e));
    }
  }

  return (
    <Overlay>
      <h3 className="text-base font-semibold">解锁 tiny-sql</h3>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        连接配置已用主密码加密，请输入主密码解锁。
      </p>
      <input
        type="password"
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900"
      />
      {error && <p className="text-xs text-red-600 dark:text-red-300">{error}</p>}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={forgotPassword}
          className="text-xs text-neutral-400 underline hover:text-red-600 dark:hover:text-red-300"
        >
          忘记主密码？
        </button>
        <button
          onClick={submit}
          disabled={busy || password.length === 0}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "解锁中…" : "解锁"}
        </button>
      </div>
    </Overlay>
  );
}

/**
 * 安全设置对话框：启用 / 锁定 / 关闭主密码。
 */
export function SecuritySettingsDialog({ onClose }: { onClose: () => void }) {
  const status = useSecurityStore((s) => s.status);
  const setup = useSecurityStore((s) => s.setup);
  const lock = useSecurityStore((s) => s.lock);
  const disable = useSecurityStore((s) => s.disable);
  const confirm = useConfirmStore((s) => s.confirm);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onClose();
    } catch (e) {
      setError(translateError(e));
      setBusy(false);
    }
  }

  async function submitSetup() {
    if (password.length < 8) {
      setError("主密码至少 8 个字符");
      return;
    }
    if (password !== confirmPassword) {
      setError("两次输入的主密码不一致");
      return;
    }
    await run(() => setup(password));
  }

  async function submitDisable() {
    const ok = await confirm({
      title: "关闭主密码",
      message:
        "关闭后连接配置将改用本机密钥加密（防明文直读，但不抗本机攻击者），已保存的 SSH passphrase 会被清除。确定继续？",
      confirmText: "关闭主密码",
      danger: true,
    });
    if (!ok) return;
    await run(() => disable(password));
  }

  return (
    <Overlay>
      <h3 className="text-base font-semibold">安全设置</h3>
      {status === "disabled" ? (
        <>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            设置主密码后，连接配置将改用主密码派生密钥加密（Argon2id +
            AES-256-GCM），并可在解锁后保存 SSH 私钥 passphrase。每次启动应用需输入主密码解锁。
          </p>
          <input
            type="password"
            placeholder="主密码（至少 8 个字符）"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="new-password"
            spellCheck={false}
            className="w-full rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900"
          />
          <input
            type="password"
            placeholder="再次输入主密码"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitSetup();
            }}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="new-password"
            spellCheck={false}
            className="w-full rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900"
          />
          {error && (
            <p className="text-xs text-red-600 dark:text-red-300">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
            >
              取消
            </button>
            <button
              onClick={submitSetup}
              disabled={busy || password.length === 0}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? "迁移中…" : "启用主密码"}
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            主密码已启用。锁定后需重新输入主密码才能读取或保存连接配置；
            关闭主密码会把数据迁回本机密钥加密。
          </p>
          <input
            type="password"
            placeholder="输入主密码以关闭保护"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-neutral-300 px-2 py-1 dark:border-neutral-600 dark:bg-neutral-900"
          />
          {error && (
            <p className="text-xs text-red-600 dark:text-red-300">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
            >
              取消
            </button>
            <button
              onClick={() => run(lock)}
              disabled={busy}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
            >
              立即锁定
            </button>
            <button
              onClick={submitDisable}
              disabled={busy || password.length === 0}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              关闭主密码
            </button>
          </div>
        </>
      )}
    </Overlay>
  );
}
