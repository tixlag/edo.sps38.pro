import { useEffect, useState } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  getListCommunicationCandidatesQueryKey,
  useCreateCandidate,
  useGetMe,
  useListCandidateManagers,
  useListCandidateProjects,
  useListCandidateStatuses,
  useListCommunicationCandidates,
  type CandidateFieldsDto,
} from "@edo/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { Button, EmptyState, PageHeader } from "@edo/ui";
import {
  CandidateForm,
  CANDIDATE_CONTROL,
  useCandidateRequest,
} from "../components/CandidateForm";
import { SearchSelect } from "../components/SearchSelect";
import { hasAccessRule } from "../lib/audit-types";
import { formatDocumentProgress } from "../lib/review-groups";

function CreateCandidate({ onCancel }: { onCancel: () => void }) {
  const create = useCreateCandidate();
  const request = useCandidateRequest();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const submit = async (
    fields: CandidateFieldsDto,
    personSelection?: string,
  ) => {
    request.begin();
    try {
      const candidate = await create.mutateAsync({
        data: {
          requestId: request.requestId,
          fields,
          ...(personSelection ? { personSelection } : {}),
        },
      });
      await cache.invalidateQueries({
        queryKey: getListCommunicationCandidatesQueryKey(),
      });
      void navigate({
        to: "/review/candidates/$candidateId",
        params: { candidateId: candidate.id },
        search: { section: "profile" },
      });
    } catch (error) {
      request.fail(error);
    }
  };
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 sm:p-6">
      <h2 className="mb-4 text-lg font-semibold">Создать кандидата</h2>
      <p className="mb-4 text-sm text-[var(--muted-foreground)]">
        Карточка будет создана в ERP со статусом «Подбор». Чат и объект можно
        добавить позже.
      </p>
      <CandidateForm
        pending={create.isPending}
        locked={request.locked}
        error={request.error}
        onSubmit={(fields, personSelection) =>
          void submit(fields, personSelection)
        }
        onCancel={onCancel}
      />
    </section>
  );
}

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
  const commit = (patch: Record<string, string | undefined>) =>
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
  const params = {
    q: value("q"),
    statusId: value("statusId"),
    managerId: value("managerId"),
    projectCode: value("projectCode"),
    cursor: value("cursor"),
    limit: 50,
  };
  const candidates = useListCommunicationCandidates(params);
  const statuses = useListCandidateStatuses();
  const managers = useListCandidateManagers({ q: managerQuery || undefined });
  const projects = useListCandidateProjects({ q: projectQuery || undefined });
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-3 sm:p-6">
      <PageHeader
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
        Очередь проверки документов России
      </Link>
      {create && <CreateCandidate onCancel={() => setCreate(false)} />}
      <section
        aria-label="Фильтры кандидатов"
        className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <input
          aria-label="Поиск кандидатов"
          placeholder="Поиск по ФИО или телефону"
          className={CANDIDATE_CONTROL}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SearchSelect
          label="Статус кандидата"
          value={value("statusId")}
          options={(statuses.data?.items ?? []).map((item) => ({
            value: item.id,
            label: item.name,
          }))}
          onChange={(statusId) => commit({ statusId })}
          isLoading={statuses.isLoading}
          isError={statuses.isError}
          onRetry={() => void statuses.refetch()}
        />
        <SearchSelect
          label="Менеджер кандидата"
          value={value("managerId")}
          options={(managers.data?.items ?? []).map((item) => ({
            value: item.id,
            label: item.name,
          }))}
          onSearchChange={setManagerQuery}
          onChange={(managerId) => commit({ managerId })}
          isLoading={managers.isLoading}
          isError={managers.isError}
          onRetry={() => void managers.refetch()}
        />
        <SearchSelect
          label="Объект кандидата"
          value={value("projectCode")}
          options={(projects.data?.items ?? []).map((item) => ({
            value: item.code ?? item.id,
            label: item.name,
          }))}
          onSearchChange={setProjectQuery}
          onChange={(projectCode) => commit({ projectCode })}
          isLoading={projects.isLoading}
          isError={projects.isError}
          onRetry={() => void projects.refetch()}
        />
      </section>
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
                    <Link
                      to="/review/candidates/$candidateId"
                      params={{ candidateId: candidate.id }}
                      search={{ section: "profile" }}
                      className="font-medium text-[var(--primary)] underline-offset-4 hover:underline"
                    >
                      {candidate.fullName || "Без имени в профиле"}
                    </Link>
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
                    {formatDocumentProgress(
                      candidate.approvedDocuments,
                      candidate.requiredDocuments,
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
