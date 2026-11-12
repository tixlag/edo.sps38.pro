import { FilterBar } from "@edo/ui";
import { filterValues } from "../lib/filter-values";
import { DocumentReviewDialog } from "../components/DocumentReviewDialog";
import { useVisibleRuDocumentSync } from "../lib/use-visible-ru-document-sync";
import { StageRing } from "../components/StageRing";
import { parseIgRegistrySearch } from "../lib/ig-registry-search";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  useGetReviewDocumentFacets,
  useListCandidateStatuses,
  getListCandidateStatusesQueryKey,
  useListDocumentTypes,
  useListPositions,
  useListReviewCandidates,
  useListCandidateReviewQueue,
  useListCatalogManagers,
  getListCatalogManagersQueryKey,
  type CandidateDetailsDto,
  type CandidateDocumentSummaryDto,
  useGetDocumentInfo,
  useGetMe,
  getListReviewCandidatesQueryKey,
  getGetReviewDocumentFacetsQueryKey,
  getListCandidateReviewQueueQueryKey,
} from "@edo/api-client";
import {
  PageHeader,
  Button,
  Badge,
  StatusBadge,
  EmptyState,
} from "@edo/ui";
import {
  Clock,
  Check,
  X,
  ChevronRight,
  CalendarDays,
  BriefcaseBusiness,
  Building2,
  GraduationCap,
  UserRound,
  FileSignature,
} from "lucide-react";
import {
  DocumentReviewWorkspace,
  type DocumentReviewNavigationState,
} from "../components/DocumentReviewWorkspace";
import { ReviewDocumentNavigation } from "../components/ReviewDocumentNavigation";
import { useLiveDocumentVersion } from "../lib/use-live-document-version";
import type { SearchSelectOption } from "../components/SearchSelect";
import { CandidateDrawer } from "../components/CandidateDrawer";
import { CreateCandidate } from "../components/CreateCandidate";
import { IgArrivalReviewQueue } from "../components/IgArrivalReviewQueue";
import { DateFilter } from "../components/DateFilter";
import { LkLink } from "../components/LkLink";
import { CandidateAvatar } from "../components/CandidateAvatar";
import { findCurrentUserAsManager } from "../lib/manager-default";
import { buildGroupedCandidateStatusOptions } from "../lib/candidate-status-groups";
import { isHistoricVersion, parseVersionParam } from "../lib/audit-types";
import { formatDateTimeRu } from "../lib/date-format";
import {
  formatBirthDateRu,
  formatCandidateObject,
  hasActiveReviewFilters,
  parseReviewSearchParams,
  type ReviewTab,
} from "../lib/review-groups";

const VERSION_STATUS_LABEL: Record<string, string> = {
  IN_REVIEW: "на проверке",
  APPROVED: "подтверждена",
  RETURNED: "возвращена",
  SIGNED: "подписана",
  OCR_FAILED: "ошибка распознавания",
  OCR_PENDING: "распознаётся",
  UPLOADED: "загружена",
  EXPIRED: "просрочена",
  DRAFT: "черновик",
};

const PAGE_LIMIT = 50;
const CANDIDATE_SELECTOR_LIMIT = 20;
const POSITION_SELECTOR_LIMIT = 50;

const TABS: { value: ReviewTab; label: string }[] = [
  { value: "ALL", label: "Все кандидаты" },
  { value: "IN_REVIEW", label: "Ожидают проверки" },
  { value: "RETURNED", label: "Возвращённые" },
  { value: "ERP_PENDING", label: "Требуют отправки в ERP" },
];

function CandidateRow({
  group,
  onOpen,
  onOpenStage,
  onContract,
  opensChat,
  synchronizing,
}: {
  group: CandidateDetailsDto;
  onOpen: () => void;
  onOpenStage: (stage: number | null) => void;
  onContract?: () => void;
  opensChat: boolean;
  synchronizing?: boolean;
  returnedHistory?: boolean;
}) {
  const candidate = group.candidate;
  const heading = candidate?.fullName?.trim() || "Без имени в профиле";
  const person = (
    name: string | null | undefined,
    code: string | null | undefined,
  ) =>
    code ? (
      <span className="pointer-events-auto">
        <LkLink code1c={code}>{name ?? code}</LkLink>
      </span>
    ) : (
      name || "—"
    );
  return (
    <section
      aria-label={heading}
      className="relative rounded-[10px] border border-[var(--border)] bg-[var(--card)] p-3"
    >
      <button
        type="button"
        aria-haspopup={opensChat ? undefined : "dialog"}
        aria-label={`${opensChat ? "Открыть чат" : "Открыть документы"}: ${heading}`}
        onClick={onOpen}
        className="absolute inset-0 rounded-[10px] hover:bg-[var(--border)]/30 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--primary)]"
      />
      <div className="pointer-events-none relative flex min-w-0 flex-col gap-3 min-[1400px]:flex-row min-[1400px]:items-center">
        <div className="min-w-0 w-full min-[1400px]:w-[min(42%,620px,calc(100%-783px))] min-[1400px]:shrink-0">
          <div className="mb-2 flex min-w-0 items-center gap-2 font-semibold">
            <CandidateAvatar
              candidateId={candidate?.id}
              fullName={candidate?.fullName}
              photoPath={candidate?.photoPath}
              size="sm"
              allowEnlarge
              className="pointer-events-auto"
            />
            <span className="min-w-0 break-words">{heading}</span>
            {candidate?.statusName && (
              <StatusBadge status={candidate.statusName} />
            )}
            {candidate?.citizenship && (
              <Badge title="Гражданство">
                {candidate.citizenship.toUpperCase()}
              </Badge>
            )}
            {candidate?.isReemployment && (
              <Badge tone="warning">Повторный найм</Badge>
            )}
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-[minmax(150px,0.8fr)_minmax(0,1fr)_minmax(0,1.6fr)]">
            {[
              [
                CalendarDays,
                "Дата рождения",
                formatBirthDateRu(candidate?.birthDate),
              ],
              [BriefcaseBusiness, "Должность", candidate?.positionName || "—"],
              [
                Building2,
                "Объект",
                formatCandidateObject(
                  candidate?.projectName,
                  candidate?.projectCode,
                ).replace(/^Объект: /, ""),
              ],
            ].map(([Icon, label, value]) => {
              const I = Icon as typeof CalendarDays;
              return (
                <div
                  key={label as string}
                  title={value as string}
                  onClick={onOpen}
                  className="pointer-events-auto flex min-w-0 cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1"
                >
                  <I
                    size={17}
                    className="shrink-0 text-[var(--muted-foreground)]"
                  />
                  <span className="min-w-0 text-sm leading-tight">
                    <span className="block text-xs text-[var(--muted-foreground)]">
                      {label as string}
                    </span>
                    <span
                      className={
                        label === "Объект"
                          ? "block break-words [overflow-wrap:anywhere]"
                          : "block truncate"
                      }
                    >
                      {value as string}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-xs">
            <span className="flex min-w-0 items-center gap-2 break-words">
              <UserRound size={18} className="text-[var(--primary)]" />
              <span>
                <span className="text-[var(--muted-foreground)]">
                  Менеджер:{" "}
                </span>
                {person(candidate?.managerName, candidate?.managerCode1c)}
              </span>
            </span>
            <span className="flex min-w-0 items-center gap-2 break-words">
              <GraduationCap
                size={18}
                className="text-[var(--muted-foreground)]"
              />
              <span>
                <span className="text-[var(--muted-foreground)]">
                  Наставник:{" "}
                </span>
                {person(candidate?.mentorName, candidate?.mentorCode1c)}
              </span>
            </span>
          </div>
        </div>
        <div
          onClick={onOpen}
          className="pointer-events-auto flex min-w-0 flex-1 items-center gap-2 border-t border-[var(--border)] pt-2 min-[1400px]:border-l min-[1400px]:border-t-0 min-[1400px]:pl-3 min-[1400px]:pt-0"
        >
          <div className="min-w-0 flex-1 pb-1">
            <div className="flex w-full flex-wrap items-center justify-end gap-1">
              {synchronizing ? (
                <p
                  role="status"
                  className="p-3 text-xs text-[var(--muted-foreground)]"
                >
                  Синхронизация документов…
                </p>
              ) : candidate?.stageProgress ? (
                candidate.stageProgress.map((progress) => (
                  <StageRing
                    key={progress.stage ?? "additional"}
                    progress={progress}
                    onOpen={() => onOpenStage(progress.stage)}
                  />
                ))
              ) : (
                <span className="w-24 text-center text-xs text-[var(--muted-foreground)]">
                  Этапы неизвестны
                </span>
              )}
              <button
                type="button"
                disabled={!onContract}
                onClick={(event) => {
                  event.stopPropagation();
                  onContract?.();
                }}
                aria-label="Подготовить договор"
                title={
                  onContract
                    ? "Подготовить договор"
                    : "Для подготовки договора необходимо право 20003"
                }
                className="ml-2 flex w-[72px] shrink-0 flex-col items-center gap-0.5 rounded border-l border-[var(--border)] pl-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] disabled:opacity-60 min-[1400px]:w-[76px]"
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--background)] text-[var(--muted-foreground)]">
                  <FileSignature size={22} />
                </span>
                <strong className="flex h-8 items-center justify-center leading-tight">
                  Договор
                </strong>
                <span>—</span>
              </button>
            </div>
          </div>
          <ChevronRight
            size={18}
            className="shrink-0 text-[var(--muted-foreground)]"
          />
        </div>
      </div>
    </section>
  );
}

export function ReviewPage({
  reviewGroup = "RU",
}: {
  reviewGroup?: "RU" | "IG";
}) {
  const base = reviewGroup === "IG" ? "/review-ig" : "/review";
  const profile = useGetMe();
  const [creatingCandidate, setCreatingCandidate] = useState(false);
  const permissions = profile.data?.permissions ?? {};
  const canReview = [reviewGroup === "IG" ? "20011" : "20002", "20009"].some(
    (rule) => Object.prototype.hasOwnProperty.call(permissions, rule),
  );
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const filters = useMemo(
    () =>
      parseReviewSearchParams(
        rawSearch,
        reviewGroup === "RU" ? "ALL" : "IN_REVIEW",
      ),
    [rawSearch, reviewGroup],
  );
  const dateRangeInvalid = !!(
    (filters.createdFrom &&
      filters.createdTo &&
      filters.createdFrom > filters.createdTo) ||
    (filters.birthDateFrom &&
      filters.birthDateTo &&
      filters.birthDateFrom > filters.birthDateTo)
  );
  const igView =
    (rawSearch.view as string) === "arrivals" ? "arrivals" : "list";

  // Functional search update: selector commits always apply on top of the
  // latest URL, so concurrent changes cannot drop each other (stale-closure
  // overwrite). Every filter change resets pagination (cursor); opening the
  // drawer keeps it.
  const setFilters = useCallback(
    (patch: Record<string, unknown>, opts?: { keepCursor?: boolean }) => {
      void navigate({
        to: base,
        search: (prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev };
          for (const [key, value] of Object.entries(patch)) {
            if (value === undefined || value === "") delete next[key];
            else next[key] = value;
          }
          if (!opts?.keepCursor) delete next.cursor;
          return next;
        },
      });
    },
    [navigate, base],
  );

  const commit = useCallback(
    (key: string) => (value: string | undefined) =>
      setFilters({ [key]: value }),
    [setFilters],
  );

  const pickTab = (next: ReviewTab) => {
    if (next !== filters.status)
      setFilters({ status: next, currentStatus: undefined });
  };

  const resetFilters = () => {
    setFilters({
      currentStatus: undefined,
      candidateIds: undefined,
      statusIds: undefined,
      documentTypeCodes: undefined,
      citizenships: undefined,
      positionCodes: undefined,
      projectCodes: undefined,
      mentorCodes1c: undefined,
      managerKeys: [],
      hasMentorValues: undefined,
      statusId: undefined,
      managerName: undefined,
      managerUnassigned: undefined,
      candidateId: undefined,
      documentTypeCode: undefined,
      citizenship: undefined,
      managerCode1c: undefined,
      managerId: "all",
      mentorCode1c: undefined,
      hasMentor: undefined,
      birthDateFrom: undefined,
      birthDateTo: undefined,
      createdFrom: undefined,
      createdTo: undefined,
      positionCode: undefined,
      projectCode: undefined,
      candidate: undefined,
      candidateStage: undefined,
      q: undefined,
      manager: undefined,
      mentor: undefined,
    });
  };

  const openCandidate = useCallback(
    (id: string, stage?: number | null) => {
      void navigate({
        to: base,
        search: (prev: Record<string, unknown>) => {
          const next: Record<string, unknown> = { ...prev, candidate: id };
          if (stage === undefined) delete next.candidateStage;
          else next.candidateStage = stage === null ? "none" : String(stage);
          return next;
        },
      });
    },
    [navigate, base],
  );

  const closeCandidate = useCallback(() => {
    void navigate({
      to: base,
      replace: true,
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev };
        delete next.candidate;
        delete next.candidateStage;
        delete next.igParticipation;
        return next;
      },
    });
  }, [navigate, base]);

  // Async selector sources: candidates (ФИО) and the LK position directory.
  const [candidateQuery, setCandidateQuery] = useState("");
  const [positionQuery, setPositionQuery] = useState("");
  const candidateParams = useMemo(
    () => ({
      q: candidateQuery.trim() || undefined,
      limit: CANDIDATE_SELECTOR_LIMIT,
      reviewGroup,
      includeAll: reviewGroup === "RU",
    }),
    [candidateQuery, reviewGroup],
  );
  const positionParams = useMemo(
    () => ({
      q: positionQuery.trim() || undefined,
      limit: POSITION_SELECTOR_LIMIT,
    }),
    [positionQuery],
  );
  const candidates = useListReviewCandidates(candidateParams, {
    query: {
      queryKey: getListReviewCandidatesQueryKey(candidateParams),
      enabled: canReview,
    },
  });
  const positions = useListPositions(positionParams);
  const facets = useGetReviewDocumentFacets(
    { reviewGroup, includeAll: reviewGroup === "RU" },
    {
      query: {
        queryKey: getGetReviewDocumentFacetsQueryKey({
          reviewGroup,
          includeAll: reviewGroup === "RU",
        }),
        enabled: canReview,
      },
    },
  );
  const catalogManagers = useListCatalogManagers({
    query: {
      queryKey: getListCatalogManagersQueryKey(),
      enabled: canReview && reviewGroup === "RU",
    },
  });
  const statuses = useListCandidateStatuses({
    query: {
      queryKey: getListCandidateStatusesQueryKey(),
      enabled: canReview && reviewGroup === "RU",
    },
  });
  const docTypesParams = useMemo(() => ({ catalogOnly: true as const }), []);
  const docTypes = useListDocumentTypes(docTypesParams);

  const myManager = useMemo(
    () => findCurrentUserAsManager(catalogManagers.data?.items, profile.data),
    [catalogManagers.data, profile.data],
  );
  const isAllManagers =
    rawSearch.managerId === "all" || filters.managerKeys !== undefined;
  const effectiveManagerId = isAllManagers
    ? undefined
    : (filters.managerId ??
      (reviewGroup === "RU" &&
      !filters.managerCode1c &&
      !filters.managerName &&
      !filters.managerUnassigned
        ? myManager?.id
        : undefined));

  const queryParams = useMemo(
    () => ({
      reviewGroup,
      status: filters.status,
      currentStatus: filters.currentStatus,
      statusId: filters.statusId,
      candidateIds: filters.candidateIds,
      statusIds: filters.statusIds,
      documentTypeCodes: filters.documentTypeCodes,
      citizenships: filters.citizenships,
      positionCodes: filters.positionCodes,
      projectCodes: filters.projectCodes,
      mentorCodes1c: filters.mentorCodes1c,
      managerKeys: filters.managerKeys,
      hasMentorValues: filters.hasMentorValues,

      managerName: filters.managerName,
      managerUnassigned: filters.managerUnassigned,
      limit: PAGE_LIMIT,
      cursor: filters.cursor,
      candidateId: filters.candidateId,
      documentTypeCode: filters.documentTypeCode,
      citizenship: filters.citizenship,
      managerCode1c: filters.managerCode1c,
      managerId: effectiveManagerId,
      mentorCode1c: filters.mentorCode1c,
      hasMentor: filters.hasMentor,
      birthDateFrom: filters.birthDateFrom,
      birthDateTo: filters.birthDateTo,
      createdFrom: filters.createdFrom,
      createdTo: filters.createdTo,
      positionCode: filters.positionCode,
      projectCode: filters.projectCode,
    }),
    [filters, reviewGroup, effectiveManagerId],
  );
  const list = useListCandidateReviewQueue(queryParams, {
    query: {
      queryKey: getListCandidateReviewQueueQueryKey(queryParams),
      enabled:
        canReview &&
        !dateRangeInvalid &&
        (reviewGroup === "RU" || igView === "list"),
      refetchInterval: 30_000,
    },
  });

  const groups = list.data?.items ?? [];
  const visibleSync = useVisibleRuDocumentSync(
    groups.map((group) => group.candidate.id),
    reviewGroup === "RU" && canReview && !dateRangeInvalid && !!list.data,
    () => list.refetch(),
  );

  // Selector options. Facet entries without an exact code cannot feed an
  // exact backend filter, so they are not selectable.
  const candidateOptions: SearchSelectOption[] = useMemo(
    () =>
      (candidates.data?.items ?? []).map((item) => ({
        value: item.id,
        label: item.fullName?.trim() || "Без имени в профиле",
      })),
    [candidates.data],
  );
  const positionOptions: SearchSelectOption[] = useMemo(
    () =>
      (positions.data?.items ?? []).map((item) => ({
        value: item.code,
        label: item.name,
      })),
    [positions.data],
  );
  const docTypeOptions: SearchSelectOption[] = useMemo(
    () =>
      (docTypes.data?.items ?? []).map((type) => ({
        value: type.code,
        label: type.title,
      })),
    [docTypes.data],
  );
  const citizenshipOptions: SearchSelectOption[] = useMemo(
    () =>
      (facets.data?.citizenships ?? []).map((code) => ({
        value: code,
        label: code,
      })),
    [facets.data],
  );
  const managerOptions: SearchSelectOption[] = useMemo(
    () =>
      reviewGroup === "RU"
        ? (catalogManagers.data?.items ?? [])
            .map((person) => ({ value: `id:${person.id}`, label: person.name }))
            .concat(
              (facets.data?.managers ?? []).flatMap((person) =>
                person.code1c
                  ? [{ value: `code:${person.code1c}`, label: person.name }]
                  : [],
              ),
            )
        : (facets.data?.managers ?? []).flatMap((person) =>
            person.code1c
              ? [{ value: `code:${person.code1c}`, label: person.name }]
              : person.name
                ? [{ value: `name:${person.name}`, label: person.name }]
                : [],
          ),
    [facets.data, catalogManagers.data, reviewGroup],
  );
  const mentorOptions: SearchSelectOption[] = useMemo(
    () =>
      (facets.data?.mentors ?? []).flatMap((person) =>
        person.code1c ? [{ value: person.code1c, label: person.name }] : [],
      ),
    [facets.data],
  );
  const projectOptions: SearchSelectOption[] = useMemo(
    () =>
      (facets.data?.projects ?? []).flatMap((project) =>
        project.code ? [{ value: project.code, label: project.name }] : [],
      ),
    [facets.data],
  );

  const statusOptions: SearchSelectOption[] = useMemo(
    () => buildGroupedCandidateStatusOptions(statuses.data?.items ?? []),
    [statuses.data],
  );

  const drawerGroup = groups.find(
    (group) => group.candidate.id === filters.candidate,
  );
  const drawerCandidateId = filters.candidate ?? null;

  const filtersActive =
    hasActiveReviewFilters(filters) ||
    (reviewGroup === "RU" && isAllManagers && !!myManager);

  if (!canReview)
    return (
      <div className="p-4 text-sm">
        {profile.isLoading
          ? "Загрузка прав доступа…"
          : "Нет доступа к этой очереди проверки."}
      </div>
    );

  return (
    <div className="h-full overflow-auto p-3 sm:p-7">
      {filters.currentStatus && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 text-sm"
        >
          Текущий статус: {VERSION_STATUS_LABEL[filters.currentStatus]}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setFilters({ currentStatus: undefined })}
          >
            Снять фильтр статуса
          </Button>
        </div>
      )}
      <PageHeader
        className="flex-col items-stretch gap-3 sm:flex-row sm:items-center"
        title={reviewGroup === "IG" ? "Проверка документов ИГ" : "Кандидаты РУ"}
        subtitle="Документы кандидатов и сотрудников"
        actions={
          reviewGroup === "RU" ? (
            <Button
              onClick={() => setCreatingCandidate(true)}
              disabled={creatingCandidate}
            >
              Создать кандидата
            </Button>
          ) : undefined
        }
      />
      {reviewGroup === "RU" && creatingCandidate && (
        <div className="mt-4">
          <CreateCandidate onCancel={() => setCreatingCandidate(false)} />
        </div>
      )}
      {reviewGroup === "IG" && (
        <div className="my-4 flex flex-wrap items-center gap-2 border-b border-[var(--border)] pb-3">
          <Button
            size="sm"
            variant={igView === "arrivals" ? "default" : "outline"}
            onClick={() => setFilters({ view: "arrivals" })}
          >
            Списочные заезды
          </Button>
          <Button
            size="sm"
            variant={igView === "list" ? "default" : "outline"}
            onClick={() => setFilters({ view: undefined })}
          >
            Обычный список
          </Button>
        </div>
      )}
      {reviewGroup === "IG" && igView === "arrivals" ? (
        <IgArrivalReviewQueue
          onSelectCandidate={(candidateId, context) => {
            void navigate({
              to: base,
              search: (prev: Record<string, unknown>) => ({
                ...prev,
                candidate: candidateId,
                candidateStage: undefined,
                igParticipation: JSON.stringify(context),
              }),
            });
          }}
        />
      ) : (
        <>
          <div className="my-4 flex flex-wrap gap-2">
            {TABS.filter(
              (tab) => reviewGroup === "RU" || tab.value !== "ALL",
            ).map((tab) => (
              <Button
                key={tab.value}
                size="sm"
                variant={filters.status === tab.value ? "default" : "outline"}
                onClick={() => pickTab(tab.value)}
              >
                {tab.label}
              </Button>
            ))}
          </div>
          {filters.status === "RETURNED" && (
            <p className="mb-4 text-[13px] text-[var(--muted-foreground)]">
              История возвращённых версий. После новой загрузки прежние возвраты
              остаются в этом списке.
            </p>
          )}
          <div>
            <div>
              <FilterBar
                label="Фильтры очереди проверки"
                active={filtersActive}
                onReset={resetFilters}
                filters={[
                  {
                    label: "ФИО кандидата",
                    placeholder: "Все кандидаты",
                    value: filterValues(
                      rawSearch,
                      "candidateIds",
                      "candidateId",
                    ),
                    options: candidateOptions,
                    selectedLabels: Object.fromEntries(
                      groups.map((group) => [
                        group.candidate.id,
                        group.candidate.fullName?.trim() ||
                          "Без имени в профиле",
                      ]),
                    ),
                    onSearchChange: setCandidateQuery,
                    onChange: (values) =>
                      setFilters({
                        candidateIds: values,
                        candidateId: undefined,
                      }),
                    isLoading: candidates.isLoading,
                    isError: candidates.isError,
                    onRetry: () => void candidates.refetch(),
                  },
                  {
                    label: "Тип документа",
                    placeholder: "Все типы",
                    value: filterValues(
                      rawSearch,
                      "documentTypeCodes",
                      "documentTypeCode",
                    ),
                    options: docTypeOptions,
                    onChange: (values) =>
                      setFilters({
                        documentTypeCodes: values,
                        documentTypeCode: undefined,
                      }),
                    isLoading: docTypes.isLoading,
                    isError: docTypes.isError,
                    onRetry: () => void docTypes.refetch(),
                  },
                  {
                    label: "Гражданство",
                    placeholder: "Все гражданства",
                    value: filterValues(
                      rawSearch,
                      "citizenships",
                      "citizenship",
                    ),
                    options: citizenshipOptions,
                    onChange: (values) =>
                      setFilters({
                        citizenships: values,
                        citizenship: undefined,
                      }),
                    isLoading: facets.isLoading,
                    isError: facets.isError,
                    onRetry: () => void facets.refetch(),
                  },
                  ...(reviewGroup === "RU"
                    ? [
                        {
                          label: "Статус кандидата",
                          placeholder: "Все статусы",
                          value: filterValues(
                            rawSearch,
                            "statusIds",
                            "statusId",
                          ),
                          options: statusOptions,
                          onChange: (values: string[]) =>
                            setFilters({
                              statusIds: values,
                              statusId: undefined,
                            }),
                          isLoading: statuses.isLoading,
                          isError: statuses.isError,
                          onRetry: () => void statuses.refetch(),
                        },
                      ]
                    : []),
                  {
                    label: "Менеджер",
                    placeholder: "Все менеджеры",
                    value:
                      filters.managerKeys ??
                      (effectiveManagerId
                        ? [`id:${effectiveManagerId}`]
                        : filters.managerCode1c
                          ? [`code:${filters.managerCode1c}`]
                          : filters.managerName
                            ? [`name:${filters.managerName}`]
                            : filters.managerUnassigned
                              ? ["unassigned"]
                              : []),
                    options: [
                      ...new Map(
                        [
                          ...managerOptions,
                          ...(facets.data?.managers ?? []).flatMap((person) =>
                            !person.code1c && person.name
                              ? [
                                  {
                                    value: `name:${person.name}`,
                                    label: person.name,
                                  },
                                ]
                              : [],
                          ),
                          { value: "unassigned", label: "Без менеджера" },
                        ].map((option) => [option.value, option]),
                      ).values(),
                    ],
                    onChange: (values) =>
                      setFilters({
                        managerKeys: values,
                        managerId: "all",
                        managerCode1c: undefined,
                        managerName: undefined,
                        managerUnassigned: undefined,
                      }),
                    isLoading:
                      facets.isLoading ||
                      (reviewGroup === "RU" && catalogManagers.isLoading),
                    isError:
                      facets.isError ||
                      (reviewGroup === "RU" && catalogManagers.isError),
                    onRetry: () => {
                      void facets.refetch();
                      if (reviewGroup === "RU") void catalogManagers.refetch();
                    },
                  },
                  {
                    label: "Наставник",
                    placeholder: "Все наставники",
                    value: filterValues(
                      rawSearch,
                      "mentorCodes1c",
                      "mentorCode1c",
                    ),
                    options: mentorOptions,
                    onChange: (values) =>
                      setFilters({
                        mentorCodes1c: values,
                        mentorCode1c: undefined,
                      }),
                    isLoading: facets.isLoading,
                    isError: facets.isError,
                    onRetry: () => void facets.refetch(),
                  },
                  {
                    label: "Наличие наставника",
                    value:
                      filters.hasMentorValues ??
                      (filters.hasMentor === undefined
                        ? []
                        : [String(filters.hasMentor)]),
                    options: [
                      { value: "true", label: "С наставником" },
                      { value: "false", label: "Без наставника" },
                    ],
                    onChange: (values) =>
                      setFilters({
                        hasMentorValues: values,
                        hasMentor: undefined,
                      }),
                  },
                  {
                    label: "Должность",
                    placeholder: "Все должности",
                    value: filterValues(
                      rawSearch,
                      "positionCodes",
                      "positionCode",
                    ),
                    options: positionOptions,
                    onSearchChange: setPositionQuery,
                    onChange: (values) =>
                      setFilters({
                        positionCodes: values,
                        positionCode: undefined,
                      }),
                    isLoading: positions.isLoading,
                    isError: positions.isError,
                    onRetry: () => void positions.refetch(),
                  },
                  {
                    label: "Объект",
                    placeholder: "Все объекты",
                    value: filterValues(
                      rawSearch,
                      "projectCodes",
                      "projectCode",
                    ),
                    options: projectOptions,
                    onChange: (values) =>
                      setFilters({
                        projectCodes: values,
                        projectCode: undefined,
                      }),
                    isLoading: facets.isLoading,
                    isError: facets.isError,
                    onRetry: () => void facets.refetch(),
                  },
                ]}
              >
                <fieldset className="min-w-0 sm:col-span-2">
                  <legend className="mb-1.5 text-xs font-medium text-[var(--muted-foreground)]">
                    Дата рождения
                  </legend>
                  <div className="flex items-center gap-2">
                    <DateFilter
                      label="Дата рождения с"
                      value={filters.birthDateFrom}
                      onChange={commit("birthDateFrom")}
                    />
                    <span className="text-[var(--muted-foreground)]">—</span>
                    <DateFilter
                      label="Дата рождения по"
                      value={filters.birthDateTo}
                      onChange={commit("birthDateTo")}
                    />
                  </div>
                </fieldset>
                {reviewGroup === "RU" && (
                  <fieldset className="min-w-0 sm:col-span-2">
                    <legend className="mb-1.5 text-xs font-medium text-[var(--muted-foreground)]">
                      Добавлен в ЭДО
                    </legend>
                    <div className="flex items-center gap-2">
                      <DateFilter
                        label="Дата добавления в ЭДО с"
                        value={filters.createdFrom}
                        onChange={commit("createdFrom")}
                      />
                      <span className="text-[var(--muted-foreground)]">—</span>
                      <DateFilter
                        label="Дата добавления в ЭДО по"
                        value={filters.createdTo}
                        onChange={commit("createdTo")}
                      />
                    </div>
                  </fieldset>
                )}
                {dateRangeInvalid && (
                  <p role="alert" className="text-sm text-[var(--danger)]">
                    Начало периода не может быть позже окончания.
                  </p>
                )}
              </FilterBar>
              {list.isLoading && <p role="status">Загрузка документов…</p>}
              {list.isError && (
                <div role="alert">
                  Не удалось загрузить очередь.{" "}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void list.refetch()}
                  >
                    Повторить
                  </Button>
                </div>
              )}
              {list.data && groups.length === 0 && (
                <EmptyState
                  title={
                    filtersActive
                      ? "Ничего не найдено"
                      : filters.status === "IN_REVIEW"
                        ? "Все документы проверены."
                        : filters.status === "RETURNED"
                          ? "Возвращённых документов нет."
                          : "Документов для ручной отправки нет."
                  }
                  description={
                    filtersActive
                      ? "По заданным фильтрам кандидатов нет. Измените фильтры или сбросьте их."
                      : undefined
                  }
                  action={
                    filtersActive ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={resetFilters}
                      >
                        Сбросить фильтры
                      </Button>
                    ) : undefined
                  }
                />
              )}
              {visibleSync.error && (
                <p
                  role="alert"
                  className="text-sm text-[var(--muted-foreground)]"
                >
                  Не удалось запросить синхронизацию документов.{" "}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={visibleSync.retry}
                  >
                    Повторить
                  </Button>
                </p>
              )}
              {groups.length > 0 && (
                <div className="mt-2 flex flex-col gap-2">
                  {groups.map((group) => (
                    <CandidateRow
                      key={group.candidate.id}
                      group={group}
                      synchronizing={visibleSync.pendingIds.has(
                        group.candidate.id,
                      )}
                      returnedHistory={filters.status === "RETURNED"}
                      onContract={
                        reviewGroup === "IG" &&
                        (Object.prototype.hasOwnProperty.call(
                          profile.data?.permissions ?? {},
                          "20003",
                        ) ||
                          Object.prototype.hasOwnProperty.call(
                            profile.data?.permissions ?? {},
                            "20009",
                          ))
                          ? () =>
                              void navigate({
                                to: "/signing",
                                search: { candidateId: group.candidate.id },
                              })
                          : undefined
                      }
                      opensChat={reviewGroup === "RU"}
                      onOpen={() =>
                        reviewGroup === "RU"
                          ? void navigate({
                              to: "/review/candidates/$candidateId",
                              params: { candidateId: group.candidate.id },
                            })
                          : openCandidate(group.candidate.id)
                      }
                      onOpenStage={(stage) =>
                        openCandidate(group.candidate.id, stage)
                      }
                    />
                  ))}
                </div>
              )}
              {list.data?.nextCursor && (
                <div className="flex gap-2 pt-4">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      setFilters(
                        { cursor: list.data!.nextCursor ?? undefined },
                        { keepCursor: true },
                      )
                    }
                  >
                    Следующая страница
                  </Button>
                </div>
              )}
              {filters.cursor && (
                <div className="flex gap-2 pt-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setFilters({ cursor: undefined }, { keepCursor: true })
                    }
                  >
                    В начало списка
                  </Button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {drawerCandidateId && (
        <CandidateDrawer
          key={drawerCandidateId}
          candidateId={drawerCandidateId}
          stage={filters.candidateStage}
          profile={drawerGroup?.candidate ?? null}
          arrivalContext={
            typeof parseIgRegistrySearch(rawSearch).igParticipation === "string"
              ? JSON.parse(
                  parseIgRegistrySearch(rawSearch).igParticipation as string,
                )
              : undefined
          }
          returnedHistory={filters.status === "RETURNED"}
          onClose={closeCandidate}
        />
      )}
      {typeof rawSearch.documentCandidate === "string" &&
        Boolean(
          rawSearch.reviewerDocument ||
          rawSearch.previousDocument ||
          rawSearch.uploadDocument,
        ) && (
          <DocumentReviewDialog
            candidateId={rawSearch.documentCandidate}
            documentId={
              typeof rawSearch.reviewerDocument === "string"
                ? rawSearch.reviewerDocument
                : undefined
            }
            previousDocumentId={
              typeof rawSearch.previousDocument === "string"
                ? rawSearch.previousDocument
                : undefined
            }
            version={parseVersionParam(rawSearch.version)}
            uploading={rawSearch.uploadDocument === true}
            onClose={() =>
              void navigate({
                to: base,
                search: (prev: Record<string, unknown>) => {
                  const next = { ...prev };
                  for (const key of [
                    "reviewerDocument",
                    "previousDocument",
                    "documentCandidate",
                    "uploadDocument",
                    "version",
                  ])
                    delete next[key];
                  return next;
                },
              })
            }
            chooseVersion={(selected) =>
              void navigate({
                to: base,
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  version: selected,
                }),
              })
            }
            onUploaded={async (id, version) => {
              await list.refetch();
              await navigate({
                to: base,
                search: (prev: Record<string, unknown>) => ({
                  ...prev,
                  reviewerDocument: id,
                  version,
                  previousDocument: undefined,
                  uploadDocument: undefined,
                }),
              });
            }}
          />
        )}
    </div>
  );
}
export function ReviewDocumentPage({
  reviewGroup = "RU",
  readOnly = false,
}: {
  reviewGroup?: "RU" | "IG";
  readOnly?: boolean;
}) {
  const { documentId } = useParams({ strict: false }) as { documentId: string };
  const navigate = useNavigate();
  // Versioned deep links use the history reader or a departmental review route.
  // useSearch (no route validateSearch change needed): invalid values fall
  // back to the current version with an explicit notice.
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const urlVersion = parseVersionParam(search.version);
  const info = useGetDocumentInfo(documentId);
  const [selectedVersion, setSelectedVersion] = useState<number>();
  // URL is the source of truth for deep links; a local override covers the
  // gap between dropdown pick and navigation commit, and resets whenever the
  // URL version changes (back/forward stays consistent).
  useEffect(() => {
    setSelectedVersion(undefined);
  }, [urlVersion, documentId]);
  const group = info.data?.candidate?.reviewGroup ?? reviewGroup;
  const base = group === "IG" ? "/review-ig" : "/review";
  const currentVersion = info.data?.currentVersion;
  const number =
    selectedVersion ??
    urlVersion ??
    (info.data?.status === "IN_REVIEW"
      ? info.data.currentVersion
      : (info.data?.pendingDeliveryVersions[0] ??
        info.data?.currentVersion ??
        0));
  const version = useLiveDocumentVersion(documentId, number);
  const [navigationState, setNavigationState] = useState<
    DocumentReviewNavigationState & { documentId: string; version: number }
  >();
  const [navigationMessage, setNavigationMessage] = useState("");
  const [documentListState, setDocumentListState] = useState<{
    candidateId: string;
    expanded: boolean;
  }>();
  const onNavigationStateChange = useCallback(
    (state: DocumentReviewNavigationState) => {
      setNavigationState({ ...state, documentId, version: number });
      setNavigationMessage("");
    },
    [documentId, number],
  );
  useEffect(() => setNavigationMessage(""), [documentId, number]);
  const activeNavigationState =
    navigationState?.documentId === documentId &&
    navigationState.version === number
      ? navigationState
      : undefined;
  const canNavigate = () => {
    if (activeNavigationState?.busy) return false;
    if (activeNavigationState?.hasUnsavedChanges) {
      setNavigationMessage(
        "Сохраните или отмените правки текущего документа перед переходом.",
      );
      return false;
    }
    return true;
  };
  const selectDocument = (document: CandidateDocumentSummaryDto) => {
    if (document.id === documentId && document.currentVersion === number)
      return;
    if (!canNavigate()) return;
    void navigate({
      to: group === "IG" ? "/review-ig/$documentId" : "/review/$documentId",
      params: { documentId: document.id },
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        version: document.currentVersion,
      }),
    });
  };
  const historic = isHistoricVersion(version.data?.version, currentVersion);
  const unknownVersionFallback = urlVersion === undefined;
  const chooseVersion = (next: number) => {
    if (!canNavigate()) return;
    setSelectedVersion(next);
    void navigate({
      to: readOnly
        ? "/history/documents/$documentId"
        : group === "IG"
          ? "/review-ig/$documentId"
          : "/review/$documentId",
      params: { documentId },
      search: (prev: Record<string, unknown>) => ({ ...prev, version: next }),
    });
  };
  const goToCurrent = () => {
    if (!currentVersion) return;
    chooseVersion(currentVersion);
  };
  const viewedStatus = version.data
    ? (VERSION_STATUS_LABEL[version.data.status] ?? version.data.status)
    : "";
  const decidedAt = version.data?.approvedAt
    ? formatDateTimeRu(version.data.approvedAt)
    : null;
  return (
    <div className="flex min-h-full min-w-0 flex-col overflow-y-auto p-3 sm:p-4">
      <Link
        to={readOnly ? "/history" : base}
        search={{
          ...parseReviewSearchParams(search),
          ...parseIgRegistrySearch(search),
        }}
        onClick={(event) => {
          if (!readOnly && !canNavigate()) event.preventDefault();
        }}
        className="mb-2 inline-block text-[13px] text-[var(--muted-foreground)] underline underline-offset-4 hover:text-[var(--foreground)]"
      >
        {readOnly ? "← История" : "← Очередь проверки"}
      </Link>
      <PageHeader
        title={
          info.data?.candidate?.fullName?.trim() ||
          info.data?.title ||
          "Проверка документа"
        }
        subtitle={
          info.data ? `${info.data.title} · Версия ${number || "—"}` : undefined
        }
        actions={
          version.data && (
            <StatusBadge
              status={version.data.status}
              document
              icon={
                version.data.status === "IN_REVIEW" ? (
                  <Clock size={14} />
                ) : version.data.status === "APPROVED" ? (
                  <Check size={14} />
                ) : (
                  <X size={14} />
                )
              }
            />
          )
        }
      />
      {!readOnly && info.data?.candidateId && (
        <ReviewDocumentNavigation
          key={info.data.candidateId}
          candidateId={info.data.candidateId}
          documentId={documentId}
          currentTitle={info.data.title}
          currentDocument={version.data}
          expanded={
            documentListState?.candidateId === info.data.candidateId &&
            documentListState.expanded
          }
          onExpandedChange={(expanded) =>
            setDocumentListState({
              candidateId: info.data!.candidateId!,
              expanded,
            })
          }
          busy={activeNavigationState?.busy ?? false}
          onSelect={selectDocument}
        />
      )}
      {navigationMessage && (
        <p role="alert" className="mt-2 text-[13px] text-[var(--primary)]">
          {navigationMessage}
        </p>
      )}
      {historic && version.data && (
        <div
          role="status"
          className="mt-2 rounded-md border border-[var(--border)] bg-[var(--primary-soft)] p-2 text-xs"
        >
          <p className="font-semibold">
            Историческая версия {version.data.version}
            {currentVersion ? ` (текущая — ${currentVersion})` : ""}. Изменение
            реквизитов запрещено.
          </p>
          <p className="mt-1">
            Версия от {decidedAt ?? "дата неизвестна"} · статус: {viewedStatus}
            {version.data.rejectionReason
              ? ` · причина: ${version.data.rejectionReason}`
              : ""}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            disabled={!currentVersion}
            onClick={goToCurrent}
          >
            Перейти к актуальной версии
          </Button>
        </div>
      )}
      {!historic &&
      unknownVersionFallback &&
      !info.isLoading &&
      currentVersion ? (
        <p
          role="status"
          className="mt-2 rounded-md bg-[var(--muted)] px-2 py-1 text-xs"
        >
          Точная версия неизвестна (ссылка без версии) — показана текущая версия{" "}
          {currentVersion}.
        </p>
      ) : null}
      {info.data &&
        info.data.pendingDeliveryVersions.some(
          (v) => v !== info.data!.currentVersion,
        ) && (
          <label className="mt-3 flex items-center gap-2 text-[13px]">
            Версия документа
            <select
              className="rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[13px]"
              value={number}
              onChange={(event) => chooseVersion(Number(event.target.value))}
            >
              {[
                ...new Set([
                  info.data.currentVersion,
                  ...info.data.pendingDeliveryVersions,
                ]),
              ].map((v) => (
                <option key={v} value={v}>
                  {v}
                  {info.data!.pendingDeliveryVersions.includes(v)
                    ? " — требует отправки в ERP"
                    : " — текущая"}
                </option>
              ))}
            </select>
          </label>
        )}
      {(info.isLoading || version.isLoading) && (
        <p role="status" className="py-6">
          Загрузка документа…
        </p>
      )}
      {(info.isError || version.isError) && (
        <div role="alert" className="py-6">
          Не удалось загрузить документ.{" "}
          {urlVersion !== undefined && (
            <span>
              Запрошенная версия {urlVersion} недоступна (удалена или не
              существует).{" "}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void info.refetch();
              void version.refetch();
            }}
          >
            Повторить
          </Button>
        </div>
      )}
      {version.data && (
        <div className="mt-3 min-w-0">
          <DocumentReviewWorkspace
            key={`${version.data.documentId}-${version.data.version}`}
            candidateId={info.data?.candidateId ?? undefined}
            data={version.data}
            readOnly={readOnly || historic}
            allowAnnotation={
              !readOnly &&
              (!historic ||
                ["APPROVED", "SIGNED"].includes(version.data.status))
            }
            allowAnnotationClaim={!readOnly && !historic}
            onNavigationStateChange={
              readOnly ? undefined : onNavigationStateChange
            }
          />
        </div>
      )}
    </div>
  );
}
