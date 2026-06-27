"use client";

import { useEffect, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import {
  SSH_EVENTS,
  tofuApi,
  type HopStatusPayload,
  type TofuRequestPayload,
} from "@/lib/tauri-api";
import { useSessionStore } from "@/stores/session-store";

/**
 * 连接相关的全局对话框 + 事件监听，挂一次即可：
 * - `ssh:tofu-request` → TOFU 信任弹窗（队列，逐个处理多跳）
 * - `ssh:hop-status` → keepalive 断开标记
 * - 私钥 passphrase 弹窗（由 session store 触发）
 */
export function ConnectionDialogs() {
  const [tofuQueue, setTofuQueue] = useState<TofuRequestPayload[]>([]);
  const passphraseFor = useSessionStore((s) => s.passphraseFor);
  const submitPassphrase = useSessionStore((s) => s.submitPassphrase);
  const cancelPassphrase = useSessionStore((s) => s.cancelPassphrase);
  const markHopLost = useSessionStore((s) => s.markHopLost);

  // TOFU 请求事件 → 入队
  useEffect(() => {
    const un = listen<TofuRequestPayload>(SSH_EVENTS.tofuRequest, (e) => {
      setTofuQueue((q) => [...q, e.payload]);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // keepalive 断开事件 → 标记
  useEffect(() => {
    const un = listen<HopStatusPayload>(SSH_EVENTS.hopStatus, (e) => {
      if (e.payload.status === "lost") markHopLost(e.payload.hopIndex);
    });
    return () => {
      un.then((f) => f());
    };
  }, [markHopLost]);

  const current = tofuQueue[0] ?? null;

  async function resolveTofu(accept: boolean) {
    if (!current) return;
    await tofuApi.decide(current.connectionId, current.hopIndex, accept);
    setTofuQueue((q) => q.slice(1));
  }

  return (
    <>
      {current && (
        <TofuDialog
          req={current}
          onAccept={() => resolveTofu(true)}
          onReject={() => resolveTofu(false)}
        />
      )}
      {passphraseFor && (
        <PassphraseDialog
          onSubmit={submitPassphrase}
          onCancel={cancelPassphrase}
        />
      )}
    </>
  );
}

/** 首次连接某 SSH 主机的指纹确认弹窗（TOFU） */
function TofuDialog({
  req,
  onAccept,
  onReject,
}: {
  req: TofuRequestPayload;
  onAccept: () => void;
  onReject: () => void;
}) {
  return (
    <Overlay>
      <h3 className="text-base font-semibold">确认 SSH 主机指纹</h3>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        首次连接第 {req.hopIndex + 1} 跳 <b>{req.host}:{req.port}</b>
        ，请核对其公钥指纹：
      </p>
      <code className="block break-all rounded bg-neutral-100 px-2 py-1 text-xs dark:bg-neutral-800">
        {req.fingerprint}
      </code>
      <p className="text-xs text-neutral-500">
        确认无误后将记入信任库；若日后指纹变化会被硬拒绝。
      </p>
      <div className="flex justify-end gap-2">
        <button
          onClick={onReject}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          拒绝
        </button>
        <button
          onClick={onAccept}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          信任并继续
        </button>
      </div>
    </Overlay>
  );
}

/** 私钥 passphrase 输入弹窗（仅会话内存） */
function PassphraseDialog({
  onSubmit,
  onCancel,
}: {
  onSubmit: (passphrase: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  return (
    <Overlay>
      <h3 className="text-base font-semibold">输入私钥 passphrase</h3>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        该 SSH 私钥已加密，请输入 passphrase（仅本次会话内存，不保存）。
      </p>
      <div className="relative">
        <input
          type={show ? "text" : "password"}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit(value);
          }}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          className="w-full rounded-md border border-neutral-300 px-2 py-1 pr-9 dark:border-neutral-600 dark:bg-neutral-900"
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          tabIndex={-1}
          title={show ? "隐藏" : "显示"}
          className="absolute inset-y-0 right-0 flex items-center px-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
        >
          {show ? "🙈" : "👁"}
        </button>
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 dark:border-neutral-600 dark:hover:bg-neutral-800"
        >
          取消
        </button>
        <button
          onClick={() => onSubmit(value)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
        >
          确定
        </button>
      </div>
    </Overlay>
  );
}

/** 居中模态遮罩 */
function Overlay({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900">
        {children}
      </div>
    </div>
  );
}
