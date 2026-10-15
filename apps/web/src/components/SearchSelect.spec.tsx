import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SearchSelect, type SearchSelectOption } from "./SearchSelect";

const OPTIONS: SearchSelectOption[] = [
  { value: "cand-ivanov", label: "Иванов Иван Иванович" },
  { value: "cand-anna", label: "Аннова Анна" },
];

function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function renderSelect(
  props: Partial<Parameters<typeof SearchSelect>[0]> = {},
  options: SearchSelectOption[] = OPTIONS,
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const onChange = vi.fn();
  const onSearchChange = vi.fn();
  const render = (extra: Partial<Parameters<typeof SearchSelect>[0]> = {}) => {
    act(() => {
      root.render(
        <SearchSelect
          label="Кандидат"
          options={options}
          onChange={onChange}
          onSearchChange={onSearchChange}
          {...props}
          {...extra}
        />,
      );
    });
  };
  render();
  return {
    container,
    root,
    render,
    onChange,
    onSearchChange,
    input: () =>
      container.querySelector(
        'input[aria-label="Кандидат"]',
      ) as HTMLInputElement,
    listbox: () => container.querySelector('[role="listbox"]'),
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("SearchSelect", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows the selected option label and clears via the cross button", () => {
    const view = renderSelect({ value: "cand-anna" });
    try {
      expect(view.input().value).toBe("Аннова Анна");
      const clear = view.container.querySelector(
        'button[aria-label="Очистить: Кандидат"]',
      ) as HTMLButtonElement;
      expect(clear).not.toBeNull();
      act(() => {
        clear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(view.onChange).toHaveBeenCalledWith(undefined);
      expect(view.input().value).toBe("");
    } finally {
      view.cleanup();
    }
  });

  it("uses selectedLabel and hides unresolved opaque values", () => {
    const withLabel = renderSelect(
      { value: "cand-ivanov", selectedLabel: "Иванов И." },
      [],
    );
    try {
      expect(withLabel.input().value).toBe("Иванов И.");
    } finally {
      withLabel.cleanup();
    }
    const raw = renderSelect({ value: "cand-unknown" }, []);
    try {
      expect(raw.input().value).toBe("Выбрано");
    } finally {
      raw.cleanup();
    }
  });

  it("debounces search text by 300ms and opens the dropdown on focus", () => {
    const view = renderSelect({ value: undefined });
    try {
      act(() => {
        view.input().focus();
      });
      expect(view.input().getAttribute("aria-expanded")).toBe("true");
      expect(view.listbox()).not.toBeNull();
      typeInto(view.input(), "иван");
      expect(view.onSearchChange).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(view.onSearchChange).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(view.onSearchChange).toHaveBeenCalledWith("иван");
    } finally {
      view.cleanup();
    }
  });

  it("commits the clicked option and closes the dropdown", () => {
    const view = renderSelect({ value: undefined });
    try {
      act(() => {
        view.input().focus();
      });
      const first = view.container.querySelector(
        '[role="option"]',
      ) as HTMLElement;
      act(() => {
        first.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(view.onChange).toHaveBeenCalledWith("cand-ivanov");
      view.render({ value: "cand-ivanov" });
      expect(view.input().value).toBe("Иванов Иван Иванович");
      expect(view.listbox()).toBeNull();
      expect(view.input().getAttribute("aria-expanded")).toBe("false");
    } finally {
      view.cleanup();
    }
  });

  it("reverts the draft and closes on Escape", () => {
    const view = renderSelect({ value: "cand-anna" });
    try {
      act(() => {
        view.input().focus();
      });
      typeInto(view.input(), "иван");
      expect(view.input().value).toBe("иван");
      act(() => {
        view
          .input()
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          );
      });
      expect(view.input().value).toBe("Аннова Анна");
      expect(view.listbox()).toBeNull();
      expect(view.onChange).not.toHaveBeenCalled();
    } finally {
      view.cleanup();
    }
  });

  it("closes on outside click without committing", () => {
    const view = renderSelect({ value: undefined });
    try {
      act(() => {
        view.input().focus();
      });
      expect(view.listbox()).not.toBeNull();
      act(() => {
        document.body.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true }),
        );
      });
      expect(view.listbox()).toBeNull();
      expect(view.onChange).not.toHaveBeenCalled();
    } finally {
      view.cleanup();
    }
  });

  it("selects the highlighted option with Enter", () => {
    const view = renderSelect({ value: undefined });
    try {
      act(() => {
        view.input().focus();
      });
      // Focus opens with the first option highlighted; ArrowDown moves on.
      act(() => {
        view
          .input()
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          );
      });
      expect(view.onChange).toHaveBeenCalledWith("cand-ivanov");
    } finally {
      view.cleanup();
    }
  });

  it("renders loading, empty and error states", () => {
    const loading = renderSelect({ value: undefined }, []);
    try {
      act(() => {
        loading.input().focus();
      });
      loading.render({ isLoading: true });
      expect(loading.container.querySelector('[role="status"]')).not.toBeNull();
    } finally {
      loading.cleanup();
    }
    const empty = renderSelect({ value: undefined }, []);
    try {
      act(() => {
        empty.input().focus();
      });
      expect(empty.container.textContent).toContain("Ничего не найдено");
    } finally {
      empty.cleanup();
    }
    const onRetry = vi.fn();
    const failed = renderSelect(
      { value: undefined, isError: true, onRetry },
      OPTIONS,
    );
    try {
      act(() => {
        failed.input().focus();
      });
      expect(failed.container.querySelector('[role="alert"]')).not.toBeNull();
      const retry = failed.container.querySelector(
        '[role="alert"] button',
      ) as HTMLButtonElement;
      act(() => {
        retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      failed.cleanup();
    }
  });

  it("reflects an externally set value (deep link, reset)", () => {
    const view = renderSelect({ value: undefined });
    try {
      view.render({ value: "cand-ivanov" });
      expect(view.input().value).toBe("Иванов Иван Иванович");
      view.render({ value: undefined });
      expect(view.input().value).toBe("");
    } finally {
      view.cleanup();
    }
  });

  it("remembers the selected label when a remote search replaces the option window", () => {
    const view = renderSelect({ value: "cand-ivanov" });
    try {
      view.render({ options: [] });
      expect(view.input().value).toBe("Иванов Иван Иванович");
      act(() => view.input().focus());
      act(() => vi.advanceTimersByTime(300));
      expect(view.onSearchChange).toHaveBeenLastCalledWith("");
      act(() =>
        view
          .input()
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
          ),
      );
      expect(view.input().value).toBe("Иванов Иван Иванович");
      act(() =>
        view
          .input()
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
          ),
      );
      expect(view.listbox()).not.toBeNull();
    } finally {
      view.cleanup();
    }
  });

  it("does not commit stale options during loading or an error", () => {
    const view = renderSelect({ isLoading: true });
    try {
      act(() => view.input().focus());
      act(() =>
        view
          .input()
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          ),
      );
      expect(view.onChange).not.toHaveBeenCalled();
      view.render({ isLoading: false, isError: true });
      act(() =>
        view
          .input()
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          ),
      );
      expect(view.onChange).not.toHaveBeenCalled();
    } finally {
      view.cleanup();
    }
  });

  it("closes when focus leaves the clear button and handles Escape from it", () => {
    const view = renderSelect({ value: "cand-ivanov" });
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      act(() => view.input().focus());
      const clear = view.container.querySelector("button")!;
      act(() => clear.focus());
      act(() =>
        clear.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        ),
      );
      expect(view.listbox()).toBeNull();
      act(() => view.input().focus());
      act(() => clear.focus());
      act(() => outside.focus());
      expect(view.listbox()).toBeNull();
      expect(view.input().value).toBe("Иванов Иван Иванович");
    } finally {
      outside.remove();
      view.cleanup();
    }
  });
});
