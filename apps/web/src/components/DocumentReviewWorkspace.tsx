import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDashboardQueryKey,
  getGetDocumentVersionQueryKey,
  getListEmployeeDocumentsQueryKey,
  useApproveDocument,
  useEditDocumentFields,
  useGetMe,
  type DocumentVersionDto,
  type OcrRegionDto,
} from "@edo/api-client";
import { Badge, Button } from "@edo/ui";
import { DocumentPreview } from "./DocumentPreview";
import { DOCUMENT_FIELD_LABELS } from "./document-field-labels";

export function DocumentReviewWorkspace({
  data,
  employeeId,
}: {
  data: DocumentVersionDto;
  employeeId: string;
}) {
  const client = useQueryClient();
  const profile = useGetMe();
  const files = data.files.filter((file) => !file.deleted);
  const [fileId, setFileId] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [selection, setSelection] = useState<{
    fieldName: string;
    regionId: string | null;
    focus: boolean;
    revealPreview: boolean;
    request: number;
  } | null>(null);
  const [draft, setDraft] = useState<{
    revision: number;
    values: Record<string, string>;
    original: Record<string, string>;
  } | null>(null);
  const [message, setMessage] = useState("");
  const inputs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const rows = useRef<Record<string, HTMLDivElement | null>>({});
  const previewSection = useRef<HTMLElement>(null);
  const fieldsContainer = useRef<HTMLDivElement>(null);
  const permissions = profile.data?.permissions;
  const canReview =
    !!permissions &&
    ["20002", "20009"].some((rule) =>
      Object.prototype.hasOwnProperty.call(permissions, rule),
    );
  const canEdit = canReview && data.status === "IN_REVIEW";
  const file = files.find((item) => item.id === fileId) ?? files[0];
  const visiblePage = Math.max(1, Math.min(pageNumber, file?.pageCount ?? 1));
  const order = Object.keys(DOCUMENT_FIELD_LABELS);
  const fields = [...data.fields].sort((a, b) => {
    const rank = (name: string) =>
      order.includes(name) ? order.indexOf(name) : order.length;
    return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "ru");
  });
  const changes = draft
    ? Object.fromEntries(
        Object.entries(draft.values)
          .filter(([name, value]) => value !== draft.original[name])
          .map(([name, value]) => [name, value || null]),
      )
    : {};
  const changedCount = Object.keys(changes).length;
  const stale = !!draft && (draft.revision !== data.revision || !canEdit);
  const update = async (result: DocumentVersionDto) => {
    client.setQueryData(
      getGetDocumentVersionQueryKey(data.documentId, data.version),
      result,
    );
    setDraft(null);
    await Promise.all([
      client.invalidateQueries({
        queryKey: getListEmployeeDocumentsQueryKey(employeeId),
      }),
      client.invalidateQueries({ queryKey: getGetDashboardQueryKey() }),
    ]);
  };
  const failure = () =>
    setMessage(
      "Не удалось сохранить. Введённые значения остались на экране. Обновите данные; если документ изменён другим проверяющим, отмените правки и начните с актуальных данных.",
    );
  const edit = useEditDocumentFields({
    mutation: {
      onSuccess: async (result) => {
        await update(result);
        setMessage(
          "Исправления сохранены. Исходный текст OCR и выделенные области сохранены отдельно.",
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
  const selectField = (
    name: string,
    focus: boolean,
    explicitRegion?: OcrRegionDto,
    revealPreview = false,
  ) => {
    const field = data.fields.find((item) => item.name === name);
    const region =
      explicitRegion ??
      field?.regions.find(
        (item) => item.fileId === file?.id && item.pageNumber === visiblePage,
      ) ??
      field?.regions[0];
    if (region) {
      setFileId(region.fileId);
      setPageNumber(region.pageNumber);
    }
    setSelection((current) => ({
      fieldName: name,
      regionId: region?.id ?? null,
      focus,
      revealPreview,
      request: (current?.request ?? 0) + 1,
    }));
  };
  useEffect(() => {
    if (selection?.revealPreview)
      previewSection.current?.scrollIntoView({
        block: "start",
        inline: "nearest",
      });
    if (selection?.focus)
      rows.current[selection.fieldName]?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    if (selection?.focus && canEdit) {
      const input = inputs.current[selection.fieldName];
      input?.focus({ preventScroll: true });
      input?.select();
    }
  }, [selection, canEdit]);
  useEffect(() => {
    if (!canEdit || !fieldsContainer.current) return;
    const resize = () => {
      for (const input of Object.values(inputs.current)) {
        if (!input) continue;
        input.style.height = "auto";
        input.style.height = `${Math.min(160, input.scrollHeight + 2)}px`;
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(fieldsContainer.current);
    return () => observer.disconnect();
  }, [canEdit, data.fields, draft]);
  useEffect(() => {
    if (
      draft &&
      !changedCount &&
      (draft.revision !== data.revision || !canEdit)
    )
      setDraft(null);
  }, [draft, changedCount, data.revision, canEdit]);
  const beginDraft = () => {
    if (!draft) {
      const values = Object.fromEntries(
        data.fields.map((field) => [field.name, field.value ?? ""]),
      );
      setDraft({ revision: data.revision, values, original: values });
    }
  };
  return (
    <div className="grid min-w-0 items-start gap-7 xl:grid-cols-2">
      <section
        ref={previewSection}
        className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-0"
        aria-label="Превью документа"
      >
        <h3 className="text-base font-semibold">Оригинал и области OCR</h3>
        {files.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {files.map((item, index) => (
              <Button
                key={item.id}
                size="sm"
                variant={item.id === file?.id ? "secondary" : "outline"}
                aria-pressed={item.id === file?.id}
                onClick={() => {
                  setFileId(item.id);
                  setPageNumber(1);
                  setSelection(null);
                }}
              >
                Файл {index + 1}
              </Button>
            ))}
          </div>
        )}
        {file && file.pageCount > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={visiblePage <= 1}
              onClick={() => {
                setPageNumber(visiblePage - 1);
                setSelection(null);
              }}
            >
              Назад
            </Button>
            <span className="text-sm">
              Страница {visiblePage} из {file.pageCount}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={visiblePage >= file.pageCount}
              onClick={() => {
                setPageNumber(visiblePage + 1);
                setSelection(null);
              }}
            >
              Далее
            </Button>
          </div>
        )}
        {file ? (
          <DocumentPreview
            key={`${file.id}-${visiblePage}`}
            documentId={data.documentId}
            version={data.version}
            file={file}
            pageNumber={visiblePage}
            fields={data.fields}
            selectedField={selection?.fieldName ?? null}
            selectedRegionId={selection?.regionId ?? null}
            onSelectRegion={(name, region) => selectField(name, true, region)}
          />
        ) : (
          <p className="text-sm text-[var(--muted-foreground)]">
            Оригиналы недоступны.
          </p>
        )}
      </section>
      <section
        className="flex min-w-0 flex-col gap-4"
        aria-label="Распознанные поля"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold">Распознанные поля</h3>
          {changedCount > 0 && (
            <Badge tone="warning">Не сохранено: {changedCount}</Badge>
          )}
        </div>
        {canEdit && (
          <p className="text-sm text-[var(--muted-foreground)]">
            Выберите поле или область на превью, исправьте значение и сохраните.
          </p>
        )}
        <div
          ref={fieldsContainer}
          className="min-w-0 overflow-x-hidden xl:max-h-[620px] xl:overflow-y-auto xl:pr-2"
        >
          <dl className="divide-y divide-[var(--border)]">
            {fields.map((field) => (
              <div
                key={field.name}
                ref={(node) => {
                  rows.current[field.name] = node;
                }}
                className={`min-w-0 rounded-[8px] px-2 py-3 ${field.name === selection?.fieldName ? "bg-[var(--primary-soft)]" : ""}`}
              >
                <dt className="mb-1 flex flex-wrap items-center justify-between gap-2 break-words text-sm font-semibold">
                  {canEdit ? (
                    <label
                      className="min-w-0 break-all"
                      htmlFor={`field-${data.documentId}-${field.name}`}
                    >
                      {DOCUMENT_FIELD_LABELS[field.name] ?? field.name}
                    </label>
                  ) : (
                    <span className="min-w-0 break-all">
                      {DOCUMENT_FIELD_LABELS[field.name] ?? field.name}
                    </span>
                  )}
                  {field.regions.length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Показать область: ${DOCUMENT_FIELD_LABELS[field.name] ?? field.name}`}
                      onClick={() =>
                        selectField(field.name, false, undefined, true)
                      }
                    >
                      На превью
                    </Button>
                  )}
                </dt>
                <dd className="min-w-0 break-words text-sm">
                  {canEdit ? (
                    <textarea
                      ref={(node) => {
                        inputs.current[field.name] = node;
                      }}
                      id={`field-${data.documentId}-${field.name}`}
                      rows={1}
                      maxLength={16384}
                      disabled={busy}
                      className="block w-full min-w-0 max-w-full resize-y rounded-[8px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-base focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                      value={draft?.values[field.name] ?? field.value ?? ""}
                      onFocus={() => {
                        beginDraft();
                        if (selection?.fieldName !== field.name)
                          selectField(field.name, false);
                      }}
                      onChange={(event) => {
                        const values =
                          draft?.values ??
                          Object.fromEntries(
                            data.fields.map((item) => [
                              item.name,
                              item.value ?? "",
                            ]),
                          );
                        setDraft({
                          revision: draft?.revision ?? data.revision,
                          original: draft?.original ?? values,
                          values: {
                            ...values,
                            [field.name]: event.target.value,
                          },
                        });
                        setMessage("");
                      }}
                    />
                  ) : (
                    <p className="whitespace-pre-wrap">
                      {draft?.values[field.name] ?? field.value ?? "—"}
                    </p>
                  )}
                  {(field.editedBy ||
                    (draft &&
                      draft.values[field.name] !==
                        (field.originalValue ?? ""))) && (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-[var(--muted-foreground)]">
                      OCR: {field.originalValue ?? "не распознано"}
                      {field.editedBy && " · исправлено вручную"}
                    </p>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        {!fields.length && (
          <p className="text-sm text-[var(--muted-foreground)]">
            Распознанных полей пока нет.
          </p>
        )}
        {stale && changedCount > 0 && (
          <p role="alert" className="text-sm">
            Документ изменён другим проверяющим. Скопируйте нужные исправления,
            нажмите «Отменить правки» и начните с актуальных данных.
          </p>
        )}
        {canReview && (
          <div className="flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
            <Button
              disabled={busy || !changedCount || stale}
              onClick={() => {
                if (draft)
                  edit.mutate({
                    documentId: data.documentId,
                    version: data.version,
                    data: { revision: draft.revision, fields: changes },
                  });
              }}
            >
              {edit.isPending ? "Сохранение…" : "Сохранить исправления"}
            </Button>
            {draft && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setDraft(null);
                  setMessage("");
                }}
              >
                Отменить правки
              </Button>
            )}
          </div>
        )}
        {canEdit && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-[var(--muted-foreground)]">
              {changedCount
                ? "Сначала сохраните исправления, затем подтвердите документ."
                : "Сверьте поля с оригиналом перед подтверждением."}
            </p>
            <Button
              variant="outline"
              disabled={busy || changedCount > 0}
              onClick={() =>
                approve.mutate({
                  documentId: data.documentId,
                  version: data.version,
                  data: { revision: data.revision },
                })
              }
            >
              {approve.isPending ? "Подтверждение…" : "Подтвердить документ"}
            </Button>
          </div>
        )}
        {data.status === "IN_REVIEW" && !canReview && (
          <p className="text-sm text-[var(--muted-foreground)]">
            Для исправления и подтверждения нужно право проверки документов.
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
    </div>
  );
}
