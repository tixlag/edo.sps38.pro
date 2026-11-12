/**
 * Human readable reasons of a failed ERP delivery.
 *
 * The technical machine code stays a diagnostic (admins only), but a reviewer
 * must see a plain explanation. The phrases are fixed and contain no personal
 * data, an unknown code never produces a message.
 */
const ERP_DELIVERY_ERROR_REASONS: Record<string, string> = {
  ERP_INVALID_FILE_CONTENT: "1С отклонила файл: некорректный формат",
  ERP_INVALID_METADATA: "1С отклонила метаданные документа",
  ERP_INVALID_DOCUMENT_FIELDS: "1С отклонила реквизиты документа",
  ERP_INVALID_FILE_HASH: "1С отклонила файл: не совпала контрольная сумма",
  ERP_INVALID_FILE_SIZE: "1С отклонила файл: неверный размер",
  ERP_UNSUPPORTED_FILE_FORMAT: "1С не поддерживает формат файла",
  ERP_FILE_TYPE_MISMATCH:
    "1С отклонила файл: тип файла не соответствует содержимому",
  ERP_DOCUMENT_ALREADY_EXISTS: "1С: документ за эту дату уже есть",
  ERP_DOCUMENT_CONFLICT: "1С: документ не создан по действующим правилам",
  ERP_CANDIDATE_OR_DOCUMENT_NOT_FOUND:
    "1С: кандидат или вид документа не найден",
  ERP_FILE_STORAGE_NOT_CONFIGURED: "1С: не настроено хранение файлов",
  ERP_IDEMPOTENCY_CONFLICT:
    "1С: ключ доставки уже использован с другими данными",
  ERP_RECEIPT_INVALID: "1С вернула некорректную квитанцию",
  ERP_HTTP_422: "1С отклонила файл",
  ERP_PERSON_IDENTITY_UNAVAILABLE:
    "1С: получатель документа не подтверждён по коду сотрудника",
  ERP_PERSON_IDENTITY_MISMATCH:
    "1С: получатель документа изменился и требует подтверждения",
};

/** Plain explanation of a delivery failure, or null for an unknown code. */
export function erpDeliveryReason(code: string | null | undefined): string | null {
  if (!code) return null;
  return ERP_DELIVERY_ERROR_REASONS[code] ?? null;
}
