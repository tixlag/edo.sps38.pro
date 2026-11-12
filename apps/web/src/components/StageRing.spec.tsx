import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ReviewStageProgressDto } from "@edo/api-client";
import { StageRing } from "./StageRing";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("StageRing tooltip", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.useRealTimers();
  });

  async function render(progress: ReviewStageProgressDto) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(<StageRing progress={progress} variant="inline" />),
    );
    const anchor = container.querySelector<HTMLElement>('[role="button"]')!;
    await act(async () => anchor.focus());
    return anchor;
  }

  const progress = (
    required: Record<string, number>,
    additional: Record<string, number>,
  ) =>
    ({
      stage: 2,
      required,
      additional,
      deliveryProblemCount: 1,
    }) as unknown as ReviewStageProgressDto;

  it("shows only non-zero rows and preserves zeroes within a visible row", async () => {
    await render(
      progress({ approved: 2, inReview: 0 }, { approved: 0, inReview: 1 }),
    );
    const tooltip = document.body.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain("Одобрен");
    expect(tooltip.textContent).toContain("На проверке");
    expect(tooltip.textContent).toContain("Проблемы отправки в ERP: 1");
    expect(tooltip.textContent).not.toContain("Распознаётся");
    expect(tooltip.textContent).not.toContain("Возвращён");
    const rows = [...tooltip.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("2");
    expect(rows[0].textContent).toContain("0");
    expect(tooltip.className).toContain("transition-[opacity,transform]");
  });

  it("shows a compact empty state when every status is zero", async () => {
    await render(progress({}, {}));
    const tooltip = document.body.querySelector('[role="tooltip"]')!;
    expect(tooltip.textContent).toContain("Документов пока нет");
    expect(tooltip.querySelector("table")).toBeNull();
    expect(tooltip.textContent).toContain("Проблемы отправки в ERP: 1");
  });
});
