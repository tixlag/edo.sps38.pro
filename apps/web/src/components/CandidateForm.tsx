import { useRef, useState, type FormEvent } from "react";
import {
  useListCandidateManagers,
  useListCandidatePositions,
  useListCandidateProjects,
  type CandidateFieldsDto,
  type CandidatePatchFieldsDto,
  type CandidateWorkspaceDto,
} from "@edo/api-client";
import { Button } from "@edo/ui";
import { SearchSelect } from "./SearchSelect";
import { CandidatePersonPicker } from "./CandidatePersonPicker";

export const CANDIDATE_CONTROL =
  "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] disabled:opacity-60";

export function candidateError(error: unknown): string {
  const response = error as {
    response?: { data?: { message?: string | string[] } };
  };
  const message = response.response?.data?.message;
  return Array.isArray(message)
    ? message.join(". ")
    : message ||
        "ERP не подтвердила операцию. Повторите запрос с теми же данными.";
}

/** The same mounted operation keeps its ID and body after an uncertain response. */
export function useCandidateRequest() {
  const requestId = useRef(crypto.randomUUID());
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  return {
    requestId: requestId.current,
    locked,
    error,
    begin: () => {
      setLocked(true);
      setError("");
    },
    fail: (cause: unknown) => {
      setError(candidateError(cause));
      const status = (cause as { response?: { status?: number } }).response
        ?.status;
      // Validation was rejected before an ERP commit; a corrected form is a new operation.
      if (status === 400 || status === 422) {
        requestId.current = crypto.randomUUID();
        setLocked(false);
      }
    },
  };
}

export function candidateFormFields(
  profile?: CandidateWorkspaceDto,
): CandidateFieldsDto {
  return {
    fullName: profile?.fullName ?? "",
    phone: profile?.phone ?? "",
    birthDate: profile?.birthDate?.slice(0, 10) ?? "",
    citizenship: profile?.citizenship ?? "ru",
    positionCode: profile?.position?.code ?? "",
    managerId: profile?.manager?.id ?? "",
    projectCode: profile?.project?.code ?? null,
  };
}

export function candidateChangedFields(
  initial: CandidateFieldsDto,
  current: CandidateFieldsDto,
): CandidatePatchFieldsDto {
  return Object.fromEntries(
    Object.entries(current).filter(
      ([key, value]) => value !== initial[key as keyof CandidateFieldsDto],
    ),
  );
}

export function CandidateForm({
  profile,
  pending,
  locked,
  error,
  onSubmit,
  onCancel,
}: {
  profile?: CandidateWorkspaceDto;
  pending: boolean;
  locked: boolean;
  error: string;
  onSubmit: (fields: CandidateFieldsDto, personSelection?: string) => void;
  onCancel: () => void;
}) {
  const [fields, setFields] = useState(() => candidateFormFields(profile));
  const [personEnabled, setPersonEnabled] = useState(false);
  const [personSelection, setPersonSelection] = useState<string>();
  const [managerQuery, setManagerQuery] = useState("");
  const [positionQuery, setPositionQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const managers = useListCandidateManagers({ q: managerQuery || undefined });
  const positions = useListCandidatePositions({
    q: positionQuery || undefined,
  });
  const projects = useListCandidateProjects({ q: projectQuery || undefined });
  const set = (key: keyof CandidateFieldsDto, value: string | null) =>
    setFields((previous) => ({ ...previous, [key]: value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (
      fields.positionCode &&
      fields.managerId &&
      (profile || !personEnabled || personSelection)
    )
      onSubmit(fields, personEnabled ? personSelection : undefined);
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-4"
      aria-label={profile ? "Редактирование кандидата" : "Создание кандидата"}
    >
      <fieldset
        disabled={pending || locked}
        className="grid min-w-0 gap-4 sm:grid-cols-2"
      >
        <label className="space-y-1 text-sm sm:col-span-2">
          ФИО
          <input
            autoFocus
            required
            maxLength={200}
            className={CANDIDATE_CONTROL}
            value={fields.fullName}
            onChange={(event) => set("fullName", event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          Телефон
          <input
            required
            type="tel"
            maxLength={40}
            className={CANDIDATE_CONTROL}
            value={fields.phone}
            onChange={(event) => set("phone", event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          Дата рождения
          <input
            required
            type="date"
            className={CANDIDATE_CONTROL}
            value={fields.birthDate}
            onChange={(event) => set("birthDate", event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          Гражданство (код страны)
          <input
            required
            minLength={2}
            maxLength={2}
            placeholder="ru"
            className={CANDIDATE_CONTROL}
            value={fields.citizenship}
            onChange={(event) =>
              set("citizenship", event.target.value.toLowerCase())
            }
          />
        </label>
        <div className="space-y-1 text-sm">
          <p>Должность · обязательно</p>
          <SearchSelect
            label="Должность"
            value={fields.positionCode}
            selectedLabel={profile?.position?.name}
            options={(positions.data?.items ?? []).map((item) => ({
              value: item.code ?? item.id,
              label: item.name,
            }))}
            onSearchChange={setPositionQuery}
            onChange={(value) => set("positionCode", value ?? "")}
            isLoading={positions.isLoading}
            isError={positions.isError}
            onRetry={() => void positions.refetch()}
            disabled={pending || locked}
          />
        </div>
        <div className="space-y-1 text-sm">
          <p>Менеджер · обязательно</p>
          <SearchSelect
            label="Менеджер"
            value={fields.managerId}
            selectedLabel={profile?.manager?.name}
            options={(managers.data?.items ?? []).map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onSearchChange={setManagerQuery}
            onChange={(value) => set("managerId", value ?? "")}
            isLoading={managers.isLoading}
            isError={managers.isError}
            onRetry={() => void managers.refetch()}
            disabled={pending || locked}
          />
        </div>
        <div className="space-y-1 text-sm">
          <p>Объект · необязательно</p>
          <SearchSelect
            label="Объект"
            value={fields.projectCode}
            selectedLabel={profile?.project?.name}
            options={(projects.data?.items ?? []).map((item) => ({
              value: item.code ?? item.id,
              label: item.name,
            }))}
            onSearchChange={setProjectQuery}
            onChange={(value) => set("projectCode", value ?? null)}
            isLoading={projects.isLoading}
            isError={projects.isError}
            onRetry={() => void projects.refetch()}
            disabled={pending || locked}
          />
        </div>
      </fieldset>
      {!profile && (
        <section
          className="space-y-3 border-t border-[var(--border)] pt-4"
          aria-label="Существующее физлицо"
        >
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              aria-label="Повторный приём при создании"
              checked={personEnabled}
              disabled={pending || locked}
              onChange={(event) => {
                setPersonEnabled(event.target.checked);
                setPersonSelection(undefined);
              }}
            />
            Повторный приём · выбрать существующее физлицо
          </label>
          {personEnabled && (
            <>
              <p className="text-sm text-[var(--muted-foreground)]">
                Новый цикл оформления будет создан с выбранным физлицом ERP.
                Прежнюю карточку кандидата искать не требуется. Кадровый приём
                выполняется в ERP.
              </p>
              <CandidatePersonPicker
                disabled={pending || locked}
                onChange={setPersonSelection}
              />
            </>
          )}
        </section>
      )}
      {profile?.mentor && (
        <p className="text-sm text-[var(--muted-foreground)]">
          Наставник: {profile.mentor.name}
          {profile.mentor.position ? ` · ${profile.mentor.position}` : ""}.
          Назначается в ERP.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
          {locked && " Данные сохранены для безопасного повтора."}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={
            pending ||
            !fields.positionCode ||
            !fields.managerId ||
            (!profile && personEnabled && !personSelection)
          }
        >
          {pending
            ? "Сохранение…"
            : error && locked
              ? "Повторить сохранение"
              : profile
                ? "Сохранить данные"
                : "Создать кандидата"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending || locked}
          onClick={onCancel}
        >
          Отмена
        </Button>
      </div>
    </form>
  );
}
