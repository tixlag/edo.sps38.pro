import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getCandidatePreviousDocumentOriginal,
  getListCandidatePreviousDocumentsQueryKey,
  useListCandidatePreviousDocuments,
  useRecheckCandidatePreviousDocument,
  type CandidatePreviousDocumentDto,
  type CandidateRecheckStatus,
} from "@edo/api-client";
import { Button } from "@edo/ui";
import { CANDIDATE_CONTROL, candidateError } from "./CandidateForm";

const RECHECK_LABELS: Record<CandidateRecheckStatus, string> = {
  REQUIRES_REVIEW: "Требует повторной проверки",
  CONFIRMED: "Актуален и подтверждён",
  REPLACE: "Требуется замена",
  MISSING: "Отсутствует",
  ORIGINAL_UNAVAILABLE: "Оригинал недоступен",
};
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
};

function PreviousDocument({
  candidateId,
  document,
}: {
  candidateId: string;
  document: CandidatePreviousDocumentDto;
}) {
  const [status, setStatus] = useState(document.status);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState("");
  const mutation = useRecheckCandidatePreviousDocument();
  const cache = useQueryClient();
  const open = async () => {
    setOpening(true);
    setError("");
    // Open during the user gesture so authenticated binary download is not popup-blocked.
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const blob = await getCandidatePreviousDocumentOriginal(
        candidateId,
        document.id,
      );
      const url = URL.createObjectURL(blob);
      if (tab) tab.location.href = url;
      else {
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = document.title;
        anchor.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      tab?.close();
      setError(candidateError(cause));
    } finally {
      setOpening(false);
    }
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
            {RECHECK_LABELS[document.status]}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
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
                  : String(value) || "Не указано"}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-sm">
        Срок действия:{" "}
        {document.expiresAt
          ? new Date(document.expiresAt).toLocaleDateString("ru-RU")
          : "Неизвестен"}
      </p>
      {document.reviewedAt && (
        <p className="text-xs text-[var(--muted-foreground)]">
          Проверено для текущего оформления:{" "}
          {new Date(document.reviewedAt).toLocaleString("ru-RU")}
        </p>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          setMessage("");
          void mutation
            .mutateAsync({
              candidateId,
              documentId: document.id,
              data: { status },
            })
            .then(async (saved) => {
              cache.setQueryData(
                getListCandidatePreviousDocumentsQueryKey(candidateId),
                saved,
              );
              setMessage("Результат повторной проверки сохранён.");
            })
            .catch((cause) => setError(candidateError(cause)));
        }}
      >
        <label className="min-w-0 flex-1 space-y-1 text-sm">
          Результат повторной проверки
          <select
            aria-label={`Повторная проверка: ${document.title}`}
            className={CANDIDATE_CONTROL}
            value={status}
            disabled={mutation.isPending}
            onChange={(event) =>
              setStatus(event.target.value as CandidateRecheckStatus)
            }
          >
            {Object.entries(RECHECK_LABELS).map(([value, label]) => (
              <option
                key={value}
                value={value}
                disabled={value === "CONFIRMED" && !document.originalAvailable}
              >
                {label}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          {mutation.isPending ? "Сохранение…" : "Сохранить проверку"}
        </Button>
      </form>
      {message && (
        <p role="status" className="text-sm">
          {message}
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
  return (
    <section
      aria-label="Прежние документы физлица"
      className="space-y-3 border-t border-[var(--border)] pt-5"
    >
      <h2 className="text-base font-semibold">Прежние документы физлица</h2>
      <p className="text-sm text-[var(--muted-foreground)]">
        Документы ERP проверяются заново для текущего оформления. Прежние
        решения и оригиналы сохраняются.
      </p>
      {documents.isLoading && <p role="status">Загрузка документов ERP…</p>}
      {documents.isError && (
        <p role="alert" className="text-sm">
          Не удалось получить документы ERP.{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void documents.refetch()}
          >
            Повторить
          </Button>
        </p>
      )}
      {documents.data?.items.length === 0 && (
        <p className="text-sm">
          Доступных прежних документов нет. Недостающие документы показаны в
          перечне справа.
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
    </section>
  );
}
