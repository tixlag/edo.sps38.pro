import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCandidatePreviousDocumentOriginal,
  getGetDocumentVersionQueryKey,
  getGetDocumentFileBinaryQueryKey,
  useGetDocumentVersion,
  useGetDocumentFileBinary,
} from "@edo/api-client";
import { cn } from "@edo/ui";
import { FileText, Loader2 } from "lucide-react";

import { PdfPage } from "./DocumentPreview";

export interface CandidateDocumentThumbnailProps {
  candidateId: string;
  documentId: string;
  originalAvailable: boolean;
  /** Present for documents uploaded to EDO; omitted for previous originals. */
  version?: number;
  title: string;
  className?: string;
  onClick?: () => void;
}

export function CandidateDocumentThumbnail({
  candidateId,
  documentId,
  originalAvailable,
  version,
  title,
  className,
  onClick,
}: CandidateDocumentThumbnailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(() => {
    return typeof IntersectionObserver === "undefined";
  });
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPdf, setIsPdf] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);
  const onPreviewError = useCallback(() => setRenderFailed(true), []);
  const onPdfReady = useCallback(() => undefined, []);
  const versionQuery = useGetDocumentVersion(documentId, version ?? 0, {
    query: {
      queryKey: getGetDocumentVersionQueryKey(documentId, version ?? 0),
      enabled: isVisible && originalAvailable && version !== undefined,
      staleTime: 240_000,
      retry: false,
    },
  });
  // Match DocumentReviewWorkspace: returned versions never request originals.
  const file =
    versionQuery.data?.status === "RETURNED"
      ? undefined
      : versionQuery.data?.files
          .filter((file) => !file.deleted)
          .sort((a, b) => a.ordinal - b.ordinal)[0];
  const binaryQuery = useGetDocumentFileBinary(
    documentId,
    version ?? 0,
    file?.id ?? "",
    {
      query: {
        queryKey: getGetDocumentFileBinaryQueryKey(
          documentId,
          version ?? 0,
          file?.id ?? "",
        ),
        enabled:
          isVisible && originalAvailable && version !== undefined && !!file,
        staleTime: 240_000,
        gcTime: 60_000,
        retry: false,
      },
    },
  );
  useEffect(() => {
    if (version === undefined) return;
    setObjectUrl(null);
    setRenderFailed(false);
    if (
      !originalAvailable ||
      !binaryQuery.data ||
      !file ||
      versionQuery.data?.status === "RETURNED"
    )
      return;
    const url = URL.createObjectURL(binaryQuery.data);
    setIsPdf(file.mimeType === "application/pdf");
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [
    version,
    originalAvailable,
    binaryQuery.data,
    file,
    versionQuery.data?.status,
  ]);
  const pending =
    version === undefined
      ? loading
      : versionQuery.isFetching || binaryQuery.isFetching;
  const unavailable =
    !originalAvailable ||
    renderFailed ||
    (version === undefined
      ? !!error
      : versionQuery.isError ||
        binaryQuery.isError ||
        (versionQuery.isSuccess && !file));

  useEffect(() => {
    if (isVisible || typeof IntersectionObserver === "undefined") return;
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "0px" },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [isVisible]);

  useEffect(() => {
    if (version !== undefined) return;
    if (!isVisible || !originalAvailable || !candidateId || !documentId) {
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
    setRenderFailed(false);

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
  }, [isVisible, candidateId, documentId, originalAvailable, title, version]);

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

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative flex h-24 w-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--muted-foreground)] focus-within:ring-2 focus-within:ring-[var(--primary)]",
        className,
      )}
    >
      {pending && (
        <Loader2
          className="h-5 w-5 animate-spin"
          aria-label="Загрузка превью"
        />
      )}
      {!pending && (unavailable || !objectUrl) && (
        <div
          className="flex flex-col items-center gap-1 p-1 text-center text-[10px] leading-tight"
          aria-label={`Превью недоступно: ${title}`}
        >
          <FileText className="h-5 w-5 opacity-60" aria-hidden />
          <span>
            {!originalAvailable ? "Оригинал недоступен" : "Превью недоступно"}
          </span>
        </div>
      )}
      {objectUrl &&
        !pending &&
        !unavailable &&
        (isPdf ? (
          <PdfPage
            key={objectUrl}
            url={objectUrl}
            pageNumber={1}
            onReady={onPdfReady}
            onError={onPreviewError}
            maxWidth={160}
            maxHeight={192}
            className="block h-full w-full object-contain"
          />
        ) : (
          <img
            src={objectUrl}
            alt={title}
            className="h-full w-full object-contain"
            onError={onPreviewError}
          />
        ))}
      <button
        type="button"
        onClick={handleOpen}
        disabled={!onClick && (!originalAvailable || pending || unavailable)}
        aria-label={`Открыть документ: ${title}`}
        title="Открыть документ"
        className="absolute inset-0 h-full w-full cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)] disabled:cursor-default"
      />
    </div>
  );
}
