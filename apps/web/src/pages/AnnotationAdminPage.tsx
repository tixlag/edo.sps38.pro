import { useState } from "react";
import { Button, PageHeader, Badge } from "@edo/ui";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  getGetAnnotationSourcesQueryKey,
  useGetAnnotationSources,
  getGetAnnotationCatalogDefaultsQueryKey,
  useGetAnnotationCatalogDefaults,
  getListAnnotationCatalogSuggestionsQueryKey,
  useGetMe,
  useListAnnotationCatalogs,
  useListDocumentTypes,
  useListAnnotations,
  useCreateAnnotationCatalog,
  useUpdateAnnotationCatalog,
  usePublishAnnotationCatalog,
  useDeleteAnnotationCatalog,
  useListAnnotationCatalogSuggestions,
  useResolveAnnotationCatalogSuggestion,
  type AnnotationCatalogDto,
  type AnnotationCatalogFieldDto,
  type AnnotationDto,
  type CreateAnnotationCatalogDto,
} from "@edo/api-client";
import { AnnotationEditor } from "../components/annotations/AnnotationEditor";
const control =
  "min-w-0 rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]";
const empty = (): CreateAnnotationCatalogDto => ({
  documentTypeCode: "",
  profile: "RU",
  title: "",
  fields: [],
});
export function AnnotationAdminPage() {
  const me = useGetMe();
  const allowed =
    !!me.data?.permissions &&
    Object.prototype.hasOwnProperty.call(me.data.permissions, "20009");
  if (me.isLoading)
    return (
      <p role="status" className="p-6">
        Загрузка прав доступа…
      </p>
    );
  if (!allowed)
    return (
      <p role="alert" className="p-6">
        Для настройки разметки нужны права администратора.
      </p>
    );
  return <AnnotationAdministration />;
}
function AnnotationAdministration() {
  const [tab, setTab] = useState<"catalogs" | "acceptance">("catalogs");
  return (
    <div className="flex h-full min-w-0 flex-col gap-5 overflow-y-auto p-6">
      <PageHeader
        title="Разметка документов"
        subtitle="Списки полей и проверка выполненной разметки"
      />
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Раздел настройки разметки"
      >
        <Button
          variant={tab === "catalogs" ? "secondary" : "outline"}
          onClick={() => setTab("catalogs")}
        >
          Списки полей
        </Button>
        <Button
          variant={tab === "acceptance" ? "secondary" : "outline"}
          onClick={() => setTab("acceptance")}
        >
          На проверке
        </Button>
      </div>
      {tab === "catalogs" ? <CatalogSettings /> : <AnnotationAcceptance />}
    </div>
  );
}
function AnnotationAcceptance() {
  const query = useListAnnotations({ status: "SUBMITTED" });
  const [selected, setSelected] = useState<string | null>(null),
    [local, setLocal] = useState<AnnotationDto | null>(null);
  const item =
    (local?.id === selected ? local : undefined) ??
    query.data?.items.find((row) => row.id === selected);
  return (
    <section className="flex flex-col gap-4" aria-label="Проверка разметки">
      {query.isLoading && <p role="status">Загрузка работ…</p>}
      {query.isError && (
        <div role="alert">
          Не удалось загрузить работы.{" "}
          <Button variant="outline" onClick={() => void query.refetch()}>
            Повторить
          </Button>
        </div>
      )}
      {query.data && !query.data.items.length && !item && (
        <p className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-5 text-sm">
          Отправленных работ пока нет.
        </p>
      )}
      {!!query.data?.items.length && (
        <label className="flex flex-col gap-2 text-sm font-semibold">
          Работа для проверки
          <select
            className={control}
            value={selected ?? ""}
            onChange={(event) => {
              setSelected(event.target.value);
              setLocal(null);
            }}
          >
            <option value="">Выберите работу</option>
            {query.data.items.map((row) => (
              <option key={row.id} value={row.id}>
                {row.schema.title} · {row.schema.profile} · документ{" "}
                {row.documentId} · версия {row.sources.version}
              </option>
            ))}
          </select>
        </label>
      )}
      {item && (
        <AdminAnnotationReview
          key={item.id}
          annotation={item}
          onSaved={(next) => {
            setLocal(next);
            void query.refetch();
          }}
        />
      )}
    </section>
  );
}
function AdminAnnotationReview({
  annotation,
  onSaved,
}: {
  annotation: AnnotationDto;
  onSaved: (next: AnnotationDto) => void;
}) {
  const source = useGetAnnotationSources(
    annotation.documentId,
    annotation.sources.version,
    {
      query: {
        queryKey: getGetAnnotationSourcesQueryKey(
          annotation.documentId,
          annotation.sources.version,
        ),
        staleTime: 240_000,
        refetchInterval: 240_000,
      },
    },
  );
  return (
    <AnnotationEditor
      annotation={annotation}
      admin
      liveSources={source.data}
      sourceError={source.isError}
      onSaved={onSaved}
    />
  );
}
function CatalogSettings() {
  const query = useListAnnotationCatalogs();
  const create = useCreateAnnotationCatalog(),
    update = useUpdateAnnotationCatalog(),
    publish = usePublishAnnotationCatalog(),
    remove = useDeleteAnnotationCatalog();
  const [selected, setSelected] = useState<AnnotationCatalogDto | null>(null),
    [draft, setDraft] = useState<CreateAnnotationCatalogDto>(empty),
    [message, setMessage] = useState(""),
    [dirty, setDirty] = useState(false);
  const docTypesQuery = useListDocumentTypes();
  const suggestions = useListAnnotationCatalogSuggestions(selected?.id ?? "", {
    query: {
      queryKey: getListAnnotationCatalogSuggestionsQueryKey(selected?.id ?? ""),
      enabled: !!selected,
    },
  });
  const resolve = useResolveAnnotationCatalogSuggestion();
  const defaults = useGetAnnotationCatalogDefaults(draft.documentTypeCode, {
    query: {
      queryKey: getGetAnnotationCatalogDefaultsQueryKey(draft.documentTypeCode),
      enabled: false,
    },
  });
  const readonly = selected?.status === "PUBLISHED",
    busy =
      create.isPending ||
      update.isPending ||
      publish.isPending ||
      remove.isPending;
  const valid =
    !!draft.documentTypeCode.trim() &&
    !!draft.title.trim() &&
    draft.fields.length > 0 &&
    draft.fields.every(
      (field) =>
        /^[-a-zA-Z0-9_]{1,64}$/.test(field.key) && !!field.label.trim(),
    ) &&
    new Set(draft.fields.map((field) => field.key)).size ===
      draft.fields.length;
  const choose = (catalog: AnnotationCatalogDto | null) => {
    setSelected(catalog);
    setDraft(
      catalog
        ? {
            documentTypeCode: catalog.documentTypeCode,
            profile: catalog.profile,
            title: catalog.title,
            fields: catalog.fields.map((field) => ({ ...field })),
          }
        : empty(),
    );
    setMessage("");
    setDirty(false);
  };
  const edit = (patch: Partial<CreateAnnotationCatalogDto>) => {
    setDraft({ ...draft, ...patch });
    setDirty(true);
  };
  const field = (index: number, patch: Partial<AnnotationCatalogFieldDto>) =>
    edit({
      fields: draft.fields.map((item, i) =>
        i === index ? { ...item, ...patch } : item,
      ),
    });
  const reorder = (index: number, offset: number) => {
    const fields = [...draft.fields];
    [fields[index], fields[index + offset]] = [
      fields[index + offset],
      fields[index],
    ];
    edit({ fields: fields.map((item, ordinal) => ({ ...item, ordinal })) });
  };
  const failure = () =>
    setMessage(
      "Не удалось сохранить. Правки остались на экране; список мог измениться. Обновите сведения и повторите.",
    );
  const save = async () => {
    const next = selected
      ? await update.mutateAsync({
          id: selected.id,
          data: {
            revision: selected.revision,
            title: draft.title,
            fields: draft.fields,
          },
        })
      : await create.mutateAsync({ data: draft });
    choose(next);
    await query.refetch();
    return next;
  };
  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      aria-label="Списки полей разметки"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-60 flex-1 flex-col gap-2 text-sm font-semibold">
          Список полей
          <select
            className={control}
            value={selected?.id ?? ""}
            disabled={dirty || busy}
            onChange={(event) =>
              choose(
                query.data?.items.find(
                  (item) => item.id === event.target.value,
                ) ?? null,
              )
            }
          >
            <option value="">Новый список</option>
            {query.data?.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title} · {item.documentTypeCode}/{item.profile} · v
                {item.version} ·{" "}
                {item.status === "PUBLISHED" ? "Опубликован" : "Черновик"}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          disabled={dirty || busy}
          onClick={() => choose(null)}
        >
          <Plus size={15} />
          Новый список
        </Button>
      </div>
      {query.isLoading && <p role="status">Загрузка списков…</p>}
      {query.isError && (
        <div role="alert">
          Не удалось загрузить списки.{" "}
          <Button variant="outline" onClick={() => void query.refetch()}>
            Повторить
          </Button>
        </div>
      )}
      {message && (
        <p role="alert" className="text-sm">
          {message}
        </p>
      )}
      {dirty && (
        <p role="status" className="text-xs">
          Есть несохранённые правки. Сохраните или сбросьте их перед выбором
          другого списка.
        </p>
      )}
      <div className="flex min-w-0 flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">
            {selected
              ? `${selected.title} · версия ${selected.version}`
              : "Новый список полей"}
          </h2>
          {selected && <Badge>{readonly ? "Опубликован" : "Черновик"}</Badge>}
        </div>
        {readonly && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <p>
              Опубликованный список сохранён для существующих работ. Для
              изменений создайте новую версию.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setSelected(null);
                setDraft({
                  documentTypeCode: selected.documentTypeCode,
                  profile: selected.profile,
                  title: selected.title,
                  fields: selected.fields.map((item) => ({ ...item })),
                });
                setDirty(true);
              }}
            >
              Создать новую версию
            </Button>
          </div>
        )}
        <fieldset
          disabled={readonly || busy}
          className="flex min-w-0 flex-col gap-4"
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs">
              Название
              <input
                className={control}
                value={draft.title}
                maxLength={255}
                onChange={(event) => edit({ title: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Тип документа (из 1С)
              <select
                className={control}
                disabled={!!selected}
                value={draft.documentTypeCode}
                onChange={(e) => edit({ documentTypeCode: e.target.value })}
              >
                <option value="">Выберите тип документа из 1С</option>
                {docTypesQuery.data?.items.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.title} ({t.code})
                  </option>
                ))}
                {!docTypesQuery.isLoading && docTypesQuery.data?.items.length === 0 && (
                  <option disabled>Нет типов из 1С</option>
                )}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              Профиль документа
              <select
                className={control}
                disabled={!!selected}
                value={draft.profile}
                onChange={(event) =>
                  edit({
                    profile: event.target
                      .value as CreateAnnotationCatalogDto["profile"],
                  })
                }
              >
                <option value="RU">РФ</option>
                <option value="UZ">Узбекистан</option>
                <option value="OTHER">Другие документы</option>
              </select>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled={!draft.documentTypeCode.trim() || defaults.isFetching}
              onClick={async () => {
                const result = await defaults.refetch();
                if (result.data) {
                  edit({
                    fields: [
                      ...draft.fields,
                      ...result.data.fields.filter(
                        (item) =>
                          !draft.fields.some(
                            (existing) => existing.key === item.key,
                          ),
                      ),
                    ].map((item, ordinal) => ({ ...item, ordinal })),
                  });
                  setMessage(
                    "Базовые поля добавлены. Проверьте подписи и состав перед публикацией.",
                  );
                } else
                  setMessage(
                    "Не удалось получить базовые поля. Проверьте код типа документа или добавьте поля вручную.",
                  );
              }}
            >
              Добавить базовые поля
            </Button>
            <p className="max-w-prose text-xs text-[var(--muted-foreground)]">
              Список можно дополнить и изменить перед публикацией.
            </p>
          </div>
          <div className="flex flex-col gap-3">
            {draft.fields.map((item, index) => (
              <div
                key={index}
                className="grid min-w-0 gap-2 border-t border-[var(--border)] pt-3 sm:grid-cols-2 lg:grid-cols-[1fr_1.5fr_1fr_auto]"
              >
                <label className="flex flex-col gap-1 text-xs">
                  Код поля
                  <input
                    className={control}
                    value={item.key}
                    maxLength={64}
                    onChange={(event) =>
                      field(index, { key: event.target.value })
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  Название
                  <input
                    className={control}
                    value={item.label}
                    maxLength={255}
                    onChange={(event) =>
                      field(index, { label: event.target.value })
                    }
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  Связь с реквизитом, необязательно
                  <input
                    className={control}
                    value={item.businessFieldName ?? ""}
                    maxLength={128}
                    onChange={(event) =>
                      field(index, {
                        businessFieldName: event.target.value || null,
                      })
                    }
                  />
                </label>
                <div className="flex items-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Поднять поле ${index + 1}`}
                    disabled={index === 0}
                    onClick={() => reorder(index, -1)}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Опустить поле ${index + 1}`}
                    disabled={index === draft.fields.length - 1}
                    onClick={() => reorder(index, 1)}
                  >
                    <ArrowDown size={14} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Удалить поле ${index + 1}`}
                    onClick={() =>
                      edit({
                        fields: draft.fields
                          .filter((_, i) => i !== index)
                          .map((value, ordinal) => ({ ...value, ordinal })),
                      })
                    }
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
                <label className="flex items-center gap-2 text-xs sm:col-span-2">
                  <input
                    type="checkbox"
                    className="accent-[var(--primary)]"
                    checked={item.multiline}
                    onChange={(event) =>
                      field(index, { multiline: event.target.checked })
                    }
                  />
                  Текст может занимать несколько строк
                </label>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            className="self-start"
            onClick={() =>
              edit({
                fields: [
                  ...draft.fields,
                  {
                    key: "",
                    label: "",
                    ordinal: draft.fields.length,
                    multiline: false,
                    businessFieldName: null,
                  },
                ],
              })
            }
          >
            <Plus size={15} />
            Добавить поле
          </Button>
        </fieldset>
        {!readonly && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy || !valid || (!dirty && !!selected)}
              onClick={async () => {
                try {
                  await save();
                  setMessage("Черновик списка сохранён.");
                } catch {
                  failure();
                }
              }}
            >
              Сохранить черновик
            </Button>
            <Button
              disabled={busy || !valid}
              onClick={async () => {
                try {
                  const catalog = dirty || !selected ? await save() : selected;
                  choose(
                    await publish.mutateAsync({
                      id: catalog.id,
                      data: { revision: catalog.revision },
                    }),
                  );
                  await query.refetch();
                  setMessage(
                    "Список опубликован. Новые работы используют эту версию.",
                  );
                } catch {
                  failure();
                }
              }}
            >
              Опубликовать список
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => choose(selected)}>
                Сбросить правки
              </Button>
            )}
            {selected && (
              <Button
                variant="ghost"
                disabled={busy || dirty}
                onClick={async () => {
                  try {
                    await remove.mutateAsync({
                      id: selected.id,
                      params: { revision: selected.revision },
                    });
                    choose(null);
                    await query.refetch();
                  } catch {
                    failure();
                  }
                }}
              >
                Удалить черновик
              </Button>
            )}
          </div>
        )}
      </div>
      {selected && (
        <div className="flex flex-col gap-3 border-t border-[var(--border)] pt-4">
          <h2 className="text-sm font-semibold">Предложения проверяющих</h2>
          {suggestions.isLoading && <p role="status">Загрузка предложений…</p>}
          {suggestions.isError && (
            <p role="alert">Не удалось загрузить предложения.</p>
          )}
          {suggestions.data && !suggestions.data.items.length && (
            <p className="text-sm text-[var(--muted-foreground)]">
              Предложений пока нет.
            </p>
          )}
          {suggestions.data?.items.map((item) => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] p-3 text-sm"
            >
              <p>
                <b>{item.label}</b> · {item.key} ·{" "}
                {item.status === "PENDING"
                  ? "Ожидает решения"
                  : item.status === "APPLIED"
                    ? "Добавлено"
                    : "Отклонено"}
              </p>
              {item.status === "PENDING" && (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={readonly || busy || resolve.isPending}
                    onClick={() => {
                      if (!draft.fields.some((field) => field.key === item.key))
                        edit({
                          fields: [
                            ...draft.fields,
                            {
                              key: item.key,
                              label: item.label,
                              ordinal: draft.fields.length,
                              multiline: false,
                              businessFieldName: null,
                            },
                          ],
                        });
                    }}
                  >
                    Добавить в черновик
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resolve.isPending}
                    onClick={async () => {
                      try {
                        await resolve.mutateAsync({
                          id: selected.id,
                          suggestionId: item.id,
                          data: { status: "APPLIED" },
                        });
                        await suggestions.refetch();
                      } catch {
                        setMessage(
                          "Сначала сохраните поле с этим кодом в новой версии списка, затем отметьте предложение выполненным.",
                        );
                      }
                    }}
                  >
                    Отметить выполненным
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={resolve.isPending}
                    onClick={async () => {
                      try {
                        await resolve.mutateAsync({
                          id: selected.id,
                          suggestionId: item.id,
                          data: { status: "DISMISSED" },
                        });
                        await suggestions.refetch();
                      } catch {
                        failure();
                      }
                    }}
                  >
                    Отклонить
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
