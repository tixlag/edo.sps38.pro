import { useRef, useState } from "react";
import { Button, Badge } from "@edo/ui";
import { ArrowDown, ArrowUp, HelpCircle, Plus, Trash2 } from "lucide-react";
import {
  useSaveAnnotation,
  useSubmitAnnotation,
  useAcceptAnnotation,
  useRequestAnnotationChanges,
  useGetMe,
  type AnnotationDto,
  type AnnotationFieldAnswerDto,
  type AnnotationLineDto,
  type AnnotationSourceDto,
  type DocumentFileDto,
} from "@edo/api-client";
import { DocumentPreview } from "../DocumentPreview";
import { annotationComplete, replaceAnnotationLine } from "./annotation-draft";
import {
  boxInsidePage,
  normalizedQuad,
  pixelBox,
  type OrientedBox,
} from "./annotation-geometry";
import { useAnnotationGuide } from "./use-annotation-guide";

const control =
  "min-w-0 rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]";
const statuses = {
  DRAFT: "Черновик",
  SUBMITTED: "На проверке",
  ACCEPTED: "Принято",
  CHANGES_REQUESTED: "Нужны исправления",
};
export function AnnotationEditor({
  annotation,
  files,
  liveSources,
  sourceError = false,
  onSaved,
  admin = false,
  active = true,
}: {
  annotation: AnnotationDto;
  files?: DocumentFileDto[];
  liveSources?: AnnotationSourceDto;
  sourceError?: boolean;
  onSaved: (next: AnnotationDto) => void;
  admin?: boolean;
  active?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const me = useGetMe(),
    save = useSaveAnnotation(),
    submit = useSubmitAnnotation(),
    accept = useAcceptAnnotation(),
    changes = useRequestAnnotationChanges();
  const [draft, setDraft] = useState<{
    revision: number;
    fields: AnnotationFieldAnswerDto[];
  } | null>(null);
  const [selectedField, setSelectedField] = useState(
      annotation.schema.fields[0]?.key ?? "",
    ),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [pageId, setPageId] = useState(annotation.sources.pages[0]?.id ?? "");
  const [drawing, setDrawing] = useState(false),
    [message, setMessage] = useState(""),
    [note, setNote] = useState(""),
    [guide, setGuide] = useState(admin ? 0 : 1);
  const busy =
    save.isPending || submit.isPending || accept.isPending || changes.isPending;
  const fields = draft?.fields ?? annotation.fields;
  const stale = !!draft && draft.revision !== annotation.revision;
  const page =
    annotation.sources.pages.find((item) => item.id === pageId) ??
    annotation.sources.pages[0];
  const freshPage = liveSources?.pages.find(
    (item) => item.id === page?.id && item.sha256 === page.sha256,
  );
  const displayPage = freshPage ?? page;
  const sourceChanged = !!liveSources && !freshPage;
  const currentSources = liveSources ?? annotation.sources;
  const sourceAvailable =
    currentSources.available !== false &&
    currentSources.pages.length > 0 &&
    currentSources.pages.every((item) => !!item.previewUrl?.trim()) &&
    !sourceError &&
    !sourceChanged;
  const editable = annotation.editable && !busy && sourceAvailable;
  const file =
    files?.find((item) => item.id === page?.fileId) ??
    (page
      ? {
          id: page.fileId,
          ordinal: 0,
          filename: `Оригинал · страница ${page.pageNumber}`,
          mimeType: page.mimeType as DocumentFileDto["mimeType"],
          sizeBytes: page.sizeBytes,
          pageCount: Math.max(
            ...annotation.sources.pages
              .filter((item) => item.fileId === page.fileId)
              .map((item) => item.pageNumber),
          ),
          deleted: false,
        }
      : undefined);
  const selected = fields
    .flatMap((field) => field.lines)
    .find((line) => line.id === selectedId);
  const fieldSchema = annotation.schema.fields.find(
    (item) => item.key === selectedField,
  );
  const answer = fields.find((item) => item.key === selectedField);
  const complete = annotationComplete(annotation.schema, fields);
  const invalidText = fields.some((field) =>
    field.lines.some((line) =>
      [...line.text].some((char) => char.charCodeAt(0) < 32),
    ),
  );
  const setFields = (next: AnnotationFieldAnswerDto[]) =>
    setDraft({
      revision: draft?.revision ?? annotation.revision,
      fields: next,
    });
  const patchLine = (id: string, patch: Partial<AnnotationLineDto>) =>
    setFields(replaceAnnotationLine(fields, id, patch));
  const chooseLine = (id: string) => {
    setSelectedId(id);
    const field = fields.find((item) =>
      item.lines.some((line) => line.id === id),
    );
    if (field) setSelectedField(field.key);
  };
  const error = () =>
    setMessage(
      "Не удалось сохранить: работа или оригинал могли измениться. Все ваши правки остались на экране. Обновите сведения о работе перед повторной попыткой.",
    );
  const saved = (next: AnnotationDto) => {
    setDraft(null);
    onSaved(next);
  };
  const persist = async () => {
    if (!draft) return annotation;
    const next = await save.mutateAsync({
      id: annotation.id,
      data: { revision: draft.revision, fields: draft.fields },
    });
    saved(next);
    return next;
  };
  const changeDisposition = (value: string) => {
    setSelectedId(null);
    setDrawing(false);
    setFields([
      ...fields.filter((item) => item.key !== selectedField),
      ...(value
        ? [
            {
              key: selectedField,
              disposition: value as AnnotationFieldAnswerDto["disposition"],
              lines: value === "PRESENT" ? (answer?.lines ?? []) : [],
            },
          ]
        : []),
    ]);
  };
  const numeric = (key: keyof OrientedBox, value: number) => {
    if (!selected || !page || !Number.isFinite(value)) return;
    const box = {
      ...pixelBox(selected.quad, page.width, page.height),
      [key]: value,
    };
    if (boxInsidePage(box, page.width, page.height))
      patchLine(selected.id, {
        quad: normalizedQuad(box, page.width, page.height),
      });
  };
  useAnnotationGuide(root, guide, !!page && active && sourceAvailable, pageId);
  return (
    <section
      ref={root}
      aria-label="Редактор разметки"
      className="flex min-h-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <b>{annotation.schema.title}</b>
          <Badge>{statuses[annotation.status]}</Badge>
          <span className="text-xs text-[var(--muted-foreground)]">
            Список полей v{annotation.schema.version} · версия документа{" "}
            {annotation.sources.version}
          </span>
          {draft && <Badge tone="warning">Не сохранено</Badge>}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!sourceAvailable}
          onClick={() => setGuide((value) => value + 1)}
        >
          <HelpCircle size={15} />
          Инструкция
        </Button>
      </div>
      {!annotation.editable && (
        <p role="status" className="text-sm">
          {annotation.authorId !== me.data?.uuid
            ? "Работу ведёт другой проверяющий. Доступен просмотр."
            : annotation.status === "SUBMITTED"
              ? "Разметка отправлена на проверку."
              : annotation.status === "ACCEPTED"
                ? "Разметка принята. Сохранённая версия доступна для просмотра."
                : "Редактирование сейчас недоступно."}
        </p>
      )}
      {annotation.note && (
        <p
          role="status"
          className="rounded-lg bg-[var(--warning-soft)] p-3 text-sm"
        >
          Комментарий проверки: {annotation.note}
        </p>
      )}
      {stale && (
        <p role="alert" className="text-sm">
          На сервере появилась новая редакция. Ваш черновик сохранён на экране.
          Скопируйте нужные значения перед сбросом черновика.
        </p>
      )}
      {!sourceAvailable && (
        <p role="alert" className="text-sm">
          Оригинал недоступен. Черновик сохранён на экране. Редактирование,
          сохранение и отправка на проверку временно недоступны.
        </p>
      )}
      {message && (
        <p role="alert" className="text-sm">
          {message}
        </p>
      )}
      <div className="grid min-h-[480px] min-w-0 gap-3 lg:h-[65dvh] lg:grid-cols-[minmax(0,1.2fr)_minmax(300px,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3">
          <label className="flex items-center gap-2 text-xs">
            Страница
            <select
              aria-label="Страница разметки"
              className={control}
              value={pageId}
              onChange={(event) => {
                setPageId(event.target.value);
                setSelectedId(null);
                setDrawing(false);
              }}
            >
              {annotation.sources.pages.map((item, index) => (
                <option key={item.id} value={item.id}>
                  Файл{" "}
                  {annotation.sources.pages.findIndex(
                    (p) => p.fileId === item.fileId,
                  ) + 1}{" "}
                  · страница {item.pageNumber}
                  {annotation.sources.pages.length > 1
                    ? ` (${index + 1}/${annotation.sources.pages.length})`
                    : ""}
                </option>
              ))}
            </select>
          </label>
          {sourceAvailable && file && displayPage ? (
            <DocumentPreview
              key={pageId}
              documentId={annotation.documentId}
              version={annotation.sources.version}
              file={file}
              pageNumber={page.pageNumber}
              fields={[]}
              selectedField={null}
              selectedRegionId={null}
              onSelectRegion={() => undefined}
              annotation={{
                source: displayPage,
                lines: fields
                  .flatMap((field) => field.lines)
                  .filter((line) => line.pageId === page.id),
                selectedId,
                editable: editable && !stale,
                drawing,
                onSelect: chooseLine,
                onChange: (id, quad) => patchLine(id, { quad }),
                onCreate: (quad) => {
                  if (!answer || answer.disposition !== "PRESENT") return;
                  const id = crypto.randomUUID();
                  setFields(
                    fields.map((field) =>
                      field.key === selectedField
                        ? {
                            ...field,
                            lines: [
                              ...field.lines,
                              {
                                id,
                                pageId: page.id,
                                order: field.lines.length,
                                text: "",
                                quad,
                              },
                            ],
                          }
                        : field,
                    ),
                  );
                  setSelectedId(id);
                  setDrawing(false);
                },
              }}
            />
          ) : (
            <p>Оригиналы недоступны.</p>
          )}
        </div>
        <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
          <div data-annotation-fields="" className="flex flex-col gap-2">
            <label
              className="text-sm font-semibold"
              htmlFor={`field-${annotation.id}`}
            >
              Поле оригинала
            </label>
            <select
              id={`field-${annotation.id}`}
              className={control}
              value={selectedField}
              onChange={(event) => {
                setSelectedField(event.target.value);
                setSelectedId(null);
                setDrawing(false);
              }}
            >
              {annotation.schema.fields
                .slice()
                .sort((a, b) => a.ordinal - b.ordinal)
                .map((field) => {
                  const value = fields.find((item) => item.key === field.key);
                  return (
                    <option key={field.key} value={field.key}>
                      {field.label}
                      {value?.disposition === "NOT_PRESENT"
                        ? " · Нет на оригинале"
                        : value?.disposition === "UNREADABLE"
                          ? " · Нечитаемо"
                          : value?.lines.length
                            ? " · " + value.lines.length + " строк"
                            : " · Не заполнено"}
                    </option>
                  );
                })}
            </select>
            <label className="text-xs" htmlFor={`disposition-${annotation.id}`}>
              Состояние поля
            </label>
            <select
              id={`disposition-${annotation.id}`}
              className={control}
              value={answer?.disposition ?? ""}
              disabled={!editable || stale}
              onChange={(event) => changeDisposition(event.target.value)}
            >
              <option value="">Выберите состояние</option>
              <option value="PRESENT">Есть на оригинале</option>
              <option value="NOT_PRESENT">Нет на оригинале</option>
              <option value="UNREADABLE">Невозможно прочитать</option>
            </select>
            <p className="text-xs text-[var(--muted-foreground)]">
              {fieldSchema?.multiline
                ? "Для каждой видимой строки добавьте отдельную рамку."
                : "Для этого поля нужна одна рамка вокруг строки."}
            </p>
          </div>
          <div data-annotation-transcript="" className="flex flex-col gap-3">
            <Button
              size="sm"
              variant={drawing ? "secondary" : "outline"}
              disabled={
                !editable ||
                stale ||
                answer?.disposition !== "PRESENT" ||
                (!fieldSchema?.multiline && !!answer?.lines.length)
              }
              aria-pressed={drawing}
              onClick={() => setDrawing((value) => !value)}
            >
              <Plus size={15} />
              {drawing ? "Отменить рисование" : "Новая строка"}
            </Button>
            {drawing && (
              <p role="status" className="text-xs">
                Протяните рамку по строке на оригинале. Затем введите её текст.
              </p>
            )}
            {answer?.lines
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((line, index) => (
                <div
                  key={line.id}
                  className={`flex flex-col gap-2 rounded-lg border p-2 ${selectedId === line.id ? "border-[var(--primary)]" : "border-[var(--border)]"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      className="text-sm font-semibold underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-[var(--primary)]"
                      onClick={() => {
                        chooseLine(line.id);
                        setPageId(line.pageId);
                      }}
                    >
                      Строка {index + 1}
                    </button>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Поднять строку ${index + 1}`}
                        disabled={!editable || stale || index === 0}
                        onClick={() =>
                          setFields(
                            fields.map((field) =>
                              field.key === selectedField
                                ? {
                                    ...field,
                                    lines: field.lines.map((item) => ({
                                      ...item,
                                      order:
                                        item.id === line.id
                                          ? index - 1
                                          : item.order === index - 1
                                            ? index
                                            : item.order,
                                    })),
                                  }
                                : field,
                            ),
                          )
                        }
                      >
                        <ArrowUp size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Опустить строку ${index + 1}`}
                        disabled={
                          !editable ||
                          stale ||
                          index === answer.lines.length - 1
                        }
                        onClick={() =>
                          setFields(
                            fields.map((field) =>
                              field.key === selectedField
                                ? {
                                    ...field,
                                    lines: field.lines.map((item) => ({
                                      ...item,
                                      order:
                                        item.id === line.id
                                          ? index + 1
                                          : item.order === index + 1
                                            ? index
                                            : item.order,
                                    })),
                                  }
                                : field,
                            ),
                          )
                        }
                      >
                        <ArrowDown size={14} />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Удалить строку ${index + 1}`}
                        disabled={!editable || stale}
                        onClick={() => {
                          setFields(
                            fields.map((field) => ({
                              ...field,
                              lines: field.lines
                                .filter((item) => item.id !== line.id)
                                .sort((a, b) => a.order - b.order)
                                .map((item, order) => ({ ...item, order })),
                            })),
                          );
                          setSelectedId(null);
                        }}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </div>
                  </div>
                  <input
                    aria-label={`Текст строки ${index + 1}`}
                    className={control}
                    value={line.text}
                    maxLength={2000}
                    disabled={!editable || stale}
                    placeholder="Точно как на оригинале"
                    onFocus={() => {
                      chooseLine(line.id);
                      setPageId(line.pageId);
                    }}
                    onChange={(event) =>
                      patchLine(line.id, { text: event.target.value })
                    }
                  />
                </div>
              ))}
            {selected && page && selected.pageId === page.id && (
              <fieldset
                disabled={!editable || stale}
                className="grid grid-cols-2 gap-2"
              >
                <legend className="mb-2 text-xs font-semibold">
                  Рамка выбранной строки · пиксели оригинала
                </legend>
                {(
                  [
                    ["cx", "Центр X"],
                    ["cy", "Центр Y"],
                    ["width", "Ширина"],
                    ["height", "Высота"],
                    ["angle", "Угол, °"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="flex flex-col gap-1 text-xs">
                    {label}
                    <input
                      type="number"
                      step={key === "angle" ? 0.1 : 1}
                      className={control}
                      value={
                        Math.round(
                          pixelBox(selected.quad, page.width, page.height)[
                            key
                          ] * 10,
                        ) / 10
                      }
                      onChange={(event) =>
                        numeric(key, Number(event.target.value))
                      }
                    />
                  </label>
                ))}
              </fieldset>
            )}
            <p className="text-xs text-[var(--muted-foreground)]">
              Стрелки на выделенной рамке перемещают её на 1 пиксель, Shift — на
              10. Клавиши [ и ] поворачивают рамку.
            </p>
          </div>
        </div>
      </div>
      <div
        data-annotation-submit=""
        className="flex flex-wrap items-center gap-2"
      >
        <Button
          variant="outline"
          disabled={!editable || stale || !draft || invalidText}
          onClick={async () => {
            setMessage("");
            try {
              await persist();
              setMessage("Черновик сохранён.");
            } catch {
              error();
            }
          }}
        >
          {save.isPending ? "Сохранение…" : "Сохранить черновик"}
        </Button>
        <Button
          disabled={!editable || stale || !complete}
          onClick={async () => {
            setMessage("");
            try {
              const current = await persist();
              saved(
                await submit.mutateAsync({
                  id: current.id,
                  data: { revision: current.revision },
                }),
              );
              setMessage("Разметка отправлена на проверку.");
            } catch {
              error();
            }
          }}
        >
          {submit.isPending ? "Отправка…" : "Отправить разметку"}
        </Button>
        {draft && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setMessage("Черновик сброшен до сохранённой редакции.");
            }}
          >
            Сбросить черновик
          </Button>
        )}
        {!complete && annotation.editable && (
          <p className="text-xs text-[var(--muted-foreground)]">
            Заполните все поля и текст каждой строки для отправки.
          </p>
        )}
      </div>
      {admin && annotation.status === "SUBMITTED" && (
        <div className="flex flex-wrap items-end gap-3 border-t border-[var(--border)] pt-3">
          <Button
            disabled={busy || !sourceAvailable}
            onClick={async () => {
              setMessage("");
              try {
                saved(
                  await accept.mutateAsync({
                    id: annotation.id,
                    data: { revision: annotation.revision },
                  }),
                );
              } catch {
                error();
              }
            }}
          >
            Принять разметку
          </Button>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
            Причина возврата
            <textarea
              className={control}
              value={note}
              maxLength={2000}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <Button
            variant="outline"
            disabled={busy || !note.trim()}
            onClick={async () => {
              try {
                saved(
                  await changes.mutateAsync({
                    id: annotation.id,
                    data: { revision: annotation.revision, note: note.trim() },
                  }),
                );
                setNote("");
              } catch {
                error();
              }
            }}
          >
            Вернуть на доработку
          </Button>
        </div>
      )}
    </section>
  );
}
