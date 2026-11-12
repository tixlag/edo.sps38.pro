import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "../lib/cn";
import { Button } from "./button";

export interface MultiSelectOption {
  value: string;
  label: string;
  group?: string;
}
export interface MultiSelectProps {
  label: string;
  placeholder?: string;
  value: string[];
  options: MultiSelectOption[];
  selectedLabels?: Record<string, string>;
  onChange: (value: string[]) => void;
  onSearchChange?: (query: string) => void;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  disabled?: boolean;
  className?: string;
}

export function MultiSelect({
  label,
  placeholder = "Все",
  value,
  options,
  selectedLabels,
  onChange,
  onSearchChange,
  isLoading,
  isError,
  onRetry,
  disabled,
  className,
}: MultiSelectProps) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const remembered = useRef(new Map<string, string>());
  for (const option of options)
    remembered.current.set(option.value, option.label);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    maxHeight: 360,
  });
  const onSearch = useRef(onSearchChange);
  onSearch.current = onSearchChange;
  const visible = onSearchChange
    ? options
    : options.filter((option) =>
        `${option.label} ${option.group ?? ""}`
          .toLocaleLowerCase("ru")
          .includes(query.trim().toLocaleLowerCase("ru")),
      );
  const name = (key: string) =>
    remembered.current.get(key) ?? selectedLabels?.[key] ?? "Выбрано";
  const close = (restoreFocus = false) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => onSearch.current?.(query), 300);
    return () => window.clearTimeout(timer);
  }, [query, open]);
  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const below = window.innerHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const height = Math.min(360, Math.max(below, above));
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24);
      setPosition({
        top:
          below >= Math.min(300, above)
            ? rect.bottom + 6
            : Math.max(12, rect.top - height - 6),
        left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12),
        width,
        maxHeight: height,
      });
    };
    reposition();
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-${active}`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, id]);
  const toggle = (key: string) => {
    if (value.includes(key)) onChange(value.filter((item) => item !== key));
    else if (value.length < 100) onChange([...value, key]);
  };
  return (
    <div
      ref={root}
      className={cn("min-w-0", className)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          close(true);
        }
        if (!open) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setActive((index) =>
            Math.max(
              0,
              Math.min(
                visible.length - 1,
                index + (event.key === "ArrowDown" ? 1 : -1),
              ),
            ),
          );
        }
        if (event.key === "Enter" && event.target === search.current) {
          event.preventDefault();
          if (visible[active] && !isLoading && !isError)
            toggle(visible[active].value);
        }
      }}
    >
      <span
        id={`${id}-label`}
        className="mb-1.5 block text-xs font-medium text-[var(--muted-foreground)]"
      >
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        disabled={disabled}
        className={cn(
          "flex h-10 w-full items-center gap-2 rounded-lg border bg-[var(--card)] px-3 text-left text-sm transition-colors hover:border-[var(--muted-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:cursor-not-allowed disabled:opacity-50",
          value.length
            ? "border-[var(--primary)]/30 text-[var(--foreground)]"
            : "border-[var(--border)] text-[var(--muted-foreground)]",
        )}
        onClick={() => setOpen((previous) => !previous)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate">
          {value.length ? name(value[0]) : placeholder}
        </span>
        {value.length > 1 && (
          <span className="shrink-0 rounded bg-[var(--primary-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--primary)]">
            ещё {value.length - 1}
          </span>
        )}
        <ChevronDown
          size={15}
          aria-hidden="true"
          className={cn("shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div
          className="fixed z-[80] flex flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-[0_8px_24px_color-mix(in_srgb,var(--foreground)_12%,transparent)]"
          style={position}
        >
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
            <Search
              size={15}
              aria-hidden="true"
              className="shrink-0 text-[var(--muted-foreground)]"
            />
            <input
              ref={search}
              type="search"
              aria-label={`Поиск: ${label}`}
              aria-controls={`${id}-list`}
              aria-activedescendant={
                visible[active] && !isLoading && !isError
                  ? `${id}-${active}`
                  : undefined
              }
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Найти…"
              className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--muted-foreground)]"
            />
          </div>
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--muted-foreground)]">
            <span aria-live="polite">
              {value.length
                ? `Выбрано: ${value.length}${value.length >= 100 ? " (максимум)" : ""}`
                : "Можно выбрать несколько"}
            </span>
            <button
              type="button"
              disabled={!value.length}
              className="rounded px-1 text-[var(--primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] disabled:opacity-40"
              onClick={() => onChange([])}
            >
              Очистить
            </button>
          </div>
          {isLoading ? (
            <p
              role="status"
              className="p-4 text-sm text-[var(--muted-foreground)]"
            >
              Загрузка…
            </p>
          ) : isError ? (
            <div role="alert" className="p-4 text-sm">
              Не удалось загрузить варианты.{" "}
              {onRetry && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onRetry}
                >
                  Повторить
                </Button>
              )}
            </div>
          ) : (
            <ul
              id={`${id}-list`}
              role="listbox"
              aria-label={label}
              aria-multiselectable="true"
              className="min-h-0 overflow-y-auto overscroll-contain p-1.5"
            >
              {!visible.length && (
                <li
                  role="presentation"
                  className="px-2 py-4 text-sm text-[var(--muted-foreground)]"
                >
                  Ничего не найдено
                </li>
              )}
              {visible.map((option, index) => (
                <Fragment key={option.value}>
                  {option.group &&
                    option.group !== visible[index - 1]?.group && (
                      <li
                        role="presentation"
                        className="mb-1 mt-2 flex items-center justify-between gap-3 border-b border-[var(--border)] px-2 pb-2 pt-1 text-xs font-semibold text-[var(--muted-foreground)]"
                      >
                        <span>{option.group}</span>
                        <span>
                          {options.filter(
                            (item) =>
                              item.group === option.group &&
                              value.includes(item.value),
                          ).length || ""}
                        </span>
                      </li>
                    )}
                  <li
                    id={`${id}-${index}`}
                    role="option"
                    aria-selected={value.includes(option.value)}
                    aria-disabled={
                      !value.includes(option.value) && value.length >= 100
                        ? true
                        : undefined
                    }
                    className={cn(
                      "flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-2.5 text-sm",
                      index === active && "bg-[var(--muted)]",
                      value.includes(option.value) && "text-[var(--primary)]",
                    )}
                    onPointerMove={() => setActive(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => toggle(option.value)}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                        value.includes(option.value)
                          ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]"
                          : "border-[var(--border)]",
                      )}
                    >
                      {value.includes(option.value) && <Check size={12} />}
                    </span>
                    <span className="min-w-0 break-words">{option.label}</span>
                  </li>
                </Fragment>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function FilterBar({
  filters,
  children,
  onReset,
  active = false,
  label = "Фильтры",
}: {
  filters: MultiSelectProps[];
  children?: ReactNode;
  onReset: () => void;
  active?: boolean;
  label?: string;
}) {
  const labels = useRef(new Map<string, string>());
  for (const filter of filters)
    for (const option of filter.options)
      labels.current.set(`${filter.label}:${option.value}`, option.label);
  const hasSelection = filters.some((filter) => filter.value.length > 0);
  return (
    <section
      aria-label={label}
      className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4"
    >
      <div className="grid grid-cols-1 items-end gap-x-3 gap-y-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {filters.map((filter) => (
          <MultiSelect
            key={filter.label}
            {...filter}
            selectedLabels={{
              ...Object.fromEntries(
                filter.value.map((key) => [
                  key,
                  labels.current.get(`${filter.label}:${key}`) ?? "Выбрано",
                ]),
              ),
              ...filter.selectedLabels,
            }}
          />
        ))}
        {children}
      </div>
      {(hasSelection || active) && (
        <div
          className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3"
          aria-label="Выбранные фильтры"
        >
          {filters.flatMap((filter) =>
            filter.value.map((key) => (
              <button
                key={`${filter.label}:${key}`}
                type="button"
                className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-[var(--primary-soft)] px-2.5 py-1.5 text-xs text-[var(--primary)] hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
                aria-label={`Убрать ${filter.label}: ${labels.current.get(`${filter.label}:${key}`) ?? filter.selectedLabels?.[key] ?? "Выбрано"}`}
                onClick={() =>
                  filter.onChange(filter.value.filter((item) => item !== key))
                }
              >
                <span className="truncate">
                  {filter.label}:{" "}
                  {labels.current.get(`${filter.label}:${key}`) ??
                    filter.selectedLabels?.[key] ??
                    "Выбрано"}
                </span>
                <X size={12} aria-hidden="true" className="shrink-0" />
              </button>
            )),
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={onReset}
          >
            Сбросить всё
          </Button>
        </div>
      )}
    </section>
  );
}
