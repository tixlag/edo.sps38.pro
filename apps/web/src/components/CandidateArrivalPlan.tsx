import { useEffect, useRef, useState } from "react";
import {
  getGetCandidateArrivalPlanNotificationsQueryKey,
  getGetCandidateArrivalPlanQueryKey,
  getSearchCandidatePersonsQueryKey,
  useGetCandidateArrivalPlan,
  useGetCandidateArrivalPlanNotifications,
  useListCandidatePositions,
  useListCandidateProjects,
  useSearchCandidatePersons,
  type CandidateArrivalPlanDto,
  type CandidateStatusRequestDto,
} from "@edo/api-client";
import { Button } from "@edo/ui";
import { formatBirthDateRu } from "../lib/review-groups";
import { candidateError } from "../lib/use-candidate-request";
import { CANDIDATE_CONTROL } from "./CandidateForm";
import { SearchSelect } from "./SearchSelect";

type PlanContext = CandidateArrivalPlanDto;
type PlanRequest = NonNullable<CandidateStatusRequestDto["arrivalPlan"]>;
type Choice = { value: string; label: string };
type TextField =
  | "plannedArrivalDate"
  | "siteArrivalDate"
  | "employmentMethod"
  | "departurePoint"
  | "height"
  | "clothingSize"
  | "shoeSize";
type PayKind = PlanRequest["pay"]["kind"];
type PayFields = {
  payKind: PayKind | "";
  classId: string;
  classPlus: boolean;
  aupRate: string;
  directorRate: string;
};
type Draft = Partial<
  Record<TextField, string> &
    PayFields & {
      project: Choice | null;
      position: Choice | null;
      dispatcher: Choice;
    }
>;

const referenceChoice = (value: PlanContext["project"]): Choice | null =>
  value && { value: value.code, label: value.name };
const payKinds: Record<PayKind, string> = {
  class: "Класс оплаты",
  aup: "АУП",
  director: "Ставка директора",
};

function planPay(
  context: PlanContext,
  { payKind, classId, classPlus, aupRate, directorRate }: PayFields,
): PlanRequest["pay"] | undefined {
  if (payKind === "class" && context.classes.some(({ id }) => id === classId)) {
    return {
      kind: "class",
      classId,
      classPlus: context.allowsClassPlus && classPlus,
    };
  }
  if (
    (payKind === "aup" && context.allowsAup) ||
    (payKind === "director" && context.allowsDirector)
  ) {
    const input = payKind === "aup" ? aupRate : directorRate;
    const rate = Number(input);
    if (
      !/^\d*(?:\.\d{1,2})?$/.test(input) ||
      !Number.isFinite(rate) ||
      rate <= 0
    ) {
      return undefined;
    }
    if (
      payKind === "director" &&
      context.directorRateLimit != null &&
      rate > context.directorRateLimit
    ) {
      return undefined;
    }
    return { kind: payKind, rate };
  }
}

export function useCandidateArrivalPlanDraft(
  candidateId: string,
  enabled: boolean,
) {
  const [draft, setDraft] = useState<Draft>({});
  const lastContext = useRef<PlanContext>();
  const params = {
    projectCode: draft.project?.value,
    positionCode: draft.position?.value,
    dispatcherId: draft.dispatcher?.value,
  };
  const contextQuery = useGetCandidateArrivalPlan(candidateId, params, {
    query: {
      queryKey: getGetCandidateArrivalPlanQueryKey(candidateId, params),
      enabled,
      refetchOnWindowFocus: false,
    },
  });
  const context = contextQuery.data ?? lastContext.current;
  useEffect(() => {
    if (contextQuery.data && !contextQuery.isError) {
      lastContext.current = contextQuery.data;
    }
  }, [contextQuery.data, contextQuery.isError]);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((previous) => ({
      ...previous,
      ...(key === "project" ? { dispatcher: undefined } : {}),
      [key]: value,
    }));
  };
  const project =
    draft.project === undefined
      ? referenceChoice(context?.project ?? null)
      : draft.project;
  const position =
    draft.position === undefined
      ? referenceChoice(context?.position ?? null)
      : draft.position;
  const dispatcher =
    draft.dispatcher ??
    (context?.dispatcher
      ? { value: context.dispatcher.id, label: context.dispatcher.name }
      : null);
  const values = {
    plannedArrivalDate:
      draft.plannedArrivalDate ??
      context?.plannedArrivalDate?.slice(0, 10) ??
      "",
    siteArrivalDate:
      draft.siteArrivalDate ?? context?.siteArrivalDate?.slice(0, 10) ?? "",
    employmentMethod: draft.employmentMethod ?? context?.employmentMethod ?? "",
    departurePoint: draft.departurePoint ?? context?.departurePoint ?? "",
    height: draft.height ?? context?.height ?? "",
    clothingSize: draft.clothingSize ?? context?.clothingSize ?? "",
    shoeSize: draft.shoeSize ?? context?.shoeSize ?? "",
  };
  const defaultPay = context?.pay;
  const payFields: PayFields = {
    payKind: draft.payKind ?? defaultPay?.kind ?? "",
    classId:
      draft.classId ??
      (defaultPay?.kind === "class" ? (defaultPay.classId ?? "") : ""),
    classPlus:
      draft.classPlus ??
      (defaultPay?.kind === "class" && defaultPay.classPlus === true),
    aupRate:
      draft.aupRate ??
      (defaultPay?.kind === "aup" ? String(defaultPay.rate ?? "") : ""),
    directorRate:
      draft.directorRate ??
      (defaultPay?.kind === "director" ? String(defaultPay.rate ?? "") : ""),
  };
  const pay = context && planPay(context, payFields);
  const contextReady =
    Boolean(contextQuery.data) &&
    !contextQuery.isError &&
    !contextQuery.isFetching;
  const data:
    | Pick<
        CandidateStatusRequestDto,
        "projectCode" | "plannedArrivalDate" | "arrivalPlan"
      >
    | undefined =
    context &&
    contextReady &&
    project?.value &&
    position?.value &&
    dispatcher?.value &&
    values.plannedArrivalDate &&
    context.employmentMethods.some(
      ({ id }) => id === values.employmentMethod,
    ) &&
    pay
      ? {
          projectCode: project.value,
          plannedArrivalDate: values.plannedArrivalDate,
          arrivalPlan: {
            version: context.version,
            positionCode: position.value,
            siteArrivalDate: values.siteArrivalDate || null,
            employmentMethod: values.employmentMethod,
            departurePoint: values.departurePoint.trim(),
            height: values.height.trim(),
            clothingSize: values.clothingSize.trim(),
            shoeSize: values.shoeSize.trim(),
            dispatcherId: dispatcher.value,
            pay,
          },
        }
      : undefined;
  return {
    data,
    context,
    contextQuery,
    set,
    project,
    position,
    dispatcher,
    values,
    payFields,
    contextReady,
  };
}

export function CandidateArrivalPlanFields({
  plan,
  disabled,
}: {
  plan: ReturnType<typeof useCandidateArrivalPlanDraft>;
  disabled: boolean;
}) {
  const {
    context,
    contextQuery,
    contextReady,
    set,
    project,
    position,
    dispatcher,
    values,
    payFields,
  } = plan;
  const [projectSearch, setProjectSearch] = useState("");
  const [positionSearch, setPositionSearch] = useState("");
  const [dispatcherSearch, setDispatcherSearch] = useState("");
  const projects = useListCandidateProjects({ q: projectSearch || undefined });
  const positions = useListCandidatePositions({
    q: positionSearch || undefined,
  });
  const personParams = { q: dispatcherSearch.trim() || undefined };
  const canSearchDispatcher = (personParams.q?.length ?? 0) >= 3;
  const people = useSearchCandidatePersons(personParams, {
    query: {
      queryKey: getSearchCandidatePersonsQueryKey(personParams),
      enabled: canSearchDispatcher && !disabled,
      refetchOnWindowFocus: false,
    },
  });
  const dispatcherOptions = (
    canSearchDispatcher ? (people.data?.items ?? []) : []
  ).flatMap((person) => {
    const id =
      person.personUid ?? (person.kind === "person" ? person.id : undefined);
    const birthDate = formatBirthDateRu(person.birthDate);
    return id
      ? [
          {
            value: id,
            label: birthDate ? `${person.name} · ${birthDate}` : person.name,
          },
        ]
      : [];
  });
  const projectOptions = (projects.data?.items ?? []).map((item) => ({
    value: item.code ?? item.id,
    label: item.name,
  }));
  const positionOptions = (positions.data?.items ?? []).map((item) => ({
    value: item.code ?? item.id,
    label: item.name,
  }));
  const textInput = (
    name: Exclude<TextField, "employmentMethod">,
    label: string,
    type: "text" | "date" = "text",
    maxLength?: number,
  ) => (
    <label className="block min-w-0 space-y-1">
      {label}
      <input
        name={name}
        type={type}
        maxLength={maxLength}
        required={name === "plannedArrivalDate"}
        className={CANDIDATE_CONTROL}
        value={values[name]}
        onChange={(event) => set(name, event.target.value)}
      />
    </label>
  );
  const director = payFields.payKind === "director";
  const rateField = director ? "directorRate" : "aupRate";
  const rateLimit = director ? context?.directorRateLimit : null;
  const rateExceedsLimit =
    rateLimit != null && Number(payFields[rateField]) > rateLimit;

  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-3 rounded-lg border border-[var(--border)] p-3 text-sm"
    >
      <legend className="px-1 font-medium">План заезда</legend>
      {contextQuery.isFetching && (
        <p role="status" className="text-[var(--muted-foreground)]">
          {context
            ? "Обновляем условия плана из ERP…"
            : "Загружаем данные плана из ERP…"}
        </p>
      )}
      {contextQuery.isError && (
        <div role="alert" className="space-y-2 text-[var(--danger)]">
          <p>
            Не удалось обновить данные плана.{" "}
            {contextQuery.error && candidateError(contextQuery.error)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void contextQuery.refetch()}
          >
            Повторить загрузку плана
          </Button>
        </div>
      )}
      {context && (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <p>Объект для заявки</p>
              <SearchSelect
                label="Объект для заявки"
                value={project?.value}
                selectedLabel={project?.label}
                options={projectOptions}
                disabled={disabled}
                onSearchChange={setProjectSearch}
                onChange={(value) =>
                  set(
                    "project",
                    projectOptions.find((item) => item.value === value) ?? null,
                  )
                }
                isLoading={projects.isLoading}
                isError={projects.isError}
                onRetry={() => void projects.refetch()}
              />
            </div>
            <div className="min-w-0 space-y-1">
              <p>Должность</p>
              <SearchSelect
                label="Должность"
                value={position?.value}
                selectedLabel={position?.label}
                options={positionOptions}
                disabled={disabled}
                onSearchChange={setPositionSearch}
                onChange={(value) =>
                  set(
                    "position",
                    positionOptions.find((item) => item.value === value) ??
                      null,
                  )
                }
                isLoading={positions.isLoading}
                isError={positions.isError}
                onRetry={() => void positions.refetch()}
              />
            </div>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {textInput("plannedArrivalDate", "Плановая дата заезда", "date")}
            {textInput(
              "siteArrivalDate",
              "Дата прибытия на объект · необязательно",
              "date",
            )}
          </div>
          <label className="block space-y-1">
            Способ оформления
            <select
              name="employmentMethod"
              required
              className={CANDIDATE_CONTROL}
              value={values.employmentMethod}
              onChange={(event) => set("employmentMethod", event.target.value)}
            >
              <option value="">Выберите способ оформления</option>
              {context.employmentMethods.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          {textInput("departurePoint", "Пункт отправления", "text", 300)}
          <div className="grid gap-3 sm:grid-cols-3">
            {textInput("height", "Рост", "text", 50)}
            {textInput("clothingSize", "Размер одежды", "text", 50)}
            {textInput("shoeSize", "Размер обуви", "text", 50)}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <label className="block min-w-0 space-y-1">
              Вид оплаты
              <select
                name="payKind"
                required
                className={CANDIDATE_CONTROL}
                value={payFields.payKind}
                onChange={(event) =>
                  set("payKind", event.target.value as PayFields["payKind"])
                }
              >
                <option value="">Выберите вид оплаты</option>
                <option value="class">{payKinds.class}</option>
                <option value="aup" disabled={!context.allowsAup}>
                  {payKinds.aup}
                </option>
                <option value="director" disabled={!context.allowsDirector}>
                  {payKinds.director}
                </option>
              </select>
            </label>
            {payFields.payKind === "class" && (
              <label className="block min-w-0 space-y-1">
                Класс оплаты
                <select
                  name="classId"
                  required
                  className={CANDIDATE_CONTROL}
                  value={payFields.classId}
                  onChange={(event) => set("classId", event.target.value)}
                >
                  <option value="">Выберите класс</option>
                  {context.classes.map(({ id, name }) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(payFields.payKind === "aup" || director) && (
              <label className="block min-w-0 space-y-1">
                {director ? "Ставка директора" : "Ставка АУП"}
                <input
                  name={rateField}
                  type="number"
                  required
                  min="0.01"
                  step="0.01"
                  max={rateLimit ?? undefined}
                  inputMode="decimal"
                  className={CANDIDATE_CONTROL}
                  value={payFields[rateField]}
                  aria-invalid={rateExceedsLimit || undefined}
                  onChange={(event) => set(rateField, event.target.value)}
                />
                {rateLimit != null && (
                  <span
                    className={
                      rateExceedsLimit
                        ? "text-[var(--danger)]"
                        : "text-[var(--muted-foreground)]"
                    }
                  >
                    Максимальная ставка {rateLimit.toLocaleString("ru-RU")}
                  </span>
                )}
              </label>
            )}
          </div>
          {payFields.payKind === "class" && context.allowsClassPlus && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={payFields.classPlus}
                onChange={(event) => set("classPlus", event.target.checked)}
              />
              Класс плюс
            </label>
          )}
          {((payFields.payKind === "aup" && !context.allowsAup) ||
            (director && !context.allowsDirector)) && (
            <p role="status" className="text-[var(--muted-foreground)]">
              Этот вид оплаты недоступен. Выберите другой.
            </p>
          )}
          <div className="space-y-1">
            <p>Диспетчер</p>
            <SearchSelect
              label="Диспетчер"
              placeholder="Поиск по ФИО"
              value={dispatcher?.value}
              selectedLabel={dispatcher?.label}
              options={dispatcherOptions}
              onSearchChange={setDispatcherSearch}
              onChange={(value) =>
                set(
                  "dispatcher",
                  dispatcherOptions.find((item) => item.value === value),
                )
              }
              disabled={disabled}
              emptyText={
                canSearchDispatcher
                  ? "Физлица не найдены"
                  : "Введите не менее 3 символов ФИО"
              }
              isLoading={canSearchDispatcher && people.isLoading}
              isError={canSearchDispatcher && people.isError}
              onRetry={() => void people.refetch()}
            />
            {contextReady && (
              <p className="break-words text-[var(--muted-foreground)]">
                {dispatcher
                  ? `Получатель по роли «Диспетчер»: ${context.dispatcher?.name ?? dispatcher.label}`
                  : "Диспетчер для этого объекта не назначен. Выберите его по ФИО."}
              </p>
            )}
          </div>
          {contextReady && context.recipients.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium">Получатели уведомлений</p>
              <ul className="space-y-1 text-[var(--muted-foreground)]">
                {context.recipients.map(({ name, roles }, index) => (
                  <li key={`${name}-${index}`} className="break-words">
                    {name}
                    {roles.length > 0 && ` · ${roles.join(", ")}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}

const deliveryChannels = { lk: "ЛК", erp: "ERP", email: "Электронная почта" };
const deliveryStatuses: Record<string, string> = {
  PENDING: "Ожидает отправки",
  SENDING: "Отправляется",
  ACCEPTED: "Принято ЛК",
  SENT: "Отправлено",
  FAILED: "Ошибка отправки",
  UNKNOWN: "Результат отправки неизвестен",
  UNRESOLVED: "Получатель не сопоставлен",
};

export function CandidateArrivalPlanNotifications({
  candidateId,
  requestId,
}: {
  candidateId: string;
  requestId: string;
}) {
  const delivery = useGetCandidateArrivalPlanNotifications(
    candidateId,
    requestId,
    {
      query: {
        queryKey: getGetCandidateArrivalPlanNotificationsQueryKey(
          candidateId,
          requestId,
        ),
        refetchOnWindowFocus: false,
        refetchInterval: (query) =>
          query.state.data?.items.some(({ status }) =>
            ["PENDING", "SENDING"].includes(status.toUpperCase()),
          )
            ? 5_000
            : false,
      },
    },
  );
  return (
    <section
      aria-label="Уведомления о плане заезда"
      className="space-y-2 rounded-lg border border-[var(--border)] p-3 text-sm"
    >
      <h3 className="font-medium">Уведомления о плане заезда</h3>
      <div aria-live="polite">
        {delivery.isLoading && <p>Загружаем результаты отправки…</p>}
        {delivery.isError && (
          <p role="alert">Не удалось получить результаты отправки.</p>
        )}
        {delivery.data &&
          (delivery.data.items.length === 0 ? (
            <p>Сведений о доставке пока нет.</p>
          ) : (
            <ul className="space-y-1">
              {delivery.data.items.map(({ name, channel, status }, index) => (
                <li key={`${name}-${channel}-${index}`} className="break-words">
                  {name} · {deliveryChannels[channel]} ·{" "}
                  {deliveryStatuses[status.toUpperCase()] ??
                    "Статус доставки неизвестен"}
                </li>
              ))}
            </ul>
          ))}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={delivery.isFetching}
        onClick={() => void delivery.refetch()}
      >
        Обновить сведения о доставке
      </Button>
    </section>
  );
}
