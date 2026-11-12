import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  ReviewStageCountsDto,
  ReviewStageProgressDto,
} from "@edo/api-client";
import { AlertTriangle, FileText } from "lucide-react";

const STAGE_STATES = [
  ["approved", "Одобрен", "var(--success)"],
  ["reused", "Зачтён ранее", "var(--success-bright)"],
  ["signed", "Подписан", "color-mix(in srgb, var(--info) 60%, var(--success))"],
  ["inReview", "На проверке", "var(--warning)"],
  ["uploaded", "Загружен", "var(--info)"],
  ["ocrPending", "Распознаётся", "var(--purple)"],
  ["ocrFailed", "Ошибка OCR", "var(--ocr-failed)"],
  ["returned", "Возвращён", "var(--danger)"],
  ["expired", "Истёк", "var(--expired)"],
  ["draft", "Черновик", "var(--crumb)"],
  ["missing", "Не загружен", "var(--border)"],
] as const;

function StageTooltip({
  id,
  label,
  progress,
  anchor,
  onEnter,
  onLeave,
}: {
  id: string;
  label: string;
  progress: ReviewStageProgressDto;
  anchor: HTMLElement;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  useLayoutEffect(() => {
    const update = () => {
      const node = panel.current;
      if (!node) return;
      const rect = anchor.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const margin = 8;
      const left = Math.max(
        margin,
        Math.min(
          rect.left + rect.width / 2 - box.width / 2,
          window.innerWidth - box.width - margin,
        ),
      );
      const above = rect.top - box.height - margin;
      const top = Math.max(
        margin,
        Math.min(
          above >= margin ? above : rect.bottom + margin,
          window.innerHeight - box.height - margin,
        ),
      );
      setPosition({ left, top, ready: true });
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchor]);
  return createPortal(
    <div
      ref={panel}
      id={id}
      role="tooltip"
      onClick={(event) => event.stopPropagation()}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      style={{
        position: "fixed",
        left: position.left,
        top: position.top,
        visibility: position.ready ? "visible" : "hidden",
      }}
      className="z-[100] max-h-[calc(100dvh-16px)] w-[min(30rem,calc(100vw-16px))] overflow-y-auto overflow-x-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 text-left text-sm text-[var(--foreground)] shadow-lg"
    >
      <p className="mb-3 font-semibold">{label}</p>
      <table className="w-full table-fixed border-collapse text-left text-xs sm:text-sm">
        <colgroup>
          <col className="w-2/5" />
          <col className="w-[30%]" />
          <col className="w-[30%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-[var(--border)] text-[var(--muted-foreground)]">
            <th scope="col" className="pb-2 pr-2 font-medium">
              Статус
            </th>
            <th
              scope="col"
              className="break-words px-1 pb-2 text-center font-medium [overflow-wrap:anywhere]"
            >
              Обязательные
            </th>
            <th
              scope="col"
              className="break-words pl-1 pb-2 text-center font-medium [overflow-wrap:anywhere]"
            >
              Дополнительные
            </th>
          </tr>
        </thead>
        <tbody>
          {STAGE_STATES.map(([key, text, color]) => {
            const reqVal =
              progress.required[key as keyof ReviewStageCountsDto] ??
              (key === "inReview" ? progress.required.pending : 0) ??
              0;
            const addVal =
              progress.additional[key as keyof ReviewStageCountsDto] ??
              (key === "inReview" ? progress.additional.pending : 0) ??
              0;
            return (
              <tr key={key}>
                <th scope="row" className="py-1.5 pr-2 font-normal">
                  <span className="inline-flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    {text}
                  </span>
                </th>
                <td className="px-1 py-1.5 text-center tabular-nums">
                  {reqVal}
                </td>
                <td className="pl-1 py-1.5 text-center tabular-nums">
                  {addVal}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!!progress.deliveryProblemCount && <p className="mt-2 text-xs font-medium text-[var(--danger)]">Проблемы отправки в ERP: {progress.deliveryProblemCount}. Проверка документов учитывается отдельно.</p>}
    </div>,
    document.body,
  );
}

export function StageRing({
  progress,
  onOpen,
  selected,
  variant = "card",
  className = "",
}: {
  progress: ReviewStageProgressDto;
  onOpen?: () => void;
  selected?: boolean;
  variant?: "card" | "inline";
  className?: string;
}) {
  const label =
    progress.stage === null ? "Дополнительные" : `Этап ${progress.stage}`;
  const tooltipId = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const open = (hovered || focused) && !dismissed;
  const enter = () => {
    window.clearTimeout(timer.current);
    setDismissed(false);
    setHovered(true);
  };
  const leave = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHovered(false), 150);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDismissed(true);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);
  const total = (counts: ReviewStageProgressDto["required"]) =>
    (counts.approved ?? 0) +
    (counts.reused ?? 0) +
    (counts.signed ?? 0) +
    (counts.inReview ?? counts.pending ?? 0) +
    (counts.uploaded ?? 0) +
    (counts.ocrPending ?? 0) +
    (counts.ocrFailed ?? 0) +
    (counts.returned ?? 0) +
    (counts.expired ?? 0) +
    (counts.draft ?? 0) +
    (counts.missing ?? 0);
  const completed = (counts: ReviewStageProgressDto["required"]) =>
    (counts.approved ?? 0) + (counts.reused ?? 0) + (counts.signed ?? 0);
  const inReview =
    (progress.required.inReview ?? progress.required.pending ?? 0) +
    (progress.additional.inReview ?? progress.additional.pending ?? 0);
  const attention =
    (progress.deliveryProblemCount ?? 0) +
    (progress.required.returned ?? 0) +
    (progress.additional.returned ?? 0) +
    (progress.required.ocrFailed ?? 0) +
    (progress.additional.ocrFailed ?? 0) +
    (progress.required.expired ?? 0) +
    (progress.additional.expired ?? 0) +
    (progress.required.attention ?? 0) +
    (progress.additional.attention ?? 0);
  const processing =
    (progress.required.uploaded ?? 0) +
    (progress.additional.uploaded ?? 0) +
    (progress.required.ocrPending ?? 0) +
    (progress.additional.ocrPending ?? 0) +
    (progress.required.processing ?? 0) +
    (progress.additional.processing ?? 0);
  const totalCount = total(progress.required) + total(progress.additional);
  const completedCount =
    completed(progress.required) + completed(progress.additional);
  const color = (progress.deliveryProblemCount ?? 0) > 0 ? "var(--danger)" : inReview
    ? "var(--warning)"
    : attention
      ? "var(--danger)"
      : processing
        ? "var(--info)"
        : totalCount > 0 && completedCount === totalCount
          ? "var(--success)"
          : "var(--muted-foreground)";
  const arc = (counts: ReviewStageProgressDto["required"], radius: number) => {
    const sum = total(counts);
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    return STAGE_STATES.map(([key, , stroke]) => {
      const countVal =
        counts[key as keyof ReviewStageCountsDto] ??
        (key === "inReview" ? counts.pending : 0) ??
        0;
      const length = sum ? (circumference * countVal) / sum : 0;
      const element = (
        <circle
          key={key}
          cx="32"
          cy="32"
          r={radius}
          fill="none"
          stroke={stroke}
          strokeWidth="4"
          strokeDasharray={`${length} ${circumference - length}`}
          strokeDashoffset={-offset}
        />
      );
      offset += length;
      return element;
    });
  };
  if (variant === "inline") {
    return (
      <div
        ref={anchor}
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          setDismissed(true);
          onOpen?.();
        }}
        onFocus={() => {
          setDismissed(false);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") enter();
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") leave();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDismissed(true);
            onOpen?.();
          }
        }}
        role="button"
        className={`group pointer-events-auto relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-transform hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] ${selected ? "ring-2 ring-[var(--primary)]/30" : ""} ${className}`}
        aria-label={`Статистика документов: ${label}`}
        aria-pressed={selected}
        aria-describedby={open ? tooltipId : undefined}
      >
        <span className="relative flex h-8 w-8 items-center justify-center">
          <svg
            viewBox="0 0 64 64"
            className="absolute inset-0 h-full w-full -rotate-90"
            aria-hidden="true"
          >
            <circle
              cx="32"
              cy="32"
              r="28"
              fill="none"
              stroke="var(--border)"
              strokeWidth="4.5"
            />
            <circle
              cx="32"
              cy="32"
              r="21"
              fill="none"
              stroke="var(--border)"
              strokeWidth="4.5"
            />
            {arc(progress.additional, 28)}
            {arc(progress.required, 21)}
          </svg>
          <span style={{ color }} aria-hidden="true" className="relative z-10 flex items-center justify-center">
            {inReview ? <AlertTriangle size={13} /> : <FileText size={13} />}
          </span>
        </span>
        {open && anchor.current && (
          <StageTooltip
            id={tooltipId}
            label={label}
            progress={progress}
            anchor={anchor.current}
            onEnter={enter}
            onLeave={leave}
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={anchor}
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        setDismissed(true);
        onOpen?.();
      }}
      onFocus={() => {
        setDismissed(false);
        setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") enter();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") leave();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setDismissed(true);
          onOpen?.();
        }
      }}
      role="button"
      className={`group pointer-events-auto relative flex w-16 shrink-0 flex-col items-center gap-0.5 rounded text-center text-xs min-[1400px]:w-[68px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] ${selected ? "bg-[var(--primary-soft)]" : ""} ${className}`}
      aria-label={`Открыть документы: ${label}`}
      aria-pressed={selected}
      aria-describedby={open ? tooltipId : undefined}
    >
      <span className="relative flex h-14 w-14 items-center justify-center">
        <svg
          viewBox="0 0 64 64"
          className="absolute inset-0 h-full w-full -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="32"
            cy="32"
            r="28"
            fill="none"
            stroke="var(--border)"
            strokeWidth="4"
          />
          <circle
            cx="32"
            cy="32"
            r="21"
            fill="none"
            stroke="var(--border)"
            strokeWidth="4"
          />
          {arc(progress.additional, 28)}
          {arc(progress.required, 21)}
        </svg>
        <span style={{ color }} aria-hidden="true">
          {inReview ? <AlertTriangle size={19} /> : <FileText size={19} />}
        </span>
      </span>
      <strong className="flex h-8 items-center justify-center leading-tight">
        {label}
      </strong>
      <span className="text-[var(--muted-foreground)]">
        {completedCount}/{totalCount}
      </span>
      {open && anchor.current && (
        <StageTooltip
          id={tooltipId}
          label={label}
          progress={progress}
          anchor={anchor.current}
          onEnter={enter}
          onLeave={leave}
        />
      )}
    </div>
  );
}
