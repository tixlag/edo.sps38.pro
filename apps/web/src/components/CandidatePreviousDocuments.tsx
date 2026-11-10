import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  getGetCandidateDetailsQueryKey,
  getListCandidateReviewQueueQueryKey,
  getListReviewDocumentsQueryKey,
  useListCandidatePreviousDocuments,
  type CandidatePreviousDocumentDto,
} from "@edo/api-client";
import { Badge, Button } from "@edo/ui";
import { ChevronDown } from "lucide-react";
import { candidateError } from "./CandidateForm";
import { formatDateRu } from "../lib/date-format";

const STATUS_LABELS: Record<string, string> = {
  REQUIRES_REVIEW: "Требует проверки",
  CONFIRMED: "Актуален и подтверждён",
  REPLACE: "Требуется замена",
  MISSING: "Отсутствует",
  ORIGINAL_UNAVAILABLE: "Оригинал недоступен",
};

function refreshDocumentViews(cache: QueryClient, candidateId: string) {
  return Promise.all([
    cache.invalidateQueries({
      queryKey: getGetCandidateDetailsQueryKey(candidateId),
    }),
    cache.invalidateQueries({
      queryKey: getListCandidateReviewQueueQueryKey(),
    }),
    cache.invalidateQueries({ queryKey: getListReviewDocumentsQueryKey() }),
  ]);
}
const FIELD_LABELS: Record<string, string> = {
  series: "Серия",
  number: "Номер",
  issuedAt: "Дата выдачи",
  issueDate: "Дата выдачи",
  issuedBy: "Кем выдан",
  expiryDate: "Срок действия",
  expiresAt: "Срок действия",
  validUntil: "Действителен до",
  name: "Наименование",
  firstName: "Имя",
  lastName: "Фамилия",
  middleName: "Отчество",
  birthDate: "Дата рождения",
  departmentCode: "Код подразделения",
  subdivisionCode: "Код подразделения",
  gender: "Пол",
  citizenship: "Гражданство",
  isInvalid: "Отмечен недействительным в ERP",
  recordDate: "Дата записи в ERP",
};

function PreviousDocument({
  candidateId,
  document,
}: {
  candidateId: string;
  document: CandidatePreviousDocumentDto;
}) {
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  let navigate: ReturnType<typeof useNavigate> | undefined;
  try {
    navigate = useNavigate();
  } catch {
    navigate = undefined;
  }
  const open = async () => {
    if (!navigate) return;
    setOpening(true); setError("");
    try {
      await navigate({ to: "/review/candidates/$candidateId", params: { candidateId }, search: { previousDocument: document.id } });
    } catch (cause) { setError(candidateError(cause)); }
    finally { setOpening(false); }
  };
  const fields = Object.entries(document.fields).filter(
    ([key, value]) =>
      !/(?:uuid|uid|code_?1c|code1c|erp|^id$)/i.test(key) &&
      (typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"),
  );
  return (
    <li className="space-y-3 border-t border-[var(--border)] py-4 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">{document.title}</h3>
          <p className="text-sm text-[var(--muted-foreground)]">
            {STATUS_LABELS[document.status] ?? document.status}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="rounded-md"
          disabled={!document.originalAvailable || opening}
          onClick={() => void open()}
        >
          {opening
            ? "Открытие…"
            : document.originalAvailable
              ? "Открыть оригинал"
              : "Оригинал недоступен"}
        </Button>
      </div>
      {!!fields.length && (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {fields.map(([key, value]) => (
            <div key={key} className="min-w-0">
              <dt className="text-[var(--muted-foreground)]">
                {FIELD_LABELS[key] ?? key}
              </dt>
              <dd className="break-words">
                {typeof value === "boolean"
                  ? value
                    ? "Да"
                    : "Нет"
                  : typeof value === "string" &&
                      [
                        "recordDate",
                        "issueDate",
                        "issuedAt",
                        "expiryDate",
                        "expiresAt",
                        "validUntil",
                        "birthDate",
                      ].includes(key)
                    ? formatDateRu(value)
                    : String(value) || "Не указано"}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-sm">
        Срок действия:{" "}
        {document.expiresAt ? formatDateRu(document.expiresAt) : "Неизвестен"}
      </p>
      {document.reviewedAt && (
        <p className="text-xs text-[var(--muted-foreground)]">
          Проверено для текущего оформления:{" "}
          {new Date(document.reviewedAt).toLocaleString("ru-RU")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
    </li>
  );
}

export function CandidatePreviousDocuments({
  candidateId,
}: {
  candidateId: string;
}) {
  const documents = useListCandidatePreviousDocuments(candidateId);
  const cache = useQueryClient();
  useEffect(() => {
    if (!documents.data) return;
    // The history GET can import and automatically confirm former originals.
    void refreshDocumentViews(cache, candidateId);
  }, [cache, candidateId, documents.data, documents.dataUpdatedAt]);
  let navigate: ReturnType<typeof useNavigate> | undefined;
  try {
    navigate = useNavigate();
  } catch {
    navigate = undefined;
  }
  const itemsCount = documents.data
    ? documents.data.items.length + (documents.data.edoDocuments?.length ?? 0)
    : undefined;

  return (
    <section
      aria-label="Прежние документы физлица"
      className="border-t border-[var(--border)] pt-5"
    >
      <details
        className="group rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 transition-colors"
        open
      >
        <summary className="flex cursor-pointer select-none items-center justify-between text-base font-semibold list-none [&::-webkit-details-marker]:hidden">
          <div className="flex items-center gap-2">
            <h2>История документов</h2>
            {typeof itemsCount === "number" && (
              <Badge tone="default">{itemsCount}</Badge>
            )}
          </div>
          <ChevronDown
            size={18}
            className="text-[var(--muted-foreground)] transition-transform duration-200 group-open:rotate-180"
          />
        </summary>
        <div className="space-y-3 pt-3">
          <p className="text-xs text-[var(--muted-foreground)]">
            Прежние документы физлица и результаты проверки для текущего
            оформления.
          </p>
          {documents.data?.employmentHistory &&
            (documents.data.employmentHistory.available ? (
              <details className="text-sm">
                <summary className="cursor-pointer font-medium">
                  Кадровая история в ERP
                </summary>
                {documents.data.employmentHistory.items.length ? (
                  <ol className="mt-2 space-y-1">
                    {documents.data.employmentHistory.items.map(
                      (event, index) => (
                        <li
                          key={`${event.eventDate}:${event.eventType}:${index}`}
                        >
                          {event.eventType === "HIRE" ? "Приём" : "Увольнение"}{" "}
                          · {formatDateRu(event.startDate ?? event.eventDate)}
                        </li>
                      ),
                    )}
                  </ol>
                ) : (
                  <p className="mt-2">Записей о приёме или увольнении нет.</p>
                )}
              </details>
            ) : (
              <p className="text-sm">
                Кадровая история ERP временно недоступна.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => void documents.refetch()}
                >
                  Повторить
                </button>
              </p>
            ))}
          <p className="text-sm text-[var(--muted-foreground)]">
            Документы ERP проверяются заново для текущего оформления. Прежние
            решения и оригиналы сохраняются.
          </p>
          {!!documents.data?.edoDocuments?.length && (
            <div>
              <h3 className="text-sm font-semibold">
                Документы прошлых оформлений в ЭДО
              </h3>
              <ul className="mt-2 space-y-1">
                {documents.data.edoDocuments.map((document) => (
                  <li key={document.id}>
                    <button
                      type="button"
                      className="text-sm underline"
                      onClick={() =>
                        void navigate?.({
                          to: "/review-ig/$documentId",
                          params: { documentId: document.id },
                          search: { version: document.currentVersion },
                        })
                      }
                    >
                      {document.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {documents.isLoading && <p role="status">Загрузка документов ERP…</p>}
          {documents.isError && (
            <p role="alert" className="text-sm">
              Не удалось получить документы ERP.{" "}
              <Button
                size="sm"
                variant="outline"
                className="rounded-md"
                onClick={() => void documents.refetch()}
              >
                Повторить
              </Button>
            </p>
          )}
          {documents.data?.items.length === 0 &&
            !documents.data.edoDocuments?.length && (
              <p className="text-sm">
                Доступных прежних документов нет. Недостающие документы показаны
                в перечне справа.
              </p>
            )}
          <ul>
            {documents.data?.items.map((document) => (
              <PreviousDocument
                key={`${document.id}:${document.status}`}
                candidateId={candidateId}
                document={document}
              />
            ))}
          </ul>
        </div>
      </details>
    </section>
  );
}
