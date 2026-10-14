import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetDashboardQueryKey,
  getGetDocumentVersionQueryKey,
  getListEmployeeDocumentsQueryKey,
  useApproveDocument,
  useEditDocumentFields,
  useGetMe,
  useRejectDocument,
  useSendDocumentToErp,
  getListReviewDocumentsQueryKey,
  type DocumentVersionDto,
  type OcrRegionDto,
} from "@edo/api-client";
import { Badge, Button } from "@edo/ui";
import { Check, Save, X } from "lucide-react";
import { DocumentPreview } from "./DocumentPreview";
import { DOCUMENT_FIELD_LABELS } from "./document-field-labels";
import { getRequiredReviewFields } from "./document-review-fields";

export function DocumentReviewWorkspace({
  data,
  employeeId,
  readOnly = false,
  fitContainer = false,
}: {
  data: DocumentVersionDto;
  employeeId?: string;
  readOnly?: boolean;
  fitContainer?: boolean;
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
  // Hover-preview: временная подсветка без смены файла/страницы, без
  // фокуса и без скролла. Отличается от selection (явный выбор кликом,
  // фокусом или кнопкой «На превью»).
  const [hoveredField, setHoveredField] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    revision: number;
    values: Record<string, string>;
    original: Record<string, string>;
  } | null>(null);
  const [message, setMessage] = useState("");
  const [rejectionReason, setRejectionReason] = useState(
    "Необходимо более качественное фото документа",
  );
  const [showReject, setShowReject] = useState(false);
  const [mismatchOnly, setMismatchOnly] = useState(false);
  const inputs = useRef<
    Record<string, HTMLTextAreaElement | HTMLInputElement | null>
  >({});
  const rows = useRef<Record<string, HTMLDivElement | null>>({});
  const previewSection = useRef<HTMLElement>(null);
  const fieldsContainer = useRef<HTMLDivElement>(null);
  const permissions = profile.data?.permissions;
  const canReview =
    !readOnly &&
    !!permissions &&
    ["20002", "20009"].some((rule) =>
      Object.prototype.hasOwnProperty.call(permissions, rule),
    );
  const canEdit = canReview && data.status === "IN_REVIEW";
  const file = files.find((item) => item.id === fileId) ?? files[0];
  const visiblePage = Math.max(1, Math.min(pageNumber, file?.pageCount ?? 1));
  const fields = getRequiredReviewFields(data);
  const mismatchCount = fields.filter((field) => field.mismatch).length;
  const visibleFields = mismatchOnly
    ? fields.filter((field) => field.mismatch)
    : fields;
  const changes = draft
    ? Object.fromEntries(
        Object.entries(draft.values)
          .filter(([name, value]) => value !== draft.original[name])
          .map(([name, value]) => [
            name,
            fields.find((f) => f.name === name)?.kind === "boolean"
              ? value === "true"
              : value || null,
          ]),
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
      ...(employeeId
        ? [
            client.invalidateQueries({
              queryKey: getListEmployeeDocumentsQueryKey(employeeId),
            }),
          ]
        : []),
      client.invalidateQueries({ queryKey: getListReviewDocumentsQueryKey() }),
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
  const reject = useRejectDocument({
    mutation: {
      onSuccess: async (result) => {
        await update(result);
        setShowReject(false);
        setMessage("Документ возвращён кандидату.");
      },
      onError: failure,
    },
  });
  const send = useSendDocumentToErp({
    mutation: {
      onSuccess: async (result) => {
        await update(result);
        setMessage(
          result.delivery?.status === "SENT"
            ? "Документ отправлен в ERP."
            : "ERP не приняла документ. Повторная отправка выполняется вручную.",
        );
      },
      onError: failure,
    },
  });
  const canSend =
    !readOnly &&
    !!permissions &&
    ["20006", "20009"].some((rule) =>
      Object.prototype.hasOwnProperty.call(permissions, rule),
    );
  const busy =
    edit.isPending || approve.isPending || reject.isPending || send.isPending;
  const setField = (name: string, value: string) => {
    const values =
      draft?.values ??
      Object.fromEntries(
        fields.map((field) => [field.name, field.value ?? ""]),
      );
    setDraft({
      revision: draft?.revision ?? data.revision,
      original: draft?.original ?? values,
      values: { ...values, [name]: value },
    });
    setMessage("");
  };
  // Явный выбор: клик по области, фокус поля, кнопка «На превью».
  // Единственное место, где разрешено менять файл/страницу.
  const selectField = (
    name: string,
    focus: boolean,
    explicitRegion?: OcrRegionDto,
    revealPreview = false,
  ) => {
    const field = fields.find((item) => item.name === name);
    if (mismatchOnly && field && !field.mismatch) setMismatchOnly(false);
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
  // Hover-preview справа (поле → область) и слева (область → поле):
  // только подсветка в пределах текущей страницы, без смены fileId/page,
  // без scrollIntoView и без focus. Явный переход — клик/«На превью».
  const hoverField = (name: string) => {
    setHoveredField((current) => (current === name ? current : name));
  };
  const unhoverField = () => {
    setHoveredField(null);
  };
  const hoverRegion = (name: string | null) => {
    setHoveredField(name);
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
      if (input) {
        input.focus({ preventScroll: true });
        try {
          if (
            input instanceof HTMLInputElement &&
            input.type === "date" &&
            typeof (input as HTMLInputElement & { showPicker?: () => void })
              .showPicker === "function"
          ) {
            (
              input as HTMLInputElement & { showPicker: () => void }
            ).showPicker();
          } else if (
            !(input instanceof HTMLInputElement && input.type === "checkbox")
          ) {
            input.select?.();
          }
        } catch {
          // showPicker требует жеста пользователя — игнорируем.
        }
      }
    }
  }, [selection, canEdit]);
  useEffect(() => {
    if (!canEdit || !fieldsContainer.current) return;
    const resize = () => {
      for (const input of Object.values(inputs.current)) {
        if (!(input instanceof HTMLTextAreaElement)) continue;
        input.style.height = "auto";
        input.style.height = `${Math.min(96, Math.max(32, input.scrollHeight + 2))}px`;
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
        fields.map((field) => [field.name, field.value ?? ""]),
      );
      setDraft({ revision: data.revision, values, original: values });
    }
  };
  return (
    <div
      className={`grid min-w-0 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.08fr)] lg:items-stretch ${fitContainer ? "lg:h-full" : "lg:h-[calc(100dvh-12rem)] lg:min-h-[360px]"}`}
    >
      <section
        ref={previewSection}
        className="flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] p-3"
        aria-label="Превью документа"
      >
        {(files.length > 1 || (file && file.pageCount > 1)) && (
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
            {files.length > 1 && (
              <div className="flex min-w-0 flex-wrap gap-1">
                {files.map((item, index) => (
                  <Button
                    key={item.id}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    variant={item.id === file?.id ? "secondary" : "outline"}
                    title={item.filename}
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
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  className="h-7 px-2 text-xs"
                  variant="outline"
                  disabled={visiblePage <= 1}
                  onClick={() => {
                    setPageNumber(visiblePage - 1);
                    setSelection(null);
                  }}
                >
                  Назад
                </Button>
                <span className="text-xs tabular-nums">
                  Страница {visiblePage} из {file.pageCount}
                </span>
                <Button
                  size="sm"
                  className="h-7 px-2 text-xs"
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
          </div>
        )}
        {file ? (
          <DocumentPreview
            key={`${file.id}-${visiblePage}`}
            documentId={data.documentId}
            version={data.version}
            file={file}
            pageNumber={visiblePage}
            fields={fields}
            selectedField={selection?.fieldName ?? null}
            selectedRegionId={selection?.regionId ?? null}
            hoveredField={hoveredField}
            onSelectRegion={(name, region) => selectField(name, true, region)}
            onHoverRegion={(name) => hoverRegion(name)}
          />
        ) : (
          <p className="text-[13px] text-[var(--muted-foreground)]">
            Оригиналы недоступны.
          </p>
        )}
      </section>
      <section
        className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]"
        aria-label="Поля документа"
      >
        <div className="shrink-0 border-b border-[var(--border)] px-3 py-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">
              Обязательные поля · {visibleFields.length}
            </h3>
            {changedCount > 0 && (
              <Badge tone="warning">Не сохранено: {changedCount}</Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-1 text-xs text-[var(--muted-foreground)]">
            <p>Сверьте значения с оригиналом документа.</p>
            {mismatchCount > 0 && (
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  className="accent-[var(--primary)]"
                  checked={mismatchOnly}
                  onChange={(event) => setMismatchOnly(event.target.checked)}
                />
                Только расхождения ({mismatchCount})
              </label>
            )}
          </div>
        </div>
        <div
          ref={fieldsContainer}
          className="max-h-[60dvh] min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-3 lg:max-h-none"
        >
          <dl className="divide-y divide-[var(--border)]">
            {visibleFields.map((field) => {
              const onCurrentPage = field.regions.some(
                (region) =>
                  region.fileId === file?.id &&
                  region.pageNumber === visiblePage,
              );
              const firstRegion = field.regions[0];
              const firstFileIndex = firstRegion
                ? files.findIndex((item) => item.id === firstRegion.fileId)
                : -1;
              const isHovered = hoveredField === field.name;
              const isSelected = selection?.fieldName === field.name;
              const label =
                DOCUMENT_FIELD_LABELS[field.name] ?? field.label ?? field.name;
              const value = draft?.values[field.name] ?? field.value ?? "";
              const displayValue = (text: string | null) =>
                field.kind === "boolean"
                  ? text === "true"
                    ? "Да"
                    : "Нет"
                  : text || "—";
              const inputClass = `block min-h-8 w-full min-w-0 rounded-md border bg-[var(--card)] px-2 py-1 text-[13px] leading-5 caret-[var(--primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] ${field.mismatch ? "border-[var(--primary)]" : "border-[var(--border)]"}`;
              return (
                <div
                  key={field.name}
                  ref={(node) => {
                    rows.current[field.name] = node;
                  }}
                  data-field-row={field.name}
                  onMouseEnter={() => hoverField(field.name)}
                  onMouseLeave={unhoverField}
                  className={`grid min-w-0 gap-1 py-2 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-3 ${field.mismatch ? "bg-[var(--primary-soft)]" : isSelected ? "bg-[var(--muted)]" : ""} ${isHovered ? `${field.mismatch ? "" : "bg-[var(--muted)]"} outline outline-1 outline-[var(--primary)]` : ""}`}
                >
                  <dt className="min-w-0 text-[13px] leading-5 sm:pt-1.5">
                    {canEdit ? (
                      <label
                        className="break-words"
                        htmlFor={`field-${data.documentId}-${field.name}`}
                      >
                        {label}
                      </label>
                    ) : (
                      <span className="break-words">{label}</span>
                    )}
                    {field.regions.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-0 text-xs font-normal text-[var(--muted-foreground)] underline underline-offset-2 hover:text-[var(--foreground)]"
                          aria-label={`Показать область: ${label}`}
                          onClick={() =>
                            selectField(field.name, false, undefined, true)
                          }
                        >
                          На превью
                        </Button>
                        {isHovered && !onCurrentPage && firstRegion && (
                          <span className="text-xs text-[var(--muted-foreground)]">
                            Область на стр. {firstRegion.pageNumber}
                            {firstRegion.fileId !== file?.id &&
                            firstFileIndex >= 0
                              ? ` · файл ${firstFileIndex + 1}`
                              : ""}
                          </span>
                        )}
                      </div>
                    )}
                  </dt>
                  <dd className="min-w-0 break-words text-[13px]">
                    {canEdit && field.name !== "positionUid" ? (
                      field.kind === "boolean" || field.kind === "date" ? (
                        <input
                          ref={(node) => {
                            inputs.current[field.name] = node;
                          }}
                          id={`field-${data.documentId}-${field.name}`}
                          type={field.kind === "boolean" ? "checkbox" : "date"}
                          disabled={busy}
                          checked={
                            field.kind === "boolean"
                              ? value === "true"
                              : undefined
                          }
                          value={field.kind === "date" ? value : undefined}
                          aria-required={field.required}
                          className={
                            field.kind === "boolean"
                              ? "mt-2 h-4 w-4 accent-[var(--primary)]"
                              : inputClass
                          }
                          onFocus={() => {
                            beginDraft();
                            if (selection?.fieldName !== field.name)
                              selectField(field.name, false);
                          }}
                          onChange={(event) =>
                            setField(
                              field.name,
                              field.kind === "boolean"
                                ? String(event.target.checked)
                                : event.target.value,
                            )
                          }
                        />
                      ) : (
                        <textarea
                          ref={(node) => {
                            inputs.current[field.name] = node;
                          }}
                          id={`field-${data.documentId}-${field.name}`}
                          rows={1}
                          maxLength={16384}
                          disabled={busy}
                          aria-required={field.required}
                          className={`${inputClass} max-h-24 resize-y`}
                          value={value}
                          onFocus={() => {
                            beginDraft();
                            if (selection?.fieldName !== field.name)
                              selectField(field.name, false);
                          }}
                          onChange={(event) =>
                            setField(field.name, event.target.value)
                          }
                        />
                      )
                    ) : (
                      <p className="py-1.5 whitespace-pre-wrap">
                        {displayValue(value)}
                      </p>
                    )}
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs leading-4 text-[var(--muted-foreground)]">
                      {field.submittedValue !== null &&
                        (field.mismatch || field.submittedValue !== value) && (
                          <p className="min-w-0 break-words">
                            Кандидат: {displayValue(field.submittedValue)}
                          </p>
                        )}
                      {data.ocrSource &&
                        (field.mismatch ||
                          field.editedBy ||
                          value !== (field.originalValue ?? "")) && (
                          <p className="min-w-0 break-words">
                            OCR: {displayValue(field.originalValue)}
                            {field.editedBy && " · исправлено вручную"}
                          </p>
                        )}
                      {field.mismatch && (
                        <p className="mt-0.5 text-xs leading-4 text-[var(--primary)]">
                          Расхождение с OCR — сверьте с оригиналом.
                        </p>
                      )}
                    </div>
                  </dd>
                </div>
              );
            })}
          </dl>
          {!fields.length && (
            <p className="py-3 text-[13px] text-[var(--muted-foreground)]">
              В документе нет обязательных полей для ручной проверки.
            </p>
          )}
          {mismatchOnly && !visibleFields.length && !!fields.length && (
            <p className="py-3 text-[13px] text-[var(--muted-foreground)]">
              Расхождений нет — снимите фильтр, чтобы увидеть все обязательные
              поля.
            </p>
          )}
          {data.delivery && (
            <div
              role="status"
              className="my-2 rounded-md bg-[var(--muted)] p-2 text-xs"
            >
              <p className="font-semibold">
                {data.delivery.status === "SENT"
                  ? "Документ отправлен в ERP"
                  : data.delivery.status === "WAITING_CONTRACT"
                    ? "Ожидается контракт ERP для отправки по code_1c"
                    : data.delivery.status === "REQUIRES_MANUAL"
                      ? "Требует отправки в ERP"
                      : "Отправка в ERP"}
              </p>
              {data.delivery.errorCode && (
                <p className="mt-1">
                  ERP недоступна или не приняла документ. Документ сохранён в
                  ЭДО. Код: {data.delivery.errorCode}
                </p>
              )}
              {canSend && data.delivery.status === "REQUIRES_MANUAL" && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={busy}
                  onClick={() =>
                    send.mutate({
                      documentId: data.documentId,
                      version: data.version,
                    })
                  }
                >
                  {send.isPending ? "Отправка…" : "Отправить в ERP"}
                </Button>
              )}
              {!!data.delivery.attempts.length && (
                <details className="mt-2">
                  <summary>История отправок</summary>
                  <ul>
                    {data.delivery.attempts.map((attempt) => (
                      <li key={attempt.id}>
                        {new Date(attempt.startedAt).toLocaleString("ru-RU")} ·{" "}
                        {attempt.errorCode ??
                          (attempt.finishedAt ? "Отправлено" : "Выполняется")}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {data.rejectionReason && (
            <p role="status" className="py-2 text-xs text-[var(--primary)]">
              {data.rejectionReason}
            </p>
          )}
          {data.status === "IN_REVIEW" && !canReview && (
            <p className="py-2 text-xs text-[var(--muted-foreground)]">
              {readOnly
                ? "Историческая версия доступна только для просмотра."
                : "Для исправления и подтверждения нужно право проверки документов."}
            </p>
          )}
          {data.approvedAt && (
            <p className="py-2 text-xs text-[var(--muted-foreground)]">
              Подтверждён {new Date(data.approvedAt).toLocaleString("ru-RU")}.
            </p>
          )}
        </div>
        {(canReview || message || (stale && changedCount > 0)) && (
          <div
            className="sticky bottom-0 z-10 shrink-0 border-t border-[var(--border)] bg-[var(--card)] p-3"
            aria-label="Действия проверки"
          >
            {canEdit && showReject && (
              <div className="mb-2 flex flex-col gap-1.5">
                <label
                  className="text-xs font-semibold"
                  htmlFor="document-rejection-reason"
                >
                  Причина отклонения
                </label>
                <textarea
                  id="document-rejection-reason"
                  value={rejectionReason}
                  rows={2}
                  maxLength={1024}
                  className="max-h-24 min-h-12 resize-y rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-1 text-[13px] caret-[var(--primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
                  onChange={(event) => setRejectionReason(event.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={busy || !rejectionReason.trim()}
                    onClick={() =>
                      reject.mutate({
                        documentId: data.documentId,
                        version: data.version,
                        data: {
                          revision: data.revision,
                          reason: rejectionReason,
                        },
                      })
                    }
                  >
                    Вернуть кандидату
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setShowReject(false)}
                  >
                    Отмена
                  </Button>
                </div>
              </div>
            )}
            {stale && changedCount > 0 && (
              <p role="alert" className="mb-2 text-xs">
                Документ изменён другим проверяющим. Скопируйте нужные
                исправления, нажмите «Отменить правки» и начните с актуальных
                данных.
              </p>
            )}
            {canReview && (
              <div className="flex flex-wrap items-center gap-2">
                {canEdit && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-[var(--primary)]"
                    aria-label="Отклонить документ"
                    disabled={busy || changedCount > 0}
                    onClick={() => setShowReject(!showReject)}
                  >
                    <X size={14} />
                    Отклонить
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
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
                  <Save size={14} />
                  {edit.isPending ? "Сохранение…" : "Сохранить исправления"}
                </Button>
                {canEdit && (
                  <Button
                    size="sm"
                    aria-label="Подтвердить документ"
                    disabled={busy || changedCount > 0}
                    onClick={() =>
                      approve.mutate({
                        documentId: data.documentId,
                        version: data.version,
                        data: { revision: data.revision },
                      })
                    }
                  >
                    <Check size={14} />
                    {approve.isPending ? "Подтверждение…" : "Подтвердить"}
                  </Button>
                )}
              </div>
            )}
            {draft && (
              <div className="mt-1 flex flex-wrap items-center justify-between gap-1">
                <span className="text-xs text-[var(--muted-foreground)]">
                  {changedCount
                    ? "Сначала сохраните исправления."
                    : "Изменений нет."}
                </span>
                <Button
                  size="sm"
                  className="h-6 px-1 text-xs font-normal"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setMessage("");
                  }}
                >
                  Отменить правки
                </Button>
              </div>
            )}
            {message && (
              <p role="status" className="mt-2 text-xs">
                {message}
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
