import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCandidateDetailsQueryKey,
  getGetCandidateWorkspaceQueryKey,
  getListCommunicationCandidatesQueryKey,
  getGetCandidateRequirementsQueryKey,
  useGetCandidateWorkspace,
  useUpdateCandidateWorkspace,
  useChangeCandidateStatus,
  useListCandidateStatuses,
  useListCandidateProjects,
  useLinkCandidatePerson,
  type CandidateWorkspaceDto,
  type CandidateFieldsDto,
} from "@edo/api-client";
import { Button } from "@edo/ui";
import {
  CandidateForm,
  CANDIDATE_CONTROL,
  candidateChangedFields,
  candidateFormFields,
  useCandidateRequest,
} from "./CandidateForm";
import { SearchSelect } from "./SearchSelect";
import { formatBirthDateRu } from "../lib/review-groups";
import { CandidatePreviousDocuments } from "./CandidatePreviousDocuments";
import { CandidatePersonPicker } from "./CandidatePersonPicker";

function useConfirmedCandidate(candidateId: string) {
  const cache = useQueryClient();
  return async (profile: CandidateWorkspaceDto) => {
    cache.setQueryData(getGetCandidateWorkspaceQueryKey(candidateId), profile);
    await Promise.all([
      cache.invalidateQueries({
        queryKey: getGetCandidateDetailsQueryKey(candidateId),
      }),
      cache.invalidateQueries({
        queryKey: getListCommunicationCandidatesQueryKey(),
      }),
      cache.invalidateQueries({
        queryKey: getGetCandidateRequirementsQueryKey(candidateId),
      }),
    ]);
  };
}

function EditCandidate({
  profile,
  onClose,
}: {
  profile: CandidateWorkspaceDto;
  onClose: () => void;
}) {
  const [initial] = useState(() => candidateFormFields(profile));
  const mutation = useUpdateCandidateWorkspace();
  const request = useCandidateRequest();
  const confirmed = useConfirmedCandidate(profile.id);
  const submit = async (fields: CandidateFieldsDto) => {
    const changed = candidateChangedFields(initial, fields);
    if (!Object.keys(changed).length) {
      onClose();
      return;
    }
    request.begin();
    try {
      const saved = await mutation.mutateAsync({
        candidateId: profile.id,
        data: { requestId: request.requestId, fields: changed },
      });
      await confirmed(saved);
      onClose();
    } catch (error) {
      request.fail(error);
    }
  };
  return (
    <CandidateForm
      profile={profile}
      pending={mutation.isPending}
      locked={request.locked}
      error={request.error}
      onSubmit={(fields) => void submit(fields)}
      onCancel={onClose}
    />
  );
}

function CandidateStatus({
  profile,
  onClose,
}: {
  profile: CandidateWorkspaceDto;
  onClose: () => void;
}) {
  const statuses = useListCandidateStatuses();
  const [statusId, setStatusId] = useState("");
  const [comment, setComment] = useState("");
  const [projectCode, setProjectCode] = useState(profile.project?.code ?? "");
  const [plannedArrivalDate, setPlannedArrivalDate] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const projects = useListCandidateProjects({ q: projectQuery || undefined });
  const mutation = useChangeCandidateStatus();
  const request = useCandidateRequest();
  const confirmed = useConfirmedCandidate(profile.id);
  const selected = statuses.data?.items.find(
    (status) => status.id === statusId,
  );
  return (
    <form
      aria-label="Изменение статуса"
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!selected || selected.editable === false) return;
        request.begin();
        void mutation
          .mutateAsync({
            candidateId: profile.id,
            data: {
              requestId: request.requestId,
              statusId,
              ...(comment.trim() ? { comment: comment.trim() } : {}),
              ...(selected.requiresProject ? { projectCode } : {}),
              ...(selected.requiresPlannedArrivalDate
                ? { plannedArrivalDate }
                : {}),
            },
          })
          .then(async (saved) => {
            await confirmed(saved);
            onClose();
          })
          .catch(request.fail);
      }}
    >
      <p className="text-sm text-[var(--muted-foreground)]">
        Текущий статус: {profile.status?.name || "Не указан"}. Статус меняется
        вручную. Заезд подтверждает диспетчер, кадровое оформление выполняется в
        ERP.
      </p>
      <label className="block space-y-1 text-sm">
        Новый статус
        <select
          required
          className={CANDIDATE_CONTROL}
          value={statusId}
          disabled={request.locked || mutation.isPending}
          onChange={(event) => setStatusId(event.target.value)}
        >
          <option value="">Выберите статус</option>
          {statuses.data?.items.map((status) => (
            <option
              key={status.id}
              value={status.id}
              disabled={status.editable === false}
            >
              {status.name}
              {status.editable === false ? " · отображается из ERP" : ""}
            </option>
          ))}
        </select>
      </label>
      {statuses.isLoading && (
        <p role="status" className="text-sm">
          Загрузка статусов ERP…
        </p>
      )}
      {statuses.isError && (
        <p role="alert" className="text-sm">
          Не удалось получить статусы.{" "}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void statuses.refetch()}
          >
            Повторить
          </Button>
        </p>
      )}
      {selected?.requiresProject && (
        <div className="space-y-1 text-sm">
          <p>Объект для заявки · обязательно</p>
          <SearchSelect
            label="Объект для заявки"
            value={projectCode}
            selectedLabel={profile.project?.name}
            disabled={request.locked || mutation.isPending}
            options={(projects.data?.items ?? []).map((project) => ({
              value: project.code ?? project.id,
              label: project.name,
            }))}
            onSearchChange={setProjectQuery}
            onChange={(value) => setProjectCode(value ?? "")}
            isLoading={projects.isLoading}
            isError={projects.isError}
            onRetry={() => void projects.refetch()}
          />
        </div>
      )}
      {selected?.requiresPlannedArrivalDate && (
        <label className="block space-y-1 text-sm">
          Плановая дата заезда
          <input
            type="date"
            required
            className={CANDIDATE_CONTROL}
            value={plannedArrivalDate}
            disabled={request.locked || mutation.isPending}
            onChange={(event) => setPlannedArrivalDate(event.target.value)}
          />
        </label>
      )}
      <label className="block space-y-1 text-sm">
        Комментарий · необязательно
        <textarea
          maxLength={2000}
          rows={3}
          className={CANDIDATE_CONTROL}
          value={comment}
          disabled={request.locked || mutation.isPending}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>
      {request.error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {request.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={
            mutation.isPending ||
            !selected ||
            selected.editable === false ||
            (selected.requiresProject && !projectCode)
          }
        >
          {mutation.isPending
            ? "Сохранение…"
            : request.error
              ? "Повторить изменение статуса"
              : "Сохранить статус"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={request.locked || mutation.isPending}
          onClick={onClose}
        >
          Отмена
        </Button>
      </div>
    </form>
  );
}

function CandidatePersonLink({
  profile,
  onClose,
}: {
  profile: CandidateWorkspaceDto;
  onClose: () => void;
}) {
  const [personSelection, setPersonSelection] = useState<string>();
  const mutation = useLinkCandidatePerson();
  const request = useCandidateRequest();
  const savedProfile = useConfirmedCandidate(profile.id);
  return (
    <form
      aria-label={
        profile.linkedPerson
          ? "Подтверждение связи с физлицом"
          : "Повторный приём"
      }
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!personSelection) return;
        request.begin();
        void mutation
          .mutateAsync({
            candidateId: profile.id,
            data: {
              requestId: request.requestId,
              personSelection,
            },
          })
          .then(async (saved) => {
            await savedProfile(saved);
            onClose();
          })
          .catch(request.fail);
      }}
    >
      <p className="text-sm text-[var(--muted-foreground)]">
        Выберите существующее физлицо из ERP и подтвердите связь с текущим
        оформлением. Кадровый приём выполняется в ERP.
      </p>
      <CandidatePersonPicker
        disabled={request.locked || mutation.isPending}
        onChange={setPersonSelection}
      />
      {request.error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {request.error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={mutation.isPending || !personSelection}>
          {mutation.isPending
            ? "Связывание…"
            : request.error
              ? "Повторить связывание"
              : "Связать с текущим кандидатом"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={request.locked || mutation.isPending}
          onClick={onClose}
        >
          Отмена
        </Button>
      </div>
    </form>
  );
}

export function CandidateManagement({ candidateId }: { candidateId: string }) {
  const workspace = useGetCandidateWorkspace(candidateId);
  const [action, setAction] = useState<"edit" | "status" | "person" | null>(
    null,
  );
  if (workspace.isLoading) return <p role="status">Загрузка данных ERP…</p>;
  if (workspace.isError || !workspace.data)
    return (
      <div role="alert" className="text-sm">
        Не удалось получить подтверждённую карточку ERP.{" "}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void workspace.refetch()}
        >
          Повторить
        </Button>
      </div>
    );
  const profile = workspace.data;
  return (
    <div className="space-y-6 p-1">
      <section aria-label="Данные кандидата" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-auto text-base font-semibold">Данные кандидата</h2>
          {!action && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAction("edit")}
              >
                Редактировать данные
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAction("status")}
              >
                Изменить статус
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAction("person")}
              >
                {profile.linkedPerson
                  ? "Подтвердить связь с физлицом"
                  : "Повторный приём"}
              </Button>
            </>
          )}
        </div>
        {action === "edit" ? (
          <EditCandidate profile={profile} onClose={() => setAction(null)} />
        ) : (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
            {[
              ["ФИО", profile.fullName],
              ["Телефон", profile.phone],
              [
                "Дата рождения",
                formatBirthDateRu(profile.birthDate?.slice(0, 10)),
              ],
              ["Гражданство", profile.citizenship?.toUpperCase()],
              ["Должность", profile.position?.name || "Не указана"],
              ["Объект", profile.project?.name || "Не указан"],
              ["Менеджер", profile.manager?.name || "Не назначен"],
              [
                "Наставник · назначается в ERP",
                profile.mentor
                  ? `${profile.mentor.name}${profile.mentor.position ? ` · ${profile.mentor.position}` : ""}`
                  : "Не назначен",
              ],
              ["Статус", profile.status?.name || "Не указан"],
              [
                "Связь с физлицом",
                profile.linkedPerson ? "Указана в ERP" : "Пока не установлена",
              ],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0">
                <dt className="text-[var(--muted-foreground)]">{label}</dt>
                <dd className="break-words font-medium">
                  {value || "Не указано"}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {action === "status" && (
          <CandidateStatus profile={profile} onClose={() => setAction(null)} />
        )}
        {action === "person" && (
          <CandidatePersonLink
            profile={profile}
            onClose={() => setAction(null)}
          />
        )}
      </section>
      <section className="space-y-3 border-t border-[var(--border)] pt-5">
        <h2 className="text-base font-semibold">История статусов</h2>
        {!profile.history.length ? (
          <p className="text-sm text-[var(--muted-foreground)]">
            История пока пуста.
          </p>
        ) : (
          <ol className="space-y-3">
            {profile.history.map((item, index) => (
              <li key={`${item.date}:${index}`} className="text-sm">
                <p className="font-medium">{item.statusName}</p>
                <p className="text-xs text-[var(--muted-foreground)]">
                  {new Date(item.date).toLocaleString("ru-RU")} ·{" "}
                  {item.author || "Автор не указан"}
                </p>
                {item.comment && (
                  <p className="mt-1 whitespace-pre-wrap break-words">
                    {item.comment}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
      {profile.linkedPerson && (
        <CandidatePreviousDocuments candidateId={candidateId} />
      )}
    </div>
  );
}
