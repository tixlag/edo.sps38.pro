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
import { DocumentPreview } from "./DocumentPreview";
import { DOCUMENT_FIELD_LABELS } from "./document-field-labels";

export function DocumentReviewWorkspace({
  data,
  employeeId,
}: {
  data: DocumentVersionDto;
  employeeId?: string;
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
    !!permissions &&
    ["20002", "20009"].some((rule) =>
      Object.prototype.hasOwnProperty.call(permissions, rule),
    );
  const canEdit = canReview && data.status === "IN_REVIEW";
  const file = files.find((item) => item.id === fileId) ?? files[0];
  const visiblePage = Math.max(1, Math.min(pageNumber, file?.pageCount ?? 1));
  const order = Object.keys(DOCUMENT_FIELD_LABELS);
  const fields = data.ocrSource
    ? [...data.fields].sort((a, b) => {
        const rank = (name: string) =>
          order.includes(name) ? order.indexOf(name) : order.length;
        return (
          rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "ru")
        );
      })
    : data.fields;
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
            data.fields.find((f) => f.name === name)?.kind === "boolean"
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
        data.fields.map((field) => [field.name, field.value ?? ""]),
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
    <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <section
        ref={previewSection}
        className="flex min-w-0 flex-col gap-3 xl:sticky xl:top-4 xl:max-h-[calc(100dvh-2rem)] xl:overflow-y-auto xl:pr-1"
        aria-label="Превью документа"
      >
        <h3 className="text-[13px] font-semibold">Оригинал документа</h3>
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
            <span className="text-[13px] tabular-nums">
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
        className="flex min-w-0 flex-col gap-3"
        aria-label="Поля документа"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[13px] font-semibold">
            Поля документа · {visibleFields.length}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {mismatchCount > 0 && (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                <input
                  type="checkbox"
                  checked={mismatchOnly}
                  onChange={(event) => setMismatchOnly(event.target.checked)}
                />
                Только расхождения ({mismatchCount})
              </label>
            )}
            {changedCount > 0 && (
              <Badge tone="warning">Не сохранено: {changedCount}</Badge>
            )}
          </div>
        </div>
        {canEdit && (
          <p className="text-xs text-[var(--muted-foreground)]">
            {data.ocrSource
              ? "Наведите на поле или область на превью, исправьте значение и сохраните."
              : "Сверьте значения с документом. При необходимости исправьте их и сохраните."}
          </p>
        )}
        <div
          ref={fieldsContainer}
          className="min-w-0 overflow-x-hidden xl:max-h-[620px] xl:overflow-y-auto xl:pr-2"
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
              return (
                <div
                  key={field.name}
                  ref={(node) => {
                    rows.current[field.name] = node;
                  }}
                  data-field-row={field.name}
                  onMouseEnter={() => hoverField(field.name)}
                  onMouseLeave={unhoverField}
                  className={`min-w-0 rounded-[6px] px-2 py-1.5 transition-colors hover:bg-[var(--muted)] ${field.mismatch ? "border border-[var(--primary)] bg-[var(--primary-soft)]" : isSelected ? "bg-[var(--muted)]" : ""} ${isHovered && !field.mismatch ? "bg-[var(--muted)] outline outline-1 outline-[var(--primary)]" : isHovered ? "outline outline-1 outline-[var(--primary)]" : ""}`}
                >
                  <dt className="mb-0.5 flex flex-wrap items-center justify-between gap-2 break-words text-[13px] font-semibold">
                    {canEdit ? (
                      <label
                        className="min-w-0 break-all"
                        htmlFor={`field-${data.documentId}-${field.name}`}
                      >
                        {DOCUMENT_FIELD_LABELS[field.name] ??
                          field.label ??
                          field.name}
                      </label>
                    ) : (
                      <span className="min-w-0 break-all">
                        {DOCUMENT_FIELD_LABELS[field.name] ??
                          field.label ??
                          field.name}
                      </span>
                    )}
                    {field.regions.length > 0 && (
                      <span className="flex items-center gap-1.5">
                        <Badge tone="info">OCR</Badge>
                        {isHovered && !onCurrentPage && firstRegion && (
                          <Badge tone="info">
                            Область на стр. {firstRegion.pageNumber}
                            {firstRegion.fileId !== file?.id &&
                            firstFileIndex >= 0
                              ? ` · файл ${firstFileIndex + 1}`
                              : ""}
                          </Badge>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Показать область: ${DOCUMENT_FIELD_LABELS[field.name] ?? field.label ?? field.name}`}
                          onClick={() =>
                            selectField(field.name, false, undefined, true)
                          }
                        >
                          На превью
                        </Button>
                      </span>
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
                            ? (draft?.values[field.name] ?? field.value) ===
                              "true"
                            : undefined
                        }
                        value={
                          field.kind === "date"
                            ? (draft?.values[field.name] ?? field.value ?? "")
                            : undefined
                        }
                        aria-required={field.required}
                        className="rounded-[6px] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[13px]"
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
                        className="block w-full min-w-0 max-w-full resize-y rounded-[6px] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[13px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
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
                    )
                  ) : (
                    <p className="whitespace-pre-wrap">
                      {field.kind === "boolean"
                        ? (draft?.values[field.name] ?? field.value) === "true"
                          ? "Да"
                          : "Нет"
                        : (draft?.values[field.name] ?? field.value ?? "—")}
                    </p>
                  )}
                  {field.submittedValue !== null && (
                    <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
                      Кандидат:{" "}
                      {field.kind === "boolean"
                        ? field.submittedValue === "true"
                          ? "Да"
                          : "Нет"
                        : field.submittedValue || "—"}
                      {field.required ? " · обязательное поле" : ""}
                    </p>
                  )}
                  {field.mismatch && (
                    <p className="mt-0.5 text-xs text-[var(--primary)]">
                      Значение кандидата отличается от результата OCR. Сверьте с
                      оригиналом.
                    </p>
                  )}
                  {data.ocrSource &&
                    (field.editedBy ||
                      (draft &&
                        draft.values[field.name] !==
                          (field.originalValue ?? ""))) && (
                      <p className="mt-0.5 whitespace-pre-wrap text-xs text-[var(--muted-foreground)]">
                        OCR: {field.originalValue ?? "не распознано"}
                        {field.editedBy && " · исправлено вручную"}
                      </p>
                    )}
                </dd>
              </div>
              );
            })}
          </dl>
        </div>
        {!fields.length && (
          <p className="text-[13px] text-[var(--muted-foreground)]">
            Полей документа пока нет.
          </p>
        )}
        {mismatchOnly && !visibleFields.length && !!fields.length && (
          <p className="text-[13px] text-[var(--muted-foreground)]">
            Расхождений нет — показаны все поля после снятия фильтра.
          </p>
        )}
        {stale && changedCount > 0 && (
          <p role="alert" className="text-[13px]">
            Документ изменён другим проверяющим. Скопируйте нужные исправления,
            нажмите «Отменить правки» и начните с актуальных данных.
          </p>
        )}
        {(canReview || canEdit) && (
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-2 border-t border-[var(--border)] bg-[var(--card)] py-2">
            {canReview && (
              <>
                <Button
                  size="sm"
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
                    size="sm"
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
              </>
            )}
            {canEdit && (
              <>
                <span className="text-xs text-[var(--muted-foreground)]">
                  {changedCount
                    ? "Сначала сохраните исправления."
                    : "Сверьте поля с оригиналом."}
                </span>
                <Button
                  size="sm"
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
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || changedCount > 0}
                  onClick={() => setShowReject(!showReject)}
                >
                  Отклонить документ
                </Button>
              </>
            )}
          </div>
        )}
        {canEdit && showReject && (
          <div className="flex w-full flex-col gap-2">
            <label
              className="text-[13px] font-semibold"
              htmlFor="document-rejection-reason"
            >
              Причина отклонения
            </label>
            <textarea
              id="document-rejection-reason"
              value={rejectionReason}
              maxLength={1024}
              className="rounded-[6px] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[13px]"
              onChange={(event) => setRejectionReason(event.target.value)}
            />
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
          </div>
        )}
        {data.delivery && (
          <div
            role="status"
            className={`rounded-[10px] p-3 text-[13px] ${["REQUIRES_MANUAL", "WAITING_CONTRACT"].includes(data.delivery.status) ? "bg-[var(--primary-soft)] text-[var(--primary)]" : "bg-[var(--muted)]"}`}
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
                ERP недоступна или не приняла документ. Документ сохранён в ЭДО.
                Код: {data.delivery.errorCode}
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
          <p role="status" className="text-[13px] text-[var(--primary)]">
            {data.rejectionReason}
          </p>
        )}
        {data.status === "IN_REVIEW" && !canReview && (
          <p className="text-[13px] text-[var(--muted-foreground)]">
            Для исправления и подтверждения нужно право проверки документов.
          </p>
        )}
        {data.approvedAt && (
          <p className="text-xs text-[var(--muted-foreground)]">
            Подтверждён {new Date(data.approvedAt).toLocaleString("ru-RU")}.
          </p>
        )}
        {message && (
          <p role="status" className="text-[13px]">
            {message}
          </p>
        )}
      </section>
    </div>
  );
}
