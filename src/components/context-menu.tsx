"use client";

import { Fragment, useLayoutEffect, useRef, useState } from "react";

/** 右键上下文菜单的单个菜单项 */
export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  /** 置灰且不可点击 */
  disabled?: boolean;
  /** 危险操作（红色文字），如删除 */
  danger?: boolean;
  /** 在该项上方渲染一条分隔线 */
  divider?: boolean;
}

/**
 * 跟随鼠标位置弹出的上下文菜单（Navicat 风格）。
 *
 * 点击空白处、按 Esc、窗口缩放/滚动都会关闭；挂载后测量自身尺寸，
 * 把溢出视口右/下边缘的位置回拉到可见区域内。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // 测量后做边缘回拉，避免菜单被视口裁切
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    });
  }, [x, y]);

  // 关闭交互：点击外部 / Esc / 缩放 / 滚动
  useLayoutEffect(() => {
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-44 rounded-md border border-neutral-200 bg-white py-1 text-sm shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      style={{ left: pos.x, top: pos.y }}
    >
      {items.map((item, i) => (
        <Fragment key={i}>
          {item.divider && (
            <div className="my-1 h-px bg-neutral-200 dark:bg-neutral-800" />
          )}
          <button
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
            disabled={item.disabled}
            className={`block w-full px-3 py-1.5 text-left hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-neutral-800 ${
              item.danger ? "text-red-600 dark:text-red-400" : ""
            }`}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
