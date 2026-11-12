import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCandidatePreviousDocumentOriginal,
  getDocumentVersion,
  getDocumentFileBinary,
  getGetDocumentVersionQueryKey,
  getGetDocumentFileBinaryQueryKey,
  useGetDocumentVersion,
  useGetDocumentFileBinary,
} from "@edo/api-client";
import { Button, cn } from "@edo/ui";
import { FileText, Loader2 } from "lucide-react";

import { PdfPage } from "./DocumentPreview";

const PREVIEW_TIMEOUT_MS = 30_000;
function withPreviewTimeout<T>(
  load: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let cleanup: () => void = () => undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const abort = () => {
      controller.abort();
      reject(new Error("Preview interrupted"));
    };
    const timer = window.setTimeout(abort, PREVIEW_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    cleanup = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    if (signal.aborted) abort();
  });
  return Promise.race([
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Preview interrupted");
      return load(controller.signal);
    }),
    interrupted,
  ]).finally(cleanup);
}

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
  const [error, setError] = useState<string | null>(null);
  const [isPdf, setIsPdf] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);
  const onPreviewError = useCallback(() => setRenderFailed(true), []);
  const [ready, setReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const onReady = useCallback(() => {
    setReady(true);
    setTimedOut(false);
  }, []);
  const versionQuery = useGetDocumentVersion(documentId, version ?? 0, {
    query: {
      queryKey: getGetDocumentVersionQueryKey(documentId, version ?? 0),
      enabled: isVisible && originalAvailable && version !== undefined,
      queryFn: ({ signal }) =>
        withPreviewTimeout(
          (previewSignal) =>
            getDocumentVersion(documentId, version ?? 0, previewSignal),
          signal,
        ),
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
        queryFn: ({ signal }) =>
          withPreviewTimeout(
            (previewSignal) =>
              getDocumentFileBinary(
                documentId,
                version ?? 0,
                file?.id ?? "",
                previewSignal,
              ),
            signal,
          ),
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
    setReady(false);
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
    retryCount,
  ]);
  const unavailable =
    !originalAvailable ||
    renderFailed ||
    (version === undefined
      ? !!error
      : (versionQuery.isError && !versionQuery.data) ||
        (binaryQuery.isError && !binaryQuery.data) ||
        (versionQuery.isSuccess && !file));
  // Background reads keep the already rendered preview in place.
  const pending =
    isVisible && originalAvailable && !ready && !unavailable && !timedOut;
  useEffect(() => {
    if (!isVisible || !originalAvailable || ready || unavailable) return;
    const timer = window.setTimeout(
      () => setTimedOut(true),
      PREVIEW_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [isVisible, originalAvailable, ready, unavailable, retryCount]);
  const retry = () => {
    setTimedOut(false);
    setRenderFailed(false);
    setReady(false);
    setRetryCount((count) => count + 1);
    if (version !== undefined) {
      if (!file || versionQuery.isError)
        void versionQuery.refetch({ cancelRefetch: false });
      else void binaryQuery.refetch({ cancelRefetch: false });
    }
  };

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
      setError(null);
      return;
    }

    let active = true;
    let createdUrl: string | null = null;
    const controller = new AbortController();

    setError(null);
    setRenderFailed(false);
    setReady(false);

    Promise.resolve(
      withPreviewTimeout(
        (signal) =>
          getCandidatePreviousDocumentOriginal(candidateId, documentId, signal),
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
      });

    return () => {
      active = false;
      controller.abort();
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [
    isVisible,
    candidateId,
    documentId,
    originalAvailable,
    title,
    version,
    retryCount,
  ]);

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
          role="status"
          aria-label="Загрузка превью"
        />
      )}
      {!pending && (unavailable || timedOut || !objectUrl) && (
        <div
          className="flex flex-col items-center gap-1 p-1 text-center text-[10px] leading-tight"
          aria-label={`Превью недоступно: ${title}`}
        >
          <FileText className="h-5 w-5 opacity-60" aria-hidden />
          <span>
            {!originalAvailable ? "Оригинал недоступен" : "Превью недоступно"}
          </span>
          {originalAvailable && (
            <Button
              variant="ghost"
              size="sm"
              className="relative z-10 h-6 px-1 text-[10px]"
              aria-label={`Повторить загрузку превью: ${title}`}
              onClick={retry}
            >
              Повторить
            </Button>
          )}
        </div>
      )}
      {objectUrl &&
        !unavailable &&
        !timedOut &&
        (isPdf ? (
          <PdfPage
            key={objectUrl}
            url={objectUrl}
            pageNumber={1}
            onReady={onReady}
            onError={onPreviewError}
            maxWidth={160}
            maxHeight={192}
            className="absolute inset-0 block h-full w-full object-contain"
          />
        ) : (
          <img
            src={objectUrl}
            alt={title}
            className="absolute inset-0 h-full w-full object-contain"
            onError={onPreviewError}
            onLoad={onReady}
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
