import { useState } from "react";
import {
  getGetDocumentVersionQueryKey,
  useGetDocumentVersion,
  useListDocumentTypes,
  useListEmployeeDocuments,
} from "@edo/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  StatusBadge,
} from "@edo/ui";
import { DocumentReviewWorkspace } from "./DocumentReviewWorkspace";

function DocumentViewer({
  documentId,
  version,
  employeeId,
}: {
  documentId: string;
  version: number;
  employeeId: string;
}) {
  const result = useGetDocumentVersion(documentId, version, {
    query: {
      queryKey: getGetDocumentVersionQueryKey(documentId, version),
      refetchInterval: (query) =>
        ["UPLOADED", "OCR_PENDING"].includes(query.state.data?.status ?? "")
          ? 3000
          : false,
    },
  });
  if (result.isLoading)
    return (
      <p role="status" className="py-8 text-sm">
        Загрузка результата распознавания…
      </p>
    );
  if (result.isError || !result.data)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 py-6 text-sm"
      >
        Не удалось загрузить документ.
        <Button variant="outline" onClick={() => void result.refetch()}>
          Повторить
        </Button>
      </div>
    );
  const data = result.data;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={data.status} />
          <span className="text-sm text-[var(--muted-foreground)]">
            Версия {data.version}
          </span>
          {data.job?.status === "SUCCEEDED" && (
            <Badge tone="success">OCR завершено</Badge>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={result.isFetching}
          onClick={() => void result.refetch()}
        >
          Обновить данные
        </Button>
      </div>
      {data.ocrSource === "STUB" && (
        <p className="rounded-[10px] bg-[var(--muted)] px-4 py-3 text-sm">
          Тестовый пример: паспорт и ответ OCR подготовлены для демонстрации.
          Данные вымышлены.
        </p>
      )}
      {data.job?.status === "SUCCEEDED" && (
        <p className="text-sm text-[var(--muted-foreground)]">
          {data.issues.length
            ? "OCR сообщил замечания к документу."
            : "Замечаний от OCR нет."}{" "}
          {data.status === "IN_REVIEW" && "Ожидается ручная проверка."}
        </p>
      )}
      {["UPLOADED", "OCR_PENDING"].includes(data.status) && (
        <p role="status" className="text-sm">
          Документ распознаётся. Результат появится автоматически.
        </p>
      )}
      {data.job?.status === "FAILED" && (
        <p role="alert" className="text-sm">
          Распознавание не завершено. Код ошибки:{" "}
          {data.job.errorCode ?? "не указан"}.
        </p>
      )}
      {data.issues.length > 0 && (
        <section
          aria-label="Замечания OCR"
          className="rounded-[10px] border border-[var(--border)] p-4"
        >
          <h3 className="mb-2 font-semibold">Замечания OCR</h3>
          <ul className="list-inside list-disc space-y-2 text-sm">
            {data.issues.map((issue, index) => (
              <li key={index}>
                {issue.code === "DOCUMENT_TYPE_MISMATCH"
                  ? "Не тот тип документа"
                  : "Плохое качество страницы"}
                : {issue.message}
                {issue.fileOrdinal !== null &&
                  ` · файл ${issue.fileOrdinal + 1}`}
                {issue.pageNumber !== null && ` · страница ${issue.pageNumber}`}
              </li>
            ))}
          </ul>
        </section>
      )}
      <DocumentReviewWorkspace data={data} employeeId={employeeId} />
      <details className="border-t border-[var(--border)] pt-4">
        <summary className="cursor-pointer text-sm font-semibold focus-visible:outline focus-visible:outline-2">
          Исходный JSON OCR
        </summary>
        <p className="mt-3 text-sm text-[var(--muted-foreground)]">
          Ответ распознавания до ручных исправлений.
        </p>
        <pre className="mt-3 max-h-[420px] overflow-auto rounded-[10px] bg-[var(--muted)] p-4 text-xs">
          {JSON.stringify(data.raw ?? {}, null, 2)}
        </pre>
      </details>
    </div>
  );
}

export function EmployeeDocuments({ employeeId }: { employeeId: string }) {
  const documents = useListEmployeeDocuments(employeeId);
  const types = useListDocumentTypes();
  const [selected, setSelected] = useState<string | null>(null);
  const active =
    documents.data?.items.find((item) => item.id === selected) ??
    documents.data?.items[0];
  return (
    <Card>
      <CardHeader>
        <h2 className="text-lg font-semibold">Документы</h2>
      </CardHeader>
      <CardContent>
        {documents.isLoading && (
          <p role="status" className="py-6 text-sm">
            Загрузка документов…
          </p>
        )}
        {documents.isError && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 py-6 text-sm"
          >
            Не удалось загрузить документы.
            <Button variant="outline" onClick={() => void documents.refetch()}>
              Повторить
            </Button>
          </div>
        )}
        {documents.data && !active && (
          <p className="py-6 text-sm text-[var(--muted-foreground)]">
            Работник пока не загрузил документы.
          </p>
        )}
        {active && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-2" aria-label="Выбор документа">
              {documents.data?.items.map((doc) => (
                <Button
                  key={doc.id}
                  variant={doc.id === active.id ? "secondary" : "outline"}
                  aria-pressed={doc.id === active.id}
                  onClick={() => setSelected(doc.id)}
                >
                  {types.data?.items.find(
                    (type) => type.code === doc.documentTypeCode,
                  )?.title ??
                    doc.documentTypeCode ??
                    "Документ"}
                </Button>
              ))}
            </div>
            <DocumentViewer
              key={`${active.id}-${active.currentVersion}`}
              documentId={active.id}
              version={active.currentVersion}
              employeeId={employeeId}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
