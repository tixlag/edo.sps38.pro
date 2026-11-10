import { useContext, useEffect, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import {
  getCandidatePreviousDocumentOriginal,
  getGetCandidateDetailsQueryKey,
  getListCandidatePreviousDocumentsQueryKey,
  useListCandidatePreviousDocuments,
  type CandidatePreviousDocumentsDto,
} from "@edo/api-client";
import { Badge, Button, cn } from "@edo/ui";
import { ChevronDown, ExternalLink, History as HistoryIcon } from "lucide-react";
import { formatDateRu } from "../lib/date-format";

export interface CandidateDrawerHistorySectionProps {
  candidateId: string;
  onOpenPrevious?: (id: string) => void;
  data?: CandidatePreviousDocumentsDto;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  defaultOpen?: boolean;
  isOpen?: boolean;
  onToggle?: () => void;
  className?: string;
}

const STATUS_LABELS: Record<string, string> = {
  REQUIRES_REVIEW: "Требует проверки",
  CONFIRMED: "Актуален и подтверждён",
  REPLACE: "Требуется замена",
  MISSING: "Отсутствует",
  ORIGINAL_UNAVAILABLE: "Оригинал недоступен",
  APPROVED: "Одобрен",
  IN_REVIEW: "На проверке",
  RETURNED: "Возвращён",
  REUSED: "Зачтён ранее",
};

function formatRequisites(fields?: Record<string, unknown>): string[] {
  if (!fields) return [];
  const parts: string[] = [];

  const series = fields.series ?? fields.doc_series;
  const number = fields.number ?? fields.doc_number;
  const issuedAt = fields.issuedAt ?? fields.issueDate ?? fields.issue_date;

  if (series && number) {
    parts.push(`Серия/номер: ${series} ${number}`);
  } else if (number) {
    parts.push(`Номер: ${number}`);
  } else if (series) {
    parts.push(`Серия: ${series}`);
  }

  if (issuedAt && typeof issuedAt === "string") {
    parts.push(`Выдан: ${formatDateRu(issuedAt)}`);
  }

  return parts;
}

export function CandidateDrawerHistorySection({
  candidateId,
  onOpenPrevious,
  data,
  isLoading,
  isError,
  onRetry,
  defaultOpen = false,
  isOpen,
  onToggle,
  className,
}: CandidateDrawerHistorySectionProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const open = isOpen !== undefined ? isOpen : internalOpen;

  const queryClient = useContext(QueryClientContext);
  const query = useListCandidatePreviousDocuments(candidateId, {
    query: {
      queryKey: getListCandidatePreviousDocumentsQueryKey(candidateId),
      enabled: data === undefined && open,
    },
  });

  const hasSyncedRef = useRef<number | null>(null);
  useEffect(() => {
    if (query.data && query.dataUpdatedAt !== hasSyncedRef.current) {
      hasSyncedRef.current = query.dataUpdatedAt;
      void queryClient?.invalidateQueries({
        queryKey: getGetCandidateDetailsQueryKey(candidateId),
      });
    }
  }, [query.data, query.dataUpdatedAt, queryClient, candidateId]);

  const effectiveData = data ?? query.data;
  const effectiveLoading =
    isLoading ?? (data === undefined && query.isLoading);
  const effectiveError = isError ?? (data === undefined && query.isError);
  const handleRetry = onRetry ?? (() => void query.refetch());

  const toggle = () => {
    if (onToggle) {
      onToggle();
    } else {
      setInternalOpen((prev) => !prev);
    }
  };

  const totalCount =
    effectiveData !== undefined
      ? (effectiveData.items?.length ?? 0) +
        (effectiveData.edoDocuments?.length ?? 0)
      : undefined;

  const handleOpenOriginal = async (docId: string, docTitle: string) => {
    if (onOpenPrevious) { onOpenPrevious(docId); return; }
    setOpeningId(docId);
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;

    try {
      const blob = await getCandidatePreviousDocumentOriginal(
        candidateId,
        docId,
      );
      const url = URL.createObjectURL(blob);
      if (tab) {
        tab.location.href = url;
      } else {
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = docTitle;
        anchor.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      tab?.close();
    } finally {
      setOpeningId(null);
    }
  };

  return (
    <section
      aria-label="История документов"
      className={cn(
        "rounded-xl border border-[var(--border)] bg-[var(--card)] transition-colors",
        className,
      )}
    >
      {/* Header button */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between p-3.5 text-left transition-colors hover:bg-[var(--muted-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] sm:p-4"
      >
        <div className="flex items-center gap-2.5">
          <HistoryIcon
            className="h-4 w-4 text-[var(--muted-foreground)]"
            aria-hidden
          />
          <h3 className="text-sm font-semibold text-[var(--foreground)]">
            История документов
          </h3>
          {typeof totalCount === "number" && (
            <Badge tone="default">{totalCount}</Badge>
          )}
        </div>

        <ChevronDown
          className={cn(
            "h-4 w-4 text-[var(--muted-foreground)] transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {/* Expanded content */}
      {open && (
        <div className="space-y-4 border-t border-[var(--border)] px-3.5 pb-4 pt-3 sm:px-4 sm:pb-5">
          {effectiveLoading && (
            <p role="status" className="text-xs text-[var(--muted-foreground)]">
              Загрузка истории документов…
            </p>
          )}

          {effectiveError && !effectiveLoading && (
            <div
              role="alert"
              className="flex items-center justify-between gap-2 text-xs text-[var(--primary)]"
            >
              <span>Не удалось загрузить историю документов.</span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 text-xs"
                onClick={handleRetry}
              >
                Повторить
              </Button>
            </div>
          )}

          {!effectiveLoading && !effectiveError && (
            <>
              {/* ERP Employment history */}
              {effectiveData?.employmentHistory && (
                <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                    Кадровая история в ERP
                  </h4>
                  {effectiveData.employmentHistory.available ? (
                    effectiveData.employmentHistory.items.length > 0 ? (
                      <ul className="space-y-1.5 text-xs">
                        {effectiveData.employmentHistory.items.map(
                          (event, idx) => (
                            <li
                              key={`${event.eventDate}-${event.eventType}-${idx}`}
                              className="text-[var(--foreground)]"
                            >
                              <span className="font-medium">
                                {event.eventType === "HIRE"
                                  ? "Приём"
                                  : "Увольнение"}
                              </span>{" "}
                              <span className="text-[var(--muted-foreground)]">
                                ·
                              </span>{" "}
                              <span className="text-[var(--muted-foreground)]">
                                {formatDateRu(
                                  event.startDate ?? event.eventDate,
                                )}
                              </span>
                            </li>
                          ),
                        )}
                      </ul>
                    ) : (
                      <p className="text-xs text-[var(--muted-foreground)]">
                        Записей о приёме или увольнении нет.
                      </p>
                    )
                  ) : (
                    <p className="text-xs text-[var(--muted-foreground)]">
                      Кадровая история ERP временно недоступна.
                    </p>
                  )}
                </div>
              )}

              {/* Historical EDO documents */}
              {Boolean(effectiveData?.edoDocuments?.length) && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                    Документы прошлых оформлений в ЭДО
                  </h4>
                  <div className="space-y-2">
                    {effectiveData!.edoDocuments!.map((doc) => (
                      <div
                        key={doc.id}
                        className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium text-[var(--foreground)]">
                            {doc.title}
                          </div>
                          <div className="text-[var(--muted-foreground)]">
                            Версия {doc.currentVersion} ·{" "}
                            {STATUS_LABELS[doc.status] ?? doc.status}
                          </div>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 shrink-0 text-xs"
                          aria-label={`Открыть оригинал: ${doc.title}`}
                          onClick={() =>
                            void handleOpenOriginal(doc.id, doc.title)
                          }
                        >
                          <ExternalLink size={13} className="mr-1" aria-hidden />
                          Открыть оригинал
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Historical ERP documents */}
              {Boolean(effectiveData?.items?.length) && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                    Прежние документы физлица из ERP
                  </h4>
                  <div className="space-y-2">
                    {effectiveData!.items!.map((doc) => {
                      const requisites = formatRequisites(doc.fields);
                      return (
                        <div
                          key={doc.id}
                          className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-xs sm:flex-row sm:items-start sm:justify-between"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-semibold text-[var(--foreground)]">
                                {doc.title}
                              </span>
                              <Badge tone="default">
                                {STATUS_LABELS[doc.status] ?? doc.status}
                              </Badge>
                            </div>

                            {requisites.length > 0 && (
                              <div className="flex flex-wrap gap-2 text-[11px] text-[var(--muted-foreground)]">
                                {requisites.map((r, i) => (
                                  <span key={i}>{r}</span>
                                ))}
                              </div>
                            )}

                            <div className="text-[11px] text-[var(--muted-foreground)]">
                              {doc.expiresAt
                                ? `Срок действия: ${formatDateRu(doc.expiresAt)}`
                                : "Срок действия не указан"}
                            </div>
                          </div>

                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              !doc.originalAvailable || openingId === doc.id
                            }
                            onClick={() =>
                              void handleOpenOriginal(doc.id, doc.title)
                            }
                            className="h-7 shrink-0 self-start text-xs sm:self-auto"
                            aria-label={`Открыть оригинал: ${doc.title}`}
                          >
                            <ExternalLink size={13} className="mr-1" aria-hidden />
                            {openingId === doc.id
                              ? "Открытие…"
                              : doc.originalAvailable
                                ? "Открыть оригинал"
                                : "Оригинал недоступен"}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Empty state */}
              {!effectiveData?.items?.length &&
                !effectiveData?.edoDocuments?.length && (
                  <p className="py-2 text-xs text-[var(--muted-foreground)]">
                    Доступных прежних документов нет.
                  </p>
                )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
