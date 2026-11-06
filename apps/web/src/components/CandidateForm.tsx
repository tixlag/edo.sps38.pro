import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  useListCandidateManagers,
  useListCatalogManagers,
  getListCatalogManagersQueryKey,
  useListCandidatePositions,
  useListCandidateProjects,
  useFindCandidatePersonMatches,
  getFindCandidatePersonMatchesQueryKey,
  type CandidateFieldsDto,
  type CandidatePatchFieldsDto,
  type CandidateWorkspaceDto,
} from "@edo/api-client";
import { Button } from "@edo/ui";
import { SearchSelect } from "./SearchSelect";
import { CandidatePersonPicker } from "./CandidatePersonPicker";

export const CANDIDATE_CONTROL =
  "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)] disabled:opacity-60";

const CITIZENSHIP_PRESETS = [
  { code: "ru", label: "РФ" },
  { code: "uz", label: "Узбекистан" },
  { code: "tj", label: "Таджикистан" },
  { code: "kg", label: "Киргизия" },
  { code: "by", label: "Беларусь" },
  { code: "kz", label: "Казахстан" },
  { code: "am", label: "Армения" },
  { code: "az", label: "Азербайджан" },
  { code: "md", label: "Молдова" },
] as const;

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
  compact = false,
}: {
  profile?: CandidateWorkspaceDto;
  pending: boolean;
  locked: boolean;
  error: string;
  onSubmit: (fields: CandidateFieldsDto, personSelection?: string) => void;
  onCancel: () => void;
  compact?: boolean;
}) {
  const [fields, setFields] = useState(() => candidateFormFields(profile));
  const citizenshipListId = useId();
  const [personEnabled, setPersonEnabled] = useState(false);
  const [personSelection, setPersonSelection] = useState<string>();
  const [suggestedName, setSuggestedName] = useState("");
  const [latinName, setLatinName] = useState("");
  const [latinMatchQuery, setLatinMatchQuery] = useState("");
  const [matchQuery, setMatchQuery] = useState("");
  const [managerQuery, setManagerQuery] = useState("");
  const [managerFallback, setManagerFallback] = useState(false);
  const [positionQuery, setPositionQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const managers = useListCandidateManagers({
    q: managerFallback ? undefined : managerQuery || undefined,
  });
  const useFallback = managerFallback || (managers.isError && !managers.data);
  const knownManagers = useListCatalogManagers({
    query: { queryKey: getListCatalogManagersQueryKey(), enabled: useFallback },
  });
  useEffect(() => {
    if (managers.isError && !managers.data) setManagerFallback(true);
  }, [managers.isError, managers.data]);
  const managerOptions = useFallback
    ? (knownManagers.data?.items ?? []).filter((item) =>
        item.name
          .toLocaleLowerCase("ru")
          .includes(managerQuery.trim().toLocaleLowerCase("ru")),
      )
    : (managers.data?.items ?? []);
  const positions = useListCandidatePositions({
    q: positionQuery || undefined,
  });
  const projects = useListCandidateProjects({ q: projectQuery || undefined });
  const matchName = fields.fullName.trim().replace(/\s+/g, " ");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setMatchQuery(matchName);
      setLatinMatchQuery(latinName.trim().replace(/\s+/g, " "));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [matchName, latinName]);
  const nameParts = matchQuery.split(" ");
  const canCheckPerson =
    !profile &&
    matchQuery === matchName &&
    latinMatchQuery === latinName.trim().replace(/\s+/g, " ") &&
    latinMatchQuery.length <= 100 &&
    nameParts.length >= 2 &&
    nameParts.every((part) => part.length > 0 && part.length <= 100) &&
    nameParts.slice(2).join(" ").length <= 100 &&
    /^\d{4}-\d{2}-\d{2}$/.test(fields.birthDate);
  const matchParams = {
    lastName: nameParts[0] ?? "",
    firstName: nameParts[1] ?? "",
    middleName: nameParts.slice(2).join(" ") || undefined,
    latinName:
      fields.citizenship.toLowerCase() === "ru"
        ? undefined
        : latinMatchQuery || undefined,
    birthDate: fields.birthDate,
  };
  const possiblePersons = useFindCandidatePersonMatches(matchParams, {
    query: {
      queryKey: getFindCandidatePersonMatchesQueryKey(matchParams),
      enabled: canCheckPerson,
      refetchOnWindowFocus: false,
    },
  });
  const matchingPersons = canCheckPerson
    ? (possiblePersons.data?.items ?? [])
    : [];
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
        className={`grid min-w-0 gap-4 ${compact ? "grid-cols-1" : "sm:grid-cols-2"}`}
      >
        <label
          className={`space-y-1 text-sm ${compact ? "" : "sm:col-span-2"}`}
        >
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
            list={citizenshipListId}
            className={CANDIDATE_CONTROL}
            value={fields.citizenship}
            onChange={(event) =>
              set("citizenship", event.target.value.toLowerCase())
            }
          />
          <datalist id={citizenshipListId}>
            {CITIZENSHIP_PRESETS.map((item) => (
              <option key={item.code} value={item.code}>
                {item.label} ({item.code})
              </option>
            ))}
          </datalist>
          <div className="flex flex-wrap gap-1 pt-1">
            {CITIZENSHIP_PRESETS.slice(0, 5).map((item) => (
              <button
                key={item.code}
                type="button"
                disabled={pending || locked}
                onClick={(e) => {
                  e.preventDefault();
                  set("citizenship", item.code);
                }}
                className={`rounded px-1.5 py-0.5 text-xs transition-colors ${
                  fields.citizenship === item.code
                    ? "bg-[var(--primary)] text-[var(--primary-foreground)] font-medium"
                    : "bg-[var(--muted)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                }`}
              >
                {item.label} ({item.code})
              </button>
            ))}
          </div>
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
            options={managerOptions.map((item) => ({
              value: item.id,
              label: item.name,
            }))}
            onSearchChange={setManagerQuery}
            onChange={(value) => set("managerId", value ?? "")}
            isLoading={
              useFallback ? knownManagers.isLoading : managers.isLoading
            }
            isError={
              useFallback
                ? knownManagers.isError
                : managers.isError && !managers.data
            }
            onRetry={() => {
              if (useFallback) void knownManagers.refetch();
              else void managers.refetch();
            }}
            disabled={pending || locked}
          />
          {useFallback && !knownManagers.isError && (
            <p className="text-xs text-[var(--muted-foreground)]">
              Менеджеры из ранее загруженных кандидатов: справочник 1С
              недоступен, список может быть неполным.{" "}
              <button
                type="button"
                className="text-[var(--primary)] underline underline-offset-2"
                onClick={() =>
                  void managers.refetch().then((result) => {
                    if (!result.isError) {
                      setManagerQuery("");
                      setManagerFallback(false);
                    }
                  })
                }
              >
                Повторить загрузку справочника
              </button>
            </p>
          )}
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
          {fields.citizenship.toLowerCase() !== "ru" && (
            <label className="block space-y-1 text-sm">
              Фамилия и имя латиницей для поиска · необязательно
              <input
                className={CANDIDATE_CONTROL}
                maxLength={100}
                value={latinName}
                disabled={pending || locked}
                onChange={(event) => setLatinName(event.target.value)}
              />
            </label>
          )}
          {canCheckPerson && possiblePersons.isError && (
            <p role="status" className="text-sm text-[var(--danger)]">
              Не удалось проверить физлиц в ERP. Можно повторить проверку или
              найти физлицо вручную.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => void possiblePersons.refetch()}
              >
                Повторить проверку
              </button>
            </p>
          )}
          {matchingPersons.length > 0 && (
            <div role="status" className="space-y-2 text-sm">
              <p>
                В ERP найдены возможные совпадения по ФИО и дате рождения.
                Проверьте физлицо и подтвердите связь с текущим оформлением.
              </p>
              <ul className="space-y-1">
                {matchingPersons.map((person) => (
                  <li key={person.id}>
                    <button
                      type="button"
                      className="text-left underline"
                      disabled={pending || locked}
                      onClick={() => {
                        setSuggestedName(person.name);
                        setPersonSelection(undefined);
                        setPersonEnabled(true);
                      }}
                    >
                      {person.name}{" "}
                      {person.latinName ? `· ${person.latinName}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
                key={suggestedName}
                disabled={pending || locked}
                onChange={setPersonSelection}
                initialQuery={suggestedName || matchName}
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
          size="sm"
          className="rounded-md"
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
          size="sm"
          className="rounded-md"
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
