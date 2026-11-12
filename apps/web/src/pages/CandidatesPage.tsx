import { FilterBar } from "@edo/ui";
import { filterValues } from "../lib/filter-values";
import { useVisibleRuDocumentSync } from "../lib/use-visible-ru-document-sync";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  useGetMe,
  useListCandidateManagers,
  useListCandidateProjects,
  useListCandidateStatuses,
  useListCatalogMentors,
  useListCommunicationCandidates,
  useListPositions,
} from "@edo/api-client";
import { Button, EmptyState, PageHeader } from "@edo/ui";
import { CANDIDATE_CONTROL } from "../components/CandidateForm";
import { CreateCandidate } from "../components/CreateCandidate";
import { CandidateAvatar } from "../components/CandidateAvatar";
import { findCurrentUserAsManager } from "../lib/manager-default";
import { buildGroupedCandidateStatusOptions } from "../lib/candidate-status-groups";
import { hasAccessRule } from "../lib/audit-types";
import { formatDocumentProgress } from "../lib/review-groups";

export function CandidatesPage() {
  const me = useGetMe();
  const allowed =
    hasAccessRule(me.data, 20002) || hasAccessRule(me.data, 20009);
  if (!allowed)
    return (
      <div className="p-4">
        <EmptyState
          title={me.isLoading ? "Загрузка прав…" : "Нет доступа"}
          description="Каталог доступен сотрудникам направления Россия."
        />
      </div>
    );
  return <CandidateCatalog />;
}

function CandidateCatalog() {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const [create, setCreate] = useState(false);
  const [query, setQuery] = useState(
    typeof search.q === "string" ? search.q : "",
  );
  const [managerQuery, setManagerQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [positionQuery, setPositionQuery] = useState("");
  const commit = (patch: Record<string, unknown>) =>
    void navigate({
      to: "/candidates",
      search: (previous: Record<string, unknown>) => ({
        ...previous,
        ...patch,
        cursor: undefined,
      }),
    });
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim() !== (search.q ?? ""))
        commit({ q: query.trim() || undefined });
    }, 300);
    return () => clearTimeout(timer);
  }, [query, search.q]);
  useEffect(
    () => setQuery(typeof search.q === "string" ? search.q : ""),
    [search.q],
  );
  const value = (key: string) =>
    typeof search[key] === "string" ? (search[key] as string) : undefined;
  const me = useGetMe();
  const managers = useListCandidateManagers({ q: managerQuery || undefined });
  const defaultManagers = useListCandidateManagers();
  const myManager = useMemo(
    () => findCurrentUserAsManager(defaultManagers.data?.items, me.data),
    [defaultManagers.data, me.data],
  );
  const rawManagerId = value("managerId");
  const isAllManagers =
    rawManagerId === "all" || search.managerKeys !== undefined;
  const effectiveManagerId = isAllManagers
    ? undefined
    : (rawManagerId ?? myManager?.id);
  const params = {
    q: value("q"),
    statusId: value("statusId"),
    statusIds:
      search.statusIds === undefined
        ? undefined
        : filterValues(search, "statusIds"),
    managerKeys:
      search.managerKeys === undefined
        ? undefined
        : filterValues(search, "managerKeys"),
    positionCodes:
      search.positionCodes === undefined
        ? undefined
        : filterValues(search, "positionCodes"),
    projectCodes:
      search.projectCodes === undefined
        ? undefined
        : filterValues(search, "projectCodes"),
    mentorCodes1c:
      search.mentorCodes1c === undefined
        ? undefined
        : filterValues(search, "mentorCodes1c"),
    managerId: effectiveManagerId,
    projectCode: value("projectCode"),
    positionCode: value("positionCode"),
    mentorCode1c: value("mentorCode1c"),
    cursor: value("cursor"),
    limit: 50,
  };
  const candidates = useListCommunicationCandidates(params);
  const documentSync = useVisibleRuDocumentSync(
    candidates.data?.items.map((c) => c.id) ?? [],
    !!candidates.data,
    () => candidates.refetch(),
  );
  const statuses = useListCandidateStatuses();
  const projects = useListCandidateProjects({ q: projectQuery || undefined });
  const positions = useListPositions({
    q: positionQuery || undefined,
    limit: 100,
  });
  const mentors = useListCatalogMentors();
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-3 sm:p-6">
      <PageHeader
        className="flex-col items-stretch gap-3 sm:flex-row sm:items-center"
        title="Кандидаты · Россия"
        subtitle="Подбор, данные и документы кандидатов"
        actions={
          <Button onClick={() => setCreate(true)} disabled={create}>
            Создать кандидата
          </Button>
        }
      />
      <Link
        to="/review"
        className="text-sm text-[var(--primary)] underline underline-offset-4"
      >
        Кандидаты РУ
      </Link>
      {create && <CreateCandidate onCancel={() => setCreate(false)} />}
      <FilterBar
        label="Фильтры кандидатов"
        active={Boolean(query)}
        onReset={() => {
          setQuery("");
          commit({
            q: undefined,
            statusId: undefined,
            statusIds: undefined,
            managerId: "all",
            managerKeys: [],
            positionCode: undefined,
            positionCodes: undefined,
            projectCode: undefined,
            projectCodes: undefined,
            mentorCode1c: undefined,
            mentorCodes1c: undefined,
          });
        }}
        filters={[
          {
            label: "Статус кандидата",
            placeholder: "Все статусы",
            value: filterValues(search, "statusIds", "statusId"),
            options: buildGroupedCandidateStatusOptions(
              statuses.data?.items ?? [],
            ),
            onChange: (values) =>
              commit({ statusIds: values, statusId: undefined }),
            isLoading: statuses.isLoading,
            isError: statuses.isError,
            onRetry: () => void statuses.refetch(),
          },
          {
            label: "Должность кандидата",
            placeholder: "Все должности",
            value: filterValues(search, "positionCodes", "positionCode"),
            options: (positions.data?.items ?? []).map((item) => ({
              value: item.code,
              label: item.name,
            })),
            onSearchChange: setPositionQuery,
            onChange: (values) =>
              commit({ positionCodes: values, positionCode: undefined }),
            isLoading: positions.isLoading,
            isError: positions.isError,
            onRetry: () => void positions.refetch(),
          },
          {
            label: "Менеджер кандидата",
            placeholder: "Все менеджеры",
            value:
              search.managerKeys !== undefined
                ? filterValues(search, "managerKeys")
                : effectiveManagerId
                  ? [`id:${effectiveManagerId}`]
                  : [],
            options: (managers.data?.items ?? []).map((item) => ({
              value: `id:${item.id}`,
              label: item.name,
            })),
            selectedLabels: Object.fromEntries(
              (defaultManagers.data?.items ?? []).map((item) => [
                `id:${item.id}`,
                item.name,
              ]),
            ),
            onSearchChange: setManagerQuery,
            onChange: (values) =>
              commit({ managerKeys: values, managerId: "all" }),
            isLoading: managers.isLoading,
            isError: managers.isError,
            onRetry: () => void managers.refetch(),
          },
          {
            label: "Объект кандидата",
            placeholder: "Все объекты",
            value: filterValues(search, "projectCodes", "projectCode"),
            options: (projects.data?.items ?? []).map((item) => ({
              value: item.code ?? item.id,
              label: item.name,
            })),
            onSearchChange: setProjectQuery,
            onChange: (values) =>
              commit({ projectCodes: values, projectCode: undefined }),
            isLoading: projects.isLoading,
            isError: projects.isError,
            onRetry: () => void projects.refetch(),
          },
          {
            label: "Наставник кандидата",
            placeholder: "Все наставники",
            value: filterValues(search, "mentorCodes1c", "mentorCode1c"),
            options: (mentors.data?.items ?? []).map((item) => ({
              value: item.code1c,
              label: item.name,
            })),
            onChange: (values) =>
              commit({ mentorCodes1c: values, mentorCode1c: undefined }),
            isLoading: mentors.isLoading,
            isError: mentors.isError,
            onRetry: () => void mentors.refetch(),
          },
        ]}
      >
        <label className="min-w-0 text-xs font-medium text-[var(--muted-foreground)]">
          Поиск кандидатов
          <input
            type="search"
            aria-label="Поиск кандидатов"
            placeholder="Поиск по ФИО или телефону"
            className={`${CANDIDATE_CONTROL} mt-1.5 h-10`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </FilterBar>
      {candidates.isLoading && <p role="status">Загрузка кандидатов…</p>}
      {candidates.isError && (
        <div role="alert" className="text-sm">
          Не удалось загрузить кандидатов.{" "}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void candidates.refetch()}
          >
            Повторить
          </Button>
        </div>
      )}
      {candidates.data?.items.length === 0 && (
        <EmptyState
          title="Кандидаты не найдены"
          description="Измените фильтры или создайте кандидата."
        />
      )}
      {!!candidates.data?.items.length && (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--card)]">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--muted-foreground)]">
                {[
                  "ФИО",
                  "Должность",
                  "Статус",
                  "Менеджер",
                  "Объект",
                  "Документы",
                ].map((label) => (
                  <th key={label} className="p-3 font-medium">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {candidates.data?.items.map((candidate) => (
                <tr
                  key={candidate.id}
                  className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--muted)]"
                >
                  <td className="p-3">
                    <div className="flex items-center gap-2.5">
                      <CandidateAvatar
                        candidateId={candidate.id}
                        fullName={candidate.fullName}
                        photoPath={candidate.photoPath}
                        size="sm"
                        allowEnlarge
                      />
                      <Link
                        to="/review/candidates/$candidateId"
                        params={{ candidateId: candidate.id }}
                        search={{ section: "profile" }}
                        className="font-medium text-[var(--primary)] underline-offset-4 hover:underline"
                      >
                        {candidate.fullName || "Без имени в профиле"}
                      </Link>
                    </div>
                  </td>
                  <td className="p-3">
                    {candidate.positionName || "Не указана"}
                  </td>
                  <td className="p-3">{candidate.statusName || "Не указан"}</td>
                  <td className="p-3">
                    {candidate.managerName || "Не назначен"}
                  </td>
                  <td className="p-3">
                    {candidate.projectName || "Не указан"}
                  </td>
                  <td className="p-3">
                    {documentSync.pendingIds.has(candidate.id) ? (
                      <span role="status">Синхронизация документов…</span>
                    ) : (
                      formatDocumentProgress(
                        candidate.approvedDocuments,
                        candidate.requiredDocuments,
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {documentSync.error && (
        <p role="alert" className="text-sm text-[var(--muted-foreground)]">
          Не удалось запросить синхронизацию документов.{" "}
          <Button size="sm" variant="outline" onClick={documentSync.retry}>
            Повторить
          </Button>
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!value("cursor")}
          onClick={() => commit({})}
        >
          В начало
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!candidates.data?.nextCursor}
          onClick={() =>
            void navigate({
              to: "/candidates",
              search: (previous: Record<string, unknown>) => ({
                ...previous,
                cursor: candidates.data?.nextCursor,
              }),
            })
          }
        >
          Далее
        </Button>
      </div>
    </div>
  );
}
