import { useEffect, useState } from "react";
import {
  useGetCandidatePreviousDocumentOriginal,
  getGetCandidatePreviousDocumentOriginalQueryKey,
  type PreviousDocumentAvailabilityDto,
} from "@edo/api-client";
import { Badge, Button } from "@edo/ui";

export function ApprovedErpDocumentPreview({
  candidateId,
  document,
}: {
  candidateId: string;
  document: PreviousDocumentAvailabilityDto;
}) {
  const [original, setOriginal] = useState<{ url: string; pdf: boolean }>();
  const query = useGetCandidatePreviousDocumentOriginal(candidateId, document.id, {
    query: { queryKey: getGetCandidatePreviousDocumentOriginalQueryKey(candidateId, document.id) },
  });
  useEffect(() => {
    setOriginal(undefined);
    if (!query.data) return;
    const url = URL.createObjectURL(query.data);
    setOriginal({ url, pdf: query.data.type.includes("pdf") });
    return () => URL.revokeObjectURL(url);
  }, [query.data]);
  const error = query.isError;
  return (
    <section
      className="flex h-full min-h-0 flex-col gap-3"
      aria-label="Утверждённый документ из ERP"
    >
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <h2 className="mr-auto font-semibold">{document.title}</h2>
        <Badge tone="success">Документ принят</Badge>
        <span className="text-xs text-[var(--muted-foreground)]">Из ERP</span>
      </header>
      {!original && !error && <p role="status">Загрузка оригинала из ERP…</p>}
      {error && (
        <div role="alert">
          Не удалось загрузить оригинал.{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Повторить
          </Button>
        </div>
      )}
      {original && (
        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-[var(--border)] bg-[var(--muted)]">
          {original.pdf ? (
            <object
              data={original.url}
              type="application/pdf"
              className="h-full min-h-96 w-full"
              aria-label={document.title}
            >
              <a href={original.url} target="_blank" rel="noreferrer">
                Открыть оригинал
              </a>
            </object>
          ) : (
            <img
              src={original.url}
              alt={document.title}
              className="mx-auto h-auto max-w-full"
            />
          )}
        </div>
      )}
    </section>
  );
}
