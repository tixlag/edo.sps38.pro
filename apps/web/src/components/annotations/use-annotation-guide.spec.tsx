import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useAnnotationGuide } from "./use-annotation-guide";
const calls = vi.hoisted(() => ({
  create: vi.fn(),
  drive: vi.fn(),
  destroy: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("driver.js", () => ({
  driver: (options: Record<string, unknown>) => {
    calls.create(options);
    return {
      drive: calls.drive,
      destroy: () => {
        calls.destroy();
        (options.onDestroyed as () => void)();
      },
      refresh: calls.refresh,
    };
  },
}));
function Guide({
  page,
  ready,
  request,
  active,
}: {
  page: string;
  ready: boolean;
  request: number;
  active: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  useAnnotationGuide(root, request, active, page);
  return (
    <section ref={root}>{ready && <div data-annotation-canvas="" />}</section>
  );
}
describe("annotation instruction lifecycle", () => {
  it("waits for rendered preview, refreshes geometry, restarts for a page and destroys on hide", async () => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    const div = document.createElement("div"),
      root = createRoot(div);
    const focus = document.createElement("button");
    document.body.append(focus, div);
    focus.focus();
    const render = (page: string, ready: boolean, active = true) =>
      act(() =>
        root.render(
          <Guide page={page} ready={ready} request={1} active={active} />,
        ),
      );
    try {
      render("p1", false);
      expect(calls.drive).not.toHaveBeenCalled();
      render("p1", true);
      await act(async () => {
        await Promise.resolve();
      });
      expect(calls.drive).toHaveBeenCalledTimes(1);
      await act(async () => {
        div.querySelector<HTMLElement>(
          "[data-annotation-canvas]",
        )!.style.width = "200px";
        await Promise.resolve();
      });
      expect(calls.refresh).toHaveBeenCalled();
      render("p2", true);
      expect(calls.destroy).toHaveBeenCalledTimes(1);
      expect(calls.drive).toHaveBeenCalledTimes(2);
      render("p2", true, false);
      expect(calls.destroy).toHaveBeenCalledTimes(2);
      expect(document.activeElement).toBe(focus);
    } finally {
      act(() => root.unmount());
      div.remove();
      focus.remove();
    }
  });
});
