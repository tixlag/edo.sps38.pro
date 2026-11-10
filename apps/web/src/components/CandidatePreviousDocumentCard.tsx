import { useState } from "react";
import {
  getCandidatePreviousDocumentOriginal,
  type CandidateDocumentSummaryDto,
  type PreviousDocumentAvailabilityDto,
  type ReturnedDocumentVersionDto,
} from "@edo/api-client";
import { Badge, Button, StatusBadge, cn } from "@edo/ui";
import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  ExternalLink,
  FileText,
} from "lucide-react";
import { CandidateDocumentThumbnail } from "./CandidateDocumentThumbnail";
import { formatDateRu } from "../lib/date-format";

export interface CandidatePreviousDocumentCardProps {
  candidateId: string;
  reviewGroup?: "RU" | "IG" | null;
  title: string;
  status?: string;
  currentDocument?: CandidateDocumentSummaryDto;
  previousDocument?: PreviousDocumentAvailabilityDto;
  returnedVersion?: ReturnedDocumentVersionDto;
  isMissing?: boolean;
  onOpenPrevious?: (id: string) => void;
  onReviewCurrent?: (docId: string, version?: number) => void;
  mode?: "compact" | "expanded";
  className?: string;
}

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

  if (parts.length === 0) {
    // Fallback: pick any primitive key-value pairs (excluding internal ids)
    for (const [k, v] of Object.entries(fields)) {
      if (
        !/(?:uuid|uid|code_?1c|code1c|erp|^id$)/i.test(k) &&
        (typeof v === "string" || typeof v === "number") &&
        v
      ) {
        parts.push(`${k}: ${v}`);
        if (parts.length >= 2) break;
      }
    }
  }

  return parts;
}

export function CandidatePreviousDocumentCard({
  candidateId,
  reviewGroup,
  title,
  status,
  currentDocument,
  previousDocument,
  returnedVersion,
  isMissing = false,
  onReviewCurrent,
  onOpenPrevious,
  mode,
  className,
}: CandidatePreviousDocumentCardProps) {
  const [openingOriginal, setOpeningOriginal] = useState(false);
  // A confirmed RU ERP original is authoritative over a parallel adaptation upload.
  if (reviewGroup !== "IG" && previousDocument?.source === "ERP" &&
      previousDocument.state === "REUSED" && previousDocument.originalAvailable &&
      !(currentDocument?.uploadOrigin === "REVIEWER" && currentDocument.deliveryStatus !== "SENT")) {
    currentDocument = undefined;
    returnedVersion = undefined;
    status = "APPROVED";
    mode = "expanded";
  }


  const effectiveStatus =
    status ??
    (isMissing
      ? "MISSING"
      : returnedVersion
        ? "RETURNED"
        : currentDocument?.status ?? previousDocument?.state ?? "DRAFT");

  const rejectionReason =
    returnedVersion?.rejectionReason ??
    currentDocument?.returnedVersions?.[0]?.rejectionReason ??
    previousDocument?.rejectionReason ??
    null;

  // Decide compact vs expanded mode
  const isCompact =
    mode === "compact" ||
    (mode !== "expanded" &&
      ((isMissing && !previousDocument) ||
        (effectiveStatus === "MISSING" && !previousDocument) ||
        (effectiveStatus === "APPROVED" &&
          (!previousDocument || previousDocument.state === "REUSED") &&
          !returnedVersion &&
          !currentDocument?.returnedVersions?.length) ||
        ((effectiveStatus === "REUSED" ||
          previousDocument?.state === "REUSED") &&
          !currentDocument &&
          !returnedVersion)));

  const handleOpenOriginal = async () => {
    if (!previousDocument) return;
    if (onOpenPrevious) { onOpenPrevious(previousDocument.id); return; }
    setOpeningOriginal(true);
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;

    try {
      const blob = await getCandidatePreviousDocumentOriginal(
        candidateId,
        previousDocument.id,
      );
      const url = URL.createObjectURL(blob);
      if (tab) {
        tab.location.href = url;
      } else {
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = previousDocument.title || title;
        anchor.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      tab?.close();
    } finally {
      setOpeningOriginal(false);
    }
  };

  const renderBadge = () => {
    if (effectiveStatus === "APPROVED" || effectiveStatus === "SIGNED") {
      return <Badge tone="success">Документ принят</Badge>;
    }
    if (effectiveStatus === "RETURNED" || returnedVersion) {
      return <Badge tone="danger">Возвращён</Badge>;
    }
    if (effectiveStatus === "IN_REVIEW") {
      return <Badge tone="warning">Ожидает проверки</Badge>;
    }
    if (effectiveStatus === "UPLOADED") {
      return <Badge tone="info">Загружен</Badge>;
    }
    if (previousDocument?.state === "REQUIRES_REVIEW") {
      return <Badge tone="warning">Проверить актуальность</Badge>;
    }
    if (
      previousDocument?.state === "EXPIRED" ||
      previousDocument?.state === "REPLACE_REQUIRED" ||
      effectiveStatus === "EXPIRED"
    ) {
      return <Badge tone="danger">Нужна замена</Badge>;
    }
    if (
      previousDocument?.state === "REUSED" ||
      effectiveStatus === "REUSED"
    ) {
      return <Badge tone="success">Зачтён ранее</Badge>;
    }
    if (previousDocument?.state === "ORIGINAL_UNAVAILABLE") {
      return <Badge tone="warning">Оригинал недоступен</Badge>;
    }
    if (isMissing || effectiveStatus === "MISSING") {
      return <Badge tone="default">Не загружен</Badge>;
    }
    return <StatusBadge status={effectiveStatus} document />;
  };

  // 1. Compact mode (44–56 px)
  if (isCompact) {
    return (
      <div
        className={cn(
          "flex min-h-[48px] items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--card)] px-3.5 py-2 transition-colors",
          className,
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <FileText
            className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
            aria-hidden
          />
          <span className="truncate text-sm font-medium text-[var(--foreground)]">
            {title}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">{renderBadge()}
          {previousDocument && <Button size="sm" variant="outline" onClick={() => void handleOpenOriginal()}>Открыть документ</Button>}
        </div>
      </div>
    );
  }

  // 2. Expanded mode
  const sourceText = previousDocument
    ? previousDocument.sourceDescription ||
      (previousDocument.source === "EDO"
        ? "Из прошлого оформления в ЭДО"
        : "Из ERP")
    : null;

  const isExpired =
    previousDocument?.state === "EXPIRED" ||
    Boolean(
      previousDocument?.expiresAt &&
        previousDocument.expiresAt <
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Irkutsk",
          }).format(new Date()),
    );

  const requisites = formatRequisites(previousDocument?.fields);

  return (
    <div
      className={cn(
        "space-y-3.5 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3.5 transition-colors sm:p-4",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileText
            className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]"
            aria-hidden
          />
          <h3 className="truncate text-sm font-semibold text-[var(--foreground)]">
            {title}
          </h3>
        </div>
        <div className="shrink-0">{renderBadge()}</div>
      </div>

      {/* Rejection reason (if returned) */}
      {(effectiveStatus === "RETURNED" || returnedVersion) &&
        rejectionReason && (
          <div className="rounded-lg border border-[var(--border)] bg-[var(--primary-soft)] p-3 text-xs">
            <div className="mb-1 flex items-center gap-1.5 font-semibold text-[var(--primary)]">
              <AlertCircle size={14} aria-hidden />
              <span>Причина возврата:</span>
            </div>
            <p className="text-[var(--foreground)]">{rejectionReason}</p>
          </div>
        )}

      {/* Previous version block */}
      {previousDocument && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--background)] p-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <CandidateDocumentThumbnail
              onClick={onOpenPrevious ? () => onOpenPrevious(previousDocument.id) : undefined}
              candidateId={candidateId}
              documentId={previousDocument.id}
              originalAvailable={previousDocument.originalAvailable}
              title={previousDocument.title || title}
            />

            <div className="min-w-0 flex-1 space-y-1.5 text-xs">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                {previousDocument.source === "EDO" ? "Из прошлого оформления в ЭДО" : "Документ из ERP"}
              </div>

              {sourceText && (
                <div className="font-medium text-[var(--foreground)]">
                  {sourceText}
                </div>
              )}

              {/* Expiry date */}
              <div className="flex items-center gap-1.5 text-[var(--muted-foreground)]">
                <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  {previousDocument.expiresAt
                    ? `Срок действия: ${formatDateRu(previousDocument.expiresAt)}`
                    : "Срок действия: не указан"}
                </span>
              </div>

              {/* Expiry warning */}
              {isExpired && (
                <div className="flex items-center gap-1.5 font-medium text-[var(--primary)]">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span>Срок действия истёк. Нужно загрузить снова</span>
                </div>
              )}

              {/* Requisites (series, number, issue date) */}
              {requisites.length > 0 && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 text-[11px] text-[var(--muted-foreground)]">
                  {requisites.map((item, idx) => (
                    <span key={idx} className="rounded bg-[var(--card)] px-1.5 py-0.5">
                      {item}
                    </span>
                  ))}
                </div>
              )}

              {/* Button: Open document */}
              <div className="pt-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!previousDocument.originalAvailable || openingOriginal}
                  onClick={() => void handleOpenOriginal()}
                  className="h-7 text-xs"
                  aria-label={`Открыть оригинал: ${previousDocument.title || title}`}
                >
                  <ExternalLink size={13} className="mr-1" aria-hidden />
                  {openingOriginal ? "Открытие…" : "Открыть документ"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Current document actions */}
      {currentDocument && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-2.5">
          <div className="text-xs text-[var(--muted-foreground)]">
            Текущая версия: {currentDocument.currentVersion}
          </div>
          {effectiveStatus !== "RETURNED" && (
            <Button
              size="sm"
              aria-label={`${title}, версия ${currentDocument.currentVersion ?? returnedVersion?.version ?? 1}`}
              onClick={() =>
                onReviewCurrent?.(
                  currentDocument.id,
                  currentDocument.currentVersion ?? returnedVersion?.version,
                )
              }
              className="text-xs font-medium"
            >
              {currentDocument.uploadOrigin === "REVIEWER" ? "Продолжить загрузку" : "Проверить документ"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
