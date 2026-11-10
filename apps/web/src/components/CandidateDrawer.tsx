import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  useGetCandidateDetails,
  getGetCandidateDetailsQueryKey,
  useRequestCandidateEnrichment,
  getListReviewCandidatesQueryKey,
  getListCandidatePreviousDocumentsQueryKey,
  getListCandidateReviewQueueQueryKey,
  getListIgArrivalRegistryGroupsQueryKey,
  getListIgArrivalRegistryParticipationsQueryKey,
  type CandidateProfileDto,
} from "@edo/api-client";
import { Badge, Button } from "@edo/ui";
import {
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  GraduationCap,
  UserRound,
  X,
} from "lucide-react";
import { formatDateRu, formatLocalArrivalTime } from "../lib/date-format";
import { LkLink } from "./LkLink";
import { CandidateStageAccordion } from "./CandidateStageAccordion";
import { CandidateDrawerHistorySection } from "./CandidateDrawerHistorySection";
import { assembleCandidateStages } from "../lib/candidate-stages";
import {
  candidateInitials,
  documentProgressPercent,
  formatBirthDateRu,
  formatCandidateObject,
  formatDocumentProgress,
} from "../lib/review-groups";

export interface CandidateDrawerProps {
  candidateId: string;
  profile: CandidateProfileDto | null;
  onClose: () => void;
  returnedHistory?: boolean;
  stage?: string;
  arrivalContext?: {
    date?: string;
    arrivalDateTime?: string;
    location?: string;
    status: string;
  };
}

/**
 * Side drawer with the candidate profile and stages of document verification.
 * Follows the approved visual layout:
 * - Panel: w-full max-w-[760px] min-[640px]:w-[720px] lg:w-[760px]
 * - Darkened backdrop with focus trap, body scroll lock, Escape & click outside handling.
 * - Pinned header with candidate initials avatar, full name, citizenship & reemployment badges,
 *   confirmed counter with thin progress bar, and close button.
 * - Compact 2-column metadata grid (birth date, position, object, mentor, manager).
 * - Body: stage accordions via CandidateStageAccordion with support for `candidateStage` / `stage`
 *   URL parameter, required/additional separation and CandidatePreviousDocumentCard.
 * - Bottom: collapsible CandidateDrawerHistorySection for ERP history and archive documents.
 */
export function CandidateDrawer({
  candidateId,
  profile: queueProfile,
  onClose,
  returnedHistory = false,
  stage: stageProp,
  arrivalContext,
}: CandidateDrawerProps) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const client = useQueryClient();
  const refresh = useRequestCandidateEnrichment();
  const requested = useRef<string>();
  const previousState = useRef<string>();
  const docs = useGetCandidateDetails(
    candidateId,
    stageProp ? { stage: stageProp } : undefined,
    {
      query: {
        queryKey: getGetCandidateDetailsQueryKey(
          candidateId,
          stageProp ? { stage: stageProp } : undefined,
        ),
        refetchInterval: (query) => {
          const state = query.state.data?.enrichment?.status;
          return state && state !== "READY" ? 5000 : false;
        },
      },
    },
  );
  const enrichment = docs.data?.enrichment;
  const requestLoading = () => {
    requested.current = candidateId;
    refresh.mutate(
      { candidateId },
      {
        onSuccess: () => {
          previousState.current = "PENDING";
          void docs.refetch();
        },
      },
    );
  };
  useEffect(() => {
    if (
      enrichment &&
      (docs.data?.candidate.reviewGroup === "RU" || enrichment.status !== "READY") &&
      requested.current !== candidateId
    )
      requestLoading();
    if (
      enrichment?.status === "READY" &&
      previousState.current &&
      previousState.current !== "READY"
    ) {
      for (const key of [
        getListCandidatePreviousDocumentsQueryKey(candidateId),
        getListReviewCandidatesQueryKey(),
        getListCandidateReviewQueueQueryKey(),
        getListIgArrivalRegistryGroupsQueryKey(),
        getListIgArrivalRegistryParticipationsQueryKey({ groupKey: "" }),
      ]) {
        void client.invalidateQueries({ queryKey: key.slice(0, 1) });
      }
    }
    previousState.current = enrichment?.status;
  }, [candidateId, enrichment?.status, docs.dataUpdatedAt]);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current!;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  const arrivalTime = formatLocalArrivalTime(arrivalContext?.arrivalDateTime);
  const arrivalDate =
    arrivalContext?.arrivalDateTime?.slice(0, 10) ?? arrivalContext?.date;
  const profile = docs.data?.candidate ?? queueProfile;
  const fullName = profile?.fullName?.trim() || null;
  const heading = fullName ?? "Профиль кандидата";
  const progressPercent = profile
    ? documentProgressPercent(
        profile.approvedDocuments,
        profile.requiredDocuments,
      )
    : null;

  const stages = useMemo(
    () =>
      assembleCandidateStages(docs.data, {
        stage: stageProp,
        returnedHistory,
      }),
    [docs.data, stageProp, returnedHistory],
  );

  const candidateStageParam =
    (search.candidateStage as string | undefined) ??
    (search.stage as string | undefined) ??
    (stageProp ? String(stageProp) : undefined);

  const [expandedStages, setExpandedStages] = useState<Record<string, boolean>>(
    {},
  );

  useEffect(() => {
    if (candidateStageParam !== undefined && candidateStageParam !== "") {
      setExpandedStages((prev) => ({ ...prev, [candidateStageParam]: true }));
    }
  }, [candidateStageParam]);

  const isStageOpen = (stgNumber: number | null, index: number) => {
    const key = stgNumber === null ? "none" : String(stgNumber);
    if (key in expandedStages) {
      return expandedStages[key];
    }
    if (candidateStageParam !== undefined && candidateStageParam !== "") {
      if (candidateStageParam === "none") return stgNumber === null;
      return String(stgNumber) === candidateStageParam;
    }
    // Default: expand Stage 1 (or the first stage if none is 1)
    if (stgNumber === 1) return true;
    const hasStageOne = stages.some((s) => s.stage === 1);
    if (!hasStageOne && index === 0) return true;
    return false;
  };

  const toggleStage = (stgNumber: number | null, index: number) => {
    const key = stgNumber === null ? "none" : String(stgNumber);
    const currentlyOpen = isStageOpen(stgNumber, index);
    const nextOpen = !currentlyOpen;
    setExpandedStages((prev) => ({ ...prev, [key]: nextOpen }));

    const nextStageParam = nextOpen ? key : undefined;
    void navigate({
      search: ((prev: Record<string, unknown>) => {
        const next = { ...prev };
        if (nextStageParam !== undefined) {
          next.candidateStage = nextStageParam;
        } else {
          delete next.candidateStage;
        }
        return next;
      }) as never,
      replace: true,
    });
  };

  const handleReviewDocument = (docId: string, version?: number) => {
    const isIg = profile?.reviewGroup === "IG";
    const to = isIg ? "/review-ig/$documentId" : "/review/$documentId";
    void navigate({
      to,
      params: { documentId: docId },
      search: {
        ...search,
        version,
      },
    });
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={headingId}
      className="candidate-drawer fixed inset-0 m-0 h-[100dvh] max-h-none w-full max-w-none overflow-hidden border-0 bg-black/40 p-0 text-[var(--foreground)] backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="candidate-drawer-panel absolute right-0 top-0 flex h-full w-full max-w-[760px] min-[640px]:w-[720px] lg:w-[760px] flex-col bg-[var(--card)] shadow-2xl">
        {enrichment && enrichment.status !== "READY" && (
          <div
            role="status"
            className="border-b border-[var(--border)] px-4 py-3 text-sm"
          >
            {enrichment.status === "RETRY"
              ? "Не удалось загрузить все данные. Повторим загрузку автоматически."
              : "Загружаем профиль и документы…"}
            {refresh.isError && (
              <span className="ml-2">
                Не удалось запросить загрузку.{" "}
                <Button variant="ghost" size="sm" onClick={requestLoading}>
                  Повторить
                </Button>
              </span>
            )}
          </div>
        )}
        {/* Pinned Header */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] p-4 sm:p-5">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--avatar)] text-sm font-semibold text-[var(--foreground)]"
            >
              {candidateInitials(fullName)}
            </span>
            <div className="min-w-0">
              <h2
                id={headingId}
                className="truncate text-lg font-semibold leading-tight text-[var(--foreground)]"
              >
                {heading}
              </h2>
              {(profile?.citizenship || profile?.isReemployment) && (
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {profile?.citizenship && (
                    <Badge title="Гражданство">
                      {profile.citizenship.toUpperCase()}
                    </Badge>
                  )}
                  {profile?.isReemployment === true && (
                    <Badge tone="warning">Повторный найм</Badge>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <div className="flex flex-col items-end gap-1">
              <span className="text-xs font-medium text-[var(--muted-foreground)]">
                {arrivalContext
                  ? "Обязательные документы — по этапам ниже"
                  : formatDocumentProgress(
                      profile?.approvedDocuments ?? 0,
                      profile?.requiredDocuments,
                    )}
              </span>
              {!arrivalContext && progressPercent !== null && (
                <span
                  role="progressbar"
                  aria-label="Прогресс подтверждения документов"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPercent}
                  className="h-1.5 w-24 overflow-hidden rounded-full bg-[var(--muted)]"
                >
                  <span
                    aria-hidden
                    className="block h-full rounded-full bg-[var(--primary)] transition-all"
                    style={{ width: `${progressPercent}%` }}
                  />
                </span>
              )}
            </div>
            <button
              ref={closeRef}
              type="button"
              aria-label="Закрыть профиль кандидата"
              onClick={onClose}
              className="rounded-lg p-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted-soft)] hover:text-[var(--foreground)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            >
              <X size={18} aria-hidden />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {arrivalContext && (
            <div
              role="note"
              className="border-b border-[var(--border)] bg-[var(--muted)] px-4 py-3 text-xs sm:px-5"
            >
              <strong>
                {arrivalContext.status === "CURRENT"
                  ? "Выбранный заезд"
                  : arrivalContext.status === "CANCELLED"
                    ? "Отменённый заезд"
                    : arrivalContext.status === "ISSUE"
                      ? "Заезд с проблемой"
                      : "Исторический заезд"}
              </strong>
              {arrivalDate && (
                <>
                  {" "}
                  · {formatDateRu(arrivalDate)}
                  {arrivalTime && `, ${arrivalTime}`}
                </>
              )}
              {arrivalContext.location && <> · {arrivalContext.location}</>}
              <p className="mt-1">
                Документы и данные ниже показывают текущий профиль кандидата.
              </p>
            </div>
          )}
          {/* Metadata Grid */}
          {!profile && !docs.isLoading && !docs.isError && (
            <p className="border-b border-[var(--border)] px-4 py-3 text-xs text-[var(--muted-foreground)] sm:px-5">
              Данные профиля не заполнены.
            </p>
          )}

          {profile && (
            <div className="border-b border-[var(--border)] bg-[var(--background)]/50 px-4 py-3 sm:px-5 sm:py-3.5">
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2 text-xs">
                {/* Дата рождения */}
                <div className="flex items-start gap-2 min-w-0">
                  <CalendarDays
                    className="h-4 w-4 shrink-0 text-[var(--muted-foreground)] mt-0.5"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <dt className="text-[11px] text-[var(--muted-foreground)]">
                      Дата рождения
                    </dt>
                    <dd className="mt-0.5 font-medium text-[var(--foreground)] break-words">
                      {formatBirthDateRu(profile.birthDate)}
                    </dd>
                  </div>
                </div>

                {/* Должность */}
                <div className="flex items-start gap-2 min-w-0">
                  <BriefcaseBusiness
                    className="h-4 w-4 shrink-0 text-[var(--muted-foreground)] mt-0.5"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <dt className="text-[11px] text-[var(--muted-foreground)]">
                      Должность
                    </dt>
                    <dd className="mt-0.5 font-medium text-[var(--foreground)] break-words [overflow-wrap:anywhere]">
                      {profile.positionName || "—"}
                    </dd>
                  </div>
                </div>

                {/* Объект */}
                <div className="flex items-start gap-2 min-w-0 sm:col-span-2">
                  <Building2
                    className="h-4 w-4 shrink-0 text-[var(--muted-foreground)] mt-0.5"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <dt className="text-[11px] text-[var(--muted-foreground)]">
                      Объект
                    </dt>
                    <dd className="mt-0.5 font-medium text-[var(--foreground)] break-words [overflow-wrap:anywhere]">
                      {formatCandidateObject(
                        profile.projectName,
                        profile.projectCode,
                      ).replace(/^Объект:\s*/, "")}
                    </dd>
                  </div>
                </div>

                {/* Менеджер */}
                <div className="flex items-start gap-2 min-w-0">
                  <UserRound
                    className="h-4 w-4 shrink-0 text-[var(--muted-foreground)] mt-0.5"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <dt className="text-[11px] text-[var(--muted-foreground)]">
                      Менеджер
                    </dt>
                    <dd className="mt-0.5 font-medium text-[var(--foreground)] break-words [overflow-wrap:anywhere]">
                      {profile.managerCode1c ? (
                        <LkLink code1c={profile.managerCode1c}>
                          {profile.managerName ?? "Менеджер"}
                        </LkLink>
                      ) : (
                        (profile.managerName ?? "—")
                      )}
                    </dd>
                  </div>
                </div>

                {/* Наставник */}
                <div className="flex items-start gap-2 min-w-0">
                  <GraduationCap
                    className="h-4 w-4 shrink-0 text-[var(--muted-foreground)] mt-0.5"
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <dt className="text-[11px] text-[var(--muted-foreground)]">
                      Наставник
                    </dt>
                    <dd className="mt-0.5 font-medium text-[var(--foreground)] break-words [overflow-wrap:anywhere]">
                      {profile.mentorCode1c ? (
                        <LkLink code1c={profile.mentorCode1c}>
                          {profile.mentorName ?? "Наставник"}
                          {profile.mentorPosition
                            ? ` · ${profile.mentorPosition}`
                            : ""}
                        </LkLink>
                      ) : (
                        (profile.mentorName ?? "—")
                      )}
                    </dd>
                  </div>
                </div>
              </dl>
            </div>
          )}

          {/* Drawer Body - Stages */}
          <div className="p-4 sm:p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--foreground)]">
                {returnedHistory
                  ? "Возвращённые версии документов"
                  : "Этапы проверки документов"}
              </h3>
            </div>

            {docs.isLoading && (
              <p
                role="status"
                className="text-xs text-[var(--muted-foreground)]"
              >
                Загрузка документов…
              </p>
            )}

            {docs.isError && (
              <div
                role="alert"
                className="flex items-center justify-between rounded-lg border border-[var(--border)] p-3 text-xs text-[var(--primary)]"
              >
                <span>Не удалось загрузить документы.</span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void docs.refetch()}
                >
                  Повторить
                </Button>
              </div>
            )}

            {!docs.isLoading && !docs.isError && stages.length === 0 && (
              <p className="text-xs text-[var(--muted-foreground)]">
                {returnedHistory
                  ? "Возвращённых версий нет."
                  : "Документов нет."}
              </p>
            )}

            {/* Stage Accordions */}
            {!docs.isLoading && stages.length > 0 && (
              <div className="space-y-3">
                {stages.map((stg, index) => (
                  <CandidateStageAccordion
                    showProgress={!arrivalContext}
                    key={`stage-${stg.stage ?? "none"}-${index}`}
                    stage={stg.stage}
                    title={stg.title}
                    required={stg.required}
                    additional={stg.additional}
                    previousDocuments={stg.previousDocuments}
                    reviewGroup={profile?.reviewGroup}
                    candidateId={candidateId}
                    isOpen={isStageOpen(stg.stage, index)}
                    onToggle={() => toggleStage(stg.stage, index)}
                    onReviewDocument={handleReviewDocument}
                  />
                ))}
              </div>
            )}

            {/* Collapsible History Section at the bottom */}
            {!returnedHistory && (
              <CandidateDrawerHistorySection
                candidateId={candidateId}
                className="mt-6"
              />
            )}
          </div>
        </div>
      </div>
    </dialog>
  );
}
