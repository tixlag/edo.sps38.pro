import type { DocumentVersionDto } from "@edo/api-client";
import { DOCUMENT_FIELD_LABELS } from "./document-field-labels";

const LABELS: Record<string, string> = {
  series: "Серия",
  number: "Номер",
  date_issue: "Дата выдачи",
  issued_by_code: "Код подразделения",
  second_name: "Фамилия",
  third_name: "Отчество",
  date_birth: "Дата рождения",
  place_birth: "Место рождения",
  sex: "Пол",
  pas_number: "Номер паспорта",
  pas_surname: "Фамилия латиницей",
  pas_name: "Имя латиницей",
  pas_patronymic: "Отчество",
  pas_nationality: "Гражданство",
  pas_date_of_birth: "Дата рождения",
  pas_sex: "Пол",
  pas_place_of_birth: "Место рождения",
  pas_date_of_issue: "Дата выдачи",
  pas_date_of_expiry: "Срок действия",
  pas_authority: "Кем выдан",
  mg_series: "Серия",
  mg_number: "Номер",
  mg_surname: "Фамилия",
  mg_surname_lat: "Фамилия латиницей",
  mg_name: "Имя",
  mg_patronymic: "Отчество",
  mg_date_of_birth: "Дата рождения",
  mg_nationality: "Гражданство",
  mg_passport_number: "Номер паспорта",
  mg_visa_number: "Номер визы",
  mg_duration_from: "Дата въезда",
  mg_duration_to: "Дата окончания пребывания",
};

function Timestamp({ value }: { value: string }) {
  return (
    <time dateTime={value} title={`${value} (UTC)`}>
      {new Date(value).toLocaleString("ru-RU", { timeZoneName: "short" })}
    </time>
  );
}

export function DocumentReviewMetadata({ data }: { data: DocumentVersionDto }) {
  const status = data.job?.status;
  const pending =
    status === "QUEUED" || status === "RUNNING" || status === "UPLOADING";
  const failed = status === "FAILED" || status === "REJECTED";
  return (
    <div
      className="space-y-1 px-3 py-2 text-xs text-[var(--muted-foreground)]"
      aria-label="Отправка и проверка документа"
    >
      <p>
        Отправлен:{" "}
        {data.submittedAt ? (
          <Timestamp value={data.submittedAt} />
        ) : (
          "дата неизвестна"
        )}
      </p>
      <p>
        Проверен:{" "}
        {data.reviewedAt ? (
          <>
            <Timestamp value={data.reviewedAt} />
            {data.reviewedBy && (
              <> · {data.reviewedByName || data.reviewedBy}</>
            )}
          </>
        ) : (
          "решение ещё не принято"
        )}
      </p>
      {pending && (
        <p role="status">Документ распознаётся. Можно проверить вручную.</p>
      )}
      {failed && (
        <p role="status">
          {data.issues[0]?.message || "Не удалось распознать документ"}.
          Доступна ручная проверка.
        </p>
      )}
      {status === "CANCELLED" && (
        <p>Распознавание отменено после решения проверяющего.</p>
      )}
      {status === "SUCCEEDED" && (
        <p>Распознавание завершено. Результаты OCR показаны ниже.</p>
      )}
    </div>
  );
}

export function DocumentOcrFields({ data }: { data: DocumentVersionDto }) {
  const fields = data.ocrFields ?? [];
  if (!fields.length) return null;
  return (
    <section
      className="mt-4 border-t border-[var(--border)] pb-3 pt-3"
      aria-label="Результаты OCR"
    >
      <h4 className="text-sm font-semibold">Результаты OCR</h4>
      <p className="mt-1 text-xs text-[var(--muted-foreground)]">
        Распознанные данные для сверки. Введённые реквизиты сохранены.
      </p>
      <dl className="mt-2 divide-y divide-[var(--border)]">
        {fields.map((field, index) => (
          <div key={`${field.name}-${index}`} className="min-w-0 py-2">
            <dt className="break-words text-[13px] font-medium">
              {LABELS[field.name] ??
                DOCUMENT_FIELD_LABELS[field.name] ??
                field.name}
            </dt>
            <dd className="min-w-0 text-[13px]">
              <p className="whitespace-pre-wrap break-words">
                {field.value || "Не распознано"}
              </p>
              <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                Источник:{" "}
                {field.source === "PADDLE"
                  ? "PaddleOCR"
                  : field.source === "GLM"
                    ? "GLM"
                    : "PaddleOCR и GLM"}
              </p>
              {field.paddleText !== null && (
                <p className="whitespace-pre-wrap break-words text-xs text-[var(--muted-foreground)]">
                  PaddleOCR: {field.paddleText || "пустой результат"}
                </p>
              )}
              {field.paddleConfidence !== null && (
                <p className="text-xs tabular-nums text-[var(--muted-foreground)]">
                  Уверенность PaddleOCR:{" "}
                  {(field.paddleConfidence * 100).toLocaleString("ru-RU", {
                    maximumFractionDigits: 1,
                  })}
                  %
                </p>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
