import { useState } from "react";
import { Button } from "@edo/ui";
import {
  getGetAnnotationSourcesQueryKey,
  getListAnnotationCatalogsQueryKey,
  useGetAnnotationSources,
  useListAnnotations,
  useListAnnotationCatalogs,
  useClaimAnnotation,
  type AnnotationDto,
  type DocumentVersionDto,
} from "@edo/api-client";
import { AnnotationEditor } from "./AnnotationEditor";

export function DocumentAnnotations({
  document,
  active = true,
  allowClaim = true,
}: {
  document: DocumentVersionDto;
  active?: boolean;
  allowClaim?: boolean;
}) {
  return (
    <section
      aria-label="Разметка документа"
      className="flex min-h-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Разметка документа</h3>
          <p className="max-w-prose text-sm text-[var(--muted-foreground)]">
            Обведите строки на оригинале и перепишите текст. Реквизиты документа
            и его отправка остаются в отдельной проверке.
          </p>
        </div>
      </div>
      <AnnotationContext
        document={document}
        active={active}
        allowClaim={allowClaim}
      />
    </section>
  );
}
function AnnotationContext({
  document,
  active = true,
  allowClaim = true,
}: {
  document: DocumentVersionDto;
  active?: boolean;
  allowClaim?: boolean;
}) {
  const source = useGetAnnotationSources(
    document.documentId,
    document.version,
    {
      query: {
        queryKey: getGetAnnotationSourcesQueryKey(
          document.documentId,
          document.version,
        ),
        staleTime: 240_000,
        refetchInterval: 240_000,
      },
    },
  );
  const list = useListAnnotations({
    documentId: document.documentId,
    version: document.version,
  });
  const catalogs = useListAnnotationCatalogs(
    { documentTypeCode: source.data?.documentTypeCode },
    {
      query: {
        queryKey: getListAnnotationCatalogsQueryKey({
          documentTypeCode: source.data?.documentTypeCode,
        }),
        enabled: !!source.data,
      },
    },
  );
  const claim = useClaimAnnotation();
  const [local, setLocal] = useState<AnnotationDto | null>(null),
    [message, setMessage] = useState("");
  const server = list.data?.items[0];
  const annotation =
    local && (!server || local.revision >= server.revision) ? local : server;
  const published =
    catalogs.data?.items.filter((item) => item.status === "PUBLISHED") ?? [];
  const [catalogId, setCatalogId] = useState("");
  const latest = published.filter(
    (item) =>
      !published.some(
        (other) =>
          other.profile === item.profile && other.version > item.version,
      ),
  );
  const catalog =
    latest.find((c) => c.id === catalogId) ??
    (latest.length === 1 ? latest[0] : undefined);
  if (annotation)
    return (
      <div className="flex min-h-0 flex-col gap-3">
        <Button
          className="self-start"
          size="sm"
          variant="outline"
          disabled={list.isFetching || source.isFetching}
          onClick={async () => {
            const result = await list.refetch();
            if (result.data?.items[0]) setLocal(result.data.items[0]);
            await source.refetch();
          }}
        >
          Обновить сведения о работе
        </Button>
        <AnnotationEditor
          key={annotation.id}
          annotation={annotation}
          files={document.files}
          liveSources={source.data}
          sourceError={source.isError}
          active={active}
          onSaved={(next) => {
            setLocal(next);
            void list.refetch();
          }}
        />
      </div>
    );
  return (
    <div className="flex flex-col items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-4 text-sm">
      {(source.isLoading || list.isLoading || catalogs.isLoading) && (
        <p role="status">Подготовка оригинала и списка полей…</p>
      )}
      {(source.isError || list.isError || catalogs.isError) && (
        <>
          <p role="alert">
            Не удалось подготовить разметку. Проверьте доступность оригиналов и
            повторите.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void source.refetch();
              void list.refetch();
              void catalogs.refetch();
            }}
          >
            Повторить
          </Button>
        </>
      )}
      {!allowClaim && !list.isLoading && !list.isError && (
        <p>
          Для этой исторической версии нет начатой разметки. Новую работу можно
          взять на актуальной версии документа.
        </p>
      )}
      {allowClaim && source.data && !latest.length && !catalogs.isLoading && (
        <p>
          Администратор ещё не опубликовал список полей для этого документа.
        </p>
      )}
      {allowClaim && latest.length > 1 && (
        <label className="flex w-full flex-col gap-2 text-sm">
          Вариант документа
          <select
            className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-2"
            value={catalog?.id ?? ""}
            onChange={(e) => setCatalogId(e.target.value)}
          >
            <option value="">Выберите вариант по оригиналу</option>
            {latest.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {allowClaim && catalog && (
        <>
          <p>
            {catalog.title} · версия списка {catalog.version} ·{" "}
            {catalog.fields.length} полей
          </p>
          <Button
            disabled={
              claim.isPending ||
              !source.data ||
              source.isError ||
              list.isLoading ||
              list.isError
            }
            onClick={async () => {
              setMessage("");
              try {
                setLocal(
                  await claim.mutateAsync({
                    data: {
                      documentId: document.documentId,
                      version: document.version,
                      catalogId: catalog.id,
                      sourceKind: "ORIGINAL",
                    },
                  }),
                );
              } catch {
                setMessage(
                  "Не удалось взять работу. Её мог взять другой проверяющий. Обновите список.",
                );
                void list.refetch();
              }
            }}
          >
            {claim.isPending ? "Подготовка…" : "Взять разметку"}
          </Button>
        </>
      )}
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
