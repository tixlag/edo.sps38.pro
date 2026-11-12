import { useEffect, useState, type FormEvent } from "react";
import {
  useListCandidateManagers,
  useListCatalogManagers,
  getListCatalogManagersQueryKey,
  useListCandidatePositions,
  useListCandidateProjects,
  useFindCandidatePersonMatches,
  getFindCandidatePersonMatchesQueryKey,
  type CandidatePatchFieldsDto,
  type CandidateWorkspaceDto,
} from "@edo/api-client";
import { Button } from "@edo/ui";
import { SearchSelect } from "./SearchSelect";
import { CandidatePersonPicker } from "./CandidatePersonPicker";
import { CandidateExpandedFields } from "./CandidateExpandedFields";
import { formatBirthDateRu } from "../lib/review-groups";
import { candidateRelatedFieldValidation } from "../lib/candidate-related-fields";
export {
  candidateError,
  useCandidateRequest,
} from "../lib/use-candidate-request";

export const CANDIDATE_CONTROL =
  "w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)] disabled:opacity-60";

export function candidateFormFields(
  profile?: CandidateWorkspaceDto,
): CandidatePatchFieldsDto {
  const basic = {
    fullName: profile?.fullName ?? "",
    phone: profile?.phone ?? "",
    birthDate: profile?.birthDate?.slice(0, 10) ?? null,
    citizenship: profile?.citizenship ?? null,
    positionCode: profile?.position?.code ?? null,
    managerId: profile?.manager?.id ?? null,
    projectCode: profile?.project?.code ?? null,
  };
  if (!profile) return { fullName: "", phone: "", birthDate: null };
  return {
    ...basic,
    sex: profile.sex ?? null,
    settlement: profile.settlement ?? null,
    organizationId: profile.organization?.id ?? null,
    expectedIncome: profile.expectedIncome ?? null,
    responsible: profile.responsible ?? null,
    additionalResponsible: profile.additionalResponsible ?? null,
    sourceId: profile.source?.id ?? null,
    sourceComment: profile.sourceComment ?? null,
    comment: profile.comment ?? "",
    gph: profile.gph ?? false,
    selfEmployed: profile.selfEmployed ?? false,
    unofficial: profile.unofficial ?? false,
    apprentice: profile.apprentice ?? false,
    internship: profile.internship ?? false,
    targetedContract: profile.targetedContract ?? false,
    contractTraining: profile.contractTraining ?? false,
    internshipStartDate: profile.internshipStartDate?.slice(0, 10) ?? null,
    internshipEndDate: profile.internshipEndDate?.slice(0, 10) ?? null,
    universityId: profile.university?.id ?? null,
    contacts: (profile.contacts ?? []).map(
      ({ rowNumber, typeId, kindId, presentation, comment }) => ({
        rowNumber,
        typeId,
        kindId,
        presentation,
        comment,
      }),
    ),
  };
}

export function candidateChangedFields(
  initial: CandidatePatchFieldsDto,
  current: CandidatePatchFieldsDto,
): CandidatePatchFieldsDto {
  const changed: CandidatePatchFieldsDto = Object.fromEntries(
    Object.entries(current).filter(
      ([key, value]) =>
        key !== "contacts" &&
        JSON.stringify(value) !==
          JSON.stringify(initial[key as keyof CandidatePatchFieldsDto]),
    ),
  );
  const contacts = current.contacts?.filter(
    (row) =>
      row.rowNumber == null ||
      JSON.stringify(row) !==
        JSON.stringify(
          initial.contacts?.find((old) => old.rowNumber === row.rowNumber),
        ),
  );
  if (contacts?.length) changed.contacts = contacts;
  return changed;
}

export function CandidateForm({
  profile,
  pending,
  locked,
  retryBlocked = false,
  error,
  onSubmit,
  onCancel,
  onOpenCandidate,
  compact = false,
}: {
  profile?: CandidateWorkspaceDto;
  pending: boolean;
  locked: boolean;
  retryBlocked?: boolean;
  error: string;
  onSubmit: (
    fields: CandidatePatchFieldsDto,
    personSelection?: string,
    ignoredSelections?: string[],
  ) => void;
  onCancel: () => void;
  onOpenCandidate?: (erpUid: string) => void;
  compact?: boolean;
}) {
  const [fields, setFields] = useState(() => candidateFormFields(profile));
  const [personEnabled, setPersonEnabled] = useState(false);
  const [personSelection, setPersonSelection] = useState<string>();
  const [selectedPersonUid, setSelectedPersonUid] = useState<string>();
  const [ignoredSelections, setIgnoredSelections] = useState<string[]>([]);
  const [managerQuery, setManagerQuery] = useState("");
  const [managerFallback, setManagerFallback] = useState(false);
  const [positionQuery, setPositionQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [identityQuery, setIdentityQuery] = useState("");
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
  const matchName = (fields.fullName ?? "").trim().replace(/\s+/g, " ");
  const identity = JSON.stringify([matchName, fields.phone, fields.birthDate]);
  useEffect(() => {
    setPersonSelection(undefined);
    setSelectedPersonUid(undefined);
    setIgnoredSelections([]);
    const timer = window.setTimeout(() => setIdentityQuery(identity), 500);
    return () => window.clearTimeout(timer);
  }, [identity]);
  const canCheckPerson =
    !profile &&
    identity === identityQuery &&
    (matchName.length >= 3 ||
      (fields.phone ?? "").replace(/\D/g, "").length >= 7);
  const matchParams = {
    scope: "creation" as const,
    fullName: matchName || undefined,
    phone: fields.phone || undefined,
    birthDate: fields.birthDate || undefined,
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
  const matchingCandidates = canCheckPerson
    ? (possiblePersons.data?.candidates ?? [])
    : [];
  const set = <K extends keyof CandidatePatchFieldsDto>(
    key: K,
    value: CandidatePatchFieldsDto[K],
  ) => setFields((previous) => ({ ...previous, [key]: value }));
  const selectedPerson = matchingPersons.find(
    (person) =>
      person.id === personSelection ||
      (!!selectedPersonUid && person.personUid === selectedPersonUid),
  );
  const selectPerson = (selection: string | undefined, personUid?: string) => {
    setPersonSelection(selection);
    setSelectedPersonUid(personUid);
    if (!selection) return;
    const samePerson = matchingPersons.find(
      (person) =>
        person.id === selection ||
        (!!personUid && person.personUid === personUid),
    );
    setIgnoredSelections((prev) =>
      prev.filter(
        (ignoredSelection) =>
          ignoredSelection !== selection &&
          ignoredSelection !== samePerson?.id &&
          !matchingCandidates.some(
            (candidate) =>
              samePerson?.candidateUids?.includes(candidate.id) &&
              candidate.selection === ignoredSelection,
          ),
      ),
    );
  };
  const ignored = (selection: string, value: boolean) => {
    const ignoredPerson = matchingPersons.find(
      (person) => person.id === selection,
    );
    const ignoredCandidate = matchingCandidates.find(
      (candidate) => candidate.selection === selection,
    );
    if (
      value &&
      (personSelection === selection ||
        (!!selectedPersonUid &&
          ignoredPerson?.personUid === selectedPersonUid) ||
        (ignoredCandidate &&
          selectedPerson?.candidateUids?.includes(ignoredCandidate.id)))
    )
      selectPerson(undefined);
    setIgnoredSelections((prev) =>
      value
        ? [...prev.filter((item) => item !== selection), selection]
        : prev.filter((item) => item !== selection),
    );
  };
  const unresolvedCandidates = matchingCandidates.some(
    (item) => !item.selection || !ignoredSelections.includes(item.selection),
  );
  const unresolvedPersons = matchingPersons.some(
    (person) =>
      personSelection !== person.id &&
      (!selectedPersonUid || person.personUid !== selectedPersonUid) &&
      !ignoredSelections.includes(person.id),
  );
  const relatedErrors = profile
    ? candidateRelatedFieldValidation(profile, fields).errors
    : [];
  const sourcePersonMissing =
    fields.sourceComment?.kind === "person" && !fields.sourceComment.id;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if ((sourcePersonMissing || relatedErrors.length > 0) && !locked) return;
    if (
      !profile &&
      !locked &&
      ((personEnabled && !personSelection) ||
        unresolvedCandidates ||
        unresolvedPersons)
    )
      return;
    onSubmit(fields, personSelection, ignoredSelections);
  };
  return (
    <form
      onSubmit={submit}
      className="space-y-5"
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
            required={!profile}
            maxLength={50}
            className={CANDIDATE_CONTROL}
            value={fields.fullName ?? ""}
            onChange={(event) => set("fullName", event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          Телефон
          <input
            required={!profile}
            type="tel"
            maxLength={40}
            className={CANDIDATE_CONTROL}
            value={fields.phone ?? ""}
            onChange={(event) => set("phone", event.target.value)}
          />
        </label>
        <label className="space-y-1 text-sm">
          Дата рождения{profile ? " · необязательно" : ""}
          <input
            required={!profile}
            type="date"
            className={CANDIDATE_CONTROL}
            value={fields.birthDate ?? ""}
            onChange={(event) => set("birthDate", event.target.value || null)}
          />
        </label>
        {profile && (
          <>
            <div className="space-y-1 text-sm">
              <p>Должность</p>
              <SearchSelect
                label="Должность"
                value={fields.positionCode}
                selectedLabel={profile.position?.name}
                options={(positions.data?.items ?? []).map((item) => ({
                  value: item.code ?? item.id,
                  label: item.name,
                }))}
                onSearchChange={setPositionQuery}
                onChange={(value) => set("positionCode", value ?? null)}
                isLoading={positions.isLoading}
                isError={positions.isError}
                onRetry={() => void positions.refetch()}
                disabled={pending || locked}
              />
            </div>
            <div className="space-y-1 text-sm">
              <p>Ведущий менеджер</p>
              <SearchSelect
                label="Менеджер"
                value={fields.managerId}
                selectedLabel={profile.manager?.name}
                options={managerOptions.map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
                onSearchChange={setManagerQuery}
                onChange={(value) => {
                  set("managerId", value ?? null);
                }}
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
                    className="text-[var(--primary)] underline"
                    onClick={() =>
                      void managers.refetch().then((result) => {
                        if (!result.isError) setManagerFallback(false);
                      })
                    }
                  >
                    Повторить загрузку справочника
                  </button>
                </p>
              )}
            </div>
            <div className="space-y-1 text-sm">
              <p>Объект</p>
              <SearchSelect
                label="Объект"
                value={fields.projectCode}
                selectedLabel={profile.project?.name}
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
          </>
        )}
      </fieldset>
      {profile && (
        <CandidateExpandedFields
          profile={profile}
          fields={fields}
          onChange={setFields}
          disabled={pending || locked}
        />
      )}
      {!profile && (
        <section
          className="space-y-3 border-t border-[var(--border)] pt-4"
          aria-label="Совпадения в ERP"
        >
          <p className="text-sm text-[var(--muted-foreground)]">
            Проверяем ФИО и телефон. Если кандидат уже есть в ERP, откройте его
            карточку. Статус сохранится; вернуть в «Подбор» можно вручную.
          </p>
          {canCheckPerson && possiblePersons.isLoading && (
            <p role="status">Проверка совпадений…</p>
          )}
          {canCheckPerson && possiblePersons.isError && (
            <p role="alert" className="text-sm text-[var(--danger)]">
              Не удалось проверить совпадения.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => void possiblePersons.refetch()}
              >
                Повторить проверку
              </button>
            </p>
          )}
          {matchingCandidates.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Существующие кандидаты</h3>
              {matchingCandidates.map((candidate) => (
                <div
                  key={candidate.id}
                  className="space-y-2 rounded-md bg-[var(--muted)] p-3 text-sm"
                >
                  <p className="font-medium">
                    {candidate.name} ·{" "}
                    {candidate.birthDate
                      ? formatBirthDateRu(candidate.birthDate)
                      : "Дата рождения не указана"}
                  </p>
                  <p className="text-[var(--muted-foreground)]">
                    Совпадение:{" "}
                    {[
                      candidate.matchedName && "ФИО",
                      candidate.matchedPhone && "телефон",
                      candidate.matchedBirthDate && "дата рождения",
                    ]
                      .filter(Boolean)
                      .join(", ") || "связанное физлицо"}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending || locked}
                    onClick={() => onOpenCandidate?.(candidate.id)}
                  >
                    Открыть существующую карточку
                  </Button>
                  {candidate.selection && (
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={ignoredSelections.includes(
                          candidate.selection,
                        )}
                        disabled={pending || locked}
                        onChange={(event) =>
                          ignored(candidate.selection!, event.target.checked)
                        }
                      />
                      Это другой человек · игнорировать совпадение
                    </label>
                  )}
                </div>
              ))}
            </div>
          )}
          {matchingPersons.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">Возможные физлица</h3>
              {matchingPersons.map((person) => (
                <div
                  key={person.id}
                  className="space-y-2 rounded-md bg-[var(--muted)] p-3 text-sm"
                >
                  <p className="font-medium">
                    {person.name} ·{" "}
                    {person.birthDate
                      ? formatBirthDateRu(person.birthDate)
                      : "Дата рождения не указана"}
                  </p>
                  <p className="text-[var(--muted-foreground)]">
                    Совпадение:{" "}
                    {[
                      person.matchedCyrillic && "ФИО",
                      person.matchedPhone && "телефон",
                      person.matchedBirthDate && "дата рождения",
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                  {(person.candidateUids ?? []).length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {person.candidateUids?.map((id) => (
                        <Button
                          key={id}
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={pending || locked}
                          onClick={() => onOpenCandidate?.(id)}
                        >
                          Открыть существующую карточку
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <label className="flex items-start gap-2">
                      <input
                        type="radio"
                        name="person-selection"
                        checked={
                          personSelection === person.id ||
                          (!!selectedPersonUid &&
                            person.personUid === selectedPersonUid)
                        }
                        disabled={pending || locked}
                        onChange={() => {
                          selectPerson(person.id, person.personUid);
                          setPersonEnabled(false);
                        }}
                      />
                      Подтверждаю: это нужный человек
                    </label>
                  )}
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={ignoredSelections.includes(person.id)}
                      disabled={pending || locked}
                      onChange={(event) =>
                        ignored(person.id, event.target.checked)
                      }
                    />
                    Это другой человек · игнорировать совпадение
                  </label>
                </div>
              ))}
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Выбрать другое физлицо"
              checked={personEnabled}
              disabled={pending || locked}
              onChange={(event) => {
                setPersonEnabled(event.target.checked);
                selectPerson(undefined);
              }}
            />
            Найти физлицо вручную
          </label>
          {personEnabled && (
            <CandidatePersonPicker
              key={identity}
              disabled={pending || locked}
              onChange={selectPerson}
              onOpenCandidate={onOpenCandidate}
            />
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
          {locked && " Данные и номер операции сохранены."}
        </p>
      )}
      <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
        <Button
          type="submit"
          size="sm"
          className="rounded-md"
          disabled={
            pending ||
            retryBlocked ||
            (!locked && (sourcePersonMissing || relatedErrors.length > 0)) ||
            (!profile &&
              !locked &&
              ((personEnabled && !personSelection) ||
                unresolvedCandidates ||
                unresolvedPersons))
          }
        >
          {pending
            ? "Сохранение…"
            : error && locked
              ? "Проверить результат сохранения"
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
