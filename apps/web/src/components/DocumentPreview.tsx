import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "@edo/ui";
import {
  getGetDocumentFileDownloadQueryKey,
  useGetDocumentFileDownload,
  type DocumentFieldDto,
  type DocumentFileDto,
  type OcrRegionDto,
} from "@edo/api-client";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import { DOCUMENT_FIELD_LABELS } from "./document-field-labels";

function PdfPage({
  url,
  pageNumber,
  onReady,
  onError,
}: {
  url: string;
  pageNumber: number;
  onReady: () => void;
  onError: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    let loading: PDFDocumentLoadingTask | undefined;
    let rendering: RenderTask | undefined;
    void (async () => {
      // The compatibility build includes PDF.js's browser polyfills.
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      if (!active) return;
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      loading = pdfjs.getDocument({
        url,
        isEvalSupported: false,
        enableXfa: false,
      });
      const pdf = await loading.promise;
      const page = await pdf.getPage(pageNumber);
      if (!active || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      if (!(base.width > 0 && base.height > 0))
        throw new Error("Invalid PDF page");
      // Bound canvas memory even for PDFs with enormous page dimensions.
      const viewport = page.getViewport({
        scale: Math.min(2, 1600 / base.width, 2200 / base.height),
      });
      canvas.current.width = Math.ceil(viewport.width);
      canvas.current.height = Math.ceil(viewport.height);
      rendering = page.render({ canvas: canvas.current, viewport });
      await rendering.promise;
      if (active) onReady();
    })().catch(() => {
      if (active) onError();
    });
    return () => {
      active = false;
      rendering?.cancel();
      void loading?.destroy().catch(() => undefined);
    };
  }, [url, pageNumber, onReady, onError]);
  return (
    <canvas
      ref={canvas}
      className="block h-auto w-full"
      role="img"
      aria-label={`Страница ${pageNumber} PDF`}
    />
  );
}

export function DocumentPreview({
  documentId,
  version,
  file,
  pageNumber,
  fields,
  selectedField,
  selectedRegionId,
  onSelectRegion,
}: {
  documentId: string;
  version: number;
  file: DocumentFileDto;
  pageNumber: number;
  fields: DocumentFieldDto[];
  selectedField: string | null;
  selectedRegionId: string | null;
  onSelectRegion: (fieldName: string, region: OcrRegionDto) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [showBoxes, setShowBoxes] = useState(true);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const download = useGetDocumentFileDownload(documentId, version, file.id, {
    query: {
      queryKey: getGetDocumentFileDownloadQueryKey(
        documentId,
        version,
        file.id,
      ),
      staleTime: 240_000,
      refetchInterval: 240_000,
    },
  });
  const regions = useMemo(
    () =>
      fields.flatMap((field) =>
        field.regions
          .filter(
            (region) =>
              region.fileId === file.id && region.pageNumber === pageNumber,
          )
          .map((region) => ({ field, region })),
      ),
    [fields, file.id, pageNumber],
  );
  const onReady = useCallback(() => setReady(true), []);
  const onError = useCallback(() => setFailed(true), []);
  useEffect(() => {
    const region = regions.find(
      (item) => item.region.id === selectedRegionId,
    )?.region;
    if (!ready || !region || !viewport.current || !page.current) return;
    viewport.current.scrollTo({
      left: Math.max(
        0,
        (region.x + region.width / 2) * page.current.clientWidth -
          viewport.current.clientWidth / 2,
      ),
      top: Math.max(
        0,
        (region.y + region.height / 2) * page.current.clientHeight -
          viewport.current.clientHeight / 2,
      ),
    });
  }, [regions, selectedRegionId, ready, zoom]);
  const selected =
    regions.find((item) => item.region.id === selectedRegionId) ??
    regions.find((item) => item.field.name === selectedField);
  const retry = async () => {
    const refreshed = await download.refetch();
    if (!refreshed.isError) {
      setFailed(false);
      setReady(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="break-all text-[var(--muted-foreground)]">
          {file.filename}
        </span>
        {download.data && (
          <a
            className="font-semibold text-[var(--primary)] underline underline-offset-4 focus-visible:outline focus-visible:outline-2"
            href={download.data.url}
            target="_blank"
            rel="noreferrer"
          >
            Скачать оригинал
          </a>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-label="Уменьшить превью"
            disabled={zoom <= 1}
            onClick={() => setZoom((value) => value - 0.5)}
          >
            <Minus size={14} />
          </Button>
          <span className="text-sm tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            size="sm"
            variant="outline"
            aria-label="Увеличить превью"
            disabled={zoom >= 4}
            onClick={() => setZoom((value) => value + 0.5)}
          >
            <Plus size={14} />
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showBoxes}
            onChange={(event) => setShowBoxes(event.target.checked)}
          />
          Области OCR
        </label>
      </div>
      {(download.isLoading || (download.data && !ready && !failed)) && (
        <p role="status" className="text-sm">
          Загрузка превью…
        </p>
      )}
      {(download.isError || failed) && (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 py-6 text-sm"
        >
          <p>
            Не удалось открыть превью. Обновите ссылку или скачайте оригинал.
          </p>
          <Button
            variant="outline"
            disabled={download.isFetching}
            onClick={() => void retry()}
          >
            Обновить ссылку
          </Button>
        </div>
      )}
      {download.data && !failed && (
        <div
          ref={viewport}
          className="max-h-[620px] overflow-auto rounded-[12px] border border-[var(--border)] bg-[var(--muted)]"
        >
          <div
            ref={page}
            className="relative"
            style={{ width: `${zoom * 100}%` }}
          >
            {file.mimeType === "application/pdf" ? (
              <PdfPage
                url={download.data.url}
                pageNumber={pageNumber}
                onReady={onReady}
                onError={onError}
              />
            ) : (
              <img
                className="block h-auto w-full"
                src={download.data.url}
                alt={`Загруженная страница документа: ${file.filename}`}
                onLoad={onReady}
                onError={onError}
              />
            )}
            {ready && showBoxes && (
              <svg
                className="pointer-events-none absolute inset-0 h-full w-full"
                viewBox="0 0 1000 1000"
                preserveAspectRatio="none"
                aria-label="Распознанные области"
              >
                {regions.map(({ field, region }) => (
                  <rect
                    key={region.id}
                    role="button"
                    tabIndex={0}
                    aria-pressed={field.name === selectedField}
                    aria-label={`${DOCUMENT_FIELD_LABELS[field.name] ?? field.name}. OCR: ${region.text ?? field.originalValue ?? "Не распознано"}`}
                    x={region.x * 1000}
                    y={region.y * 1000}
                    width={region.width * 1000}
                    height={region.height * 1000}
                    fill={
                      field.name === selectedField
                        ? "var(--primary)"
                        : "var(--info)"
                    }
                    fillOpacity={field.name === selectedField ? 0.18 : 0.06}
                    stroke={
                      field.name === selectedField
                        ? "var(--primary)"
                        : "var(--info)"
                    }
                    strokeWidth={field.name === selectedField ? 3 : 1.5}
                    vectorEffect="non-scaling-stroke"
                    className="pointer-events-auto cursor-pointer focus:outline focus:outline-2 focus:outline-[var(--primary)]"
                    onClick={() => onSelectRegion(field.name, region)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelectRegion(field.name, region);
                      }
                    }}
                  >
                    <title>
                      {DOCUMENT_FIELD_LABELS[field.name] ?? field.name}:{" "}
                      {region.text ?? field.originalValue ?? "—"}
                    </title>
                  </rect>
                ))}
              </svg>
            )}
          </div>
        </div>
      )}
      {selected && (
        <p className="break-words text-sm">
          <b>
            {DOCUMENT_FIELD_LABELS[selected.field.name] ?? selected.field.name}
          </b>{" "}
          · OCR: «
          {selected.region.text ??
            selected.field.originalValue ??
            "Не распознано"}
          »
        </p>
      )}
      <p className="text-xs text-[var(--muted-foreground)]">
        {regions.length
          ? "Нажмите на область, чтобы перейти к полю. Для мелкого текста увеличьте превью."
          : "Для этой страницы OCR не передала координаты. Поля можно проверить по оригиналу."}
      </p>
    </div>
  );
}
