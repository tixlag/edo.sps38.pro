import { useEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { formatDateRu, maskDateRuInput, parseDateRu } from "../lib/date-format";

export function DateFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string;
  onChange: (value: string | undefined) => void;
}) {
  const [text, setText] = useState(value ? formatDateRu(value) : "");
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value ? formatDateRu(value) : ""), [value]);
  const invalid = !!text && text.length === 10 && !parseDateRu(text);
  return (
    <div className="relative min-w-0 flex-1">
      <input
        type="text"
        aria-label={label}
        aria-invalid={invalid || undefined}
        inputMode="numeric"
        placeholder="Выберите дату"
        value={text}
        onChange={(event) => {
          const next = maskDateRuInput(event.target.value);
          setText(next);
          if (!next) onChange(undefined);
          else {
            const date = parseDateRu(next);
            if (date) onChange(date);
          }
        }}
        onBlur={() => {
          if (text && !parseDateRu(text))
            setText(value ? formatDateRu(value) : "");
        }}
        className="h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--card)] pl-3 pr-9 text-sm text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      />
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
        className="pointer-events-none absolute right-0 top-0 h-full w-8 opacity-0"
      />
      <button
        type="button"
        aria-label={`${label}: выбрать в календаре`}
        onClick={() => {
          const input = picker.current;
          if (!input) return;
          try {
            if (typeof input.showPicker === "function") input.showPicker();
            else {
              input.focus();
              input.click();
            }
          } catch {
            input.focus();
            input.click();
          }
        }}
        className="absolute right-0 top-0 flex h-full w-8 items-center justify-center rounded text-[var(--muted-foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
      >
        <CalendarDays size={16} />
      </button>
    </div>
  );
}
