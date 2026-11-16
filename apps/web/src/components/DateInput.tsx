import { useEffect, useRef, useState } from "react";
import { CalendarDays } from "lucide-react";
import { formatDateRu, maskDateRuInput, parseDateRu } from "../lib/date-format";
import { CANDIDATE_CONTROL } from "./CandidateForm";

/** Calendar date in the form, ISO date at the API boundary. */
export function DateInput({
  label,
  value,
  onChange,
  required,
  disabled,
}: {
  label: string;
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  required?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState(value ? formatDateRu(value) : "");
  const picker = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLInputElement>(null);
  useEffect(() => setText(value ? formatDateRu(value) : ""), [value]);
  const invalid = !!text && !parseDateRu(text);
  useEffect(() => {
    textInput.current?.setCustomValidity(
      invalid ? "Введите существующую дату в формате дд.мм.гггг" : "",
    );
  }, [invalid]);

  return (
    <div className="relative">
      <input
        ref={textInput}
        type="text"
        aria-label={label}
        aria-invalid={invalid || undefined}
        inputMode="numeric"
        autoComplete="off"
        placeholder="дд.мм.гггг"
        required={required}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          const next = maskDateRuInput(event.target.value);
          setText(next);
          const date = parseDateRu(next);
          event.currentTarget.setCustomValidity(
            next && !date
              ? "Введите существующую дату в формате дд.мм.гггг"
              : "",
          );
          if (date) onChange(date);
          else if (!next) onChange(null);
        }}
        className={`${CANDIDATE_CONTROL} pr-10`}
      />
      <input
        ref={picker}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        disabled={disabled}
        value={value ?? ""}
        onChange={(event) => {
          const date = event.target.value || null;
          setText(date ? formatDateRu(date) : "");
          onChange(date);
        }}
        className="pointer-events-none absolute right-0 top-0 h-full w-9 opacity-0"
      />
      <button
        type="button"
        aria-label={`${label}: выбрать в календаре`}
        disabled={disabled}
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
        className="absolute right-0 top-0 flex h-full w-9 items-center justify-center rounded text-[var(--muted-foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] disabled:opacity-60"
      >
        <CalendarDays size={16} />
      </button>
    </div>
  );
}
