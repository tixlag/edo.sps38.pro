import {
  Clock,
  User,
  FileUp,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import { StatusBadge } from "@edo/ui";
import type {
  CandidateFeedFilter,
  CandidateFeedStatusItem,
  CandidateFeedDocumentSubmittedItem,
  CandidateFeedDocumentReviewedItem,
  CandidateFeedDocumentReturnedItem,
} from "../lib/use-candidate-feed";

function formatEventTime(isoString: string): string {
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return d.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function StatusChangeEventItem({
  item,
}: {
  item: CandidateFeedStatusItem;
}) {
  return (
    <div className="mx-auto my-1 flex max-w-[92%] flex-col rounded-xl border border-[var(--border)] bg-[var(--muted)]/40 p-3 text-xs text-[var(--foreground)] sm:max-w-[85%]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 font-medium">
          <Clock
            size={14}
            className="text-[var(--muted-foreground)]"
            aria-hidden
          />
          <span>Смена статуса:</span>
          <StatusBadge status={item.statusName || item.statusId} />
        </div>
        <time
          dateTime={item.timestamp}
          className="text-[11px] text-[var(--muted-foreground)]"
        >
          {formatEventTime(item.timestamp)}
        </time>
      </div>
      {item.author && (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--muted-foreground)]">
          <User size={12} aria-hidden />
          <span>{item.author}</span>
        </div>
      )}
      {item.comment && (
        <blockquote className="mt-2 rounded border-l-2 border-[var(--primary)] bg-[var(--card)] px-2.5 py-1.5 text-xs italic text-[var(--foreground)]">
          «{item.comment}»
        </blockquote>
      )}
    </div>
  );
}

export function DocumentSubmittedEventItem({
  item,
}: {
  item: CandidateFeedDocumentSubmittedItem;
}) {
  return (
    <div className="mx-auto my-1 flex max-w-[92%] items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--muted)]/30 px-3.5 py-2.5 text-xs sm:max-w-[85%]">
      <div className="flex min-w-0 items-center gap-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--primary-soft)] text-[var(--primary)]">
          <FileUp size={15} aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="truncate font-medium text-[var(--foreground)]">
            {item.documentTitle}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-[var(--muted-foreground)]">
            <span>Загружен кандидатом</span>
            {item.version != null && <span>· Версия {item.version}</span>}
          </div>
        </div>
      </div>
      <time
        dateTime={item.timestamp}
        className="shrink-0 text-[11px] text-[var(--muted-foreground)]"
      >
        {formatEventTime(item.timestamp)}
      </time>
    </div>
  );
}

export function DocumentReviewedEventItem({
  item,
}: {
  item: CandidateFeedDocumentReviewedItem;
}) {
  const isApproved = item.status === "APPROVED";
  return (
    <div className="mx-auto my-1 flex max-w-[92%] flex-col rounded-xl border border-[var(--border)] bg-[var(--muted)]/30 p-3 text-xs sm:max-w-[85%]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {isApproved ? (
            <CheckCircle2
              size={15}
              className="text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
          ) : (
            <AlertTriangle
              size={15}
              className="text-amber-600 dark:text-amber-400"
              aria-hidden
            />
          )}
          <span className="font-medium text-[var(--foreground)]">
            {item.documentTitle}
          </span>
          <StatusBadge status={item.status} document />
        </div>
        <time
          dateTime={item.timestamp}
          className="text-[11px] text-[var(--muted-foreground)]"
        >
          {formatEventTime(item.timestamp)}
        </time>
      </div>
      {item.reviewedBy && (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--muted-foreground)]">
          <User size={12} aria-hidden />
          <span>Проверил: {item.reviewedBy}</span>
        </div>
      )}
      {(item.reason || item.comment) && (
        <div className="mt-2 rounded border border-[var(--border)] bg-[var(--card)] p-2 text-xs">
          {item.reason && (
            <p className="font-medium text-[var(--foreground)]">
              Причина: <span className="font-normal">{item.reason}</span>
            </p>
          )}
          {item.comment && (
            <p className="mt-0.5 text-[var(--muted-foreground)]">
              {item.comment}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function DocumentReturnedEventItem({
  item,
}: {
  item: CandidateFeedDocumentReturnedItem;
}) {
  return (
    <div className="mx-auto my-1 flex max-w-[92%] flex-col rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs sm:max-w-[85%]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <RotateCcw
            size={15}
            className="text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <span className="font-medium text-[var(--foreground)]">
            {item.documentTitle} (версия {item.version})
          </span>
          <StatusBadge status="RETURNED" document />
        </div>
        <time
          dateTime={item.timestamp}
          className="text-[11px] text-[var(--muted-foreground)]"
        >
          {formatEventTime(item.timestamp)}
        </time>
      </div>
      {(item.reason || item.comment) && (
        <div className="mt-2 rounded border border-amber-500/20 bg-[var(--card)] p-2 text-xs">
          {item.reason && (
            <p className="font-medium text-[var(--foreground)]">
              Причина возврата:{" "}
              <span className="font-normal">{item.reason}</span>
            </p>
          )}
          {item.comment && (
            <p className="mt-0.5 text-[var(--muted-foreground)]">
              {item.comment}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function FeedFilterTabs({
  filter,
  onChange,
  counts,
}: {
  filter: CandidateFeedFilter;
  onChange: (filter: CandidateFeedFilter) => void;
  counts: { all: number; messages: number; events: number };
}) {
  return (
    <div
      role="tablist"
      aria-label="Фильтр ленты"
      className="inline-flex items-center rounded-lg border border-[var(--border)] bg-[var(--muted)]/40 p-0.5 text-xs"
    >
      <button
        role="tab"
        type="button"
        aria-selected={filter === "all"}
        onClick={() => onChange("all")}
        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
          filter === "all"
            ? "bg-[var(--card)] font-medium text-[var(--foreground)] shadow-xs"
            : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        }`}
      >
        <span>Все</span>
        <span className="rounded-full bg-[var(--muted)] px-1.5 py-0.2 text-[10px] font-semibold text-[var(--muted-foreground)]">
          {counts.all}
        </span>
      </button>
      <button
        role="tab"
        type="button"
        aria-selected={filter === "messages"}
        onClick={() => onChange("messages")}
        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
          filter === "messages"
            ? "bg-[var(--card)] font-medium text-[var(--foreground)] shadow-xs"
            : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        }`}
      >
        <span>Сообщения</span>
        <span className="rounded-full bg-[var(--muted)] px-1.5 py-0.2 text-[10px] font-semibold text-[var(--muted-foreground)]">
          {counts.messages}
        </span>
      </button>
      <button
        role="tab"
        type="button"
        aria-selected={filter === "events"}
        onClick={() => onChange("events")}
        className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
          filter === "events"
            ? "bg-[var(--card)] font-medium text-[var(--foreground)] shadow-xs"
            : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        }`}
      >
        <span>События</span>
        <span className="rounded-full bg-[var(--muted)] px-1.5 py-0.2 text-[10px] font-semibold text-[var(--muted-foreground)]">
          {counts.events}
        </span>
      </button>
    </div>
  );
}
