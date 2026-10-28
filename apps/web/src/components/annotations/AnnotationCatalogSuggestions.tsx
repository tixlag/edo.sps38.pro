import { useState } from "react";
import { Button } from "@edo/ui";
import {
  useListAnnotationCatalogSuggestions,
  getListAnnotationCatalogSuggestionsQueryKey,
  useResolveAnnotationCatalogSuggestion,
  type AnnotationCatalogDto,
  type AnnotationCatalogFieldDto,
} from "@edo/api-client";
export function AnnotationCatalogSuggestions({
  catalog,
  catalogs,
  onAdd,
  disabled,
}: {
  catalog: AnnotationCatalogDto;
  catalogs: AnnotationCatalogDto[];
  onAdd: (field: AnnotationCatalogFieldDto) => void;
  disabled: boolean;
}) {
  const query = useListAnnotationCatalogSuggestions(catalog.id, {
      query: {
        queryKey: getListAnnotationCatalogSuggestionsQueryKey(catalog.id),
      },
    }),
    resolve = useResolveAnnotationCatalogSuggestion();
  const [message, setMessage] = useState("");
  const pending = query.data?.items.filter((s) => s.status === "PENDING") ?? [];
  const settle = async (id: string, status: "APPLIED" | "DISMISSED") => {
    try {
      await resolve.mutateAsync({
        id: catalog.id,
        suggestionId: id,
        data: { status },
      });
      await query.refetch();
    } catch {
      setMessage("Не удалось обновить предложение. Повторите действие.");
    }
  };
  return (
    <section
      className="flex flex-col gap-3 border-t border-[var(--border)] pt-4"
      aria-label="Предложения проверяющих"
    >
      <h3 className="text-base font-semibold">Предложения проверяющих</h3>
      {message && <p role="alert">{message}</p>}
      {query.isLoading && <p role="status">Загрузка предложений…</p>}
      {query.isError && (
        <p role="alert">
          Не удалось загрузить предложения.{" "}
          <Button variant="outline" onClick={() => void query.refetch()}>
            Повторить
          </Button>
        </p>
      )}
      {query.data && !pending.length && (
        <p className="text-sm text-[var(--muted-foreground)]">
          Новых предложений нет.
        </p>
      )}
      {pending.map((s) => {
        const applied = catalogs.some(
          (c) =>
            c.documentTypeCode === catalog.documentTypeCode &&
            c.profile === catalog.profile &&
            c.version > catalog.version &&
            c.status === "PUBLISHED" &&
            c.fields.some((f) => f.key === s.key),
        );
        return (
          <div
            key={s.id}
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <span>{s.label}</span>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={
                  disabled || catalog.fields.some((f) => f.key === s.key)
                }
                onClick={() =>
                  onAdd({
                    key: s.key,
                    label: s.label,
                    ordinal: catalog.fields.length,
                    multiline: false,
                    kind: "TEXT",
                    sectionKey: catalog.sections?.[0]?.key ?? "main",
                    businessFieldName: null,
                  })
                }
              >
                {catalog.status === "PUBLISHED"
                  ? "Добавить в новую версию"
                  : "Добавить в черновик"}
              </Button>
              <Button
                variant="outline"
                disabled={!applied || resolve.isPending}
                onClick={() => void settle(s.id, "APPLIED")}
              >
                Отметить добавленным
              </Button>
              <Button
                variant="ghost"
                disabled={resolve.isPending}
                onClick={() => void settle(s.id, "DISMISSED")}
              >
                Отклонить
              </Button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
