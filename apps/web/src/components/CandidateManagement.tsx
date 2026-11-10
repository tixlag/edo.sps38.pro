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
  type CandidateProfileDto,
  type CandidateFieldsDto,
} from "@edo/api-client";
import { Badge, Button, EmptyState, StatusBadge } from "@edo/ui";
import {
  Briefcase,
  Check,
  Clock,
  Copy,
  Pencil,
  User,
  UserCheck,
} from "lucide-react";
import {
  CandidateForm,
  CANDIDATE_CONTROL,
  candidateChangedFields,
  candidateFormFields,
  useCandidateRequest,
} from "./CandidateForm";
import { SearchSelect } from "./SearchSelect";
import { formatBirthDateRu } from "../lib/review-groups";
import { groupCandidateStatuses } from "../lib/candidate-status-groups";
import { CandidatePreviousDocuments } from "./CandidatePreviousDocuments";
import { CandidatePersonPicker } from "./CandidatePersonPicker";
import { LkLink } from "./LkLink";

function formatPhoneRu(phone?: string | null): string {
  if (!phone) return "";
  const cleaned = phone.replace(/\D/g, "");
  if (
    cleaned.length === 11 &&
    (cleaned.startsWith("7") || cleaned.startsWith("8"))
  ) {
    return `+7 (${cleaned.slice(1, 4)}) ${cleaned.slice(4, 7)}-${cleaned.slice(7, 9)}-${cleaned.slice(9, 11)}`;
  }
  if (cleaned.length === 10) {
    return `+7 (${cleaned.slice(0, 3)}) ${cleaned.slice(3, 6)}-${cleaned.slice(6, 8)}-${cleaned.slice(8, 10)}`;
  }
  return phone;
}

function CopyPhoneButton({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(phone);
      } else if (typeof document !== "undefined") {
        const input = document.createElement("textarea");
        input.value = phone;
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard copy failure
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
      title={copied ? "Скопировано!" : "Скопировать телефон"}
      aria-label={copied ? "Скопировано!" : "Скопировать телефон"}
    >
      {copied ? (
        <Check size={13} className="text-[var(--success)]" />
      ) : (
        <Copy size={13} />
      )}
    </button>
  );
}

function formatHistoryDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function getStatusDotColor(statusId?: string, statusName?: string): string {
  const text = `${statusId ?? ""} ${statusName ?? ""}`.toLowerCase();
  if (/отказ|блок|запрет|увол|недозвон|ошибк/i.test(text)) {
    return "bg-[var(--primary)]";
  }
  if (
    /заезд|arrival|прием|приём|приказ|оформлен|принят|стажировк|employment|onboarding|готов/i.test(
      text,
    )
  ) {
    return "bg-[var(--success)]";
  }
  if (
    /медосмотр|удостоверен|согласован|рассмотрен|пропуск|проверк|безопасн|security|medical|approval/i.test(
      text,
    ) ||
    /(?:^|[^\p{L}\p{N}])(?:мо|уц|сб|фсб|епт|воз|sb|mo|uc)(?:[^\p{L}\p{N}]|$)/iu.test(
      text,
    )
  ) {
    return "bg-[var(--warning)]";
  }
  if (
    /подбор|recruiting|потенциальн|potential|в\s*работе|резерв|reserve|скрининг/i.test(
      text,
    )
  ) {
    return "bg-[var(--info)]";
  }
  return "bg-[var(--muted-foreground)]";
}

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
  compact,
}: {
  profile: CandidateWorkspaceDto;
  onClose: () => void;
  compact?: boolean;
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
      compact={compact}
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
  const groupedStatuses = groupCandidateStatuses(statuses.data?.items ?? []);
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
          {groupedStatuses.map((group) => (
            <optgroup key={group.key} label={group.label}>
              {group.items.map((status) => (
                <option
                  key={status.id}
                  value={status.id}
                  disabled={status.editable === false}
                >
                  {status.name}
                  {status.editable === false ? " · отображается из ERP" : ""}
                </option>
              ))}
            </optgroup>
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
      {(selected?.requiresProject || selected?.requiresPlannedArrivalDate) && (
        <div className="rounded-lg border border-[var(--primary)]/20 bg-[var(--primary)]/5 p-3 space-y-3">
          {selected.requiresProject && (
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
          {selected.requiresPlannedArrivalDate && (
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
        </div>
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
      <div className="flex flex-wrap items-center gap-2 pt-1">
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
          className="min-w-[100px]"
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
      <div className="flex flex-wrap items-center gap-2 pt-1">
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
          className="min-w-[100px]"
          disabled={request.locked || mutation.isPending}
          onClick={onClose}
        >
          Отмена
        </Button>
      </div>
    </form>
  );
}

export function CandidateManagement({
  candidateId,
  compact = false,
  fallbackProfile,
}: {
  candidateId: string;
  compact?: boolean;
  fallbackProfile?: CandidateProfileDto | null;
}) {
  const workspace = useGetCandidateWorkspace(candidateId);
  const [action, setAction] = useState<"edit" | "status" | "person" | null>(
    null,
  );
  if (workspace.isLoading) return <p role="status">Загрузка данных ERP…</p>;
  const response = (
    workspace.error as {
      response?: { status?: number; data?: { message?: unknown } };
    } | null
  )?.response;
  if (
    response?.status === 409 &&
    response.data?.message === "ERP_CANDIDATE_CONFIRMATION_REQUIRED"
  )
    return (
      <div className="space-y-4 text-sm">
        <p role="status" className="text-[var(--muted-foreground)]">
          Нет подтверждённой связи с кандидатом в 1С. Данные оформления и
          изменение статуса станут доступны после установления связи.
        </p>
        {fallbackProfile && (
          <dl className="space-y-3">
            {[
              ["ФИО", fallbackProfile.fullName],
              ["Дата рождения", formatBirthDateRu(fallbackProfile.birthDate)],
              ["Должность", fallbackProfile.positionName],
              ["Объект", fallbackProfile.projectName],
              ["Менеджер", fallbackProfile.managerName],
              ["Наставник", fallbackProfile.mentorName],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-[var(--muted-foreground)]">{label}</dt>
                <dd className="break-words font-medium">
                  {value || "Не указано"}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    );
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
  const managerCode1c =
    (profile.manager as { code1c?: string })?.code1c ||
    fallbackProfile?.managerCode1c;
  return (
    <div className="space-y-4 p-1">
      <section aria-label="Данные кандидата" className="space-y-3">
        {!action && (
          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              variant="default"
              onClick={() => setAction("status")}
              className="w-full justify-center gap-2 h-9 font-medium shadow-2xs"
            >
              <Clock size={14} />
              <span>Изменить статус</span>
            </Button>
            <div className="grid grid-cols-2 gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAction("edit")}
                className="w-full justify-center gap-1.5 h-8 text-xs font-medium"
              >
                <Pencil size={13} />
                <span>Редактировать данные</span>
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAction("person")}
                className="w-full justify-center gap-1.5 h-8 text-xs font-medium"
              >
                <UserCheck size={13} />
                <span className="truncate">
                  {profile.linkedPerson
                    ? "Подтвердить связь с физлицом"
                    : "Повторный приём"}
                </span>
              </Button>
            </div>
          </div>
        )}
        {action === "edit" && (
          <EditCandidate
            profile={profile}
            compact={compact}
            onClose={() => setAction(null)}
          />
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
        {!action && (
          <div className="space-y-3">
            {/* Карточка 1: Личные данные */}
            <div className="space-y-2.5 rounded-xl border border-[var(--border)]/60 bg-[var(--muted)]/20 p-3.5 shadow-2xs">
              <div className="flex items-center gap-2 border-b border-[var(--border)]/40 pb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                <User size={13} className="text-[var(--primary)]" />
                <span>Личные данные</span>
              </div>
              <dl className="space-y-2 text-xs sm:text-[13px]">
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[var(--muted-foreground)]">ФИО</dt>
                  <dd className="break-words font-medium text-[var(--foreground)]">
                    {profile.fullName || "Не указано"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Телефон
                  </dt>
                  <dd className="break-words font-medium text-[var(--foreground)]">
                    {profile.phone ? (
                      <div className="flex items-center gap-1.5">
                        <a
                          href={`tel:${profile.phone}`}
                          className="transition-colors hover:text-[var(--primary)] hover:underline"
                        >
                          {formatPhoneRu(profile.phone)}
                        </a>
                        <CopyPhoneButton phone={profile.phone} />
                      </div>
                    ) : (
                      "Не указан"
                    )}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Дата рождения
                  </dt>
                  <dd className="break-words font-medium text-[var(--foreground)]">
                    {formatBirthDateRu(profile.birthDate?.slice(0, 10)) ||
                      "Не указана"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Гражданство
                  </dt>
                  <dd className="pt-0.5">
                    {profile.citizenship ? (
                      <Badge tone="default">
                        {profile.citizenship.toUpperCase()}
                      </Badge>
                    ) : (
                      <span className="font-medium text-[var(--foreground)]">
                        Не указано
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Карточка 2: Назначение ERP */}
            <div className="space-y-2.5 rounded-xl border border-[var(--border)]/60 bg-[var(--muted)]/20 p-3.5 shadow-2xs">
              <div className="flex items-center gap-2 border-b border-[var(--border)]/40 pb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
                <Briefcase size={13} className="text-[var(--primary)]" />
                <span>Назначение ERP</span>
              </div>
              <dl className="space-y-2 text-xs sm:text-[13px]">
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Должность
                  </dt>
                  <dd className="break-words font-medium text-[var(--foreground)]">
                    {profile.position?.name || "Не указана"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Объект
                  </dt>
                  <dd className="break-words font-medium text-[var(--foreground)]">
                    {profile.project?.name || "Не указан"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Менеджер
                  </dt>
                  <dd className="break-words font-medium text-[var(--foreground)]">
                    {profile.manager ? (
                      managerCode1c ? (
                        <LkLink code1c={managerCode1c}>
                          {profile.manager.name}
                        </LkLink>
                      ) : (
                        profile.manager.name
                      )
                    ) : (
                      "Не назначен"
                    )}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--muted-foreground)]">
                    <span>Наставник</span>
                    <span className="rounded bg-[var(--muted)] px-1 py-0.5 text-[9px] font-semibold text-[var(--muted-foreground)]">
                      ERP
                    </span>
                  </dt>
                  <dd className="break-words font-medium text-[var(--foreground)]">
                    {profile.mentor
                      ? `${profile.mentor.name}${profile.mentor.position ? ` · ${profile.mentor.position}` : ""}`
                      : "Не назначен"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Связь с физлицом
                  </dt>
                  <dd className="break-words font-medium text-[var(--foreground)]">
                    {profile.linkedPerson
                      ? "Указана в ERP"
                      : "Пока не установлена"}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[11px] font-medium text-[var(--muted-foreground)]">
                    Статус
                  </dt>
                  <dd className="pt-0.5">
                    {profile.status?.name ? (
                      <StatusBadge status={profile.status.name} />
                    ) : (
                      <span className="font-medium text-[var(--foreground)]">
                        Не указан
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        )}
      </section>
      <section className="space-y-3 border-t border-[var(--border)]/60 pt-4">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          История статусов
        </h2>
        {!profile.history.length ? (
          <EmptyState
            title="История пока пуста"
            description="Статусы кандидата будут отображаться здесь по мере прохождения оформления."
            className="py-6"
          />
        ) : (
          <ol className="relative ml-2.5 space-y-4 border-l-2 border-[var(--border)] pl-4">
            {profile.history.map((item, index) => (
              <li
                key={`${item.date}:${index}`}
                className="relative space-y-1 text-xs"
              >
                <span
                  aria-hidden="true"
                  className={`absolute -left-[21px] top-1 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--card)] ${getStatusDotColor(item.statusId, item.statusName)}`}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={item.statusName || item.statusId} />
                  <time className="text-[11px] text-[var(--muted-foreground)]">
                    {formatHistoryDate(item.date)}
                  </time>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-[var(--muted-foreground)]">
                  <User
                    size={11}
                    className="shrink-0 text-[var(--muted-foreground)]"
                  />
                  <span>{item.author || "Автор не указан"}</span>
                </div>
                {item.comment && (
                  <blockquote className="rounded-md border border-[var(--border)]/60 bg-[var(--muted)]/60 p-2 text-xs text-[var(--foreground)] whitespace-pre-wrap break-words">
                    {item.comment}
                  </blockquote>
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
