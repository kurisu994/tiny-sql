// 竖向列表拖拽排序 hook（FR-003）
//
// 不引入 dnd 库：pointer 事件 + 元素位置计算，指示线交给调用方按 dropIndex 画。
// 用 pointer 而不是 HTML5 draggable —— Tauri 窗口默认接管拖放，
// WebView 里的 dragstart/drop 不可靠。
//
// 列表项需要带 `data-drag-id={id}`，且 DOM 顺序与传入的 ids 一致。

import { useCallback, useEffect, useRef, useState } from "react";

/** 超过这个位移才认作拖拽，避免和单击选中 / 双击连接抢手势 */
const DRAG_THRESHOLD_PX = 4;
/** 指针进入容器上下边缘这个范围时自动滚动 */
const EDGE_SCROLL_ZONE_PX = 28;
/** 自动滚动速度（px / 帧） */
const EDGE_SCROLL_SPEED_PX = 10;

export interface DragSortController<T extends HTMLElement> {
  /** 绑到滚动容器：用于边缘自动滚动和读取列表项位置 */
  containerRef: React.RefObject<T | null>;
  /** 正在拖的项 id，null 表示没在拖 */
  draggingId: string | null;
  /** 插入位置下标，取值 0..ids.length；null 表示不画指示线 */
  dropIndex: number | null;
  /** 列表项的 onPointerDown */
  startDrag: (id: string, event: React.PointerEvent) => void;
  /** 拖完那一次 click 要吞掉，避免误改选中项；读一次即复位 */
  consumeClickSuppression: () => boolean;
}

export function useDragSort<T extends HTMLElement>(
  ids: string[],
  onReorder: (nextIds: string[]) => void,
): DragSortController<T> {
  const containerRef = useRef<T | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  // 拖拽中 ids / 回调变化不该重建监听，统一走 ref 读最新值
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const dragRef = useRef<{
    id: string;
    startY: number;
    pointerY: number;
    active: boolean;
  } | null>(null);
  const scrollRafRef = useRef<number | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const suppressClickRef = useRef(false);

  /** 指针落在哪两项之间：返回插入下标（0..n） */
  const computeDropIndex = useCallback((clientY: number): number | null => {
    const container = containerRef.current;
    if (!container) return null;
    const items = Array.from(
      container.querySelectorAll<HTMLElement>("[data-drag-id]"),
    );
    if (items.length === 0) return null;
    for (let i = 0; i < items.length; i += 1) {
      const rect = items[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return items.length;
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
  }, []);

  /** 指针贴着容器上下边缘时持续滚动；离开边缘区后循环自行停止 */
  const pumpAutoScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return;
    const step = () => {
      scrollRafRef.current = null;
      const drag = dragRef.current;
      const container = containerRef.current;
      if (!drag?.active || !container) return;
      const rect = container.getBoundingClientRect();
      let delta = 0;
      if (drag.pointerY < rect.top + EDGE_SCROLL_ZONE_PX) {
        delta = -EDGE_SCROLL_SPEED_PX;
      } else if (drag.pointerY > rect.bottom - EDGE_SCROLL_ZONE_PX) {
        delta = EDGE_SCROLL_SPEED_PX;
      }
      if (delta === 0) return;
      container.scrollTop += delta;
      setDropIndex(computeDropIndex(drag.pointerY));
      scrollRafRef.current = requestAnimationFrame(step);
    };
    scrollRafRef.current = requestAnimationFrame(step);
  }, [computeDropIndex]);

  /** 把 id 移到插入下标处，顺序真的变了才回调 */
  const commit = useCallback((id: string, insertAt: number) => {
    const current = idsRef.current;
    const from = current.indexOf(id);
    if (from < 0) return;
    const next = current.slice();
    next.splice(from, 1);
    // 插入点在原位置之后时，抽走自己后下标要减一
    next.splice(insertAt > from ? insertAt - 1 : insertAt, 0, id);
    if (next.some((value, index) => value !== current[index])) {
      onReorderRef.current(next);
    }
  }, []);

  const startDrag = useCallback(
    (id: string, event: React.PointerEvent) => {
      // 只接左键：右键留给上下文菜单
      if (event.button !== 0) return;
      dragRef.current = {
        id,
        startY: event.clientY,
        pointerY: event.clientY,
        active: false,
      };

      const onMove = (e: PointerEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        drag.pointerY = e.clientY;
        if (!drag.active) {
          if (Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD_PX) return;
          drag.active = true;
          setDraggingId(drag.id);
        }
        setDropIndex(computeDropIndex(e.clientY));
        pumpAutoScroll();
      };
      const finish = () => {
        cleanupRef.current?.();
        cleanupRef.current = null;
        stopAutoScroll();
        const drag = dragRef.current;
        dragRef.current = null;
        setDraggingId(null);
        setDropIndex(null);
        if (!drag?.active) return;
        // 拖拽结束后浏览器还会补一次 click，交给调用方吞掉
        suppressClickRef.current = true;
        const insertAt = computeDropIndex(drag.pointerY);
        if (insertAt !== null) commit(drag.id, insertAt);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
      };
    },
    [commit, computeDropIndex, pumpAutoScroll, stopAutoScroll],
  );

  // 拖到一半组件被卸载时兜底清理
  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    },
    [],
  );

  const consumeClickSuppression = useCallback(() => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  }, []);

  return {
    containerRef,
    draggingId,
    dropIndex,
    startDrag,
    consumeClickSuppression,
  };
}
