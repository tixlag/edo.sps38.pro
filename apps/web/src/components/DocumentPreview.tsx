import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FileImage,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
} from "lucide-react";
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

const ZOOM_LEVELS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
type PageSize = { width: number; height: number };

function PdfPage({
  url,
  pageNumber,
  onReady,
  onError,
}: {
  url: string;
  pageNumber: number;
  onReady: (size: PageSize) => void;
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
      if (active) onReady({ width: base.width, height: base.height });
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
  hoveredField,
  hoveredRegionId,
  onSelectRegion,
  onHoverRegion,
}: {
  documentId: string;
  version: number;
  file: DocumentFileDto;
  pageNumber: number;
  fields: DocumentFieldDto[];
  selectedField: string | null;
  selectedRegionId: string | null;
  hoveredField?: string | null;
  hoveredRegionId?: string | null;
  onSelectRegion: (fieldName: string, region: OcrRegionDto) => void;
  onHoverRegion?: (
    fieldName: string | null,
    region: OcrRegionDto | null,
  ) => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [pageSize, setPageSize] = useState<PageSize>({
    width: 1,
    height: 1.414,
  });
  const [viewportWidth, setViewportWidth] = useState(600);
  const [showBoxes, setShowBoxes] = useState(true);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
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
  const onReady = useCallback((size: PageSize) => {
    if (size.width > 0 && size.height > 0) setPageSize(size);
    setReady(true);
  }, []);
  const onError = useCallback(() => setFailed(true), []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setViewportWidth(element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [download.data, failed]);
  const pageWidth = viewportWidth * zoom;
  const pageHeight = (pageWidth * pageSize.height) / pageSize.width;
  const sideways = rotation % 180 !== 0;
  const rotatedWidth = sideways ? pageHeight : pageWidth;
  const rotatedHeight = sideways ? pageWidth : pageHeight;
  const stageWidth = Math.max(viewportWidth, rotatedWidth);
  useEffect(() => {
    const region = regions.find(
      (item) => item.region.id === selectedRegionId,
    )?.region;
    if (!ready || !region || !viewport.current) return;
    // The image and overlay rotate together around the page center. Move the
    // selected region's center through the same transform before scrolling.
    const x = (region.x + region.width / 2 - 0.5) * pageWidth;
    const y = (region.y + region.height / 2 - 0.5) * pageHeight;
    const radians = (rotation * Math.PI) / 180;
    viewport.current.scrollTo({
      left: Math.max(
        0,
        stageWidth / 2 +
          x * Math.cos(radians) -
          y * Math.sin(radians) -
          viewport.current.clientWidth / 2,
      ),
      top: Math.max(
        0,
        rotatedHeight / 2 +
          12 +
          x * Math.sin(radians) +
          y * Math.cos(radians) -
          viewport.current.clientHeight / 2,
      ),
    });
  }, [
    regions,
    selectedRegionId,
    ready,
    rotation,
    pageWidth,
    pageHeight,
    stageWidth,
    rotatedHeight,
  ]);
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border)] pb-2 text-xs">
        <FileImage
          size={16}
          className="shrink-0 text-[var(--primary)]"
          aria-hidden="true"
        />
        <span
          className="min-w-0 flex-1 truncate font-semibold"
          title={file.filename}
        >
          {file.filename}
        </span>
        {download.data && (
          <a
            className="flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] border border-[var(--border)] px-2.5 font-medium hover:bg-[var(--muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            href={download.data.url}
            target="_blank"
            rel="noreferrer"
            aria-label="Скачать оригинал"
          >
            <Download size={14} aria-hidden="true" />
            Скачать
          </a>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 px-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            aria-label="Уменьшить превью"
            title="Уменьшить превью"
            disabled={zoom <= ZOOM_LEVELS[0]}
            onClick={() =>
              setZoom(ZOOM_LEVELS[Math.max(0, ZOOM_LEVELS.indexOf(zoom) - 1)])
            }
          >
            <Minus size={14} />
          </Button>
          <select
            className="h-8 rounded-[10px] border border-[var(--border)] bg-[var(--card)] px-2 text-xs tabular-nums focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            aria-label="Масштаб превью"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          >
            {ZOOM_LEVELS.map((level) => (
              <option key={level} value={level}>
                {Math.round(level * 100)}%
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 px-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            aria-label="Увеличить превью"
            title="Увеличить превью"
            disabled={zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
            onClick={() =>
              setZoom(
                ZOOM_LEVELS[
                  Math.min(
                    ZOOM_LEVELS.length - 1,
                    ZOOM_LEVELS.indexOf(zoom) + 1,
                  )
                ],
              )
            }
          >
            <Plus size={14} />
          </Button>
          <span
            className="mx-1 h-5 border-l border-[var(--border)]"
            aria-hidden="true"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 px-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            aria-label="Повернуть влево"
            title="Повернуть влево"
            onClick={() => setRotation((value) => (value + 270) % 360)}
          >
            <RotateCcw size={14} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 px-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--primary)]"
            aria-label="Повернуть вправо"
            title="Повернуть вправо"
            onClick={() => setRotation((value) => (value + 90) % 360)}
          >
            <RotateCw size={14} />
          </Button>
        </div>
        <label className="flex h-8 cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-[var(--primary)]"
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
            size="sm"
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
          className="min-h-[240px] max-h-[60dvh] flex-1 overflow-auto rounded-[12px] border border-[var(--border)] bg-[var(--muted)] lg:min-h-0 lg:max-h-none"
          aria-label="Изображение документа"
        >
          <div
            className="relative"
            data-preview-stage=""
            style={{ width: stageWidth, height: rotatedHeight + 24 }}
          >
            <div
              className="absolute"
              data-preview-page=""
              style={{
                width: pageWidth,
                height: pageHeight,
                left: "50%",
                top: "50%",
                transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                transformOrigin: "center",
              }}
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
                  onLoad={(event) =>
                    onReady({
                      width: event.currentTarget.naturalWidth,
                      height: event.currentTarget.naturalHeight,
                    })
                  }
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
                  {regions.map(({ field, region }) => {
                    const isSelected =
                      field.name === selectedField ||
                      region.id === selectedRegionId;
                    const isHovered =
                      !isSelected &&
                      (field.name === hoveredField ||
                        region.id === hoveredRegionId);
                    return (
                      <rect
                        key={region.id}
                        role="button"
                        tabIndex={0}
                        data-region={region.id}
                        data-field={field.name}
                        aria-pressed={field.name === selectedField}
                        aria-label={`${DOCUMENT_FIELD_LABELS[field.name] ?? field.name}. OCR: ${region.text ?? field.originalValue ?? "Не распознано"}`}
                        x={region.x * 1000}
                        y={region.y * 1000}
                        width={region.width * 1000}
                        height={region.height * 1000}
                        fill={
                          isSelected || isHovered
                            ? "var(--primary)"
                            : "var(--info)"
                        }
                        fillOpacity={
                          isSelected ? 0.18 : isHovered ? 0.12 : 0.06
                        }
                        stroke={
                          isSelected || isHovered
                            ? "var(--primary)"
                            : "var(--info)"
                        }
                        strokeWidth={isSelected ? 3 : isHovered ? 2.5 : 1.5}
                        vectorEffect="non-scaling-stroke"
                        className="pointer-events-auto cursor-pointer focus:outline focus:outline-2 focus:outline-[var(--primary)]"
                        onClick={() => onSelectRegion(field.name, region)}
                        onMouseEnter={() => onHoverRegion?.(field.name, region)}
                        onMouseLeave={() => onHoverRegion?.(null, null)}
                        onFocus={() => onHoverRegion?.(field.name, region)}
                        onBlur={() => onHoverRegion?.(null, null)}
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
                    );
                  })}
                </svg>
              )}
            </div>
          </div>
        </div>
      )}
      {selected && (
        <p
          className="shrink-0 truncate text-xs"
          title={`${DOCUMENT_FIELD_LABELS[selected.field.name] ?? selected.field.name} · OCR: ${selected.region.text ?? selected.field.originalValue ?? "Не распознано"}`}
        >
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
      <p className="shrink-0 text-[11px] leading-4 text-[var(--muted-foreground)]">
        {regions.length
          ? "Нажмите на область, чтобы перейти к полю. Для мелкого текста увеличьте превью."
          : "Для этой страницы OCR не передала координаты. Поля можно проверить по оригиналу."}
      </p>
    </div>
  );
}
