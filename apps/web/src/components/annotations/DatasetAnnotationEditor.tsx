import { useState } from "react";
import { Badge, Button } from "@edo/ui";
import { Plus, Trash2 } from "lucide-react";
import {
  useSaveAnnotation,
  useSubmitAnnotation,
  useAcceptAnnotation,
  useRequestAnnotationChanges,
  type AnnotationFieldAnswerDto,
  type AnnotationSectionInstanceDto,
  type AnnotationRegionDto,
  type AnnotationLineDto,
  type AnnotationDto,
  type DocumentFileDto,
} from "@edo/api-client";
import { DocumentPreview } from "../DocumentPreview";
import type { AnnotationEditorProps } from "./AnnotationEditor";
import { pixelBox, normalizedQuad, boxInsidePage } from "./annotation-geometry";
const control =
  "min-w-0 rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]";
const statuses = {
  DRAFT: "Черновик",
  SUBMITTED: "На проверке",
  ACCEPTED: "Принято",
  CHANGES_REQUESTED: "Нужны исправления",
};
const emptySection = (key: string): AnnotationSectionInstanceDto => ({
  id: key,
  sectionKey: key,
  availability: "NOT_UPLOADED",
  pageIds: [],
});
export function DatasetAnnotationEditor({
  annotation,
  files,
  liveSources,
  sourceError = false,
  onSaved,
  admin = false,
  active = true,
}: AnnotationEditorProps) {
  const save = useSaveAnnotation(),
    submit = useSubmitAnnotation(),
    accept = useAcceptAnnotation(),
    changes = useRequestAnnotationChanges();
  const [draft, setDraft] = useState<{
    revision: number;
    fields: AnnotationFieldAnswerDto[];
    sections: AnnotationSectionInstanceDto[];
  } | null>(null);
  const [sectionId, setSectionId] = useState(
      annotation.sections?.[0]?.id ??
        annotation.schema.sections?.[0]?.key ??
        "",
    ),
    [fieldKey, setFieldKey] = useState(""),
    [pageId, setPageId] = useState(annotation.sources.pages[0]?.id ?? ""),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [mode, setMode] = useState<"RECTANGLE" | "POLYGON" | "LINE" | null>(null),
    [message, setMessage] = useState(""),
    [note, setNote] = useState("");
  const fields = draft?.fields ?? annotation.fields,
    sections =
      draft?.sections ??
      (annotation.sections?.length
        ? annotation.sections
        : (annotation.schema.sections ?? []).map((s) => emptySection(s.key)));
  const currentSection =
    sections.find((s) => s.id === sectionId) ?? sections[0];
  const sectionDefinition = annotation.schema.sections?.find(
    (s) => s.key === currentSection?.sectionKey,
  );
  const visibleFields = annotation.schema.fields.filter(
    (f) => (f.sectionKey ?? "main") === currentSection?.sectionKey,
  );
  const definition =
    visibleFields.find((f) => f.key === fieldKey) ?? visibleFields[0];
  const answer = fields.find(
    (f) => f.key === definition?.key && f.instanceId === currentSection?.id,
  );
  const page =
    annotation.sources.pages.find((p) => p.id === pageId) ??
    annotation.sources.pages[0];
  const source = liveSources ?? annotation.sources;
  const available =
    !!page &&
    source.available !== false &&
    !sourceError &&
    source.pages.length === annotation.sources.pages.length &&
    annotation.sources.pages.every((p) =>
      source.pages.some(
        (f) =>
          f.id === p.id &&
          f.sha256 === p.sha256 &&
          f.width === p.width &&
          f.height === p.height &&
          f.previewUrl,
      ),
    );
  const busy =
    save.isPending || submit.isPending || accept.isPending || changes.isPending;
  const stale = !!draft && draft.revision !== annotation.revision;
  const editable =
    annotation.editable && !busy && !stale && available && active;
  const patch = (nextFields = fields, nextSections = sections) =>
    setDraft({
      revision: draft?.revision ?? annotation.revision,
      fields: nextFields,
      sections: nextSections,
    });
  const updateAnswer = (data: Partial<AnnotationFieldAnswerDto>) => {
    if (!definition || !currentSection) return;
    const next: AnnotationFieldAnswerDto = {
      key: definition.key,
      instanceId: currentSection.id,
      disposition: "PRESENT",
      lines: [],
      regions: [],
      ...answer,
      ...data,
    };
    patch([
      ...fields.filter(
        (f) =>
          !(f.key === definition.key && f.instanceId === currentSection.id),
      ),
      next,
    ]);
  };
  const updateSection = (data: Partial<AnnotationSectionInstanceDto>) => {
    if (!currentSection) return;
    const missing = data.availability && data.availability !== "PRESENT";
    patch(
      missing
        ? fields.filter((f) => f.instanceId !== currentSection.id)
        : fields,
      sections.map((s) =>
        s.id === currentSection.id
          ? { ...s, ...data, ...(missing ? { pageIds: [] } : {}) }
          : s,
      ),
    );
    setMode(null);
  };
  const patchLine = (id: string, data: Partial<AnnotationLineDto>) =>
    patch(
      fields.map((f) => ({
        ...f,
        lines: f.lines.map((l) => (l.id === id ? { ...l, ...data } : l)),
      })),
    );
  const patchRegion = (id: string, data: Partial<AnnotationRegionDto>) =>
    patch(
      fields.map((f) => ({
        ...f,
        regions: f.regions?.map((r) => (r.id === id ? { ...r, ...data } : r)),
      })),
    );
  const region = fields
      .flatMap((f) => f.regions ?? [])
      .find((r) => r.id === selectedId),
    line = fields.flatMap((f) => f.lines).find((l) => l.id === selectedId);
  const select = (id: string) => {
    setSelectedId(id);
    const f = fields.find(
      (f) =>
        f.lines.some((l) => l.id === id) || f.regions?.some((r) => r.id === id),
    );
    if (f) {
      setFieldKey(f.key);
      setSectionId(f.instanceId ?? "main");
    }
    setMode(null);
  };
  const complete =
    sections.some((s) => s.availability === "PRESENT") &&
    (annotation.schema.sections ?? []).every((d) =>
      sections.some((s) => s.sectionKey === d.key),
    ) &&
    sections.every(
      (s) =>
        s.availability !== "PRESENT" ||
        (s.pageIds.length > 0 &&
          annotation.schema.fields
            .filter((f) => (f.sectionKey ?? "main") === s.sectionKey)
            .every((d) => {
              const a = fields.find(
                (f) => f.key === d.key && f.instanceId === s.id,
              );
              return (
                !!a &&
                (a.disposition === "NOT_PRESENT" ||
                  (!!a.regions?.length &&
                    (a.disposition === "UNREADABLE" ||
                      (d.kind && d.kind !== "TEXT") ||
                      (a.lines.length > 0 &&
                        a.lines.every(
                          (l) =>
                            !!l.text.trim() &&
                            ![...l.text].some((c) => {
                              const n = c.charCodeAt(0);
                              return (
                                n < 32 ||
                                (n >= 127 && n <= 159) ||
                                n === 0x2028 ||
                                n === 0x2029
                              );
                            }),
                        )))))
              );
            })),
    );
  const saved = (next: AnnotationDto) => {
    setDraft(null);
    onSaved(next);
  };
  const persist = async () => {
    if (!draft) return annotation;
    const next = await save.mutateAsync({
      id: annotation.id,
      data: {
        revision: draft.revision,
        fields: draft.fields,
        sections: draft.sections,
      },
    });
    saved(next);
    return next;
  };
  const perform = async (fn: () => Promise<unknown>) => {
    setMessage("");
    try {
      await fn();
    } catch {
      setMessage(
        "Не удалось сохранить: работа или оригинал могли измениться. Ваши правки остались на экране. Обновите сведения и повторите.",
      );
    }
  };
  const readyToDraw =
    editable &&
    !!definition &&
    currentSection?.availability === "PRESENT" &&
    currentSection.pageIds.includes(page?.id ?? "") &&
    answer?.disposition !== "NOT_PRESENT";
  const displayPage = source.pages.find((p) => p.id === page?.id) ?? page;
  const file =
    files?.find((f) => f.id === page?.fileId) ??
    (page
      ? {
          id: page.fileId,
          ordinal: 0,
          filename: `Оригинал · страница ${page.pageNumber}`,
          mimeType: page.mimeType as DocumentFileDto["mimeType"],
          sizeBytes: page.sizeBytes,
          pageCount: Math.max(
            ...annotation.sources.pages
              .filter((p) => p.fileId === page.fileId)
              .map((p) => p.pageNumber),
          ),
          deleted: false,
        }
      : undefined);
  return (
    <section
      aria-label="Редактор разметки"
      className="flex min-w-0 flex-col gap-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <b>{annotation.schema.title}</b>
        <Badge>{statuses[annotation.status]}</Badge>
        <span className="text-xs text-[var(--muted-foreground)]">
          Версия списка {annotation.schema.version} · версия документа{" "}
          {annotation.sources.version}
        </span>
        {draft && <Badge tone="warning">Не сохранено</Badge>}
      </div>
      <p className="max-w-prose text-sm text-[var(--muted-foreground)]">
        Назначьте страницы разделам. Обведите поле целиком, затем каждую строку
        и перепишите текст как на оригинале. Маркер «Верх» задаёт направление
        чтения; у фото, подписей и печатей текст не требуется.
      </p>
      {!available && (
        <p role="alert">
          Оригинал недоступен или изменился. Черновик сохранён на экране;
          редактирование и отправка временно недоступны.
        </p>
      )}
      {stale && (
        <p role="alert">
          На сервере появилась новая редакция. Ваши правки остались на экране.
          Обновите сведения; для перехода к сохранённой редакции сбросьте
          черновик.
        </p>
      )}
      {annotation.note && (
        <p role="status">Комментарий проверки: {annotation.note}</p>
      )}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(300px,1fr)]">
        <div className="flex min-h-[480px] min-w-0 flex-col gap-3 lg:h-[70dvh]">
          <label className="flex flex-col gap-1 text-xs">
            Страница оригинала
            <select
              className={control}
              value={page?.id ?? ""}
              onChange={(e) => {
                setPageId(e.target.value);
                setMode(null);
                setSelectedId(null);
              }}
            >
              {annotation.sources.pages.map((p, index) => (
                <option key={p.id} value={p.id}>
                  Изображение {index + 1} · страница файла {p.pageNumber}
                </option>
              ))}
            </select>
          </label>
          {available && file && displayPage && page && (
            <DocumentPreview
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
                  .flatMap((f) => f.lines)
                  .filter((l) => l.pageId === page.id),
                selectedId,
                editable: editable && (!mode || mode === "LINE"),
                drawing: mode === "LINE",
                onSelect: select,
                onChange: (id, quad) => patchLine(id, { quad }),
                onCreate: (quad) => {
                  if (!readyToDraw) return;
                  const id = crypto.randomUUID();
                  updateAnswer({
                    lines: [
                      ...(answer?.lines ?? []),
                      {
                        id,
                        pageId: page.id,
                        order: answer?.lines.length ?? 0,
                        text: "",
                        quad,
                      },
                    ],
                  });
                  setSelectedId(id);
                  setMode(null);
                },
                regionLayer: {
                  passive: mode === "LINE",
                  regions: fields
                    .flatMap((f) => f.regions ?? [])
                    .filter((r) => r.pageId === page.id),
                  selectedId,
                  editable: editable && mode !== "LINE",
                  drawing:
                    mode === "RECTANGLE" || mode === "POLYGON" ? mode : null,
                  onSelect: select,
                  onChange: patchRegion,
                  onCreate: (r) => {
                    if (!readyToDraw) return;
                    updateAnswer({
                      regions: [
                        ...(answer?.regions ?? []),
                        { ...r, pageId: page.id },
                      ],
                    });
                    setSelectedId(r.id);
                    setMode(null);
                  },
                },
              }}
            />
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-4 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 lg:max-h-[70dvh]">
          <label className="flex flex-col gap-1 text-xs">
            Раздел и экземпляр блока
            <select
              className={control}
              value={currentSection?.id ?? ""}
              onChange={(e) => {
                setSectionId(e.target.value);
                setFieldKey("");
                setSelectedId(null);
                setMode(null);
              }}
            >
              {sections.map((s) => {
                const def = annotation.schema.sections?.find(
                  (d) => d.key === s.sectionKey,
                );
                const ordinal =
                  sections
                    .filter((x) => x.sectionKey === s.sectionKey)
                    .findIndex((x) => x.id === s.id) + 1;
                return (
                  <option key={s.id} value={s.id}>
                    {def?.label ?? "Раздел"}
                    {def?.repeatable ? ` · блок ${ordinal}` : ""}
                  </option>
                );
              })}
            </select>
          </label>
          <div className="flex flex-wrap gap-2">
            {sectionDefinition?.repeatable && (
              <Button
                variant="outline"
                size="sm"
                disabled={!editable}
                onClick={() => {
                  const id = crypto.randomUUID();
                  patch(fields, [
                    ...sections,
                    {
                      id,
                      sectionKey: sectionDefinition.key,
                      availability: "PRESENT",
                      pageIds: page ? [page.id] : [],
                    },
                  ]);
                  setSectionId(id);
                  setSelectedId(null);
                  setMode(null);
                }}
              >
                <Plus size={15} />
                Добавить блок
              </Button>
            )}
            {sectionDefinition?.repeatable &&
              sections.filter((s) => s.sectionKey === sectionDefinition.key)
                .length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!editable}
                  onClick={() => {
                    const next = sections.filter(
                      (s) => s.id !== currentSection.id,
                    );
                    patch(
                      fields.filter((f) => f.instanceId !== currentSection.id),
                      next,
                    );
                    setSectionId(next[0].id);
                  }}
                >
                  Удалить блок
                </Button>
              )}
          </div>
          <label className="flex flex-col gap-1 text-xs">
            Состояние раздела
            <select
              className={control}
              disabled={!editable}
              value={currentSection?.availability ?? "NOT_UPLOADED"}
              onChange={(e) =>
                updateSection({
                  availability: e.target
                    .value as AnnotationSectionInstanceDto["availability"],
                  pageIds:
                    e.target.value === "PRESENT" && page ? [page.id] : [],
                })
              }
            >
              <option value="NOT_UPLOADED">Страница не загружена</option>
              <option value="PRESENT">Есть на загруженных страницах</option>
              <option value="NOT_PRESENT">
                Раздел отсутствует в документе
              </option>
            </select>
          </label>
          {currentSection?.availability === "PRESENT" && (
            <fieldset disabled={!editable} className="flex flex-col gap-2">
              <legend className="mb-2 text-xs">Страницы этого раздела</legend>
              {annotation.sources.pages.map((p, i) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={currentSection.pageIds.includes(p.id)}
                    onChange={(e) =>
                      updateSection({
                        pageIds: e.target.checked
                          ? [...currentSection.pageIds, p.id]
                          : currentSection.pageIds.filter((id) => id !== p.id),
                      })
                    }
                  />
                  Изображение {i + 1} · страница {p.pageNumber}
                </label>
              ))}
            </fieldset>
          )}
          {currentSection?.availability === "PRESENT" && (
            <>
              <label className="flex flex-col gap-1 text-xs">
                Поле документа
                <select
                  className={control}
                  value={definition?.key ?? ""}
                  onChange={(e) => {
                    setFieldKey(e.target.value);
                    setSelectedId(null);
                    setMode(null);
                  }}
                >
                  {visibleFields.map((f) => {
                    const a = fields.find(
                      (a) =>
                        a.key === f.key && a.instanceId === currentSection.id,
                    );
                    return (
                      <option key={f.key} value={f.key}>
                        {f.label} ·{" "}
                        {a?.disposition === "NOT_PRESENT"
                          ? "Нет на оригинале"
                          : a?.disposition === "UNREADABLE"
                            ? "Не читается"
                            : a?.regions?.length
                              ? "Область отмечена"
                              : "Не размечено"}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-xs">
                Состояние поля
                <select
                  className={control}
                  disabled={!editable}
                  value={answer?.disposition ?? ""}
                  onChange={(e) => {
                    updateAnswer({
                      disposition: e.target
                        .value as AnnotationFieldAnswerDto["disposition"],
                      lines:
                        e.target.value === "PRESENT"
                          ? (answer?.lines ?? [])
                          : [],
                      regions:
                        e.target.value === "NOT_PRESENT"
                          ? []
                          : (answer?.regions ?? []),
                    });
                    setMode(null);
                  }}
                >
                  <option value="" disabled>
                    Выберите состояние
                  </option>
                  <option value="PRESENT">Есть на оригинале</option>
                  <option value="NOT_PRESENT">Нет на оригинале</option>
                  {(!definition?.kind || definition.kind === "TEXT") && (
                    <option value="UNREADABLE">
                      Текст невозможно прочитать
                    </option>
                  )}
                </select>
              </label>
              <div className="flex flex-wrap gap-2">
                {(["RECTANGLE", "POLYGON"] as const).map((shape) => (
                  <Button
                    key={shape}
                    variant={mode === shape ? "secondary" : "outline"}
                    size="sm"
                    disabled={!readyToDraw}
                    aria-pressed={mode === shape}
                    onClick={() => {
                      setMode(mode === shape ? null : shape);
                      setSelectedId(null);
                    }}
                  >
                    {shape === "RECTANGLE"
                      ? "Обвести рамкой"
                      : "Обвести контуром"}
                  </Button>
                ))}
                {(!definition?.kind || definition.kind === "TEXT") && (
                  <Button
                    variant={mode === "LINE" ? "secondary" : "outline"}
                    size="sm"
                    disabled={
                      !readyToDraw ||
                      answer?.disposition === "UNREADABLE" ||
                      (!definition?.multiline && !!answer?.lines.length)
                    }
                    onClick={() => {
                      setMode(mode === "LINE" ? null : "LINE");
                      setSelectedId(null);
                    }}
                  >
                    Добавить строку
                  </Button>
                )}
              </div>
              {mode && (
                <p role="status" className="text-sm">
                  {mode === "POLYGON"
                    ? "Отмечайте вершины по контуру. Для завершения нажмите на первую вершину или Enter. Escape отменяет контур."
                    : mode === "RECTANGLE"
                      ? "Протяните рамку вокруг всего поля."
                      : "Обведите одну визуальную строку, затем введите точный текст."}
                </p>
              )}
              <p className="text-xs text-[var(--muted-foreground)]">
                {definition?.multiline
                  ? "Для каждой визуальной строки нужна отдельная рамка."
                  : "Для текстового поля нужна одна рамка строки."}{" "}
                Поворот просмотра не меняет направление сохранённой разметки.
              </p>
              {(answer?.regions ?? []).map((r, i) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-2 text-sm"
                >
                  <button
                    className="text-left underline underline-offset-4"
                    onClick={() => {
                      select(r.id);
                      setPageId(r.pageId);
                    }}
                  >
                    Область поля {i + 1}
                    {r.id === selectedId ? " · выбрана" : ""}
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!editable}
                    aria-label={`Удалить область ${i + 1}`}
                    onClick={() =>
                      updateAnswer({
                        regions: answer?.regions?.filter((x) => x.id !== r.id),
                      })
                    }
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}
              {region && (
                <fieldset disabled={!editable} className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1 text-xs">
                    Направление верха области, °
                    <input
                      type="number"
                      min={0}
                      max={359.999}
                      className={control}
                      value={region.orientationDeg}
                      onChange={(e) => {
                        const angle = Number(e.target.value);
                        if (Number.isFinite(angle))
                          patchRegion(region.id, {
                            orientationDeg: ((angle % 360) + 360) % 360,
                          });
                      }}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        patchRegion(region.id, {
                          orientationDeg: (region.orientationDeg + 90) % 360,
                        })
                      }
                    >
                      Верх на 90°
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        patchRegion(region.id, {
                          orientationDeg: (region.orientationDeg + 180) % 360,
                        })
                      }
                    >
                      Развернуть на 180°
                    </Button>
                  </div>
                  <p className="text-xs text-[var(--muted-foreground)]">
                    Направление отмечено стрелкой «Верх». Вершины контура можно
                    перемещать на оригинале.
                  </p>
                </fieldset>
              )}
              {(answer?.lines ?? []).map((l, i) => (
                <div
                  key={l.id}
                  className="flex flex-col gap-2 border-t border-[var(--border)] pt-3"
                >
                  <div className="flex items-center justify-between">
                    <button
                      className="text-sm underline underline-offset-4"
                      onClick={() => {
                        select(l.id);
                        setPageId(l.pageId);
                      }}
                    >
                      Строка {i + 1}
                      {l.id === selectedId ? " · выбрана" : ""}
                    </button>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!editable || i === 0}
                        onClick={() => {
                          const lines = [...(answer?.lines ?? [])];
                          [lines[i - 1], lines[i]] = [lines[i], lines[i - 1]];
                          updateAnswer({
                            lines: lines.map((x, order) => ({ ...x, order })),
                          });
                        }}
                      >
                        Выше
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!editable}
                        aria-label={`Удалить строку ${i + 1}`}
                        onClick={() =>
                          updateAnswer({
                            lines: answer?.lines
                              .filter((x) => x.id !== l.id)
                              .map((x, order) => ({ ...x, order })),
                          })
                        }
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </div>
                  <label className="flex flex-col gap-1 text-xs">
                    Точный текст строки
                    <input
                      className={control}
                      disabled={!editable}
                      maxLength={2000}
                      value={l.text}
                      onChange={(e) =>
                        patchLine(l.id, { text: e.target.value })
                      }
                    />
                  </label>
                </div>
              ))}
              {line && page && line.pageId === page.id && (
                <fieldset disabled={!editable} className="flex flex-col gap-2">
                  <label className="flex flex-col gap-1 text-xs">
                    Поворот строки, °
                    <input
                      type="number"
                      className={control}
                      value={
                        Math.round(
                          pixelBox(line.quad, page.width, page.height).angle *
                            100,
                        ) / 100
                      }
                      onChange={(e) => {
                        const b = {
                          ...pixelBox(line.quad, page.width, page.height),
                          angle: Number(e.target.value),
                        };
                        if (boxInsidePage(b, page.width, page.height))
                          patchLine(line.id, {
                            quad: normalizedQuad(b, page.width, page.height),
                          });
                      }}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const b = pixelBox(line.quad, page.width, page.height);
                      patchLine(line.id, {
                        quad: normalizedQuad(
                          { ...b, angle: b.angle + 180 },
                          page.width,
                          page.height,
                        ),
                      });
                    }}
                  >
                    Развернуть строку на 180°
                  </Button>
                </fieldset>
              )}
            </>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={!editable || !draft}
          onClick={() =>
            void perform(async () => {
              await persist();
              setMessage("Черновик сохранён.");
            })
          }
        >
          Сохранить черновик
        </Button>
        <Button
          disabled={!editable || !complete}
          onClick={() =>
            void perform(async () => {
              const next = await persist();
              saved(
                await submit.mutateAsync({
                  id: next.id,
                  data: { revision: next.revision },
                }),
              );
              setMessage("Разметка отправлена на проверку.");
            })
          }
        >
          Отправить разметку
        </Button>
        {draft && (
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setMode(null);
              setSelectedId(null);
            }}
          >
            Сбросить черновик
          </Button>
        )}
        {!complete && annotation.editable && (
          <p className="text-xs text-[var(--muted-foreground)]">
            Назначьте страницы и завершите поля каждого присутствующего раздела.
          </p>
        )}
      </div>
      {admin && annotation.status === "SUBMITTED" && (
        <div className="flex flex-wrap items-end gap-3 border-t border-[var(--border)] pt-4">
          <Button
            disabled={busy || !available}
            onClick={() =>
              void perform(async () =>
                saved(
                  await accept.mutateAsync({
                    id: annotation.id,
                    data: { revision: annotation.revision },
                  }),
                ),
              )
            }
          >
            Принять разметку
          </Button>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
            Причина возврата
            <textarea
              className={control}
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <Button
            variant="outline"
            disabled={busy || !note.trim()}
            onClick={() =>
              void perform(async () =>
                saved(
                  await changes.mutateAsync({
                    id: annotation.id,
                    data: { revision: annotation.revision, note: note.trim() },
                  }),
                ),
              )
            }
          >
            Вернуть на доработку
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
