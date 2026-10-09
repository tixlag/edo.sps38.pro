import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDashboardQueryKey,
  getGetDocumentFileDownloadQueryKey,
  getGetDocumentVersionQueryKey,
  getListEmployeeDocumentsQueryKey,
  useApproveDocument,
  useEditDocumentFields,
  useGetDocumentFileDownload,
  useGetDocumentVersion,
  useGetMe,
  useListDocumentTypes,
  useListEmployeeDocuments,
  type DocumentFileDto,
  type DocumentVersionDto,
} from "@edo/api-client";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  StatusBadge,
} from "@edo/ui";

const FIELD_LABELS: Record<string, string> = {
  holder_name: "ФИО",
  last_name: "Фамилия",
  first_name: "Имя",
  middle_name: "Отчество",
  document_series: "Серия",
  document_number: "Номер",
  date_of_birth: "Дата рождения",
  birth_place: "Место рождения",
  citizenship: "Гражданство",
  issued_at: "Дата выдачи",
  issued_by: "Кем выдан",
  department_code: "Код подразделения",
  registration_address: "Адрес регистрации",
  document_type: "Тип документа",
};

function FilePreview({
  documentId,
  version,
  file,
}: {
  documentId: string;
  version: number;
  file: DocumentFileDto;
}) {
  const [imageError, setImageError] = useState(false);
  const download = useGetDocumentFileDownload(documentId, version, file.id, {
    query: {
      queryKey: getGetDocumentFileDownloadQueryKey(
        documentId,
        version,
        file.id,
      ),
      staleTime: 240_000,
      refetchInterval: 240_000,
    },
  });
  const retry = async () => {
    const refreshed = await download.refetch();
    if (!refreshed.isError) setImageError(false);
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="break-all text-[var(--muted-foreground)]">
          {file.filename}
        </span>
        {download.data && (
          <a
            className="font-semibold text-[var(--primary)] underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
            href={download.data.url}
            target="_blank"
            rel="noreferrer"
          >
            Скачать оригинал
          </a>
        )}
      </div>
      {download.isLoading && (
        <p role="status" className="py-8 text-sm">
          Загрузка файла…
        </p>
      )}
      {(download.isError || imageError) && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 py-6 text-sm"
        >
          <p>
            Не удалось открыть файл. Обновите временную ссылку и попробуйте
            снова.
          </p>
          <Button
            variant="outline"
            disabled={download.isFetching}
            onClick={() => void retry()}
          >
            Обновить ссылку
          </Button>
        </div>
      )}
      {download.data &&
        !imageError &&
        (file.mimeType.startsWith("image/") ? (
          <img
            className="max-h-[620px] w-full rounded-[12px] border border-[var(--border)] bg-[var(--muted)] object-contain"
            src={download.data.url}
            alt={`Загруженная страница документа: ${file.filename}`}
            onError={() => setImageError(true)}
          />
        ) : (
          <p className="rounded-[12px] bg-[var(--muted)] p-6 text-sm">
            PDF · страниц: {file.pageCount}. Скачайте оригинал для просмотра.
          </p>
        ))}
      <p className="text-xs text-[var(--muted-foreground)]">
        Ссылка на оригинал действует 5 минут и обновляется во время просмотра.
      </p>
    </div>
  );
}

function ReviewFields({
  data,
  employeeId,
}: {
  data: DocumentVersionDto;
  employeeId: string;
}) {
  const client = useQueryClient();
  const profile = useGetMe();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const permissions = profile.data?.permissions;
  const canReview =
    !!permissions &&
    ["20002", "20009"].some((rule) =>
      Object.prototype.hasOwnProperty.call(permissions, rule),
    );
  const update = async (result: DocumentVersionDto) => {
    client.setQueryData(
      getGetDocumentVersionQueryKey(data.documentId, data.version),
      result,
    );
    setDraft(null);
    setDraftRevision(null);
    await Promise.all([
      client.invalidateQueries({
        queryKey: getListEmployeeDocumentsQueryKey(employeeId),
      }),
      client.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
    ]);
  };
  const failure = () =>
    setMessage(
      "Не удалось сохранить. Возможно, документ изменён другим проверяющим. Обновите данные и повторите действие.",
    );
  const edit = useEditDocumentFields({
    mutation: {
      onSuccess: async (result) => {
        await update(result);
        setMessage(
          "Исправления сохранены. Исходный результат OCR сохранён отдельно.",
        );
      },
      onError: failure,
    },
  });
  const approve = useApproveDocument({
    mutation: {
      onSuccess: async (result) => {
        await update(result);
        setMessage("Документ подтверждён вами.");
      },
      onError: failure,
    },
  });
  const busy = edit.isPending || approve.isPending;
  const reviewChanged =
    !!draft && (draftRevision !== data.revision || data.status !== "IN_REVIEW");
  const fieldOrder = Object.keys(FIELD_LABELS);
  const fields = [...data.fields].sort((a, b) => {
    const rank = (name: string) =>
      fieldOrder.includes(name) ? fieldOrder.indexOf(name) : fieldOrder.length;
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "ru");
  });
  const changes = draft
    ? Object.fromEntries(
        data.fields
          .filter((field) => draft[field.name] !== (field.value ?? ""))
          .map((field) => [field.name, draft[field.name] || null]),
      )
    : {};
  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      aria-label="Распознанные поля"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Распознанные поля</h3>
        {canReview && data.status === "IN_REVIEW" && !draft && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setMessage("");
              setDraftRevision(data.revision);
              setDraft(
                Object.fromEntries(
                  data.fields.map((field) => [field.name, field.value ?? ""]),
                ),
              );
            }}
          >
            Исправить поля
          </Button>
        )}
      </div>
      <dl className="divide-y divide-[var(--border)]">
        {fields.map((field) => (
          <div
            key={field.name}
            className="grid gap-1 py-3 sm:grid-cols-[minmax(110px,1fr)_minmax(0,2fr)] sm:gap-4"
          >
            <dt className="text-sm text-[var(--muted-foreground)]">
              {draft ? (
                <label htmlFor={`field-${data.documentId}-${field.name}`}>
                  {FIELD_LABELS[field.name] ?? field.name}
                </label>
              ) : (
                (FIELD_LABELS[field.name] ?? field.name)
              )}
            </dt>
            <dd className="min-w-0 whitespace-pre-wrap break-words text-sm">
              {draft ? (
                <textarea
                  id={`field-${data.documentId}-${field.name}`}
                  className="w-full rounded-[8px] border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                  rows={2}
                  maxLength={16384}
                  disabled={busy}
                  value={draft[field.name] ?? field.value ?? ""}
                  onChange={(event) =>
                    setDraft({ ...draft, [field.name]: event.target.value })
                  }
                />
              ) : (
                (field.value ?? "—")
              )}
              {field.editedBy && (
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                  Исправлено вручную · OCR:{" "}
                  {field.originalValue ?? "не распознано"}
                </p>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {!data.fields.length && (
        <p className="text-sm text-[var(--muted-foreground)]">
          Распознанных полей пока нет.
        </p>
      )}
      {reviewChanged && (
        <p role="alert" className="text-sm">
          Документ изменён другим проверяющим. Ваши введённые значения сохранены
          на экране. Скопируйте нужные исправления, нажмите «Отмена» и начните
          проверку актуальных данных.
        </p>
      )}
      {draft && (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || reviewChanged || !Object.keys(changes).length}
            onClick={() => {
              setMessage("");
              edit.mutate({
                documentId: data.documentId,
                version: data.version,
                data: {
                  revision: draftRevision ?? data.revision,
                  fields: changes,
                },
              });
            }}
          >
            {edit.isPending ? "Сохранение…" : "Сохранить исправления"}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setDraftRevision(null);
            }}
          >
            Отмена
          </Button>
        </div>
      )}
      {!draft && canReview && data.status === "IN_REVIEW" && (
        <div className="flex flex-col items-start gap-2 border-t border-[var(--border)] pt-4">
          <p className="text-sm text-[var(--muted-foreground)]">
            Сверьте поля с оригиналом перед подтверждением.
          </p>
          <Button
            disabled={busy}
            onClick={() => {
              setMessage("");
              approve.mutate({
                documentId: data.documentId,
                version: data.version,
                data: { revision: data.revision },
              });
            }}
          >
            {approve.isPending ? "Подтверждение…" : "Подтвердить документ"}
          </Button>
        </div>
      )}
      {data.status === "IN_REVIEW" && !canReview && (
        <p className="text-sm text-[var(--muted-foreground)]">
          Документ ожидает сотрудника с правом проверки документов.
        </p>
      )}
      {data.approvedAt && (
        <p className="text-sm text-[var(--muted-foreground)]">
          Подтверждён {new Date(data.approvedAt).toLocaleString("ru-RU")}.
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}

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
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
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
  const files = data.files.filter((file) => !file.deleted);
  const file = files.find((item) => item.id === selectedFile) ?? files[0];
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
      <div className="grid min-w-0 gap-7 xl:grid-cols-2">
        <section
          className="flex min-w-0 flex-col gap-4"
          aria-label="Оригиналы документа"
        >
          <h3 className="text-base font-semibold">Загруженные файлы</h3>
          {files.length > 1 && (
            <div className="flex flex-wrap gap-2">
              {files.map((item, index) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant={item.id === file?.id ? "secondary" : "outline"}
                  aria-pressed={item.id === file?.id}
                  onClick={() => setSelectedFile(item.id)}
                >
                  Файл {index + 1}
                </Button>
              ))}
            </div>
          )}
          {file ? (
            <FilePreview
              key={file.id}
              documentId={documentId}
              version={version}
              file={file}
            />
          ) : (
            <p className="text-sm text-[var(--muted-foreground)]">
              Оригиналы недоступны.
            </p>
          )}
        </section>
        <ReviewFields data={data} employeeId={employeeId} />
      </div>
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
