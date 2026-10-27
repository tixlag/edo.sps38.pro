export type Point = { x: number; y: number };
export type OrientedBox = {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
};
export function boxToQuad(box: OrientedBox): number[] {
  const r = (box.angle * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  return [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].flatMap(([x, y]) => [
    box.cx + ((x * box.width) / 2) * c - ((y * box.height) / 2) * s,
    box.cy + ((x * box.width) / 2) * s + ((y * box.height) / 2) * c,
  ]);
}
export function quadToBox(q: number[]): OrientedBox {
  return {
    cx: (q[0] + q[4]) / 2,
    cy: (q[1] + q[5]) / 2,
    width: Math.hypot(q[2] - q[0], q[3] - q[1]),
    height: Math.hypot(q[6] - q[0], q[7] - q[1]),
    angle: (Math.atan2(q[3] - q[1], q[2] - q[0]) * 180) / Math.PI,
  };
}
/** Invert the page's centered CSS rotation and rendered size, including zoom. */
export function screenToSource(
  point: Point,
  center: Point,
  displayWidth: number,
  displayHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  rotation: number,
): Point {
  const r = (rotation * Math.PI) / 180,
    dx = point.x - center.x,
    dy = point.y - center.y;
  return {
    x:
      ((dx * Math.cos(r) + dy * Math.sin(r)) / displayWidth + 0.5) *
      sourceWidth,
    y:
      ((-dx * Math.sin(r) + dy * Math.cos(r)) / displayHeight + 0.5) *
      sourceHeight,
  };
}
export function resizeBox(box: OrientedBox, point: Point): OrientedBox {
  const q = boxToQuad(box),
    r = (box.angle * Math.PI) / 180,
    c = Math.cos(r),
    s = Math.sin(r);
  const dx = point.x - q[0],
    dy = point.y - q[1];
  const width = Math.max(2, dx * c + dy * s),
    height = Math.max(2, -dx * s + dy * c);
  return {
    ...box,
    width,
    height,
    cx: q[0] + (width / 2) * c - (height / 2) * s,
    cy: q[1] + (width / 2) * s + (height / 2) * c,
  };
}
export function moveBox(
  box: OrientedBox,
  dx: number,
  dy: number,
  width: number,
  height: number,
): OrientedBox {
  const q = boxToQuad(box),
    xs = q.filter((_, i) => i % 2 === 0),
    ys = q.filter((_, i) => i % 2 !== 0);
  return {
    ...box,
    cx:
      box.cx +
      Math.max(-Math.min(...xs), Math.min(dx, width - Math.max(...xs))),
    cy:
      box.cy +
      Math.max(-Math.min(...ys), Math.min(dy, height - Math.max(...ys))),
  };
}
export function boxInsidePage(
  box: OrientedBox,
  width: number,
  height: number,
): boolean {
  return (
    box.width >= 2 &&
    box.height >= 2 &&
    boxToQuad(box).every(
      (v, i) =>
        Number.isFinite(v) &&
        v >= -1e-7 &&
        v <= (i % 2 === 0 ? width : height) + 1e-7,
    )
  );
}
export function normalizedQuad(
  box: OrientedBox,
  width: number,
  height: number,
): number[] {
  return boxToQuad(box).map((v, i) =>
    Math.min(1, Math.max(0, v / (i % 2 === 0 ? width : height))),
  );
}
export function pixelBox(
  quad: number[],
  width: number,
  height: number,
): OrientedBox {
  return quadToBox(quad.map((v, i) => v * (i % 2 === 0 ? width : height)));
}
