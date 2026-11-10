import type {
  CandidateDocumentSummaryDto,
  MissingDocumentTypeDto,
  PreviousDocumentAvailabilityDto,
  ReturnedDocumentVersionDto,
  ReviewStageProgressDto,
} from "@edo/api-client";
import { StageRing } from "./StageRing";
import { cn } from "@edo/ui";
import { ChevronDown, Layers } from "lucide-react";
import { CandidatePreviousDocumentCard } from "./CandidatePreviousDocumentCard";

interface AccordionCardItem {
  key: string;
  title: string;
  status: string;
  currentDocument?: CandidateDocumentSummaryDto;
  previousDocument?: PreviousDocumentAvailabilityDto;
  returnedVersion?: ReturnedDocumentVersionDto;
  isMissing?: boolean;
}

export interface CandidateStageAccordionProps {
  stage: number | null;
  title: string;
  required: {
    documents: CandidateDocumentSummaryDto[];
    missingDocuments: MissingDocumentTypeDto[];
  };
  additional: {
    documents: CandidateDocumentSummaryDto[];
    missingDocuments: MissingDocumentTypeDto[];
  };
  previousDocuments: PreviousDocumentAvailabilityDto[];
  reviewGroup?: "RU" | "IG" | null;
  candidateId: string;
  isOpen: boolean;
  showProgress?: boolean;
  progress?: ReviewStageProgressDto;
  onToggle: () => void;
  onOpenPrevious?: (id: string) => void;
  onReviewDocument?: (docId: string, version?: number) => void;
  className?: string;
}

export function CandidateStageAccordion({
  stage,
  title,
  required,
  additional,
  previousDocuments = [],
  reviewGroup,
  candidateId,
  isOpen,
  showProgress = true,
  progress,
  onToggle,
  onReviewDocument,
  onOpenPrevious,
  className,
}: CandidateStageAccordionProps) {
  // Calculate progress: confirmed/reused vs total required
  const approvedRequired = required.documents.filter(
    (d) => d.status === "APPROVED" || d.status === "SIGNED",
  ).length;

  const reusedRequired = required.missingDocuments.filter((m) =>
    previousDocuments.some(
      (p) => p.documentTypeCode === m.code && p.state === "REUSED",
    ),
  ).length;

  const confirmedCount = progress
    ? progress.required.approved + (progress.required.reused ?? 0) + (progress.required.signed ?? 0)
    : approvedRequired + reusedRequired;

  const missingRequiredNotReused = required.missingDocuments.filter(
    (m) =>
      !previousDocuments.some(
        (p) => p.documentTypeCode === m.code && p.state === "REUSED",
      ),
  ).length;

  const totalRequired = progress
    ? ["approved", "reused", "signed", "inReview", "uploaded", "ocrPending", "ocrFailed", "returned", "expired", "draft", "missing"].reduce(
        (sum, key) => sum + (progress.required[key as keyof typeof progress.required] ?? (key === "inReview" ? progress.required.pending : 0) ?? 0), 0)
    : Math.max(
    confirmedCount,
    required.documents.length + missingRequiredNotReused + reusedRequired,
  );

  const progressPercent =
    totalRequired > 0
      ? Math.min(100, Math.round((confirmedCount / totalRequired) * 100))
      : 100;

  // Build list of required cards
  const renderedRequiredCodes = new Set<string>();

  const requiredDocCards = required.documents.map((doc) => {
    if (doc.documentTypeCode) {
      renderedRequiredCodes.add(doc.documentTypeCode);
    }
    const matchingPrev = previousDocuments.find(
      (p) =>
        (doc.documentTypeCode && p.documentTypeCode === doc.documentTypeCode) ||
        p.id === doc.id,
    );
    return {
      key: `doc-${doc.id}`,
      title: doc.title,
      status: doc.status,
      currentDocument: doc,
      previousDocument: matchingPrev,
      returnedVersion: doc.returnedVersions?.[0],
      isMissing: false,
    };
  });

  const missingRequiredCards = required.missingDocuments.map((missing) => {
    renderedRequiredCodes.add(missing.code);
    const matchingPrev = previousDocuments.find(
      (p) =>
        p.documentTypeCode === missing.code &&
        (p.category === "required" || !p.category),
    );

    if (matchingPrev) {
      return {
        key: `missing-prev-${missing.code}`,
        title: missing.title || matchingPrev.title,
        status: matchingPrev.state === "REUSED" ? "REUSED" : matchingPrev.state,
        previousDocument: matchingPrev,
        isMissing: false,
      };
    }

    return {
      key: `missing-${missing.code}`,
      title: missing.title,
      status: "MISSING",
      isMissing: true,
    };
  });

  const unmatchedRequiredPrevCards = previousDocuments
    .filter(
      (p) =>
        p.category === "required" &&
        !renderedRequiredCodes.has(p.documentTypeCode),
    )
    .map((p) => ({
      key: `unmatched-req-prev-${p.id}`,
      title: p.title,
      status: p.state === "REUSED" ? "REUSED" : p.state,
      previousDocument: p,
      isMissing: false,
    }));

  const allRequiredCards: AccordionCardItem[] = [
    ...requiredDocCards,
    ...missingRequiredCards,
    ...unmatchedRequiredPrevCards,
  ];

  // Build list of additional cards (if any)
  const renderedAdditionalCodes = new Set<string>();

  const additionalDocCards = additional.documents.map((doc) => {
    if (doc.documentTypeCode) {
      renderedAdditionalCodes.add(doc.documentTypeCode);
    }
    const matchingPrev = previousDocuments.find(
      (p) =>
        (doc.documentTypeCode && p.documentTypeCode === doc.documentTypeCode) ||
        p.id === doc.id,
    );
    return {
      key: `add-doc-${doc.id}`,
      title: doc.title,
      status: doc.status,
      currentDocument: doc,
      previousDocument: matchingPrev,
      returnedVersion: doc.returnedVersions?.[0],
      isMissing: false,
    };
  });

  const missingAdditionalCards = additional.missingDocuments.map((missing) => {
    renderedAdditionalCodes.add(missing.code);
    const matchingPrev = previousDocuments.find(
      (p) =>
        p.documentTypeCode === missing.code &&
        (p.category === "additional" || !p.category),
    );

    if (matchingPrev) {
      return {
        key: `add-missing-prev-${missing.code}`,
        title: missing.title || matchingPrev.title,
        status: matchingPrev.state === "REUSED" ? "REUSED" : matchingPrev.state,
        previousDocument: matchingPrev,
        isMissing: false,
      };
    }

    return {
      key: `add-missing-${missing.code}`,
      title: missing.title,
      status: "MISSING",
      isMissing: true,
    };
  });

  const unmatchedAdditionalPrevCards = previousDocuments
    .filter(
      (p) =>
        p.category === "additional" &&
        !renderedAdditionalCodes.has(p.documentTypeCode),
    )
    .map((p) => ({
      key: `unmatched-add-prev-${p.id}`,
      title: p.title,
      status: p.state === "REUSED" ? "REUSED" : p.state,
      previousDocument: p,
      isMissing: false,
    }));

  const allAdditionalCards: AccordionCardItem[] = [
    ...additionalDocCards,
    ...missingAdditionalCards,
    ...unmatchedAdditionalPrevCards,
  ];

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] transition-colors",
        className,
      )}
    >
      <div className="flex items-center gap-2 p-2">
      {showProgress && progress && (
        <StageRing progress={progress} selected={isOpen} onOpen={onToggle} />
      )}
      {/* Header Button */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full flex-col p-3.5 text-left transition-colors hover:bg-[var(--muted-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] sm:p-4"
      >
        <div
          className={cn(
            "flex w-full items-center justify-between gap-3",
            showProgress && "mb-2.5",
          )}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            {(!progress || !showProgress) && (stage !== null ? (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--primary-soft)] text-xs font-bold text-[var(--primary)]">
                {stage}
              </span>
            ) : (
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--primary-soft)] text-xs font-bold text-[var(--primary)]">
                <Layers size={14} aria-hidden />
              </span>
            ))}
            <h3 className="truncate text-sm font-semibold text-[var(--foreground)]">
              {title}
            </h3>
          </div>

          <div className="flex shrink-0 items-center gap-2.5">
            {showProgress && (
              <span className="text-xs font-medium text-[var(--muted-foreground)]">
                {confirmedCount} из {totalRequired}
              </span>
            )}
            <ChevronDown
              className={cn(
                "h-4 w-4 text-[var(--muted-foreground)] transition-transform duration-200",
                isOpen && "rotate-180",
              )}
              aria-hidden
            />
          </div>
        </div>

        {/* Progress Bar */}
        {showProgress && !progress && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--muted)]">
            <div
              className="h-full bg-[var(--primary)] transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        )}
      </button>
      </div>

      {/* Accordion Content */}
      {isOpen && (
        <div className="space-y-4 px-3.5 pb-4 pt-1 sm:px-4 sm:pb-5">
          {/* Required documents */}
          {allRequiredCards.length > 0 ? (
            <section
              aria-label="Обязательные документы"
              className="space-y-2.5"
            >
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                Обязательные
              </h4>
              {allRequiredCards.map((card) => (
                <CandidatePreviousDocumentCard
                  key={card.key}
                  candidateId={candidateId}
                  reviewGroup={reviewGroup}
                  title={card.title}
                  status={card.status}
                  currentDocument={card.currentDocument}
                  previousDocument={card.previousDocument}
                  returnedVersion={card.returnedVersion}
                  isMissing={card.isMissing}
                  onOpenPrevious={onOpenPrevious}
                  onReviewCurrent={onReviewDocument}
                />
              ))}
            </section>
          ) : (
            <p className="py-2 text-xs text-[var(--muted-foreground)]">
              Обязательные документы отсутствуют.
            </p>
          )}

          {/* Additional documents */}
          {allAdditionalCards.length > 0 && (
            <section
              aria-label="Дополнительные документы"
              className="space-y-2.5 pt-2"
            >
              <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                Дополнительные
              </h4>
              {allAdditionalCards.map((card) => (
                <CandidatePreviousDocumentCard
                  key={card.key}
                  candidateId={candidateId}
                  reviewGroup={reviewGroup}
                  title={card.title}
                  status={card.status}
                  currentDocument={card.currentDocument}
                  previousDocument={card.previousDocument}
                  returnedVersion={card.returnedVersion}
                  isMissing={card.isMissing}
                  onOpenPrevious={onOpenPrevious}
                  onReviewCurrent={onReviewDocument}
                />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
