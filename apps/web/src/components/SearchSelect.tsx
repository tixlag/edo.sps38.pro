import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";

/**
 * Single option of {@link SearchSelect}: an opaque `value` committed to the
 * caller (URL, exact backend filter) and a human-readable `label`.
 */
export interface SearchSelectOption {
  value: string;
  label: string;
}

export interface SearchSelectProps {
  /** Accessible name of the filter (input aria-label). */
  label: string;
  placeholder?: string;
  /**
   * Selected option value (`null`/`undefined`/"" = nothing selected).
   * The input shows the matching option label, or `selectedLabel`, or
   * a neutral label while a deep-linked value has not been resolved yet.
   */
  value?: string | null;
  /** Label for `value` when `options` do not contain it. */
  selectedLabel?: string;
  /** Currently visible options; the parent reloads or filters them. */
  options: SearchSelectOption[];
  /**
   * Debounced (300 ms) search text. The parent reloads async options
   * (candidates, positions) or filters static ones (facets) from it.
   */
  onSearchChange?: (query: string) => void;
  /** Commits the selected value (`undefined` = cleared). */
  onChange: (next: string | undefined) => void;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  emptyText?: string;
  loadingText?: string;
  errorText?: string;
  disabled?: boolean;
  className?: string;
}

/** Debounce for search propagation, ms. */
export const SEARCH_SELECT_DEBOUNCE_MS = 300;

/**
 * Universal search selector: text input + dropdown list.
 * Closes on Escape / outside click / focus loss, clears via the cross button.
 * Styles use semantic CSS tokens only (no hardcoded hex).
 */
export function SearchSelect({
  label,
  placeholder,
  value,
  selectedLabel,
  options,
  onSearchChange,
  onChange,
  isLoading,
  isError,
  onRetry,
  emptyText = "Ничего не найдено",
  loadingText = "Загрузка…",
  errorText = "Не удалось загрузить варианты.",
  disabled,
  className,
}: SearchSelectProps) {
  const listboxId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onSearchChangeRef = useRef(onSearchChange);
  onSearchChangeRef.current = onSearchChange;

  const normalizedValue = value ?? "";
  const rememberedOption = useRef<SearchSelectOption>();
  const currentOption = options.find(
    (option) => option.value === normalizedValue,
  );
  if (currentOption) rememberedOption.current = currentOption;
  const display =
    normalizedValue === ""
      ? ""
      : (currentOption?.label ??
        selectedLabel ??
        (rememberedOption.current?.value === normalizedValue
          ? rememberedOption.current.label
          : "Выбрано"));
  const displayRef = useRef(display);
  displayRef.current = display;

  const [text, setText] = useState(display);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const sentQueryRef = useRef<string | null>(null);

  // External value/options changes (URL deep link, reset button, loaded
  // options resolving the label) refresh the input, but never while typing.
  useEffect(() => {
    if (!open) {
      setText(displayRef.current);
    }
  }, [display, open]);

  useEffect(() => {
    setHighlight(-1);
  }, [options]);

  useEffect(() => {
    if (open && highlight >= 0) {
      document
        .getElementById(`${listboxId}-${highlight}`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }, [open, highlight, listboxId]);

  // Propagate the search text debounced, only while the dropdown is open.
  useEffect(() => {
    if (!open) return;
    if (sentQueryRef.current === text) return;
    const timer = window.setTimeout(() => {
      sentQueryRef.current = text;
      onSearchChangeRef.current?.(text);
    }, SEARCH_SELECT_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, open]);

  const close = (revert: boolean) => {
    setOpen(false);
    setHighlight(-1);
    if (revert) setText(displayRef.current);
  };

  const commit = (next: string | undefined, nextLabel: string) => {
    if (next) rememberedOption.current = { value: next, label: nextLabel };
    sentQueryRef.current = null;
    setText(nextLabel);
    setOpen(false);
    setHighlight(-1);
    onChange(next);
  };

  const openWithHighlight = () => {
    const selectedIndex = options.findIndex(
      (option) => option.value === normalizedValue,
    );
    setHighlight(options.length > 0 ? Math.max(0, selectedIndex) : -1);
    setText("");
    setOpen(true);
  };

  const clear = () => {
    sentQueryRef.current = "";
    setText("");
    onSearchChangeRef.current?.("");
    onChange(undefined);
    setHighlight(-1);
    setOpen(true);
    inputRef.current?.focus();
  };

  // Close on outside click (option clicks stay inside the container and
  // select via onClick; option mousedown keeps input focus so no premature
  // blur happens before the click).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        close(true);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const showClear = normalizedValue !== "" || text !== "";

  return (
    <div
      ref={containerRef}
      className={`relative ${className ?? ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          close(true);
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
      }}
    >
      <input
        ref={inputRef}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && !isLoading && !isError && options[highlight]
            ? `${listboxId}-${highlight}`
            : undefined
        }
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder ?? label}
        value={text}
        className="w-full rounded-[6px] border border-[var(--border)] bg-[var(--background)] py-1.5 pl-2 pr-12 text-[13px] text-[var(--foreground)]"
        onFocus={() => {
          if (!open) openWithHighlight();
        }}
        onClick={() => {
          if (!open) openWithHighlight();
        }}
        onChange={(event) => {
          if (!open) openWithHighlight();
          setText(event.target.value);
          setHighlight(-1);
        }}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openWithHighlight();
            return;
          }
          if (!open || isLoading || isError || options.length === 0) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setHighlight((prev) =>
              prev < 0 ? 0 : Math.min(prev + 1, options.length - 1),
            );
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setHighlight((prev) =>
              prev < 0 ? options.length - 1 : Math.max(prev - 1, 0),
            );
          } else if (event.key === "Enter") {
            const picked = highlight >= 0 ? options[highlight] : undefined;
            if (picked) {
              event.preventDefault();
              commit(picked.value, picked.label);
            }
          }
        }}
      />
      {showClear && !disabled && (
        <button
          type="button"
          aria-label={`Очистить: ${label}`}
          onClick={clear}
          className="absolute right-7 top-1/2 -translate-y-1/2 rounded px-1 text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <X size={14} aria-hidden />
        </button>
      )}
      <span
        aria-hidden
        className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--muted-foreground)]"
      >
        <ChevronDown size={14} />
      </span>
      {open && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="absolute z-50 mt-1 max-h-56 w-full overflow-auto rounded-[6px] border border-[var(--border)] bg-[var(--background)] py-1 shadow-lg"
        >
          {isLoading && (
            <li
              role="status"
              className="px-2 py-1.5 text-[13px] text-[var(--muted-foreground)]"
            >
              {loadingText}
            </li>
          )}
          {!isLoading && isError && (
            <li role="alert" className="px-2 py-1.5 text-[13px]">
              <span className="text-[var(--danger)]">{errorText}</span>{" "}
              {onRetry && (
                <button
                  type="button"
                  className="font-semibold text-[var(--primary)] underline-offset-4 hover:underline"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void onRetry()}
                >
                  Повторить
                </button>
              )}
            </li>
          )}
          {!isLoading && !isError && options.length === 0 && (
            <li className="px-2 py-1.5 text-[13px] text-[var(--muted-foreground)]">
              {emptyText}
            </li>
          )}
          {!isLoading &&
            !isError &&
            options.map((option, index) => (
              <li
                key={option.value}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={option.value === normalizedValue}
                data-highlighted={index === highlight || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (highlight !== index) setHighlight(index);
                }}
                onClick={() => commit(option.value, option.label)}
                className={`cursor-pointer px-2 py-1.5 text-[13px] text-[var(--foreground)] ${
                  index === highlight ? "bg-[var(--muted)]" : ""
                } ${option.value === normalizedValue ? "font-semibold" : ""}`}
              >
                {option.label}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
