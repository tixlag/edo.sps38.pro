import { useState } from "react";
import {
  useListCandidateCountries,
  useListCandidateOrganizations,
  useListCandidateSources,
  useListCandidateResponsibles,
  useListCandidateContactTypes,
  useListCandidateContactKinds,
  useListCandidateUniversities,
  type CandidatePatchFieldsDto,
  type CandidateWorkspaceDto,
  type CandidateReferenceDto,
} from "@edo/api-client";
import { Button } from "@edo/ui";
import { SearchSelect } from "./SearchSelect";
import { CANDIDATE_CONTROL } from "./CandidateForm";
import { candidateRelatedFieldValidation } from "../lib/candidate-related-fields";

export function CandidateExpandedFields({
  profile,
  fields,
  onChange,
  disabled,
}: {
  profile: CandidateWorkspaceDto;
  fields: CandidatePatchFieldsDto;
  onChange: (fields: CandidatePatchFieldsDto) => void;
  disabled: boolean;
}) {
  const validation = candidateRelatedFieldValidation(profile, fields);
  const commentKind = validation.isRecommendation
    ? "person"
    : (fields.sourceComment?.kind ??
      (fields.sourceId === "Другое" ? "text" : ""));
  const [countryQuery, setCountryQuery] = useState("");
  const [organizationQuery, setOrganizationQuery] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [responsibleQuery, setResponsibleQuery] = useState("");
  const [universityQuery, setUniversityQuery] = useState("");
  const countries = useListCandidateCountries({ q: countryQuery || undefined });
  const organizations = useListCandidateOrganizations({
    q: organizationQuery || undefined,
  });
  const sources = useListCandidateSources({ q: sourceQuery || undefined });
  const responsibles = useListCandidateResponsibles({
    q: responsibleQuery || undefined,
  });
  const universities = useListCandidateUniversities({
    q: universityQuery || undefined,
  });
  const contactTypes = useListCandidateContactTypes();
  const contactKinds = useListCandidateContactKinds();
  const set = <K extends keyof CandidatePatchFieldsDto>(
    key: K,
    value: CandidatePatchFieldsDto[K],
  ) => onChange({ ...fields, [key]: value });
  const referenceOptions = (items?: CandidateReferenceDto[]) =>
    (items ?? []).map((item) => ({ value: item.id, label: item.name }));
  const responsibleOptions = (responsibles.data?.items ?? [])
    .filter((item) => item.kind)
    .map((item) => ({
      value: `${item.kind}:${item.id}`,
      label: `${item.name} · ${item.kind === "user" ? "пользователь" : "физлицо"}`,
    }));
  const responsibleField = (
    key: "responsible" | "additionalResponsible",
    label: string,
  ) => {
    const value = fields[key];
    return (
      <div className="space-y-1 text-sm">
        <p>{label}</p>
        <SearchSelect
          label={label}
          value={value ? `${value.kind}:${value.id}` : null}
          selectedLabel={value?.name ?? value?.id}
          options={responsibleOptions}
          onSearchChange={setResponsibleQuery}
          onChange={(choice) => {
            const option = responsibles.data?.items.find(
              (item) => `${item.kind}:${item.id}` === choice,
            );
            set(
              key,
              option?.kind
                ? { kind: option.kind, id: option.id, name: option.name }
                : null,
            );
          }}
          disabled={disabled}
          isLoading={responsibles.isLoading}
          isError={responsibles.isError}
          onRetry={() => void responsibles.refetch()}
        />
      </div>
    );
  };
  return (
    <fieldset disabled={disabled} className="space-y-6">
      <section
        className="space-y-3 border-t border-[var(--border)] pt-4"
        aria-label="Личные данные"
      >
        <h3 className="font-medium">Личные данные</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <p>Гражданство</p>
            <SearchSelect
              label="Гражданство"
              value={fields.citizenship}
              selectedLabel={profile.citizenship?.toUpperCase()}
              options={(countries.data?.items ?? []).map((item) => ({
                value: item.code ?? item.id,
                label: item.name,
              }))}
              onSearchChange={setCountryQuery}
              onChange={(value) => set("citizenship", value ?? null)}
              disabled={disabled}
              isLoading={countries.isLoading}
              isError={countries.isError}
              onRetry={() => void countries.refetch()}
            />
          </div>
          <label className="space-y-1 text-sm">
            Пол
            <select
              className={CANDIDATE_CONTROL}
              value={fields.sex ?? ""}
              onChange={(event) =>
                set(
                  "sex",
                  event.target.value === "male"
                    ? "male"
                    : event.target.value === "female"
                      ? "female"
                      : null,
                )
              }
            >
              <option value="">Не указан</option>
              <option value="male">Мужской</option>
              <option value="female">Женский</option>
            </select>
          </label>
          <label className="space-y-1 text-sm sm:col-span-2">
            Населённый пункт
            <input
              className={CANDIDATE_CONTROL}
              maxLength={500}
              value={fields.settlement ?? ""}
              onChange={(event) =>
                set("settlement", event.target.value || null)
              }
            />
          </label>
        </div>
      </section>
      <section
        className="space-y-3 border-t border-[var(--border)] pt-4"
        aria-label="Работа и оформление"
      >
        <h3 className="font-medium">Работа и оформление</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <p>Организация</p>
            <SearchSelect
              label="Организация"
              value={fields.organizationId}
              selectedLabel={profile.organization?.name}
              options={referenceOptions(organizations.data?.items)}
              onSearchChange={setOrganizationQuery}
              onChange={(value) => set("organizationId", value ?? null)}
              disabled={disabled}
              isLoading={organizations.isLoading}
              isError={organizations.isError}
              onRetry={() => void organizations.refetch()}
            />
          </div>
          <label className="space-y-1 text-sm">
            Ожидаемый доход
            <input
              type="number"
              min={0}
              step="0.01"
              max={99999999.99}
              className={CANDIDATE_CONTROL}
              value={fields.expectedIncome ?? ""}
              onChange={(event) =>
                set(
                  "expectedIncome",
                  event.target.value === "" ? null : Number(event.target.value),
                )
              }
            />
          </label>
          {responsibleField("responsible", "Ответственный")}
          {responsibleField(
            "additionalResponsible",
            "Дополнительный ответственный",
          )}
          <div className="space-y-1 text-sm">
            <p>Источник</p>
            <SearchSelect
              label="Источник"
              value={fields.sourceId}
              selectedLabel={profile.source?.name}
              options={referenceOptions(sources.data?.items)}
              onSearchChange={setSourceQuery}
              onChange={(value) => {
                const sourceId = value ?? null;
                if (sourceId !== (fields.sourceId ?? null))
                  onChange({ ...fields, sourceId, sourceComment: null });
              }}
              disabled={disabled}
              isLoading={sources.isLoading}
              isError={sources.isError}
              onRetry={() => void sources.refetch()}
            />
          </div>
          <div className="space-y-2 text-sm">
            <label className="block space-y-1">
              Комментарий к источнику
              {validation.sourceCommentRequired ? " · обязательно" : ""}
              <select
                aria-label="Тип комментария к источнику"
                className={CANDIDATE_CONTROL}
                value={commentKind}
                disabled={validation.isRecommendation}
                onChange={(event) =>
                  set(
                    "sourceComment",
                    event.target.value === "text"
                      ? { kind: "text", text: "" }
                      : event.target.value === "person"
                        ? { kind: "person", id: "" }
                        : null,
                  )
                }
              >
                <option value="">Не указан</option>
                <option value="text">Текст</option>
                <option value="person">Физлицо</option>
              </select>
            </label>
            {commentKind === "text" && (
              <input
                aria-label="Текст комментария к источнику"
                maxLength={200}
                className={CANDIDATE_CONTROL}
                required={
                  validation.sourceChanged && validation.sourceCommentRequired
                }
                value={
                  fields.sourceComment?.kind === "text"
                    ? (fields.sourceComment.text ?? "")
                    : ""
                }
                onChange={(event) =>
                  set("sourceComment", {
                    kind: "text",
                    text: event.target.value,
                  })
                }
              />
            )}
            {commentKind === "person" && (
              <SearchSelect
                label="Физлицо в источнике"
                value={
                  fields.sourceComment?.kind === "person"
                    ? fields.sourceComment.id
                    : null
                }
                selectedLabel={
                  fields.sourceComment?.kind === "person"
                    ? (fields.sourceComment.name ?? fields.sourceComment.id)
                    : undefined
                }
                options={referenceOptions(
                  responsibles.data?.items.filter(
                    (item) => item.kind === "person",
                  ),
                )}
                onSearchChange={setResponsibleQuery}
                onChange={(value) => {
                  const person = responsibles.data?.items.find(
                    (item) => item.id === value && item.kind === "person",
                  );
                  set(
                    "sourceComment",
                    person
                      ? { kind: "person", id: person.id, name: person.name }
                      : null,
                  );
                }}
                disabled={disabled}
                isLoading={responsibles.isLoading}
                isError={responsibles.isError}
                onRetry={() => void responsibles.refetch()}
              />
            )}
          </div>
          {fields.sourceComment?.kind === "person" &&
            !fields.sourceComment.id && (
              <p
                role="status"
                className="text-sm text-[var(--danger)] sm:col-span-2"
              >
                Выберите физлицо в источнике или очистите тип комментария.
              </p>
            )}
        </div>
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          {(
            [
              ["gph", "ГПХ"],
              ["selfEmployed", "Самозанятый"],
              ["unofficial", "Неофициальное оформление"],
              ["apprentice", "Ученик"],
              ["internship", "Студент на практике"],
              ["targetedContract", "Целевой договор"],
              ["contractTraining", "Обучение по договору"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={fields[key] ?? false}
                onChange={(event) => set(key, event.target.checked)}
              />
              {label}
            </label>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            Начало практики
            <input
              type="date"
              className={CANDIDATE_CONTROL}
              value={fields.internshipStartDate ?? ""}
              onChange={(event) =>
                set("internshipStartDate", event.target.value || null)
              }
            />
          </label>
          <label className="space-y-1 text-sm">
            Окончание практики{fields.internship ? " · обязательно" : ""}
            <input
              type="date"
              className={CANDIDATE_CONTROL}
              required={validation.practiceChanged && !!fields.internship}
              value={fields.internshipEndDate ?? ""}
              onChange={(event) =>
                set("internshipEndDate", event.target.value || null)
              }
            />
          </label>
          <div className="space-y-1 text-sm sm:col-span-2">
            <p>Учебное заведение</p>
            <SearchSelect
              label="Учебное заведение"
              value={fields.universityId}
              selectedLabel={profile.university?.name}
              options={referenceOptions(universities.data?.items)}
              onSearchChange={setUniversityQuery}
              onChange={(value) => set("universityId", value ?? null)}
              disabled={disabled}
              isLoading={universities.isLoading}
              isError={universities.isError}
              onRetry={() => void universities.refetch()}
            />
          </div>
        </div>
        {validation.errors.map((message) => (
          <p
            key={message}
            role="alert"
            className="text-sm text-[var(--danger)]"
          >
            {message}
          </p>
        ))}
        <label className="block space-y-1 text-sm">
          Комментарий
          <textarea
            className={CANDIDATE_CONTROL}
            rows={3}
            maxLength={10000}
            value={fields.comment ?? ""}
            onChange={(event) => set("comment", event.target.value)}
          />
        </label>
      </section>
      <section
        className="space-y-3 border-t border-[var(--border)] pt-4"
        aria-label="Контактная информация"
      >
        <h3 className="font-medium">Контактная информация</h3>
        <p className="text-sm text-[var(--muted-foreground)]">
          Сохраняются только изменённые строки. Остальные контакты останутся в
          ERP.
        </p>
        {contactTypes.isError || contactKinds.isError ? (
          <p role="alert" className="text-sm text-[var(--danger)]">
            Не удалось загрузить типы контактов.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => {
                void contactTypes.refetch();
                void contactKinds.refetch();
              }}
            >
              Повторить
            </button>
          </p>
        ) : null}
        {(fields.contacts ?? []).map((contact, index) => {
          const update = (changes: Partial<typeof contact>) =>
            set(
              "contacts",
              fields.contacts?.map((row, i) =>
                i === index ? { ...row, ...changes } : row,
              ),
            );
          return (
            <div
              key={contact.rowNumber ?? `new-${index}`}
              className="grid gap-3 rounded-md bg-[var(--muted)] p-3 sm:grid-cols-2"
              aria-label={`Контакт ${index + 1}`}
            >
              <label className="space-y-1 text-sm">
                Тип
                <select
                  className={CANDIDATE_CONTROL}
                  value={contact.typeId}
                  required={contact.rowNumber == null}
                  onChange={(event) =>
                    update({ typeId: event.target.value, kindId: null })
                  }
                >
                  <option value="">Выберите тип</option>
                  {!(contactTypes.data?.items ?? []).some(
                    (item) => item.id === contact.typeId,
                  ) &&
                    contact.typeId && (
                      <option value={contact.typeId}>{contact.typeId}</option>
                    )}
                  {contactTypes.data?.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                Вид
                <select
                  className={CANDIDATE_CONTROL}
                  value={contact.kindId ?? ""}
                  onChange={(event) =>
                    update({ kindId: event.target.value || null })
                  }
                >
                  <option value="">Не указан</option>
                  {contact.kindId &&
                    !(contactKinds.data?.items ?? []).some(
                      (item) => item.id === contact.kindId,
                    ) && (
                      <option value={contact.kindId}>{contact.kindId}</option>
                    )}
                  {contactKinds.data?.items
                    .filter(
                      (item) => !item.typeId || item.typeId === contact.typeId,
                    )
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                Значение
                <input
                  required={contact.rowNumber == null}
                  className={CANDIDATE_CONTROL}
                  maxLength={200}
                  value={contact.presentation}
                  onChange={(event) =>
                    update({ presentation: event.target.value })
                  }
                />
              </label>
              <label className="space-y-1 text-sm">
                Комментарий
                <input
                  className={CANDIDATE_CONTROL}
                  maxLength={100}
                  value={contact.comment ?? ""}
                  onChange={(event) => update({ comment: event.target.value })}
                />
              </label>
              {contact.rowNumber == null && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() =>
                    set(
                      "contacts",
                      fields.contacts?.filter((_row, i) => i !== index),
                    )
                  }
                >
                  Убрать новый контакт
                </Button>
              )}
            </div>
          );
        })}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() =>
            set("contacts", [
              ...(fields.contacts ?? []),
              { typeId: "", presentation: "" },
            ])
          }
        >
          Добавить контакт
        </Button>
      </section>
    </fieldset>
  );
}
