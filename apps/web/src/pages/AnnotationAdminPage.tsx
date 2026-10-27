import { useState } from "react";
import { Button, PageHeader } from "@edo/ui";
import {
  useListAnnotations,
  useGetAnnotationSources,
  getGetAnnotationSourcesQueryKey,
  useGetMe,
  type AnnotationDto,
} from "@edo/api-client";
import { AnnotationEditor } from "../components/annotations/AnnotationEditor";
import { AnnotationCatalogSettings } from "../components/annotations/AnnotationCatalogSettings";
const control =
  "min-w-0 rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-sm";
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
      {tab === "catalogs" ? (
        <AnnotationCatalogSettings />
      ) : (
        <AnnotationAcceptance />
      )}
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
                {row.schema.title} · документ {row.documentId} · версия{" "}
                {row.sources.version}
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
