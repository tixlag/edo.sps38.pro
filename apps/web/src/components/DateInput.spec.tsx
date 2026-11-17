import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { DateInput } from "./DateInput";

it("rejects impossible typed dates and clears the error after choosing a calendar date", () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function Form() {
    const [value, setValue] = useState<string | null>("2024-02-29");
    return <DateInput label="Дата" value={value} onChange={setValue} />;
  }
  try {
    act(() => root.render(<Form />));
    const text = container.querySelector(
      'input[type="text"]',
    ) as HTMLInputElement;
    const calendar = container.querySelector(
      'input[type="date"]',
    ) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    const enter = (input: HTMLInputElement, value: string) =>
      act(() => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
    expect(text.value).toBe("29.02.2024");
    enter(text, "31022024");
    expect(text.checkValidity()).toBe(false);
    expect(calendar.value).toBe("2024-02-29");
    enter(calendar, "2025-03-01");
    expect(text.value).toBe("01.03.2025");
    expect(text.checkValidity()).toBe(true);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
