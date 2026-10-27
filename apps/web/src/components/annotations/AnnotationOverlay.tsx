import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { AnnotationLineDto } from "@edo/api-client";
import {
  boxInsidePage,
  boxToQuad,
  moveBox,
  normalizedQuad,
  pixelBox,
  resizeBox,
  screenToSource,
  type OrientedBox,
  type Point,
} from "./annotation-geometry";

export interface AnnotationOverlayProps {
  lines: AnnotationLineDto[];
  width: number;
  height: number;
  rotation: number;
  selectedId: string | null;
  editable: boolean;
  drawing?: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, quad: number[]) => void;
  onCreate: (quad: number[]) => void;
}
type Drag =
  | { kind: "draw"; start: Point }
  | {
      kind: "move" | "resize" | "rotate";
      start: Point;
      box: OrientedBox;
      id: string;
    };
export function AnnotationOverlay({
  lines,
  width,
  height,
  rotation,
  selectedId,
  editable,
  drawing = false,
  onSelect,
  onChange,
  onCreate,
}: AnnotationOverlayProps) {
  const svg = useRef<SVGSVGElement>(null),
    drag = useRef<Drag | null>(null);
  const [pending, setPending] = useState<OrientedBox | null>(null);
  const point = (event: ReactPointerEvent): Point => {
    const rect = svg.current!.getBoundingClientRect(),
      sideways = rotation % 180 !== 0;
    return screenToSource(
      { x: event.clientX, y: event.clientY },
      { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      sideways ? rect.height : rect.width,
      sideways ? rect.width : rect.height,
      width,
      height,
      rotation,
    );
  };
  const start = (
    event: ReactPointerEvent<SVGElement>,
    kind: "move" | "resize" | "rotate",
    line: AnnotationLineDto,
  ) => {
    onSelect(line.id);
    if (!editable || drawing) return;
    event.currentTarget.focus();
    event.preventDefault();
    event.stopPropagation();
    drag.current = {
      kind,
      start: point(event),
      box: pixelBox(line.quad, width, height),
      id: line.id,
    };
    svg.current?.setPointerCapture(event.pointerId);
  };
  const publish = (id: string, box: OrientedBox) => {
    if (boxInsidePage(box, width, height))
      onChange(id, normalizedQuad(box, width, height));
  };
  return (
    <svg
      ref={svg}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-label="Разметка строк документа"
      data-annotation-canvas=""
      className={`absolute inset-0 h-full w-full touch-none ${drawing && editable ? "cursor-crosshair" : "pointer-events-none"}`}
      onPointerDown={(event) => {
        if (!editable || !drawing) return;
        const p = point(event);
        drag.current = {
          kind: "draw",
          start: {
            x: Math.max(0, Math.min(width, p.x)),
            y: Math.max(0, Math.min(height, p.y)),
          },
        };
        svg.current?.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d) return;
        const p = point(event);
        if (d.kind === "draw") {
          const x = Math.max(0, Math.min(width, p.x)),
            y = Math.max(0, Math.min(height, p.y));
          setPending({
            cx: (d.start.x + x) / 2,
            cy: (d.start.y + y) / 2,
            width: Math.abs(x - d.start.x),
            height: Math.abs(y - d.start.y),
            angle: 0,
          });
        } else if (d.kind === "move")
          publish(
            d.id,
            moveBox(d.box, p.x - d.start.x, p.y - d.start.y, width, height),
          );
        else if (d.kind === "resize") publish(d.id, resizeBox(d.box, p));
        else
          publish(d.id, {
            ...d.box,
            angle:
              (Math.atan2(p.y - d.box.cy, p.x - d.box.cx) * 180) / Math.PI + 90,
          });
      }}
      onPointerUp={(event) => {
        if (
          drag.current?.kind === "draw" &&
          pending &&
          boxInsidePage(pending, width, height)
        )
          onCreate(normalizedQuad(pending, width, height));
        drag.current = null;
        setPending(null);
        if (svg.current?.hasPointerCapture(event.pointerId))
          svg.current.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setPending(null);
      }}
    >
      {lines.map((line) => {
        const box = pixelBox(line.quad, width, height),
          q = boxToQuad(box),
          selected = line.id === selectedId;
        const topX = (q[0] + q[2]) / 2,
          topY = (q[1] + q[3]) / 2,
          r = (box.angle * Math.PI) / 180;
        return (
          <g key={line.id}>
            <polygon
              data-annotation-line={line.id}
              points={q
                .reduce<
                  string[]
                >((out, v, i) => (i % 2 === 0 ? [...out, `${v},${q[i + 1]}`] : out), [])
                .join(" ")}
              role="button"
              tabIndex={0}
              aria-label={`Строка ${line.order + 1}: ${line.text || "Введите текст"}`}
              aria-pressed={selected}
              fill="var(--primary)"
              fillOpacity={selected ? 0.18 : 0.06}
              stroke="var(--primary)"
              strokeWidth={selected ? 2 : 1}
              vectorEffect="non-scaling-stroke"
              className="pointer-events-auto cursor-move focus:outline focus:outline-2 focus:outline-[var(--primary)]"
              onFocus={() => onSelect(line.id)}
              onClick={() => onSelect(line.id)}
              onPointerDown={(event) => start(event, "move", line)}
              onKeyDown={(event) => {
                if (!editable) return;
                const step = event.shiftKey ? 10 : 1;
                let next = box;
                if (event.key === "ArrowLeft")
                  next = moveBox(box, -step, 0, width, height);
                else if (event.key === "ArrowRight")
                  next = moveBox(box, step, 0, width, height);
                else if (event.key === "ArrowUp")
                  next = moveBox(box, 0, -step, width, height);
                else if (event.key === "ArrowDown")
                  next = moveBox(box, 0, step, width, height);
                else if (event.key === "[" || event.key === "]")
                  next = {
                    ...box,
                    angle: box.angle + (event.key === "[" ? -step : step),
                  };
                else return;
                event.preventDefault();
                publish(line.id, next);
              }}
            >
              <title>{line.text || "Новая строка"}</title>
            </polygon>
            {selected && editable && !drawing && (
              <>
                <line
                  x1={topX}
                  y1={topY}
                  x2={topX + Math.sin(r) * 24}
                  y2={topY - Math.cos(r) * 24}
                  stroke="var(--primary)"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx={topX + Math.sin(r) * 24}
                  cy={topY - Math.cos(r) * 24}
                  r={8}
                  fill="var(--card)"
                  stroke="var(--primary)"
                  className="pointer-events-auto cursor-grab"
                  aria-label="Повернуть рамку"
                  onPointerDown={(event) => start(event, "rotate", line)}
                />
                <rect
                  x={q[4] - 7}
                  y={q[5] - 7}
                  width={14}
                  height={14}
                  fill="var(--card)"
                  stroke="var(--primary)"
                  className="pointer-events-auto cursor-nwse-resize"
                  aria-label="Изменить размер рамки"
                  onPointerDown={(event) => start(event, "resize", line)}
                />
              </>
            )}
          </g>
        );
      })}
      {pending && (
        <polygon
          points={boxToQuad(pending)
            .reduce<string[]>(
              (out, v, i, q) =>
                i % 2 === 0 ? [...out, `${v},${q[i + 1]}`] : out,
              [],
            )
            .join(" ")}
          fill="var(--primary)"
          fillOpacity={0.12}
          stroke="var(--primary)"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
