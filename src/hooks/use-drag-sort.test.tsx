import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDragSort } from "@/hooks/use-drag-sort";

const ITEM_HEIGHT = 50;

/** 最小列表：三项各高 50px，纵向堆叠 */
function Demo({ ids, onReorder }: { ids: string[]; onReorder: (next: string[]) => void }) {
  const { containerRef, draggingId, dropIndex, startDrag } =
    useDragSort<HTMLDivElement>(ids, onReorder);
  return (
    <div ref={containerRef}>
      <ul>
        {ids.map((id) => (
          <li
            key={id}
            data-drag-id={id}
            data-testid={`item-${id}`}
            onPointerDown={(e) => startDrag(id, e)}
          >
            {id}
          </li>
        ))}
      </ul>
      <p data-testid="state">{`${draggingId ?? "-"}/${dropIndex ?? "-"}`}</p>
    </div>
  );
}

/** jsdom 不排版，按 DOM 顺序伪造每项的位置；非列表项按大容器处理 */
function mockLayout() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
    this: Element,
  ) {
    const el = this as HTMLElement;
    const id = el.dataset?.dragId;
    if (id === undefined) {
      return { top: 0, bottom: 1000, height: 1000, left: 0, right: 200, width: 200 } as DOMRect;
    }
    const index = Array.prototype.indexOf.call(el.parentElement!.children, el);
    const top = index * ITEM_HEIGHT;
    return {
      top,
      bottom: top + ITEM_HEIGHT,
      height: ITEM_HEIGHT,
      left: 0,
      right: 200,
      width: 200,
    } as DOMRect;
  });
}

/** 从某项按下，移动到 clientY，然后松手 */
function drag(id: string, fromY: number, toY: number) {
  fireEvent.pointerDown(screen.getByTestId(`item-${id}`), { button: 0, clientY: fromY });
  fireEvent(window, new MouseEvent("pointermove", { clientY: toY }));
  fireEvent(window, new MouseEvent("pointerup", { clientY: toY }));
}

beforeEach(() => {
  mockLayout();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useDragSort", () => {
  it("向下拖过后一项中线时插到它后面", () => {
    const onReorder = vi.fn();
    render(<Demo ids={["a", "b", "c"]} onReorder={onReorder} />);

    // a（0-50）拖到 c（100-150）的下半区
    drag("a", 25, 140);

    expect(onReorder).toHaveBeenCalledWith(["b", "c", "a"]);
  });

  it("向上拖到首项上半区时插到最前", () => {
    const onReorder = vi.fn();
    render(<Demo ids={["a", "b", "c"]} onReorder={onReorder} />);

    drag("c", 125, 10);

    expect(onReorder).toHaveBeenCalledWith(["c", "a", "b"]);
  });

  it("位移没过阈值时按点击处理，不重排", () => {
    const onReorder = vi.fn();
    render(<Demo ids={["a", "b", "c"]} onReorder={onReorder} />);

    drag("a", 25, 27);

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("拖动后落回原位不触发重排", () => {
    const onReorder = vi.fn();
    render(<Demo ids={["a", "b", "c"]} onReorder={onReorder} />);

    // 拖出阈值但仍停在自己所在的区间
    drag("b", 75, 90);

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("拖动中暴露 draggingId 与 dropIndex，松手后复位", () => {
    render(<Demo ids={["a", "b", "c"]} onReorder={vi.fn()} />);

    fireEvent.pointerDown(screen.getByTestId("item-a"), { button: 0, clientY: 25 });
    fireEvent(window, new MouseEvent("pointermove", { clientY: 140 }));
    expect(screen.getByTestId("state")).toHaveTextContent("a/3");

    fireEvent(window, new MouseEvent("pointerup", { clientY: 140 }));
    expect(screen.getByTestId("state")).toHaveTextContent("-/-");
  });

  it("右键按下不进入拖拽", () => {
    const onReorder = vi.fn();
    render(<Demo ids={["a", "b", "c"]} onReorder={onReorder} />);

    fireEvent.pointerDown(screen.getByTestId("item-a"), { button: 2, clientY: 25 });
    fireEvent(window, new MouseEvent("pointermove", { clientY: 140 }));
    fireEvent(window, new MouseEvent("pointerup", { clientY: 140 }));

    expect(onReorder).not.toHaveBeenCalled();
    expect(screen.getByTestId("state")).toHaveTextContent("-/-");
  });
});
