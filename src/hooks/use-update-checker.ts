"use client";

import { useCallback, useEffect, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import {
  APP_EVENTS,
  isTauriRuntime,
  translateError,
  updateApi,
  type UpdateInfo,
} from "@/lib/tauri-api";

const STARTUP_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const LAST_CHECK_KEY = "tiny-sql:last-update-check";

function getLastCheckAt(): number {
  try {
    return Number(window.localStorage.getItem(LAST_CHECK_KEY) ?? "0");
  } catch {
    return 0;
  }
}

function setLastCheckAt(value: number) {
  try {
    window.localStorage.setItem(LAST_CHECK_KEY, String(value));
  } catch {
    // localStorage 不可用不影响更新检查本身。
  }
}

export function useUpdateChecker() {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [checkNotice, setCheckNotice] = useState<string | null>(null);

  const checkForUpdate = useCallback(async (manual: boolean) => {
    if (!isTauriRuntime()) return null;

    setChecking(true);
    if (manual) {
      setCheckError(null);
      setCheckNotice(null);
    }

    try {
      const update = await updateApi.check();
      setLastCheckAt(Date.now());
      setUpdateInfo(update);
      if (update) {
        setCheckNotice(null);
      } else if (manual) {
        setCheckNotice("当前已是最新版本");
      }
      return update;
    } catch (e) {
      if (manual) setCheckError(translateError(e));
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    const un = listen(APP_EVENTS.checkUpdate, () => {
      void checkForUpdate(true);
    });

    return () => {
      un.then((f) => f());
    };
  }, [checkForUpdate]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    if (Date.now() - getLastCheckAt() < CHECK_INTERVAL_MS) return;

    const timer = window.setTimeout(() => {
      void checkForUpdate(false);
    }, STARTUP_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [checkForUpdate]);

  return {
    updateInfo,
    checking,
    checkError,
    checkNotice,
    manualCheck: () => checkForUpdate(true),
    dismissUpdate: () => {
      setUpdateInfo(null);
      setCheckNotice(null);
    },
  };
}
