import { HttpException } from "@nestjs/common";
import {
  CandidateDocumentErrorCode as Code,
  CandidateProfileField,
} from "./dto/candidate-error.dto";

const definitions: Record<Code, [number, boolean, string]> = {
  AUTH_REQUIRED: [
    401,
    false,
    "Сессия закончилась. Войдите в личный кабинет заново.",
  ],
  EMPLOYEE_IDENTITY_REQUIRED: [
    403,
    false,
    "В учётной записи не указан код сотрудника. Обратитесь к ответственному за оформление.",
  ],
  EMPLOYEE_IDENTITY_INVALID: [
    403,
    false,
    "В учётной записи указан некорректный код сотрудника. Обратитесь к ответственному за оформление.",
  ],
  CANDIDATE_LINK_MISSING: [
    409,
    false,
    "Учётная запись не связана с кандидатом. Обратитесь к ответственному за оформление.",
  ],
  CANDIDATE_CHAT_NOT_FOUND: [
    404,
    false,
    "Кандидат по этой ссылке не найден. Запросите новую ссылку у ответственного за оформление.",
  ],
  ERP_CANDIDATE_NOT_FOUND: [
    404,
    false,
    "Карточка кандидата не найдена в 1С. Обратитесь к ответственному за оформление.",
  ],
  CANDIDATE_PROFILE_INCOMPLETE: [
    422,
    false,
    "В карточке 1С не заполнены обязательные данные. Обратитесь к ответственному за оформление.",
  ],
  LK_CONTRACT_ERROR: [
    502,
    false,
    "Личный кабинет вернул некорректные данные сотрудника. Сообщите ответственному за оформление.",
  ],
  ERP_CONTRACT_ERROR: [
    502,
    false,
    "1С вернула некорректную карточку кандидата. Сообщите ответственному за оформление.",
  ],
  LK_UNAVAILABLE: [
    503,
    true,
    "Личный кабинет временно недоступен. Повторите загрузку позже.",
  ],
  ERP_UNAVAILABLE: [
    503,
    true,
    "1С временно недоступна. Повторите загрузку позже.",
  ],
  LK_TIMEOUT: [
    504,
    true,
    "Личный кабинет не ответил вовремя. Повторите загрузку позже.",
  ],
  ERP_TIMEOUT: [504, true, "1С не ответила вовремя. Повторите загрузку позже."],
  DOCUMENTS_TIMEOUT: [
    504,
    true,
    "Не удалось загрузить документы за отведённое время. Повторите загрузку позже.",
  ],
  DOCUMENT_CATALOG_UNAVAILABLE: [
    503,
    true,
    "Каталог документов временно недоступен. Повторите загрузку позже.",
  ],
  DOCUMENTS_INTEGRATION_MISCONFIGURED: [
    503,
    false,
    "Сервис документов не настроен. Сообщите ответственному за оформление.",
  ],
  DOCUMENT_REQUEST_INVALID: [
    400,
    false,
    "Некорректный запрос документов. Обновите страницу и сообщите об ошибке, если она повторится.",
  ],
  DOCUMENT_ACCESS_DENIED: [
    403,
    false,
    "Нет доступа к этому документу. Обратитесь к ответственному за оформление.",
  ],
  DOCUMENT_NOT_FOUND: [
    404,
    false,
    "Документ не найден. Обновите список документов.",
  ],
  DOCUMENT_CONFLICT: [
    409,
    false,
    "Состояние документа изменилось. Обновите список документов.",
  ],
  DOCUMENTS_UNAVAILABLE: [
    503,
    true,
    "Документы временно недоступны. Повторите загрузку позже.",
  ],
};

export class CandidateDocumentError extends HttpException {
  constructor(
    readonly code: Code,
    readonly fields?: CandidateProfileField[],
    readonly diagnostic?: {
      source: "LK" | "ERP" | "catalog";
      upstreamStatus?: number;
      durationMs: number;
    },
  ) {
    const [status, retryable, defaultMessage] = definitions[code];
    const labels = fields?.map((field) =>
      field === CandidateProfileField.CITIZENSHIP ? "гражданство" : "должность",
    );
    const message = labels?.length
      ? `В карточке 1С не заполнены: ${labels.join(", ")}. Обратитесь к ответственному за оформление.`
      : defaultMessage;
    super(
      { code, message, retryable, ...(fields?.length ? { fields } : {}) },
      status,
    );
  }
}

/** Bound a caller's wait without cancelling shared cache/catalog work. */
export function withinDocumentDeadline<T>(
  request: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new CandidateDocumentError(Code.DOCUMENTS_TIMEOUT));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
