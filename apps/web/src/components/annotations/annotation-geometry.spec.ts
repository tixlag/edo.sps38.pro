import { describe, expect, it } from "vitest";
import {
  boxToQuad,
  quadToBox,
  screenToSource,
  resizeBox,
  moveBox,
  boxInsidePage,
} from "./annotation-geometry";

describe("annotation geometry in canonical upright pixels", () => {
  it("round trips rotated rectangular lines without flattening their angle", () => {
    const box = { cx: 340, cy: 280, width: 210, height: 36, angle: 23 };
    const restored = quadToBox(boxToQuad(box));
    for (const key of Object.keys(box) as (keyof typeof box)[])
      expect(restored[key]).toBeCloseTo(box[key]);
  });
  it.each([0, 90, 180, 270])(
    "inverts screen zoom and %s degree view rotation",
    (rotation) => {
      const r = (rotation * Math.PI) / 180;
      const dx = (120 - 300) * 1.5;
      const dy = (200 - 450) * 1.5;
      const point = screenToSource(
        {
          x: 800 + dx * Math.cos(r) - dy * Math.sin(r),
          y: 700 + dx * Math.sin(r) + dy * Math.cos(r),
        },
        { x: 800, y: 700 },
        900,
        1350,
        600,
        900,
        rotation,
      );
      expect(point.x).toBeCloseTo(120);
      expect(point.y).toBeCloseTo(200);
    },
  );
  it("resizes in a line’s local axes and keeps opposite corner fixed", () => {
    const box = { cx: 200, cy: 200, width: 100, height: 20, angle: 90 };
    const resized = resizeBox(box, { x: 180, y: 280 });
    expect(resized.width).toBeCloseTo(130);
    expect(resized.height).toBeCloseTo(30);
    expect(boxToQuad(resized)[0]).toBeCloseTo(boxToQuad(box)[0]);
    expect(boxToQuad(resized)[1]).toBeCloseTo(boxToQuad(box)[1]);
  });
  it("rejects rotated corners outside the page and bounds movement", () => {
    const box = { cx: 20, cy: 20, width: 60, height: 10, angle: 45 };
    expect(boxInsidePage(box, 600, 900)).toBe(false);
    const moved = moveBox({ ...box, cx: 300, cy: 200 }, -999, -999, 600, 900);
    expect(boxInsidePage(moved, 600, 900)).toBe(true);
  });
});
