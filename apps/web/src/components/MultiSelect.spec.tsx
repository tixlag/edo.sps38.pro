import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FilterBar, MultiSelect, type MultiSelectOption } from "@edo/ui";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let view: HTMLDivElement;
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = undefined;
  view?.remove();
});
const options = [
  { value: "a", label: "Анна", group: "Подбор" },
  { value: "b", label: "Борис", group: "Подбор" },
  { value: "c", label: "Вера", group: "Оформление" },
];
function mount(optionsOverride: MultiSelectOption[] = options) {
  view = document.createElement("div");
  document.body.append(view);
  root = createRoot(view);
  function Demo() {
    const [value, setValue] = useState<string[]>([]);
    return (
      <FilterBar
        filters={[
          {
            label: "Кандидаты",
            options: optionsOverride,
            value,
            onChange: setValue,
          },
        ]}
        onReset={() => setValue([])}
      />
    );
  }
  act(() => root?.render(<Demo />));
}
function click(selector: string) {
  act(() => view.querySelector<HTMLElement>(selector)!.click());
}

describe("filter multi-select", () => {
  it("keeps the list open while choosing multiple items, shows summary and removable chips", () => {
    mount();
    click('[role="combobox"]');
    click('[role="option"]');
    click('[role="option"]:not([aria-selected="true"])');
    expect(
      view.querySelector('[role="combobox"]')?.getAttribute("aria-expanded"),
    ).toBe("true");
    expect(view.querySelector('[role="combobox"]')?.textContent).toContain(
      "ещё 1",
    );
    expect(
      view.querySelectorAll('[role="option"][aria-selected="true"]'),
    ).toHaveLength(2);
    expect(
      view
        .querySelector('[role="listbox"]')
        ?.getAttribute("aria-multiselectable"),
    ).toBe("true");
    click('button[aria-label="Убрать Кандидаты: Анна"]');
    expect(view.querySelector('[role="combobox"]')?.textContent).toContain(
      "Борис",
    );
    const reset = [...view.querySelectorAll("button")].find(
      (button) => button.textContent === "Сбросить всё",
    )!;
    act(() => reset.click());
    expect(view.querySelector('[aria-label="Выбранные фильтры"]')).toBeNull();
  });
  it("supports keyboard selection and Escape restores trigger focus", () => {
    mount();
    click('[role="combobox"]');
    const input = view.querySelector<HTMLInputElement>('input[type="search"]')!;
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    expect(
      view.querySelector('[role="option"][aria-selected="true"]')?.textContent,
    ).toBe("Борис");
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(
      view.querySelector('[role="combobox"]'),
    );
    expect(view.querySelector('[role="listbox"]')).toBeNull();
  });
  it("retains labels when the async options window changes and renders recoverable errors", () => {
    mount();
    click('[role="combobox"]');
    click('[role="option"]');
    const retry = vi.fn();
    act(() =>
      root?.render(
        <MultiSelect
          label="Кандидаты"
          value={["a"]}
          options={options}
          onChange={vi.fn()}
        />,
      ),
    );
    act(() =>
      root?.render(
        <MultiSelect
          label="Кандидаты"
          value={["a"]}
          options={[]}
          onChange={vi.fn()}
          isError
          onRetry={retry}
        />,
      ),
    );
    expect(view.querySelector('[role="combobox"]')?.textContent).toContain(
      "Анна",
    );
    click('[role="combobox"]');
    expect(view.querySelector('[role="alert"]')?.textContent).toContain(
      "Не удалось",
    );
    act(() =>
      [...view.querySelectorAll("button")]
        .find((button) => button.textContent === "Повторить")!
        .click(),
    );
    expect(retry).toHaveBeenCalledOnce();
  });
});
