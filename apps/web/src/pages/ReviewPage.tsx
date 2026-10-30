import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  useGetReviewDocumentFacets,
  useListDocumentTypes,
  useListPositions,
  useListReviewCandidates,
  useListCandidateReviewQueue,
  type CandidateDetailsDto,
  type ReviewStageProgressDto,
  useGetDocumentInfo,
  useGetMe,
  getListReviewCandidatesQueryKey,
  getGetReviewDocumentFacetsQueryKey,
  getListCandidateReviewQueueQueryKey,
} from "@edo/api-client";
import {
  PageHeader,
  Card,
  CardContent,
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
  FileText,
  AlertTriangle,
} from "lucide-react";
import { DocumentReviewWorkspace } from "../components/DocumentReviewWorkspace";
import { useLiveDocumentVersion } from "../lib/use-live-document-version";
import {
  SearchSelect,
  type SearchSelectOption,
} from "../components/SearchSelect";
import { CandidateDrawer } from "../components/CandidateDrawer";
import { LkLink } from "../components/LkLink";
import { isHistoricVersion, parseVersionParam } from "../lib/audit-types";
import {
  formatDateTimeRu,
  formatDateRu,
  maskDateRuInput,
  parseDateRu,
} from "../lib/date-format";
import {
  candidateInitials,
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

const FILTER_CONTROL =
  "rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[13px] text-[var(--foreground)]";

const TABS: { value: ReviewTab; label: string }[] = [
  { value: "IN_REVIEW", label: "Ожидают проверки" },
  { value: "RETURNED", label: "Возвращённые" },
  { value: "ERP_PENDING", label: "Требуют отправки в ERP" },
];

/**
 * Search selector over a static (facet/directory) option list: the dropdown
 * search text filters the already loaded options client-side.
 */
function StaticSearchSelect({
  label,
  placeholder,
  value,
  selectedLabel,
  allOptions,
  onChange,
  className,
  isLoading,
  isError,
  onRetry,
}: {
  label: string;
  placeholder?: string;
  value?: string | null;
  selectedLabel?: string;
  allOptions: SearchSelectOption[];
  onChange: (next: string | undefined) => void;
  className?: string;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allOptions;
    return allOptions.filter((option) =>
      option.label.toLowerCase().includes(needle),
    );
  }, [allOptions, query]);
  return (
    <SearchSelect
      label={label}
      placeholder={placeholder}
      value={value}
      selectedLabel={selectedLabel}
      options={options}
      onSearchChange={setQuery}
      onChange={onChange}
      className={className}
      isLoading={isLoading}
      isError={isError}
      onRetry={onRetry}
    />
  );
}

function StageRing({
  progress,
  onOpen,
}: {
  progress: ReviewStageProgressDto;
  onOpen: () => void;
}) {
  const label =
    progress.stage === null ? "Дополнительные" : `Этап ${progress.stage}`;
  const describe = (
    title: string,
    counts: ReviewStageProgressDto["required"],
  ) =>
    `${title}: подтверждено ${counts.approved}, ожидают проверки: ${counts.pending}, обрабатываются ${counts.processing}, не загружено ${counts.missing}, требуют внимания ${counts.attention}`;
  const description = `${label}. ${describe("Обязательные", progress.required)}. ${describe("Дополнительные", progress.additional)}`;
  const total = (counts: ReviewStageProgressDto["required"]) =>
    counts.approved +
    counts.pending +
    counts.processing +
    counts.missing +
    counts.attention;
  const pending = progress.required.pending + progress.additional.pending;
  const attention = progress.required.attention + progress.additional.attention;
  const processing =
    progress.required.processing + progress.additional.processing;
  const missing = progress.required.missing + progress.additional.missing;
  const color = pending
    ? "var(--warning)"
    : attention
      ? "var(--danger)"
      : processing
        ? "var(--info)"
        : missing
          ? "var(--muted-foreground)"
          : "var(--success)";
  const arc = (counts: ReviewStageProgressDto["required"], radius: number) => {
    const sum = total(counts);
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    return (
      [
        ["approved", "var(--success)"],
        ["pending", "var(--warning)"],
        ["processing", "var(--info)"],
        ["attention", "var(--danger)"],
        ["missing", "var(--border)"],
      ] as const
    ).map(([key, stroke]) => {
      const length = sum ? (circumference * counts[key]) / sum : 0;
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
  return (
    <div
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      role="button"
      className="group pointer-events-auto relative flex w-24 shrink-0 flex-col items-center gap-1 rounded text-center text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
      title={description}
      aria-label={description}
    >
      <span className="relative flex h-16 w-16 items-center justify-center">
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
          {pending ? <AlertTriangle size={19} /> : <FileText size={19} />}
        </span>
      </span>
      <strong>{label}</strong>
      <span className="text-[var(--muted-foreground)]">
        {progress.required.approved + progress.additional.approved}/
        {total(progress.required) + total(progress.additional)}
      </span>
      <span
        aria-hidden="true"
        className="absolute bottom-full right-0 z-20 mb-2 hidden w-64 rounded-md border border-[var(--border)] bg-[var(--card)] p-3 text-left text-xs text-[var(--foreground)] shadow-lg group-hover:block group-focus:block"
      >
        <span className="block font-semibold">{label}</span>
        <span className="mt-1 block">
          {describe("Обязательные", progress.required)}
        </span>
        <span className="mt-1 block">
          {describe("Дополнительные", progress.additional)}
        </span>
      </span>
    </div>
  );
}

function CandidateRow({
  group,
  onOpen,
}: {
  group: CandidateDetailsDto;
  onOpen: () => void;
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
        aria-haspopup="dialog"
        aria-label={`Открыть документы: ${heading}`}
        onClick={onOpen}
        className="absolute inset-0 rounded-[10px] hover:bg-[var(--border)]/30 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--primary)]"
      />
      <div className="pointer-events-none relative flex flex-wrap items-center gap-4">
        <span
          aria-hidden
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[var(--avatar)] font-semibold"
        >
          {candidateInitials(candidate?.fullName)}
        </span>
        <div className="min-w-[240px] flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-2 font-semibold">
            {heading}
            {candidate?.citizenship && (
              <Badge title="Гражданство">
                {candidate.citizenship.toUpperCase()}
              </Badge>
            )}
            {candidate?.isReemployment && (
              <Badge tone="warning">Повторный найм</Badge>
            )}
          </div>
          <div className="grid gap-2 md:grid-cols-3">
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
                  className="flex min-w-0 items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1"
                >
                  <I
                    size={19}
                    className="shrink-0 text-[var(--muted-foreground)]"
                  />
                  <span className="min-w-0 text-sm">
                    <span className="block text-xs text-[var(--muted-foreground)]">
                      {label as string}
                    </span>
                    {value as string}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-xs">
            <span className="flex items-center gap-2">
              <UserRound size={18} className="text-[var(--primary)]" />
              <span>
                <span className="block text-[var(--muted-foreground)]">
                  Менеджер
                </span>
                {person(candidate?.managerName, candidate?.managerCode1c)}
              </span>
            </span>
            <span className="flex items-center gap-2">
              <GraduationCap
                size={18}
                className="text-[var(--muted-foreground)]"
              />
              <span>
                <span className="block text-[var(--muted-foreground)]">
                  Наставник
                </span>
                {person(candidate?.mentorName, candidate?.mentorCode1c)}
              </span>
            </span>
          </div>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2 border-l border-[var(--border)] pl-3">
          {candidate?.stageProgress ? (
            candidate.stageProgress.map((progress) => (
              <StageRing
                key={progress.stage ?? "additional"}
                progress={progress}
                onOpen={onOpen}
              />
            ))
          ) : (
            <span className="w-24 text-center text-xs text-[var(--muted-foreground)]">
              Этапы неизвестны
            </span>
          )}
          <span className="pointer-events-auto flex w-20 flex-col items-center gap-1 text-xs">
            <span className="flex h-14 w-14 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--background)] text-[var(--muted-foreground)]">
              <FileSignature size={22} />
            </span>
            <strong>Договор</strong>
            <span>—</span>
          </span>
          <ChevronRight size={18} className="text-[var(--muted-foreground)]" />
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
  const permissions = profile.data?.permissions ?? {};
  const canReview = [reviewGroup === "IG" ? "20011" : "20002", "20009"].some(
    (rule) => Object.prototype.hasOwnProperty.call(permissions, rule),
  );
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const filters = useMemo(
    () => parseReviewSearchParams(rawSearch),
    [rawSearch],
  );
  const [birthDateFromText, setBirthDateFromText] = useState(
    filters.birthDateFrom ? formatDateRu(filters.birthDateFrom) : "",
  );
  const [birthDateToText, setBirthDateToText] = useState(
    filters.birthDateTo ? formatDateRu(filters.birthDateTo) : "",
  );
  useEffect(() => {
    setBirthDateFromText(
      filters.birthDateFrom ? formatDateRu(filters.birthDateFrom) : "",
    );
    setBirthDateToText(
      filters.birthDateTo ? formatDateRu(filters.birthDateTo) : "",
    );
  }, [filters.birthDateFrom, filters.birthDateTo]);

  // Functional search update: selector commits always apply on top of the
  // latest URL, so concurrent changes cannot drop each other (stale-closure
  // overwrite). Every filter change resets pagination (cursor); opening the
  // drawer keeps it.
  const setFilters = useCallback(
    (
      patch: Record<string, string | undefined>,
      opts?: { keepCursor?: boolean },
    ) => {
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
      managerName: undefined,
      managerUnassigned: undefined,
      candidateId: undefined,
      documentTypeCode: undefined,
      citizenship: undefined,
      managerCode1c: undefined,
      mentorCode1c: undefined,
      hasMentor: undefined,
      birthDateFrom: undefined,
      birthDateTo: undefined,
      positionCode: undefined,
      projectCode: undefined,
      candidate: undefined,
      q: undefined,
      manager: undefined,
      mentor: undefined,
    });
  };

  const openCandidate = useCallback(
    (id: string) => {
      void navigate({
        to: base,
        search: (prev: Record<string, unknown>) => ({ ...prev, candidate: id }),
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
    { reviewGroup },
    {
      query: {
        queryKey: getGetReviewDocumentFacetsQueryKey({ reviewGroup }),
        enabled: canReview,
      },
    },
  );
  const docTypesParams = useMemo(() => ({ catalogOnly: true as const }), []);
  const docTypes = useListDocumentTypes(docTypesParams);

  const queryParams = useMemo(
    () => ({
      reviewGroup,
      status: filters.status,
      currentStatus: filters.currentStatus,
      managerName: filters.managerName,
      managerUnassigned: filters.managerUnassigned,
      limit: PAGE_LIMIT,
      cursor: filters.cursor,
      candidateId: filters.candidateId,
      documentTypeCode: filters.documentTypeCode,
      citizenship: filters.citizenship,
      managerCode1c: filters.managerCode1c,
      mentorCode1c: filters.mentorCode1c,
      hasMentor: filters.hasMentor,
      birthDateFrom: filters.birthDateFrom,
      birthDateTo: filters.birthDateTo,
      positionCode: filters.positionCode,
      projectCode: filters.projectCode,
    }),
    [filters, reviewGroup],
  );
  const list = useListCandidateReviewQueue(queryParams, {
    query: {
      queryKey: getListCandidateReviewQueueQueryKey(queryParams),
      enabled: canReview,
    },
  });

  const groups = list.data?.items ?? [];

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
      (facets.data?.managers ?? []).flatMap((person) =>
        person.code1c ? [{ value: person.code1c, label: person.name }] : [],
      ),
    [facets.data],
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

  // Labels for values set via deep links when the current option window does
  // not contain them yet (filtered candidate/position lists).
  const candidateLabel = groups
    .find((group) => group.candidate?.id === filters.candidateId)
    ?.candidate?.fullName?.trim();
  const managerLabel = facets.data?.managers.find(
    (person) => person.code1c === filters.managerCode1c,
  )?.name;
  const mentorLabel = facets.data?.mentors.find(
    (person) => person.code1c === filters.mentorCode1c,
  )?.name;
  const positionLabel =
    positions.data?.items.find((item) => item.code === filters.positionCode)
      ?.name ??
    groups.find(
      (group) => group.candidate?.positionCode === filters.positionCode,
    )?.candidate?.positionName ??
    undefined;
  const projectLabel = facets.data?.projects.find(
    (project) => project.code === filters.projectCode,
  )?.name;
  const docType = docTypes.data?.items.find(
    (type) => type.code === filters.documentTypeCode,
  );
  const docTypeLabel = docType?.title;

  const drawerGroup = groups.find(
    (group) => group.candidate.id === filters.candidate,
  );
  const drawerCandidateId = filters.candidate ?? null;

  const filtersActive = hasActiveReviewFilters(filters);

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
        title={`Проверка документов ${reviewGroup === "IG" ? "ИГ" : "РУ"}`}
        subtitle="Документы кандидатов и сотрудников"
      />
      <div className="my-4 flex flex-wrap gap-2">
        {TABS.map((tab) => (
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
          <Card>
            <CardContent>
              <div
                role="search"
                aria-label="Фильтры очереди проверки"
                className="grid grid-cols-1 items-center gap-2 pb-4 sm:grid-cols-2 lg:grid-cols-4"
              >
                <SearchSelect
                  label="ФИО кандидата"
                  placeholder="ФИО кандидата…"
                  value={filters.candidateId}
                  selectedLabel={candidateLabel}
                  options={candidateOptions}
                  onSearchChange={setCandidateQuery}
                  onChange={commit("candidateId")}
                  isLoading={candidates.isLoading}
                  isError={candidates.isError}
                  onRetry={() => void candidates.refetch()}
                  className="min-w-[180px]"
                />
                <StaticSearchSelect
                  label="Тип документа"
                  placeholder="Все типы"
                  value={filters.documentTypeCode}
                  selectedLabel={docTypeLabel}
                  allOptions={docTypeOptions}
                  onChange={commit("documentTypeCode")}
                  className="min-w-[180px]"
                  isLoading={docTypes.isLoading}
                  isError={docTypes.isError}
                  onRetry={() => void docTypes.refetch()}
                />
                <StaticSearchSelect
                  label="Гражданство"
                  placeholder="Все гражданства"
                  value={filters.citizenship}
                  allOptions={citizenshipOptions}
                  isLoading={facets.isLoading}
                  isError={facets.isError}
                  onRetry={() => void facets.refetch()}
                  onChange={commit("citizenship")}
                  className="min-w-[140px]"
                />
                <StaticSearchSelect
                  label="Менеджер"
                  placeholder="Все менеджеры"
                  value={filters.managerCode1c}
                  selectedLabel={managerLabel}
                  allOptions={managerOptions}
                  isLoading={facets.isLoading}
                  isError={facets.isError}
                  onRetry={() => void facets.refetch()}
                  onChange={commit("managerCode1c")}
                  className="min-w-[160px]"
                />
                <StaticSearchSelect
                  label="Наставник"
                  placeholder="Все наставники"
                  value={filters.mentorCode1c}
                  selectedLabel={mentorLabel}
                  allOptions={mentorOptions}
                  isLoading={facets.isLoading}
                  isError={facets.isError}
                  onRetry={() => void facets.refetch()}
                  onChange={commit("mentorCode1c")}
                  className="min-w-[160px]"
                />
                <select
                  aria-label="Наличие наставника"
                  className={FILTER_CONTROL}
                  value={
                    filters.hasMentor === undefined
                      ? ""
                      : String(filters.hasMentor)
                  }
                  onChange={(event) =>
                    setFilters({ hasMentor: event.target.value || undefined })
                  }
                >
                  <option value="">Все (наставник)</option>
                  <option value="true">Только с наставником</option>
                  <option value="false">Только без наставника</option>
                </select>
                <SearchSelect
                  label="Должность"
                  placeholder="Все должности"
                  value={filters.positionCode}
                  selectedLabel={positionLabel}
                  options={positionOptions}
                  onSearchChange={setPositionQuery}
                  onChange={commit("positionCode")}
                  isLoading={positions.isLoading}
                  isError={positions.isError}
                  onRetry={() => void positions.refetch()}
                  className="min-w-[160px]"
                />
                <StaticSearchSelect
                  label="Объект"
                  placeholder="Все объекты"
                  value={filters.projectCode}
                  selectedLabel={projectLabel}
                  allOptions={projectOptions}
                  isLoading={facets.isLoading}
                  isError={facets.isError}
                  onRetry={() => void facets.refetch()}
                  onChange={commit("projectCode")}
                  className="min-w-[160px]"
                />
                <label className="flex items-center gap-1 text-[13px] text-[var(--muted-foreground)]">
                  Рожд. с
                  <input
                    aria-label="Дата рождения с"
                    type="text"
                    inputMode="numeric"
                    placeholder="dd.mm.yyyy"
                    className={FILTER_CONTROL}
                    value={birthDateFromText}
                    onChange={(event) => {
                      const value = maskDateRuInput(event.target.value);
                      setBirthDateFromText(value);
                      if (!value) commit("birthDateFrom")(undefined);
                      else {
                        const parsed = parseDateRu(value);
                        if (parsed) commit("birthDateFrom")(parsed);
                      }
                    }}
                    onBlur={() =>
                      setBirthDateFromText(
                        filters.birthDateFrom
                          ? formatDateRu(filters.birthDateFrom)
                          : "",
                      )
                    }
                  />
                </label>
                <label className="flex items-center gap-1 text-[13px] text-[var(--muted-foreground)]">
                  по
                  <input
                    aria-label="Дата рождения по"
                    type="text"
                    inputMode="numeric"
                    placeholder="dd.mm.yyyy"
                    className={FILTER_CONTROL}
                    value={birthDateToText}
                    onChange={(event) => {
                      const value = maskDateRuInput(event.target.value);
                      setBirthDateToText(value);
                      if (!value) commit("birthDateTo")(undefined);
                      else {
                        const parsed = parseDateRu(value);
                        if (parsed) commit("birthDateTo")(parsed);
                      }
                    }}
                    onBlur={() =>
                      setBirthDateToText(
                        filters.birthDateTo
                          ? formatDateRu(filters.birthDateTo)
                          : "",
                      )
                    }
                  />
                </label>
                {filtersActive && (
                  <Button size="sm" variant="ghost" onClick={resetFilters}>
                    Сбросить
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
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
                  <Button size="sm" variant="outline" onClick={resetFilters}>
                    Сбросить фильтры
                  </Button>
                ) : undefined
              }
            />
          )}
          {groups.length > 0 && (
            <div className="mt-2 flex flex-col gap-2">
              {groups.map((group) => (
                <CandidateRow
                  key={group.candidate.id}
                  group={group}
                  returnedHistory={filters.status === "RETURNED"}
                  onOpen={() => openCandidate(group.candidate.id)}
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
      {drawerCandidateId && (
        <CandidateDrawer
          key={drawerCandidateId}
          candidateId={drawerCandidateId}
          profile={drawerGroup?.candidate ?? null}
          returnedHistory={filters.status === "RETURNED"}
          onClose={closeCandidate}
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
  const historic = isHistoricVersion(version.data?.version, currentVersion);
  const unknownVersionFallback = urlVersion === undefined;
  const chooseVersion = (next: number) => {
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
        search={{ ...parseReviewSearchParams(search) }}
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
          />
        </div>
      )}
    </div>
  );
}
