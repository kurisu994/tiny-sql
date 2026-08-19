// 结果表格列宽拖拽 hook（FR-111）
//
// 拖拽表头右缘手柄调整列宽，实时更新并在松手时持久化到 localStorage；
// reset 恢复默认等宽布局。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clampColumnWidth,
  clearColumnWidths,
  columnWidthsKey,
  DEFAULT_COLUMN_WIDTH,
  loadColumnWidths,
  saveColumnWidths,
} from "@/lib/column-widths";

export interface ColumnWidthsController {
  /** 取某列当前宽度（未自定义时为默认值） */
  widthOf: (index: number) => number;
  /** 是否有自定义列宽（决定「恢复默认」按钮可用性） */
  customized: boolean;
  /** 表头手柄 onMouseDown：开始拖拽 */
  startResize: (index: number, event: React.MouseEvent) => void;
  /** 恢复默认列宽并清除持久化 */
  reset: () => void;
}

export function useColumnWidths(
  connectionId: string | null,
  columns: string[],
): ColumnWidthsController {
  const storageKey = useMemo(
    () => (connectionId ? columnWidthsKey(connectionId, columns) : null),
    [connectionId, columns],
  );
  const [widths, setWidths] = useState<Record<number, number>>({});
  const dragRef = useRef<{ index: number; startX: number; startWidth: number } | null>(
    null,
  );

  // 结果结构变化时载入对应持久化列宽
  useEffect(() => {
    setWidths(storageKey ? loadColumnWidths(storageKey) : {});
  }, [storageKey]);

  const startResize = useCallback(
    (index: number, event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = {
        index,
        startX: event.clientX,
        startWidth: widths[index] ?? DEFAULT_COLUMN_WIDTH,
      };

      const onMove = (e: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const next = clampColumnWidth(drag.startWidth + (e.clientX - drag.startX));
        setWidths((prev) => ({ ...prev, [drag.index]: next }));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        dragRef.current = null;
        // 松手才持久化，避免拖拽中高频写 localStorage
        if (storageKey) {
          setWidths((prev) => {
            saveColumnWidths(storageKey, prev);
            return prev;
          });
        }
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [widths, storageKey],
  );

  const widthOf = useCallback(
    (index: number) => widths[index] ?? DEFAULT_COLUMN_WIDTH,
    [widths],
  );

  const reset = useCallback(() => {
    setWidths({});
    if (storageKey) clearColumnWidths(storageKey);
  }, [storageKey]);

  return {
    widthOf,
    customized: Object.keys(widths).length > 0,
    startResize,
    reset,
  };
}
