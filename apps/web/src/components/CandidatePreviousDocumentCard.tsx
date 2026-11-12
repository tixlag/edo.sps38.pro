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
} from "lucide-react";
import { CandidateDocumentThumbnail } from "./CandidateDocumentThumbnail";
import { documentDeliveryPresentation } from "../lib/document-delivery-presentation";
import { formatDateRu } from "../lib/date-format";

export interface CandidatePreviousDocumentCardProps {
  candidateId: string;
  /**
   * Kept for compatibility: the source of the card is derived from the
   * document facts only, so RU and IG candidates behave identically.
   */
  reviewGroup?: "RU" | "IG" | null;
  title: string;
  status?: string;
  currentDocument?: CandidateDocumentSummaryDto;
  previousDocument?: PreviousDocumentAvailabilityDto;
  returnedVersion?: ReturnedDocumentVersionDto;
  /** Explicit archive context; a current card must never inherit an old return. */
  returnedHistory?: boolean;
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
  title,
  status,
  currentDocument,
  previousDocument,
  returnedVersion,
  returnedHistory = false,
  isMissing = false,
  onReviewCurrent,
  onOpenPrevious,
  mode,
  className,
}: CandidatePreviousDocumentCardProps) {
  const [openingOriginal, setOpeningOriginal] = useState(false);
  // EDO always wins when present, regardless of delivery or preview availability.
  const showPrevious = !currentDocument && !!previousDocument;
  const primary = currentDocument
    ? "EDO"
    : previousDocument
      ? "PREVIOUS"
      : "NONE";
  const displayedVersion =
    returnedHistory && returnedVersion
      ? returnedVersion.version
      : currentDocument?.currentVersion;
  const effectiveStatus =
    returnedHistory && returnedVersion
      ? "RETURNED"
      : (currentDocument?.status ??
        status ??
        (isMissing ? "MISSING" : (previousDocument?.state ?? "DRAFT")));
  const currentReturned =
    (returnedHistory ? returnedVersion : undefined) ??
    currentDocument?.returnedVersions?.find(
      (v) => v.version === currentDocument.currentVersion,
    ) ??
    (returnedVersion?.version === currentDocument?.currentVersion
      ? returnedVersion
      : undefined);
  const rejectionReason =
    effectiveStatus === "RETURNED"
      ? (currentReturned?.rejectionReason ??
        (showPrevious ? previousDocument?.rejectionReason : null))
      : null;
  const delivery =
    currentDocument && !returnedHistory
      ? documentDeliveryPresentation(
          currentDocument.status,
          currentDocument.deliveryStatus,
        )
      : null;
  const isCompact =
    mode === "compact" ||
    (mode !== "expanded" && !showPrevious && effectiveStatus !== "RETURNED");
  const edoActionLabel =
    currentDocument?.uploadOrigin === "REVIEWER" && effectiveStatus === "DRAFT"
      ? "Продолжить загрузку"
      : effectiveStatus === "IN_REVIEW"
        ? "Проверить документ"
        : "Открыть документ";

  const openEdoDocument = () =>
    onReviewCurrent?.(
      currentDocument!.id,
      displayedVersion ?? returnedVersion?.version,
    );

  const handleOpenOriginal = async () => {
    if (!previousDocument) return;
    if (onOpenPrevious) {
      onOpenPrevious(previousDocument.id);
      return;
    }
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
    if (delivery) return <Badge tone={delivery.tone}>{delivery.label}</Badge>;
    if (effectiveStatus === "RETURNED") {
      return <Badge tone="danger">Возвращён</Badge>;
    }
    if (effectiveStatus === "IN_REVIEW") {
      return <Badge tone="warning">Ожидает проверки</Badge>;
    }
    if (effectiveStatus === "UPLOADED") {
      return <Badge tone="info">Загружен</Badge>;
    }
    if (showPrevious && previousDocument?.state === "REQUIRES_REVIEW") {
      return <Badge tone="warning">Проверить актуальность</Badge>;
    }
    if (
      (showPrevious &&
        (previousDocument?.state === "EXPIRED" ||
          previousDocument?.state === "REPLACE_REQUIRED")) ||
      effectiveStatus === "EXPIRED"
    ) {
      return <Badge tone="danger">Нужна замена</Badge>;
    }
    if (
      showPrevious &&
      (previousDocument?.state === "REUSED" || effectiveStatus === "REUSED")
    ) {
      return <Badge tone="success">Зачтён ранее</Badge>;
    }
    if (showPrevious && previousDocument?.state === "ORIGINAL_UNAVAILABLE") {
      return <Badge tone="warning">Оригинал недоступен</Badge>;
    }
    if ((!currentDocument && isMissing) || effectiveStatus === "MISSING") {
      return <Badge tone="default">Не загружен</Badge>;
    }
    return <StatusBadge status={effectiveStatus} document />;
  };

  const sourceText =
    primary === "EDO" || previousDocument?.source === "EDO"
      ? "Из ЭДО"
      : "Из ERP";
  const isExpired =
    previousDocument?.state === "EXPIRED" ||
    Boolean(
      previousDocument?.expiresAt &&
      previousDocument.expiresAt <
        new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Irkutsk" }).format(
          new Date(),
        ),
    );
  const requisites = formatRequisites(previousDocument?.fields);
  const actionClassName =
    "h-8 max-w-full whitespace-normal px-2.5 text-xs leading-tight";
  const edoAction = currentDocument && (
    <Button
      size="sm"
      variant="outline"
      className={actionClassName}
      onClick={openEdoDocument}
      aria-label={`${title}, версия ${displayedVersion ?? returnedVersion?.version ?? 1}`}
    >
      <ExternalLink size={13} className="shrink-0" aria-hidden />
      {edoActionLabel}
    </Button>
  );
  const previousAction = previousDocument && (
    <Button
      size="sm"
      variant="outline"
      className={actionClassName}
      disabled={!previousDocument.originalAvailable || openingOriginal}
      onClick={() => void handleOpenOriginal()}
      aria-label={`Открыть оригинал: ${previousDocument.title || title}`}
    >
      <ExternalLink size={13} className="shrink-0" aria-hidden />
      {openingOriginal ? "Открытие…" : "Открыть документ"}
    </Button>
  );

  return (
    <article
      className={cn(
        "min-w-0 space-y-2 rounded-lg border border-[var(--border)] bg-[var(--card)] p-3",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {primary === "EDO" && currentDocument ? (
          <CandidateDocumentThumbnail
            key={`edo:${currentDocument.id}:${displayedVersion}`}
            candidateId={candidateId}
            documentId={currentDocument.id}
            version={displayedVersion ?? returnedVersion?.version ?? 1}
            originalAvailable={effectiveStatus !== "RETURNED"}
            title={title}
            className="h-20 w-16"
            onClick={openEdoDocument}
          />
        ) : showPrevious && previousDocument ? (
          <CandidateDocumentThumbnail
            key={`previous:${previousDocument.id}`}
            candidateId={candidateId}
            documentId={previousDocument.id}
            originalAvailable={previousDocument.originalAvailable}
            title={title}
            className="h-20 w-16"
            onClick={
              previousDocument.originalAvailable
                ? () => void handleOpenOriginal()
                : undefined
            }
          />
        ) : null}
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="break-words text-[13px] font-semibold leading-5 text-[var(--foreground)]">
            {title}
          </h3>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {renderBadge()}
            {primary !== "NONE" && (
              <span className="text-[11px] text-[var(--muted-foreground)]">
                {sourceText}
                {currentDocument ? ` · версия ${displayedVersion}` : ""}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {primary === "EDO" ? edoAction : previousAction}
          </div>
        </div>
      </div>

      {delivery?.problem && (
        <p
          role="status"
          className="break-words rounded-md bg-[var(--muted)] px-2 py-1.5 text-xs leading-5"
        >
          {currentDocument?.deliveryErrorReason && (
            <span className="block font-medium">
              {currentDocument.deliveryErrorReason}
            </span>
          )}
          Документ сохранён в ЭДО.
        </p>
      )}
      {effectiveStatus === "RETURNED" && rejectionReason && (
        <div className="rounded-lg bg-[var(--primary-soft)] p-2.5 text-xs">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-[var(--primary)]">
            <AlertCircle size={14} aria-hidden />
            <span>Причина возврата:</span>
          </div>
          <p className="break-words">{rejectionReason}</p>
        </div>
      )}

      {!isCompact && showPrevious && previousDocument && (
        <div className="space-y-1.5 text-xs text-[var(--muted-foreground)]">
          <div className="flex items-center gap-1.5">
            <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {previousDocument.expiresAt
                ? `Срок действия: ${formatDateRu(previousDocument.expiresAt)}`
                : "Срок действия: не указан"}
            </span>
          </div>
          {isExpired && (
            <div className="flex items-center gap-1.5 font-medium text-[var(--primary)]">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>Срок действия истёк. Нужно загрузить снова</span>
            </div>
          )}
          {requisites.length > 0 && (
            <div className="flex flex-wrap gap-x-2 gap-y-1 text-[11px]">
              {requisites.map((item) => (
                <span key={item} className="break-words">
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
