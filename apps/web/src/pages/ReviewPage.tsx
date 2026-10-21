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
  useGetDocumentInfo,
  useGetDocumentVersion,
  getGetDocumentVersionQueryKey,
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
import { Clock, Check, X, ChevronRight } from "lucide-react";
import { DocumentReviewWorkspace } from "../components/DocumentReviewWorkspace";
import {
  SearchSelect,
  type SearchSelectOption,
} from "../components/SearchSelect";
import { CandidateDrawer } from "../components/CandidateDrawer";
import { LkLink } from "../components/LkLink";
import { isHistoricVersion, parseVersionParam } from "../lib/audit-types";
import {
  candidateInitials,
  documentProgressPercent,
  formatBirthDateRu,
  formatCandidateObject,
  formatDocumentProgress,
  hasActiveReviewFilters,
  parseReviewSearchParams,
  type ReviewTab,
} from "../lib/review-groups";

const VERSION_STATUS_LABEL: Record<string, string> = {
  IN_REVIEW: "на проверке",
  APPROVED: "подтверждена",
  RETURNED: "возвращена",
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

/**
 * One queue row: candidate profile summary. Clicking opens the candidate
 * drawer (profile + all documents); there is no inline expansion.
 */
function CandidateRow({
  group,
  onOpen,
  returnedHistory = false,
}: {
  group: CandidateDetailsDto;
  onOpen: () => void;
  returnedHistory?: boolean;
}) {
  const candidate = group.candidate;
  const heading = candidate?.fullName?.trim() || "Без имени в профиле";
  const count = returnedHistory
    ? group.documents.reduce(
        (sum, doc) => sum + (doc.returnedVersions?.length ?? 0),
        0,
      )
    : group.documents.length;
  const progressPercent = candidate
    ? documentProgressPercent(
        candidate.approvedDocuments,
        candidate.requiredDocuments,
      )
    : null;
  return (
    <section
      aria-label={heading}
      className="overflow-hidden rounded-[10px] border border-[var(--border)]"
    >
      <div className="relative flex w-full flex-wrap items-center gap-3 bg-[var(--muted)] px-3 py-2.5">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-label={`Открыть документы: ${heading}`}
          onClick={onOpen}
          className="absolute inset-0 rounded-[10px] hover:bg-[var(--border)]/30 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--primary)]"
        />
        <span
          aria-hidden
          className="pointer-events-none relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--avatar)] text-[13px] font-semibold text-[var(--foreground)]"
        >
          {candidateInitials(candidate?.fullName)}
        </span>
        <span className="pointer-events-none relative min-w-0 flex-1 basis-[180px]">
          <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
            {heading}
            {candidate?.citizenship && (
              <Badge title="Гражданство">
                {candidate.citizenship.toUpperCase()}
              </Badge>
            )}
            {candidate?.isReemployment === true && (
              <Badge tone="warning">Повторный найм</Badge>
            )}
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
            <span title="Дата рождения">
              {formatBirthDateRu(candidate?.birthDate)}
            </span>
            {candidate?.positionName && (
              <span title="Должность">{candidate.positionName}</span>
            )}
            <span title="Объект">
              {formatCandidateObject(
                candidate?.projectName,
                candidate?.projectCode,
              )}
            </span>
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
            <span>
              Менеджер:{" "}
              {candidate?.managerCode1c ? (
                <span className="pointer-events-auto">
                  <LkLink code1c={candidate.managerCode1c}>
                    {candidate.managerName ?? candidate.managerCode1c}
                  </LkLink>
                </span>
              ) : (
                (candidate?.managerName ?? "—")
              )}
            </span>
            <span>
              Наставник:{" "}
              {candidate?.mentorCode1c ? (
                <span className="pointer-events-auto">
                  <LkLink code1c={candidate.mentorCode1c}>
                    {candidate.mentorName ?? candidate.mentorCode1c}
                    {candidate.mentorPosition
                      ? ` · ${candidate.mentorPosition}`
                      : ""}
                  </LkLink>
                </span>
              ) : (
                (candidate?.mentorName ?? "—")
              )}
            </span>
          </span>
          {candidate && (
            <span className="mt-1 flex flex-wrap items-center gap-2">
              <Badge>
                {formatDocumentProgress(
                  candidate.approvedDocuments,
                  candidate.requiredDocuments,
                )}
              </Badge>
              {progressPercent !== null && (
                <span
                  role="progressbar"
                  aria-label="Прогресс подтверждения документов"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPercent}
                  className="h-1 w-24 overflow-hidden rounded-full bg-[var(--muted)]"
                >
                  <span
                    aria-hidden
                    className="block h-full rounded-full bg-[var(--primary)]"
                    style={{ width: `${progressPercent}%` }}
                  />
                </span>
              )}
            </span>
          )}
        </span>
        <span className="pointer-events-none relative flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          {returnedHistory ? "возвратов" : "документов"}: {count}
          <ChevronRight size={16} aria-hidden />
        </span>
      </div>
    </section>
  );
}

export function ReviewPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const filters = useMemo(
    () => parseReviewSearchParams(rawSearch),
    [rawSearch],
  );

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
        to: "/review",
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
    [navigate],
  );

  const commit = useCallback(
    (key: string) => (value: string | undefined) =>
      setFilters({ [key]: value }),
    [setFilters],
  );

  const pickTab = (next: ReviewTab) => {
    if (next !== filters.status) setFilters({ status: next });
  };

  const resetFilters = () => {
    setFilters({
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
        to: "/review",
        search: (prev: Record<string, unknown>) => ({ ...prev, candidate: id }),
      });
    },
    [navigate],
  );

  const closeCandidate = useCallback(() => {
    void navigate({
      to: "/review",
      replace: true,
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev };
        delete next.candidate;
        return next;
      },
    });
  }, [navigate]);

  // Async selector sources: candidates (ФИО) and the LK position directory.
  const [candidateQuery, setCandidateQuery] = useState("");
  const [positionQuery, setPositionQuery] = useState("");
  const candidateParams = useMemo(
    () => ({
      q: candidateQuery.trim() || undefined,
      limit: CANDIDATE_SELECTOR_LIMIT,
    }),
    [candidateQuery],
  );
  const positionParams = useMemo(
    () => ({
      q: positionQuery.trim() || undefined,
      limit: POSITION_SELECTOR_LIMIT,
    }),
    [positionQuery],
  );
  const candidates = useListReviewCandidates(candidateParams);
  const positions = useListPositions(positionParams);
  const facets = useGetReviewDocumentFacets();
  const docTypesParams = useMemo(() => ({ catalogOnly: true as const }), []);
  const docTypes = useListDocumentTypes(docTypesParams);

  const queryParams = useMemo(
    () => ({
      status: filters.status,
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
    [filters],
  );
  const list = useListCandidateReviewQueue(queryParams);

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

  return (
    <div className="h-full overflow-auto p-3 sm:p-7">
      <PageHeader
        title="Проверка документов"
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
      <Card>
        <CardContent>
          <div
            role="search"
            aria-label="Фильтры очереди проверки"
            className="flex flex-wrap items-center gap-2 pb-4"
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
                filters.hasMentor === undefined ? "" : String(filters.hasMentor)
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
                type="date"
                className={FILTER_CONTROL}
                value={filters.birthDateFrom ?? ""}
                onChange={(event) =>
                  commit("birthDateFrom")(event.target.value || undefined)
                }
              />
            </label>
            <label className="flex items-center gap-1 text-[13px] text-[var(--muted-foreground)]">
              по
              <input
                aria-label="Дата рождения по"
                type="date"
                className={FILTER_CONTROL}
                value={filters.birthDateTo ?? ""}
                onChange={(event) =>
                  commit("birthDateTo")(event.target.value || undefined)
                }
              />
            </label>
            {filtersActive && (
              <Button size="sm" variant="ghost" onClick={resetFilters}>
                Сбросить
              </Button>
            )}
          </div>
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
            <div className="flex flex-col gap-3">
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
        </CardContent>
      </Card>
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
export function ReviewDocumentPage() {
  const { documentId } = useParams({ strict: false }) as { documentId: string };
  const navigate = useNavigate();
  // Versioned deep link from history: /review/$documentId?version=N.
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
  const currentVersion = info.data?.currentVersion;
  const number =
    selectedVersion ??
    urlVersion ??
    (info.data?.status === "IN_REVIEW"
      ? info.data.currentVersion
      : (info.data?.pendingDeliveryVersions[0] ??
        info.data?.currentVersion ??
        0));
  const version = useGetDocumentVersion(documentId, number, {
    query: {
      queryKey: getGetDocumentVersionQueryKey(documentId, number),
      enabled: !!number,
      refetchInterval: (query) =>
        ["QUEUED", "RUNNING"].includes(query.state.data?.job?.status ?? "")
          ? 3000
          : false,
    },
  });
  const historic = isHistoricVersion(version.data?.version, currentVersion);
  const unknownVersionFallback = urlVersion === undefined;
  const chooseVersion = (next: number) => {
    setSelectedVersion(next);
    void navigate({
      to: "/review/$documentId",
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
    ? new Date(version.data.approvedAt).toLocaleString("ru-RU")
    : null;
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-3 sm:p-4 lg:overflow-hidden">
      <Link
        to="/review"
        search={{ ...parseReviewSearchParams(search) }}
        className="mb-2 inline-block text-[13px] text-[var(--muted-foreground)] underline underline-offset-4 hover:text-[var(--foreground)]"
      >
        ← Очередь проверки
      </Link>
      <PageHeader
        title={info.data?.title ?? "Проверка документа"}
        subtitle={
          info.data?.code1c
            ? `Сотрудник ${info.data.code1c} · Версия ${number}`
            : `Чат ${info.data?.chatUuid ?? ""} · Версия ${number || "—"}`
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
            запрещено.
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
        <div className="mt-3 min-h-0 lg:flex-1">
          <DocumentReviewWorkspace
            candidateId={info.data?.candidateId ?? undefined}
            data={version.data}
            readOnly={historic}
            fitContainer
          />
        </div>
      )}
    </div>
  );
}
