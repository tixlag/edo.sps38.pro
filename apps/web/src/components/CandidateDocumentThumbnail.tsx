import { useEffect, useState } from "react";
import { getCandidatePreviousDocumentOriginal } from "@edo/api-client";
import { cn } from "@edo/ui";
import { ExternalLink, FileText, Loader2 } from "lucide-react";

export interface CandidateDocumentThumbnailProps {
  candidateId: string;
  documentId: string;
  originalAvailable: boolean;
  title: string;
  className?: string;
  onClick?: () => void;
}

export function CandidateDocumentThumbnail({
  candidateId,
  documentId,
  originalAvailable,
  title,
  className,
  onClick,
}: CandidateDocumentThumbnailProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPdf, setIsPdf] = useState(false);

  useEffect(() => {
    if (!originalAvailable || !candidateId || !documentId) {
      setObjectUrl(null);
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    let createdUrl: string | null = null;
    const controller = new AbortController();

    setLoading(true);
    setError(null);

    Promise.resolve(
      getCandidatePreviousDocumentOriginal(
        candidateId,
        documentId,
        controller.signal,
      ),
    )
      ?.then((blob) => {
        if (!active || !blob) return;
        const isPdfBlob =
          blob.type === "application/pdf" ||
          blob.type.includes("pdf") ||
          title.toLowerCase().endsWith(".pdf");
        setIsPdf(isPdfBlob);
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Не удалось загрузить");
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [candidateId, documentId, originalAvailable, title]);

  const handleOpen = () => {
    if (onClick) {
      onClick();
      return;
    }

    if (objectUrl) {
      window.open(objectUrl, "_blank", "noopener,noreferrer");
      return;
    }

    if (originalAvailable) {
      const tab = window.open("about:blank", "_blank");
      if (tab) tab.opener = null;
      void getCandidatePreviousDocumentOriginal(candidateId, documentId)
        .then((blob) => {
          const url = URL.createObjectURL(blob);
          if (tab) {
            tab.location.href = url;
          } else {
            const anchor = window.document.createElement("a");
            anchor.href = url;
            anchor.download = title;
            anchor.click();
          }
          window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        })
        .catch(() => {
          tab?.close();
        });
    }
  };

  if (!originalAvailable) {
    return (
      <div
        className={cn(
          "flex h-24 w-20 shrink-0 select-none flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border)] bg-[var(--card)] p-2 text-center text-xs text-[var(--muted-foreground)]",
          className,
        )}
        aria-label={`Оригинал недоступен: ${title}`}
      >
        <FileText className="mb-1 h-6 w-6 opacity-60" aria-hidden />
        <span className="text-[10px] font-medium leading-tight">
          Оригинал недоступен
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex h-24 w-20 shrink-0 flex-col items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] transition-colors hover:border-[var(--primary)] focus-within:ring-2 focus-within:ring-[var(--primary)]",
        className,
      )}
    >
      {loading && (
        <div
          role="status"
          className="flex h-full w-full flex-col items-center justify-center p-1 text-[10px] text-[var(--muted-foreground)]"
        >
          <Loader2
            className="mb-1 h-5 w-5 animate-spin text-[var(--primary)]"
            aria-hidden
          />
          <span>Загрузка…</span>
        </div>
      )}

      {error && !loading && (
        <div
          role="alert"
          className="flex h-full w-full flex-col items-center justify-center p-1 text-center text-[10px] text-[var(--primary)]"
        >
          <FileText className="mb-1 h-5 w-5 opacity-70" aria-hidden />
          <span className="line-clamp-2">Ошибка</span>
        </div>
      )}

      {objectUrl && !loading && (
        <>
          {isPdf ? (
            <object
              data={`${objectUrl}#toolbar=0&navpanes=0`}
              type="application/pdf"
              className="pointer-events-none h-full w-full object-cover"
              aria-label={title}
            >
              <div className="flex h-full w-full flex-col items-center justify-center p-1 text-center text-[10px] text-[var(--muted-foreground)]">
                <FileText
                  className="mb-1 h-6 w-6 text-[var(--primary)]"
                  aria-hidden
                />
                <span className="font-semibold">PDF</span>
              </div>
            </object>
          ) : (
            <img
              src={objectUrl}
              alt={title}
              className="h-full w-full object-cover"
            />
          )}

          <div
            className="absolute inset-0 flex flex-col items-center justify-center rounded-lg bg-black/60 p-1 text-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
            aria-hidden
          >
            <ExternalLink className="mb-0.5 h-4 w-4 text-white" />
            <span className="text-[9px] font-medium leading-tight text-white">
              Открыть документ
            </span>
          </div>
        </>
      )}

      <button
        type="button"
        onClick={handleOpen}
        disabled={loading || !!error}
        aria-label={`Открыть документ: ${title}`}
        title="Открыть документ"
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 focus:opacity-100 focus:outline-none"
      >
        <span className="sr-only">Открыть документ</span>
      </button>
    </div>
  );
}
