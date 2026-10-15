import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  useListDocumentTypes,
  useListReviewDocuments,
  useGetDocumentInfo,
  useGetDocumentVersion,
  getGetDocumentVersionQueryKey,
  type DocumentDto,
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
import { Clock, Check, X, ChevronDown } from "lucide-react";
import { DocumentReviewWorkspace } from "../components/DocumentReviewWorkspace";
import { isHistoricVersion, parseVersionParam } from "../lib/audit-types";
import {
  candidateInitials,
  formatBirthDateRu,
  groupReviewItems,
  hasActiveReviewFilters,
  lkEmployeeUrl,
  parseReviewSearchParams,
  type ReviewCandidateGroup,
  type ReviewTab,
} from "../lib/review-groups";

const VERSION_STATUS_LABEL: Record<string, string> = {
  IN_REVIEW: "на проверке",
  APPROVED: "подтверждена",
  RETURNED: "возвращена",
};

const PAGE_LIMIT = 50;

const FILTER_CONTROL =
  "rounded-[6px] border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-[13px] text-[var(--foreground)]";

const TABS: { value: ReviewTab; label: string }[] = [
  { value: "IN_REVIEW", label: "Ожидают проверки" },
  { value: "RETURNED", label: "Возвращённые" },
  { value: "ERP_PENDING", label: "Требуют отправки в ERP" },
];

function LkLink({ code1c, children }: { code1c: string; children: ReactNode }) {
  const url = lkEmployeeUrl(code1c);
  if (!url) return <span>{children}</span>;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      title={`Профиль в ЛК: ${code1c}`}
      className="text-[var(--primary)] underline-offset-4 hover:underline"
    >
      {children}
    </a>
  );
}

function DebouncedTextFilter({
  label,
  placeholder,
  value,
  onCommit,
  type,
}: {
  label: string;
  placeholder?: string;
  value: string;
  onCommit: (next: string | undefined) => void;
  type?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  useEffect(() => {
    if (draft === value) return;
    const timer = window.setTimeout(() => {
      onCommit(draft.trim() || undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draft, onCommit, value]);
  return (
    <input
      aria-label={label}
      type={type ?? "search"}
      className={`${FILTER_CONTROL} min-w-[140px]`}
      placeholder={placeholder ?? label}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

function CandidateGroup({
  group,
  tab,
  collapsed,
  onToggle,
}: {
  group: ReviewCandidateGroup;
  tab: ReviewTab;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const candidate = group.candidate;
  const heading = candidate?.fullName?.trim() || "Без имени в профиле";
  const count = group.documents.length;
  return (
    <section
      aria-label={heading}
      className="overflow-hidden rounded-[10px] border border-[var(--border)]"
    >
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex w-full flex-wrap items-center gap-3 bg-[var(--muted)]/40 px-3 py-2.5 text-left hover:bg-[var(--muted)]/70"
      >
        <span
          aria-hidden
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--muted)] text-[13px] font-semibold text-[var(--foreground)]"
        >
          {candidateInitials(candidate?.fullName)}
        </span>
        <span className="min-w-[180px] flex-1">
          <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold">
            {heading}
            {candidate?.citizenship && (
              <Badge title="Гражданство">{candidate.citizenship.toUpperCase()}</Badge>
            )}
            {candidate?.isReemployment && <Badge tone="info">Повторное</Badge>}
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
            <span title="Дата рождения">
              {formatBirthDateRu(candidate?.birthDate)}
            </span>
            {(candidate?.positionName ?? candidate?.positionCode) && (
              <span title="Должность">
                {candidate.positionName ?? "—"}
                {candidate.positionCode ? ` (${candidate.positionCode})` : ""}
              </span>
            )}
            {(candidate?.projectName ?? candidate?.projectCode) && (
              <span title="Проект">
                {candidate.projectName ?? "—"}
                {candidate.projectCode ? ` (${candidate.projectCode})` : ""}
              </span>
            )}
          </span>
          <span className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[var(--muted-foreground)]">
            <span>
              Менеджер:{" "}
              {candidate?.managerCode1c ? (
                <LkLink code1c={candidate.managerCode1c}>
                  {candidate.managerName ?? candidate.managerCode1c}
                </LkLink>
              ) : (
                (candidate?.managerName ?? "—")
              )}
            </span>
            <span>
              Наставник:{" "}
              {candidate?.mentorCode1c ? (
                <LkLink code1c={candidate.mentorCode1c}>
                  {candidate.mentorName ?? candidate.mentorCode1c}
                  {candidate.mentorPosition ? ` · ${candidate.mentorPosition}` : ""}
                </LkLink>
              ) : (
                (candidate?.mentorName ?? "—")
              )}
            </span>
          </span>
        </span>
        <span className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          документов: {count}
          <ChevronDown
            size={16}
            aria-hidden
            className={collapsed ? "-rotate-90 transition-transform" : "transition-transform"}
          />
        </span>
      </button>
      {!collapsed && (
        <ul className="divide-y divide-[var(--border)]">
          {group.documents.map((doc: DocumentDto) => (
            <li
              key={doc.id}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="text-[13px] font-semibold">
                  {doc.title}
                  {doc.documentTypeCode && (
                    <span className="ml-2 font-normal text-[var(--muted-foreground)]">
                      {doc.documentTypeCode}
                    </span>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                  Версия {doc.currentVersion}
                  {doc.code1c
                    ? ` · Сотрудник ${doc.code1c}`
                    : doc.chatUuid
                      ? ` · Чат ${doc.chatUuid}`
                      : ""}
                </p>
                {tab === "ERP_PENDING" && (
                  <p className="mt-0.5 text-xs text-[var(--destructive)]">
                    Ожидают отправки версии: {doc.pendingDeliveryVersions.join(", ")}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge
                  status={doc.status}
                  document
                  icon={
                    doc.status === "IN_REVIEW" ? (
                      <Clock size={14} />
                    ) : doc.status === "APPROVED" ? (
                      <Check size={14} />
                    ) : (
                      <X size={14} />
                    )
                  }
                />
                <Link
                  to="/review/$documentId"
                  params={{ documentId: doc.id }}
                  search={{ version: doc.currentVersion }}
                  className="text-[13px] font-semibold text-[var(--primary)] underline-offset-4 hover:underline"
                >
                  Открыть →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ReviewPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const filters = useMemo(() => parseReviewSearchParams(rawSearch), [rawSearch]);

  // Functional search update: debounced text commits always apply on top
  // of the latest URL, so typing "иван" while toggling a select cannot
  // drop the other filter (stale-closure overwrite).
  const setFilters = useCallback(
    (patch: Record<string, string | undefined>, opts?: { keepCursor?: boolean }) => {
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
    (key: string) => (value: string | undefined) => setFilters({ [key]: value }),
    [setFilters],
  );

  const pickTab = (next: ReviewTab) => {
    if (next !== filters.status) setFilters({ status: next });
  };

  const resetFilters = () => {
    setFilters({
      q: undefined,
      documentTypeCode: undefined,
      citizenship: undefined,
      manager: undefined,
      mentor: undefined,
      hasMentor: undefined,
      birthDateFrom: undefined,
      birthDateTo: undefined,
      positionCode: undefined,
      projectCode: undefined,
    });
  };

  const queryParams = useMemo(
    () => ({
      status: filters.status,
      limit: PAGE_LIMIT,
      cursor: filters.cursor,
      q: filters.q,
      documentTypeCode: filters.documentTypeCode,
      citizenship: filters.citizenship,
      manager: filters.manager,
      mentor: filters.mentor,
      hasMentor: filters.hasMentor,
      birthDateFrom: filters.birthDateFrom,
      birthDateTo: filters.birthDateTo,
      positionCode: filters.positionCode,
      projectCode: filters.projectCode,
    }),
    [filters],
  );
  const list = useListReviewDocuments(queryParams);
  const docTypes = useListDocumentTypes();

  const groups = useMemo(() => groupReviewItems(list.data?.items ?? []), [list.data]);

  // Local accordion state only (never in the URL): everything expanded
  // by default, toggles survive refetches because keys are candidate-stable.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleGroup = useCallback((key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const filtersActive = hasActiveReviewFilters(filters);

  return (
    <div className="h-full overflow-auto p-7">
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
      <Card>
        <CardContent>
          <div
            role="search"
            aria-label="Фильтры очереди проверки"
            className="flex flex-wrap items-center gap-2 pb-4"
          >
            <DebouncedTextFilter
              label="Поиск по ФИО"
              placeholder="Поиск по ФИО…"
              value={filters.q ?? ""}
              onCommit={commit("q")}
            />
            <select
              aria-label="Тип документа"
              className={`${FILTER_CONTROL} max-w-[220px]`}
              value={filters.documentTypeCode ?? ""}
              onChange={(event) => commit("documentTypeCode")(event.target.value || undefined)}
            >
              <option value="">Все типы</option>
              {(docTypes.data?.items ?? []).map((type) => (
                <option key={type.code} value={type.code}>
                  {type.title} ({type.code})
                </option>
              ))}
            </select>
            <DebouncedTextFilter
              label="Гражданство"
              placeholder="Гражданство (ru)…"
              value={filters.citizenship ?? ""}
              onCommit={commit("citizenship")}
            />
            <DebouncedTextFilter
              label="Менеджер"
              placeholder="Менеджер…"
              value={filters.manager ?? ""}
              onCommit={commit("manager")}
            />
            <DebouncedTextFilter
              label="Наставник"
              placeholder="Наставник…"
              value={filters.mentor ?? ""}
              onCommit={commit("mentor")}
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
            <label className="flex items-center gap-1 text-[13px] text-[var(--muted-foreground)]">
              Рожд. с
              <input
                aria-label="Дата рождения с"
                type="date"
                className={FILTER_CONTROL}
                value={filters.birthDateFrom ?? ""}
                onChange={(event) => commit("birthDateFrom")(event.target.value || undefined)}
              />
            </label>
            <label className="flex items-center gap-1 text-[13px] text-[var(--muted-foreground)]">
              по
              <input
                aria-label="Дата рождения по"
                type="date"
                className={FILTER_CONTROL}
                value={filters.birthDateTo ?? ""}
                onChange={(event) => commit("birthDateTo")(event.target.value || undefined)}
              />
            </label>
            <DebouncedTextFilter
              label="Код должности"
              placeholder="Код должности…"
              value={filters.positionCode ?? ""}
              onCommit={commit("positionCode")}
            />
            <DebouncedTextFilter
              label="Код проекта"
              placeholder="Код проекта…"
              value={filters.projectCode ?? ""}
              onCommit={commit("projectCode")}
            />
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
                <CandidateGroup
                  key={group.key}
                  group={group}
                  tab={filters.status}
                  collapsed={Boolean(collapsed[group.key])}
                  onToggle={() => toggleGroup(group.key)}
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
                  setFilters({ cursor: list.data!.nextCursor ?? undefined }, { keepCursor: true })
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
                onClick={() => setFilters({ cursor: undefined }, { keepCursor: true })}
              >
                В начало списка
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
export function ReviewDocumentPage() {
  const { documentId } = useParams({ strict: false }) as { documentId: string };
  const navigate = useNavigate();
  // Versioned deep link from history: /review/$documentId?version=N.
  // useSearch (no route validateSearch change needed): invalid values fall
  // back to the current version with an explicit notice.
  const search = useSearch({ strict: false }) as { version?: unknown };
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
    },
  });
  const historic = isHistoricVersion(version.data?.version, currentVersion);
  const unknownVersionFallback = urlVersion === undefined;
  const chooseVersion = (next: number) => {
    setSelectedVersion(next);
    void navigate({
      to: "/review/$documentId",
      params: { documentId },
      search: { version: next },
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
            data={version.data}
            readOnly={historic}
            fitContainer
          />
        </div>
      )}
    </div>
  );
}
