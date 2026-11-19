import { useRef, useState } from "react";
import {
  useGetCandidateOperation,
  getGetCandidateOperationQueryKey,
  type CandidateWorkspaceDto,
} from "@edo/api-client";

const candidateMessages: Record<string, string> = {
  INVALID_PERSON_MATCH_NAME:
    "ERP не приняла проверку совпадений. Проверьте обновление интеграции с карточками кандидатов у администратора 1С.",
  REQUIRED_FIELD_MISSING:
    "ERP требует дополнительные поля. Для создания по ФИО, телефону и дате рождения требуется обновление интеграции с карточками кандидатов. Обратитесь к администратору 1С.",
  CANDIDATE_DUPLICATE_REQUIRES_REVIEW:
    "В ERP найдены похожие кандидаты. Откройте подходящую карточку. Если это другой человек, подтвердите это у совпадения.",
  EXISTING_PERSON_REQUIRES_EXPLICIT_SELECTION:
    "В ERP найдено физлицо. Выберите нужного человека и подтвердите выбор. Если совпадение ложное, отметьте «Это другой человек».",
  CANDIDATE_PERSON_LINK_AMBIGUOUS:
    "У физлица несколько карточек кандидата. Проверьте совпадения и откройте нужную карточку.",
  PERSON_IDENTITY_AMBIGUOUS:
    "Найдено несколько физлиц. Выберите нужного человека по ФИО и дате рождения.",
  CURRENT_CANDIDATE_AMBIGUOUS:
    "ERP не определила единственную карточку кандидата. Откройте нужную карточку из совпадений.",
  CURRENT_CANDIDATE_CONFIRMATION_REQUIRED:
    "Подтвердите связь с существующей карточкой кандидата в ERP.",
  CANDIDATE_CONFIRMATION_REQUIRED:
    "Подтвердите связь с существующей карточкой кандидата в ERP.",
  CURRENT_CANDIDATE_UNAVAILABLE:
    "Карточка кандидата в ERP недоступна. Обновите данные или обратитесь к администратору 1С.",
  CANDIDATE_PERSON_LINK_CONFLICT:
    "Физлицо уже связано с другой карточкой кандидата. Откройте существующую карточку из совпадений.",
  PERSON_LINK_REQUIRED_OR_AMBIGUOUS:
    "ERP не определила физлицо для этой карточки. Выберите нужного человека и подтвердите связь.",
  DISPATCHER_NOT_CONFIGURED:
    "Диспетчер не назначен. Выберите диспетчера или проверьте настройки объекта в ERP.",
  DISPATCHER_EMAIL_NOT_CONFIGURED:
    "В ERP не указана почта диспетчера. Обратитесь к администратору 1С, затем повторите изменение статуса.",
  ARRIVAL_PLAN_STALE:
    "Условия плана изменились в ERP. Проверьте обновлённые данные и повторите сохранение.",
  RECENT_ARRIVAL_BLOCKS_PLAN:
    "В ERP уже зарегистрирован недавний заезд. Проверьте историю заездов кандидата.",
  ARRIVAL_PLAN_REQUIRED: "Заполните план заезда.",
  ARRIVAL_PROJECT_AND_DATE_REQUIRED: "Укажите объект и плановую дату заезда.",
  INVALID_ARRIVAL_PROJECT_OR_DATE: "Проверьте объект и плановую дату заезда.",
  ARRIVAL_PROJECT_OR_DATE_UNAVAILABLE:
    "Объект или плановая дата заезда недоступны в ERP. Проверьте их и повторите сохранение.",
  INVALID_ARRIVAL_PLAN: "Проверьте данные плана заезда.",
  INVALID_ARRIVAL_POSITION: "Выберите доступную должность из справочника ERP.",
  INVALID_ARRIVAL_EMPLOYMENT_METHOD: "Выберите доступный способ оформления.",
  INVALID_ARRIVAL_MEASUREMENTS: "Проверьте рост, размер одежды и размер обуви.",
  INVALID_ARRIVAL_DISPATCHER: "Выберите диспетчера из справочника физлиц ERP.",
  INVALID_SITE_ARRIVAL_DATE: "Проверьте дату прибытия на объект.",
  INVALID_ARRIVAL_PAY: "Проверьте вид оплаты и его параметры.",
  INVALID_ARRIVAL_CLASS: "Выберите доступный класс оплаты.",
  ARRIVAL_CLASS_PLUS_UNAVAILABLE: "Класс плюс недоступен для этой должности.",
  INVALID_ARRIVAL_RATE: "Укажите положительную ставку с точностью до сотых.",
  INVALID_ARRIVAL_AUP_RATE: "Проверьте ставку АУП.",
  INVALID_ARRIVAL_DIRECTOR_RATE: "Проверьте ставку директора и её верхний предел.",
  ARRIVAL_AUP_FORBIDDEN: "Выберите доступный вид оплаты. АУП сейчас недоступен.",
  ARRIVAL_DIRECTOR_FORBIDDEN:
    "Выберите доступный вид оплаты. Ставка директора сейчас недоступна.",
  INVALID_COMMENT: "Проверьте комментарий к изменению статуса.",
  OPERATION_RESULT_UNKNOWN:
    "ERP ещё не определила результат. Проверьте результат позже; данные и номер операции сохранены.",
  IDEMPOTENCY_CONFLICT:
    "ERP обнаружила другие данные с тем же номером операции. Повторное сохранение остановлено. Обратитесь к администратору.",
  STATUS_OWNED_BY_DISPATCH_OR_HR:
    "Этот статус устанавливает диспетчер или кадровая служба в ERP. Выберите другой статус.",
  REFERENCE_NOT_FOUND:
    "Выбранное значение больше не доступно в ERP. Повторно выберите значение из справочника.",
  CONTACT_KIND_TYPE_MISMATCH:
    "Вид контакта не соответствует типу. Выберите подходящий вид или очистите его.",
  CONTACT_KIND_NOT_FOUND:
    "Вид контакта не найден в ERP. Выберите его повторно из справочника.",
  INVALID_CONTACT_COMMENT:
    "Комментарий контакта должен содержать не более 100 символов.",
  INVALID_CONTACT_PRESENTATION:
    "Проверьте значение контакта и повторите сохранение.",
  INVALID_CONTACT_TYPE: "Выберите тип контакта из справочника ERP.",
  INVALID_CONTACT_ROW:
    "Строка контакта изменилась в ERP. Обновите карточку перед редактированием контактов.",
  INVALID_EXPECTED_INCOME:
    "Ожидаемый доход должен быть неотрицательным числом.",
  INVALID_INTERNSHIP_DATE_RANGE:
    "Окончание стажировки не может быть раньше её начала.",
  INVALID_SOURCE_COMMENT:
    "Проверьте комментарий к источнику: укажите текст или выберите физлицо.",
  SOURCE_COMMENT_REQUIRED: "Укажите комментарий к источнику кандидата.",
  SOURCE_REFERRER_REQUIRED:
    "Выберите физлицо, по рекомендации которого обратился кандидат.",
  INTERNSHIP_END_DATE_REQUIRED:
    "Для студента на практике укажите дату окончания практики.",
  INVALID_RESPONSIBLE:
    "Выберите ответственного из справочника пользователей или физлиц ERP.",
  RESPONSIBLE_NOT_FOUND:
    "Ответственный не найден в ERP. Повторно выберите его из справочника.",
  PERSON_SELECTION_REQUIRED:
    "Выберите физлицо и подтвердите, что это нужный человек.",
  CONTRADICTORY_DUPLICATE_SELECTION:
    "Нельзя одновременно выбрать человека и отметить его как ложное совпадение. Проверьте выбор.",
  INVALID_FULL_NAME: "Проверьте ФИО кандидата.",
  FULL_NAME_TOO_LONG: "ФИО должно содержать не более 50 символов.",
  INVALID_PHONE: "Проверьте номер телефона кандидата.",
  INVALID_BIRTH_DATE: "Укажите корректную дату рождения кандидата.",
};

function candidateErrorCode(error: unknown): string {
  const data = (
    error as {
      response?: { data?: { message?: string | string[]; code?: string } };
    }
  ).response?.data;
  const message = Array.isArray(data?.message)
    ? data.message.join(". ")
    : data?.message;
  return (
    data?.code ??
    message?.match(/(?:ERP_)?[A-Z][A-Z0-9_]{2,}/)?.[0] ??
    ""
  ).replace(/^ERP_/, "");
}

export function candidateError(
  error: unknown,
  fallback = "ERP не подтвердила операцию. Сначала проверьте результат сохранения.",
): string {
  const data = (
    error as {
      response?: { data?: { message?: string | string[]; code?: string } };
    }
  ).response?.data;
  const message = Array.isArray(data?.message)
    ? data.message.join(". ")
    : data?.message;
  const code = candidateErrorCode(error);
  if (code === "ACTOR_NOT_FOUND_OR_AMBIGUOUS")
    return "Пользователь 1С для вашей учётной записи не найден или не сопоставлен с физическим лицом в ERP. Обратитесь к администратору 1С.";
  return (
    candidateMessages[code] ?? message ?? fallback
  );
}

const definitiveCandidateConflicts = new Set([
  "CANDIDATE_DUPLICATE_REQUIRES_REVIEW",
  "EXISTING_PERSON_REQUIRES_EXPLICIT_SELECTION",
  "CANDIDATE_PERSON_LINK_AMBIGUOUS",
  "PERSON_IDENTITY_AMBIGUOUS",
  "CURRENT_CANDIDATE_AMBIGUOUS",
  "CURRENT_CANDIDATE_CONFIRMATION_REQUIRED",
  "CURRENT_CANDIDATE_UNAVAILABLE",
  "CANDIDATE_PERSON_LINK_CONFLICT",
  "PERSON_LINK_REQUIRED_OR_AMBIGUOUS",
  "DISPATCHER_NOT_CONFIGURED",
  "DISPATCHER_EMAIL_NOT_CONFIGURED",
  "ARRIVAL_PLAN_STALE",
  "RECENT_ARRIVAL_BLOCKS_PLAN",
]);

// Only definitive rejections permit a corrected operation with another ID.
export function isKnownCandidateRejection(cause: unknown): boolean {
  const response = (
    cause as {
      response?: {
        status?: number;
        data?: { message?: string; code?: string };
      };
    }
  ).response;
  const code = candidateErrorCode(cause);
  if (code.includes("IDEMPOTENCY_CONFLICT")) return false;
  return (
    [400, 403, 422].includes(response?.status ?? 0) ||
    (response?.status === 409 && definitiveCandidateConflicts.has(code))
  );
}

/** Holds the exact mutation and body until ERP has reported a definitive result. */
export function useCandidateRequest() {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [locked, setLocked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const uncertain = useRef(false);
  const conflict = useRef(false);
  const running = useRef(false);
  const savedOperation = useRef<() => Promise<CandidateWorkspaceDto>>();
  const operation = useGetCandidateOperation(requestId, {
    query: {
      queryKey: getGetCandidateOperationQueryKey(requestId),
      enabled: false,
      retry: false,
    },
  });
  const unlock = () => {
    uncertain.current = false;
    savedOperation.current = undefined;
    setLocked(false);
    setRequestId(crypto.randomUUID());
  };
  const fail = (cause: unknown, onRejected?: (code: string) => void) => {
    const code = candidateErrorCode(cause);
    setError(candidateError(cause));
    conflict.current = code === "IDEMPOTENCY_CONFLICT";
    setBlocked(conflict.current);
    if (isKnownCandidateRejection(cause)) {
      unlock();
      onRejected?.(code);
    } else uncertain.current = true;
  };
  return {
    requestId,
    locked,
    error,
    checking,
    blocked,
    execute: async (
      send: () => Promise<CandidateWorkspaceDto>,
      confirmed: (profile: CandidateWorkspaceDto) => Promise<void> | void,
      onRejected?: (code: string) => void,
    ) => {
      if (running.current || conflict.current) return;
      running.current = true;
      savedOperation.current ??= send;
      setLocked(true);
      setError("");
      try {
        if (uncertain.current) {
          setChecking(true);
          const result = await operation.refetch();
          if (result.isError || !result.data)
            throw result.error ?? new Error("Operation lookup failed");
          const outcome = result.data;
          if (outcome.state === "SUCCEEDED" && outcome.candidate) {
            await confirmed(outcome.candidate);
            return;
          }
          if (outcome.code?.includes("IDEMPOTENCY_CONFLICT")) {
            setError(
              candidateError({ response: { data: { code: outcome.code } } }),
            );
            conflict.current = true;
            setBlocked(true);
            return;
          }
          if (outcome.state === "REJECTED") {
            setError(
              outcome.code
                ? candidateError({ response: { data: { code: outcome.code } } })
                : "ERP отклонила операцию. Исправьте данные и повторите сохранение.",
            );
            unlock();
            onRejected?.(outcome.code?.replace(/^ERP_/, "") ?? "");
            return;
          }
          if (outcome.state !== "NOT_FOUND") {
            setError(
              "ERP ещё не определила результат. Проверьте результат позже; данные и номер операции сохранены.",
            );
            return;
          }
        }
        const profile = await savedOperation.current();
        await confirmed(profile);
      } catch (cause) {
        fail(cause, onRejected);
      } finally {
        running.current = false;
        setChecking(false);
      }
    },
  };
}
