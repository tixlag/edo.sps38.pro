import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { AnnotationRegionDto } from "@edo/api-client";
import { screenToSource } from "./annotation-geometry";
export interface RegionLayerProps {
  passive?: boolean;
  regions: AnnotationRegionDto[];
  selectedId: string | null;
  editable: boolean;
  drawing: "RECTANGLE" | "POLYGON" | null;
  onSelect: (id: string) => void;
  onCreate: (region: AnnotationRegionDto) => void;
  onChange: (id: string, patch: Partial<AnnotationRegionDto>) => void;
}
export function RegionOverlay({
  width,
  height,
  rotation,
  ...props
}: RegionLayerProps & { width: number; height: number; rotation: number }) {
  const svg = useRef<SVGSVGElement>(null),
    start = useRef<number[] | null>(null),
    drag = useRef<{ id: string; vertex: number } | null>(null);
  const [points, setPoints] = useState<number[]>([]),
    [pending, setPending] = useState<number[]>([]);
  const point = (e: ReactPointerEvent) => {
    const r = svg.current!.getBoundingClientRect();
    const p = screenToSource(
      { x: e.clientX, y: e.clientY },
      { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      rotation % 180 ? r.height : r.width,
      rotation % 180 ? r.width : r.height,
      width,
      height,
      rotation,
    );
    return [
      Math.min(1, Math.max(0, p.x / width)),
      Math.min(1, Math.max(0, p.y / height)),
    ];
  };
  const create = (p: number[], shape: AnnotationRegionDto["shape"]) => {
    if (p.length < 6) return;
    let area = 0;
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      area += p[i] * p[j + 1] - p[j] * p[i + 1];
    }
    if (Math.abs(area) < 1e-8) return;
    const polygon =
      area < 0
        ? Array.from({ length: p.length / 2 }, (_, i) =>
            p.slice(p.length - 2 - i * 2, p.length - i * 2),
          ).flat()
        : p;
    props.onCreate({
      id: crypto.randomUUID(),
      pageId: "",
      shape,
      orientationDeg: 0,
      polygon,
    });
    setPoints([]);
    setPending([]);
  };
  const pixels = (p: number[]) =>
    Array.from(
      { length: p.length / 2 },
      (_, i) => `${p[i * 2] * width},${p[i * 2 + 1] * height}`,
    ).join(" ");
  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-label="Контуры полей документа"
      tabIndex={0}
      className={`absolute inset-0 h-full w-full touch-none ${props.drawing && props.editable ? "cursor-crosshair" : "pointer-events-none"}`}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setPoints([]);
          setPending([]);
        }
        if (e.key === "Enter" && props.drawing === "POLYGON")
          create(points, "POLYGON");
      }}
      onPointerDown={(e) => {
        if (!props.editable || !props.drawing) return;
        svg.current?.focus();
        const p = point(e);
        if (props.drawing === "POLYGON") {
          setPoints([...points, ...p]);
        } else {
          start.current = p;
          svg.current?.setPointerCapture(e.pointerId);
        }
      }}
      onPointerMove={(e) => {
        if (drag.current) {
          const d = drag.current,
            r = props.regions.find((r) => r.id === d.id);
          if (r) {
            const polygon = [...r.polygon];
            const p = point(e);
            polygon[d.vertex * 2] = p[0];
            polygon[d.vertex * 2 + 1] = p[1];
            props.onChange(r.id, { polygon, shape: "POLYGON" });
          }
          return;
        }
        if (start.current) {
          const [x, y] = start.current,
            [x1, y1] = point(e);
          setPending([
            Math.min(x, x1),
            Math.min(y, y1),
            Math.max(x, x1),
            Math.min(y, y1),
            Math.max(x, x1),
            Math.max(y, y1),
            Math.min(x, x1),
            Math.max(y, y1),
          ]);
        }
      }}
      onPointerUp={(e) => {
        if (start.current && pending.length) create(pending, "RECTANGLE");
        start.current = null;
        drag.current = null;
        setPending([]);
        if (svg.current?.hasPointerCapture(e.pointerId))
          svg.current.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        start.current = null;
        drag.current = null;
        setPending([]);
      }}
    >
      {props.regions.map((region) => {
        const selected = region.id === props.selectedId;
        const xs = region.polygon.filter((_, i) => i % 2 === 0),
          ys = region.polygon.filter((_, i) => i % 2 === 1),
          cx = (xs.reduce((a, b) => a + b, 0) / xs.length) * width,
          cy = (ys.reduce((a, b) => a + b, 0) / ys.length) * height;
        const angle = (region.orientationDeg * Math.PI) / 180;
        const reach = Math.max(
          15,
          (Math.min(
            Math.max(...xs) - Math.min(...xs),
            Math.max(...ys) - Math.min(...ys),
          ) *
            Math.min(width, height)) /
            2,
        );
        return (
          <g key={region.id}>
            <polygon
              points={pixels(region.polygon)}
              fill="var(--info)"
              fillOpacity={selected ? 0.16 : 0.04}
              stroke="var(--info)"
              strokeWidth={selected ? 2 : 1}
              vectorEffect="non-scaling-stroke"
              role="button"
              tabIndex={0}
              aria-label="Выбрать область поля"
              aria-pressed={selected}
              className={
                props.drawing || props.passive
                  ? "pointer-events-none"
                  : "pointer-events-auto cursor-pointer"
              }
              onClick={() => props.onSelect(region.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter") props.onSelect(region.id);
              }}
            />
            {selected && (
              <>
                <line
                  x1={cx}
                  y1={cy}
                  x2={cx + Math.sin(angle) * reach}
                  y2={cy - Math.cos(angle) * reach}
                  stroke="var(--info)"
                  strokeWidth={3}
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={cx + Math.sin(angle) * reach}
                  cy={cy - Math.cos(angle) * reach}
                  r={5}
                  fill="var(--info)"
                />
                <text
                  x={cx + Math.sin(angle) * reach + 8}
                  y={cy - Math.cos(angle) * reach}
                  fontSize={Math.max(12, width / 80)}
                  fill="var(--info)"
                >
                  Верх
                </text>
              </>
            )}
            {selected &&
              props.editable &&
              !props.drawing &&
              Array.from({ length: region.polygon.length / 2 }, (_, vertex) => (
                <circle
                  key={vertex}
                  cx={region.polygon[vertex * 2] * width}
                  cy={region.polygon[vertex * 2 + 1] * height}
                  r={6}
                  fill="var(--card)"
                  stroke="var(--info)"
                  className="pointer-events-auto cursor-move"
                  aria-label={`Вершина ${vertex + 1}`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    drag.current = { id: region.id, vertex };
                    svg.current?.setPointerCapture(e.pointerId);
                  }}
                />
              ))}
          </g>
        );
      })}
      {!!pending.length && (
        <polygon
          points={pixels(pending)}
          fill="var(--info)"
          fillOpacity={0.1}
          stroke="var(--info)"
        />
      )}
      {!!points.length && props.drawing === "POLYGON" && (
        <>
          <polyline
            points={pixels(points)}
            fill="none"
            stroke="var(--info)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={points[0] * width}
            cy={points[1] * height}
            r={8}
            fill="var(--card)"
            stroke="var(--info)"
            className="pointer-events-auto cursor-pointer"
            aria-label="Замкнуть контур"
            onPointerDown={(e) => {
              e.stopPropagation();
              create(points, "POLYGON");
            }}
          />
        </>
      )}
    </svg>
  );
}
