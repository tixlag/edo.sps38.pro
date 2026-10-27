import { describe, expect, it } from "vitest";
import { validateAnswers } from "../src/annotations/annotation-validation";
const page = { id: "f:1", width: 1000, height: 800 };
const schema = [{ key: "name", label: "Name", ordinal: 0 }];
const answer = () => [
  {
    key: "name",
    disposition: "PRESENT",
    lines: [
      {
        id: "l",
        pageId: "f:1",
        order: 0,
        text: "ИВАНОВ  ИВАН",
        quad: [0.01, 0.025, 0.21, 0.025, 0.21, 0.0625, 0.01, 0.0625],
      },
    ],
  },
];
describe("manual annotation geometry and literal text", () => {
  it("preserves literal spaces and validates an oriented rectangle", () => {
    const a = answer();
    a[0].lines[0].quad = [0.1, 0.125, 0.2, 0.25, 0.18, 0.275, 0.08, 0.15];
    expect(validateAnswers(a, schema, [page], true)).toEqual(a);
  });
  it("rejects unresolved fields on submission but permits a partial draft", () => {
    expect(() => validateAnswers([], schema, [page], true)).toThrow();
    expect(validateAnswers([], schema, [page], false)).toEqual([]);
  });
  it("rejects normalized multiline or tab labels", () => {
    for (const text of ["A\nB", "A\tB", "A\rB"]) {
      const a = answer();
      a[0].lines[0].text = text;
      expect(() => validateAnswers(a, schema, [page], true)).toThrow();
    }
  });
  it("rejects trapezoids, reflected order, out-of-bounds and nonfinite geometry", () => {
    for (const quad of [
      [0.01, 0.02, 0.21, 0.02, 0.2, 0.05, 0.01, 0.05],
      [0.01, 0.05, 0.21, 0.05, 0.21, 0.02, 0.01, 0.02],
      [-1, 0.02, 0.21, 0.02, 0.21, 0.05, -1, 0.05],
      [NaN, 0.02, 0.21, 0.02, 0.21, 0.05, 0.01, 0.05],
    ]) {
      const a = answer();
      a[0].lines[0].quad = quad;
      expect(() => validateAnswers(a, schema, [page], true)).toThrow();
    }
  });
  it("requires explicit dispositions and unique line order", () => {
    const a = answer();
    a[0].lines.push({ ...a[0].lines[0], id: "l2" });
    expect(() => validateAnswers(a, schema, [page], true)).toThrow();
    expect(() =>
      validateAnswers(
        [{ key: "name", disposition: "NOT_PRESENT", lines: [] }],
        schema,
        [page],
        true,
      ),
    ).not.toThrow();
  });
  it("rejects fields outside catalog and unknown source pages", () => {
    const a = answer();
    a[0].key = "foreign";
    expect(() => validateAnswers(a, schema, [page], false)).toThrow();
    a[0].key = "name";
    a[0].lines[0].pageId = "foreign";
    expect(() => validateAnswers(a, schema, [page], false)).toThrow();
  });
});
describe("unfinished line drafts", () => {
  it("keeps empty text drafts but rejects them on submission", () => {
    const a = answer();
    a[0].lines[0].text = "";
    expect(() => validateAnswers(a, schema, [page], false)).not.toThrow();
    expect(() => validateAnswers(a, schema, [page], true)).toThrow();
  });
});
it("rejects a parallelogram whose perpendicular error exceeds half a source pixel", () => {
  const a = answer();
  a[0].lines[0].quad = [0, 0, 0.9, 0, 0.9015, 0.5, 0.0015, 0.5];
  expect(() => validateAnswers(a, schema, [page], true)).toThrow();
});
