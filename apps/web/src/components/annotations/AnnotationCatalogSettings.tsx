import { useEffect, useRef, useState } from "react";
import { Badge, Button } from "@edo/ui";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  useListAnnotationCatalogs,
  useListAnnotationDocumentTypes,
  useRefreshAnnotationDocumentTypes,
  useGetAnnotationCatalogDefaults,
  getGetAnnotationCatalogDefaultsQueryKey,
  useCreateAnnotationCatalog,
  useUpdateAnnotationCatalog,
  usePublishAnnotationCatalog,
  useDeleteAnnotationCatalog,
  type AnnotationCatalogDto,
  type CreateAnnotationCatalogDto,
  type AnnotationCatalogFieldDto,
} from "@edo/api-client";
import { AnnotationCatalogSuggestions } from "./AnnotationCatalogSuggestions";
import { SearchSelect } from "../SearchSelect";
import { DOCUMENT_FIELD_LABELS } from "../document-field-labels";
const control =
  "min-w-0 rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]";
const main = () => [
  { key: "main", label: "Основной документ", ordinal: 0, repeatable: false },
];
const blank = (documentTypeCode = ""): CreateAnnotationCatalogDto => ({
  documentTypeCode,
  profile: "",
  title: "",
  fields: [],
  sections: main(),
});
const kinds: Record<string, string> = {
  TEXT: "Текст",
  PHOTO: "Фотография",
  SIGNATURE: "Подпись",
  STAMP: "Печать или штамп",
  CODE: "Штрихкод или QR-код",
};
export function AnnotationCatalogSettings() {
  const catalogs = useListAnnotationCatalogs(),
    types = useListAnnotationDocumentTypes(),
    refresh = useRefreshAnnotationDocumentTypes();
  const create = useCreateAnnotationCatalog(),
    update = useUpdateAnnotationCatalog(),
    publish = usePublishAnnotationCatalog(),
    remove = useDeleteAnnotationCatalog();
  const [selected, setSelected] = useState<AnnotationCatalogDto | null>(null),
    [draft, setDraft] = useState<CreateAnnotationCatalogDto>(blank),
    [dirty, setDirty] = useState(false),
    [message, setMessage] = useState(""),
    [known, setKnown] = useState("");
  const entered = useRef(false);
  const refreshTypes = async () => {
    try {
      await refresh.mutateAsync();
      await Promise.all([types.refetch(), catalogs.refetch()]);
    } catch {
      setMessage(
        "Не удалось обновить справочник из 1С. Доступны сохранённые сведения.",
      );
    }
  };
  useEffect(() => {
    if (!entered.current) {
      entered.current = true;
      void refreshTypes();
    }
  }, []);
  const defaults = useGetAnnotationCatalogDefaults(
    draft.documentTypeCode,
    { profile: draft.profile || undefined },
    {
      query: {
        queryKey: getGetAnnotationCatalogDefaultsQueryKey(
          draft.documentTypeCode,
          { profile: draft.profile || undefined },
        ),
        enabled: false,
      },
    },
  );
  const readonly = selected?.status === "PUBLISHED",
    busy =
      create.isPending ||
      update.isPending ||
      publish.isPending ||
      remove.isPending;
  const choose = (
    catalog: AnnotationCatalogDto | null,
    code = draft.documentTypeCode,
  ) => {
    setSelected(catalog);
    setDraft(
      catalog
        ? {
            documentTypeCode: catalog.documentTypeCode,
            profile: catalog.profile,
            title: catalog.title,
            fields: catalog.fields.map((f) => ({ ...f })),
            sections: catalog.sections?.length
              ? catalog.sections.map((s) => ({ ...s }))
              : main(),
          }
        : blank(code),
    );
    setDirty(false);
    setMessage("");
  };
  const edit = (patch: Partial<CreateAnnotationCatalogDto>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const field = (index: number, patch: Partial<AnnotationCatalogFieldDto>) =>
    edit({
      fields: draft.fields.map((f, i) =>
        i === index ? { ...f, ...patch } : f,
      ),
    });
  const sections = draft.sections ?? main();
  const variants = (catalogs.data?.items ?? []).filter(
    (c) => c.documentTypeCode === draft.documentTypeCode,
  );
  const definitions =
    types.data?.items.find((t) => t.code === draft.documentTypeCode)
      ?.businessFields ?? [];
  const usable = refresh.data ?? types.data;
  const valid =
    !!draft.documentTypeCode &&
    !!draft.title.trim() &&
    draft.fields.length > 0 &&
    draft.fields.every(
      (f) =>
        f.label.trim() &&
        sections.some((s) => s.key === (f.sectionKey ?? "main")),
    ) &&
    sections.every((s) => s.label.trim());
  const library = [
    ...new Map(
      (catalogs.data?.items ?? [])
        .flatMap((c) => c.fields)
        .map((f) => [f.label, f]),
    ).values(),
  ].sort((a, b) => a.label.localeCompare(b.label, "ru"));
  const save = async () => {
    const payload = {
      ...draft,
      sections,
      fields: draft.fields.map((f, ordinal) => ({ ...f, ordinal })),
    };
    const next = selected
      ? await update.mutateAsync({
          id: selected.id,
          data: {
            title: payload.title,
            fields: payload.fields,
            sections,
            revision: selected.revision,
          },
        })
      : await create.mutateAsync({ data: payload });
    choose(next);
    await catalogs.refetch();
    return next;
  };
  const action = async (fn: () => Promise<unknown>) => {
    setMessage("");
    try {
      await fn();
    } catch {
      setMessage(
        "Не удалось сохранить изменения. Правки остались на экране. Обновите сведения и повторите.",
      );
    }
  };
  return (
    <section
      className="flex min-w-0 flex-col gap-5"
      aria-label="Списки полей разметки"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-prose text-sm text-[var(--muted-foreground)]">
          Настройте страницы и поля оригинала. Эти списки используются для
          разметки датасета и сохраняются независимо от реквизитов 1С.
        </p>
        <Button
          variant="outline"
          disabled={refresh.isPending || dirty}
          onClick={() => void refreshTypes()}
        >
          {refresh.isPending ? "Обновление…" : "Обновить из 1С"}
        </Button>
      </div>
      {usable?.syncedAt && (
        <p className="text-xs text-[var(--muted-foreground)]">
          Справочник обновлён:{" "}
          {new Date(usable.syncedAt).toLocaleString("ru-RU")}
          {usable.stale ? " · Используются сохранённые сведения" : ""}
        </p>
      )}
      {(types.isError || catalogs.isError) && (
        <p role="alert">
          Не удалось загрузить справочник.{" "}
          <Button
            variant="outline"
            onClick={() => {
              void types.refetch();
              void catalogs.refetch();
            }}
          >
            Повторить
          </Button>
        </p>
      )}
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-2 text-sm font-semibold">
          Тип документа из 1С
          <SearchSelect
            label="Тип документа из 1С"
            placeholder="Выберите документ"
            value={draft.documentTypeCode}
            options={(usable?.items ?? []).map((t) => ({
              value: t.code,
              label: t.title,
            }))}
            isLoading={types.isLoading || refresh.isPending}
            disabled={dirty || busy}
            onChange={(code) => {
              const c = catalogs.data?.items.find(
                (c) => c.documentTypeCode === code,
              );
              choose(c ?? null, code ?? "");
            }}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-2 text-sm font-semibold">
          Вариант документа и версия списка
          <SearchSelect
            label="Вариант документа и версия списка"
            placeholder={
              draft.documentTypeCode
                ? "Выберите вариант"
                : "Сначала выберите тип"
            }
            value={selected?.id}
            selectedLabel={draft.title}
            disabled={dirty || busy || !draft.documentTypeCode}
            options={variants.map((c) => ({
              value: c.id,
              label: `${c.title} · версия ${c.version} · ${c.status === "PUBLISHED" ? "Опубликован" : "Черновик"}`,
            }))}
            emptyText="Для этого документа ещё нет списка полей"
            onChange={(id) => choose(variants.find((c) => c.id === id) ?? null)}
          />
        </div>
      </div>
      {!!draft.documentTypeCode && (
        <>
          {!variants.length && (
            <p role="status" className="text-sm">
              Этот тип ещё не настроен. Создайте вариант документа и добавьте
              его поля.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={dirty || busy}
              onClick={() => {
                choose(null);
                setDirty(true);
              }}
            >
              Создать вариант документа
            </Button>
            {readonly && (
              <Button
                variant="outline"
                onClick={() => {
                  setSelected(null);
                  setDirty(true);
                }}
              >
                Создать новую версию
              </Button>
            )}
            {selected && <Badge>{readonly ? "Опубликован" : "Черновик"}</Badge>}
          </div>
          {readonly && (
            <p className="text-sm text-[var(--muted-foreground)]">
              Для изменения опубликованного списка создайте новую версию. Уже
              начатая разметка сохраняет прежний список полей.
            </p>
          )}
          <fieldset
            disabled={readonly || busy}
            className="flex min-w-0 flex-col gap-5"
          >
            <label className="flex flex-col gap-2 text-sm font-semibold">
              Название варианта документа
              <input
                className={control}
                value={draft.title}
                maxLength={255}
                placeholder="Например, Паспорт России"
                onChange={(e) => edit({ title: e.target.value })}
              />
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="outline"
                disabled={defaults.isFetching}
                onClick={() =>
                  void action(async () => {
                    const result = await defaults.refetch();
                    if (!result.data) throw Error();
                    const data = result.data;
                    edit({
                      title: draft.title || data.title || "",
                      profile: draft.profile,
                      sections: draft.fields.length
                        ? sections
                        : (data.sections ?? main()),
                      fields: [
                        ...draft.fields,
                        ...data.fields.filter(
                          (f) => !draft.fields.some((x) => x.key === f.key),
                        ),
                      ].map((f, ordinal) => ({ ...f, ordinal })),
                    });
                    setMessage(
                      data.fields.length
                        ? "Базовые поля добавлены."
                        : "Для нового типа добавьте поля самостоятельно или выберите их из готовых списков.",
                    );
                  })
                }
              >
                Добавить базовые поля
              </Button>
            </div>
            <div className="flex flex-col gap-3">
              <h3 className="text-base font-semibold">Страницы и разделы</h3>
              <p className="text-sm text-[var(--muted-foreground)]">
                Раздел соответствует части документа. Разметчик привяжет его к
                загруженным страницам. Повторы подходят для штампов,
                исследований и записей таблицы.
              </p>
              {sections.map((s, index) => (
                <div key={s.key} className="flex flex-wrap items-center gap-3">
                  <input
                    aria-label={`Название раздела ${index + 1}`}
                    className={`${control} flex-1`}
                    value={s.label}
                    maxLength={255}
                    onChange={(e) =>
                      edit({
                        sections: sections.map((x, i) =>
                          i === index ? { ...x, label: e.target.value } : x,
                        ),
                      })
                    }
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={s.repeatable}
                      onChange={(e) =>
                        edit({
                          sections: sections.map((x, i) =>
                            i === index
                              ? { ...x, repeatable: e.target.checked }
                              : x,
                          ),
                        })
                      }
                    />
                    Повторяемый блок
                  </label>
                  <Button
                    variant="ghost"
                    aria-label={`Удалить раздел ${s.label}`}
                    disabled={
                      sections.length === 1 ||
                      draft.fields.some(
                        (f) => (f.sectionKey ?? "main") === s.key,
                      )
                    }
                    onClick={() =>
                      edit({
                        sections: sections
                          .filter((x) => x.key !== s.key)
                          .map((x, ordinal) => ({ ...x, ordinal })),
                      })
                    }
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              ))}
              <Button
                className="self-start"
                variant="outline"
                onClick={() =>
                  edit({
                    sections: [
                      ...sections,
                      {
                        key: `section_${crypto.randomUUID().slice(0, 8)}`,
                        label: "Новый раздел",
                        ordinal: sections.length,
                        repeatable: false,
                      },
                    ],
                  })
                }
              >
                <Plus size={16} />
                Добавить раздел
              </Button>
            </div>
            <div className="flex flex-col gap-4">
              <h3 className="text-base font-semibold">Поля документа</h3>
              {draft.fields.map((f, index) => (
                <div
                  key={index}
                  className="grid min-w-0 gap-3 border-t border-[var(--border)] pt-4 sm:grid-cols-2 lg:grid-cols-3"
                >
                  <label className="flex flex-col gap-1 text-xs">
                    Название поля
                    <input
                      className={control}
                      value={f.label}
                      maxLength={255}
                      onChange={(e) => field(index, { label: e.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    Раздел
                    <select
                      className={control}
                      value={f.sectionKey ?? "main"}
                      onChange={(e) =>
                        field(index, { sectionKey: e.target.value })
                      }
                    >
                      {sections.map((s) => (
                        <option key={s.key} value={s.key}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    Вид области
                    <select
                      className={control}
                      value={f.kind ?? "TEXT"}
                      onChange={(e) =>
                        field(index, {
                          kind: e.target
                            .value as AnnotationCatalogFieldDto["kind"],
                          multiline: false,
                        })
                      }
                    >
                      {Object.entries(kinds).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    Связь с реквизитом 1С
                    <select
                      className={control}
                      value={f.businessFieldName ?? ""}
                      onChange={(e) =>
                        field(index, {
                          businessFieldName: e.target.value || null,
                        })
                      }
                    >
                      <option value="">Не связывать</option>
                      {definitions.map((name) => (
                        <option key={name} value={name}>
                          {DOCUMENT_FIELD_LABELS[name] ??
                            "Дополнительный реквизит"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      disabled={!!f.kind && f.kind !== "TEXT"}
                      checked={f.multiline}
                      onChange={(e) =>
                        field(index, { multiline: e.target.checked })
                      }
                    />
                    Несколько строк текста
                  </label>
                  <div className="flex items-end justify-end gap-1">
                    {[-1, 1].map((offset) => (
                      <Button
                        key={offset}
                        variant="ghost"
                        aria-label={`${offset < 0 ? "Поднять" : "Опустить"} поле ${f.label}`}
                        disabled={
                          index + offset < 0 ||
                          index + offset >= draft.fields.length
                        }
                        onClick={() => {
                          const fields = [...draft.fields];
                          [fields[index], fields[index + offset]] = [
                            fields[index + offset],
                            fields[index],
                          ];
                          edit({
                            fields: fields.map((x, ordinal) => ({
                              ...x,
                              ordinal,
                            })),
                          });
                        }}
                      >
                        {offset < 0 ? (
                          <ArrowUp size={16} />
                        ) : (
                          <ArrowDown size={16} />
                        )}
                      </Button>
                    ))}
                    <Button
                      variant="ghost"
                      aria-label={`Удалить поле ${f.label}`}
                      onClick={() =>
                        edit({
                          fields: draft.fields
                            .filter((_, i) => i !== index)
                            .map((x, ordinal) => ({ ...x, ordinal })),
                        })
                      }
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-60 flex-1 flex-col gap-2 text-xs">
                Поле из готовых списков
                <SearchSelect
                  label="Поле из готовых списков"
                  value={known}
                  options={library.map((f) => ({
                    value: f.label,
                    label: f.label,
                  }))}
                  onChange={(key) => setKnown(key ?? "")}
                />
              </div>
              <Button
                variant="outline"
                disabled={!known}
                onClick={() => {
                  const f = library.find((f) => f.label === known);
                  if (f) {
                    edit({
                      fields: [
                        ...draft.fields,
                        {
                          ...f,
                          key: "",
                          sectionKey: sections[0].key,
                          ordinal: draft.fields.length,
                          businessFieldName: null,
                        },
                      ],
                    });
                    setKnown("");
                  }
                }}
              >
                Добавить выбранное
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  edit({
                    fields: [
                      ...draft.fields,
                      {
                        key: "",
                        label: "",
                        sectionKey: sections[0].key,
                        kind: "TEXT",
                        ordinal: draft.fields.length,
                        multiline: false,
                        businessFieldName: null,
                      },
                    ],
                  })
                }
              >
                <Plus size={16} />
                Новое поле
              </Button>
            </div>
          </fieldset>
          {!readonly && (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!valid || busy || (!dirty && !!selected)}
                onClick={() =>
                  void action(async () => {
                    await save();
                    setMessage("Черновик сохранён.");
                  })
                }
              >
                Сохранить черновик
              </Button>
              <Button
                disabled={!valid || busy}
                onClick={() =>
                  void action(async () => {
                    const c = dirty || !selected ? await save() : selected;
                    choose(
                      await publish.mutateAsync({
                        id: c.id,
                        data: { revision: c.revision },
                      }),
                    );
                    await catalogs.refetch();
                    setMessage("Список опубликован и доступен для разметки.");
                  })
                }
              >
                Опубликовать список
              </Button>
              {selected && (
                <AnnotationCatalogSuggestions
                  catalog={selected}
                  catalogs={catalogs.data?.items ?? []}
                  disabled={busy || dirty}
                  onAdd={(suggestion) => {
                    if (readonly) setSelected(null);
                    edit({
                      fields: [
                        ...draft.fields,
                        { ...suggestion, ordinal: draft.fields.length },
                      ],
                    });
                  }}
                />
              )}
              {dirty && (
                <Button variant="ghost" onClick={() => choose(selected)}>
                  Сбросить правки
                </Button>
              )}
              {selected && (
                <Button
                  variant="ghost"
                  disabled={busy || dirty}
                  onClick={() =>
                    void action(async () => {
                      await remove.mutateAsync({
                        id: selected.id,
                        params: { revision: selected.revision },
                      });
                      choose(null);
                      await catalogs.refetch();
                    })
                  }
                >
                  Удалить черновик
                </Button>
              )}
            </div>
          )}
        </>
      )}
      {dirty && (
        <p role="status" className="text-sm">
          Есть несохранённые изменения. Сохраните или сбросьте их перед выбором
          другого документа.
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
