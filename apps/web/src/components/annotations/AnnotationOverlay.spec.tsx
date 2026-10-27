import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AnnotationOverlay } from "./AnnotationOverlay";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
describe("manual annotation overlay", () => {
  it("moves a focused line by source pixels using keyboard and keeps literal text", () => {
    const div = document.createElement("div");
    document.body.append(div);
    const root = createRoot(div);
    const change = vi.fn();
    act(() =>
      root.render(
        <AnnotationOverlay
          lines={[
            {
              id: "line",
              pageId: "p",
              order: 0,
              text: "ИВАНОВ",
              quad: [0.1, 0.1, 0.3, 0.1, 0.3, 0.15, 0.1, 0.15],
            },
          ]}
          width={600}
          height={900}
          rotation={90}
          selectedId="line"
          onSelect={() => undefined}
          onChange={change}
          onCreate={() => undefined}
          editable
        />,
      ),
    );
    act(() =>
      div
        .querySelector('[data-annotation-line="line"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
    );
    expect(change).toHaveBeenCalledWith(
      "line",
      expect.arrayContaining([expect.closeTo(0.1 + 1 / 600, 6)]),
    );
    expect(div.textContent).toContain("ИВАНОВ");
    act(() => root.unmount());
    div.remove();
  });
  it("does not mutate a submitted or foreign author line", () => {
    const div = document.createElement("div"),
      root = createRoot(div),
      change = vi.fn();
    act(() =>
      root.render(
        <AnnotationOverlay
          lines={[
            {
              id: "line",
              pageId: "p",
              order: 0,
              text: "TEXT",
              quad: [0.1, 0.1, 0.3, 0.1, 0.3, 0.15, 0.1, 0.15],
            },
          ]}
          width={600}
          height={900}
          rotation={0}
          selectedId="line"
          onSelect={() => undefined}
          onChange={change}
          onCreate={() => undefined}
          editable={false}
        />,
      ),
    );
    act(() =>
      div
        .querySelector('[data-annotation-line="line"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
    );
    expect(change).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it("focuses a pointer-selected line so the next arrow key moves that line", () => {
    const div = document.createElement("div"),
      root = createRoot(div),
      change = vi.fn();
    document.body.append(div);
    act(() =>
      root.render(
        <AnnotationOverlay
          lines={[
            {
              id: "line",
              pageId: "p",
              order: 0,
              text: "TEXT",
              quad: [0.1, 0.1, 0.3, 0.1, 0.3, 0.15, 0.1, 0.15],
            },
          ]}
          width={600}
          height={900}
          rotation={0}
          selectedId={null}
          onSelect={() => undefined}
          onChange={change}
          onCreate={() => undefined}
          editable
        />,
      ),
    );
    const svg = div.querySelector("svg")!;
    svg.setPointerCapture = vi.fn();
    vi.spyOn(svg, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 600,
      height: 900,
    } as DOMRect);
    try {
      act(() =>
        div.querySelector('[data-annotation-line="line"]')!.dispatchEvent(
          new MouseEvent("pointerdown", {
            clientX: 120,
            clientY: 110,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(document.activeElement).toBe(
        div.querySelector('[data-annotation-line="line"]'),
      );
      act(() =>
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        ),
      );
      expect(change).toHaveBeenCalledWith(
        "line",
        expect.arrayContaining([expect.closeTo(0.1 + 1 / 600, 6)]),
      );
    } finally {
      act(() => root.unmount());
      div.remove();
    }
  });
});
