import { describe, expect, it } from "vitest";
import { annotationComplete, replaceAnnotationLine } from "./annotation-draft";
import type {
  AnnotationCatalogDto,
  AnnotationFieldAnswerDto,
} from "@edo/api-client";
const schema = {
  fields: [{ key: "name" }, { key: "issuer" }],
} as AnnotationCatalogDto;
const line = {
  id: "l",
  pageId: "p",
  order: 0,
  text: "ИВАНОВ",
  quad: [0.1, 0.1, 0.2, 0.1, 0.2, 0.2, 0.1, 0.2],
};
describe("annotation answers", () => {
  it("requires every schema field to be explicitly answered and every present line transcribed", () => {
    expect(
      annotationComplete(schema, [
        { key: "name", disposition: "PRESENT", lines: [line] },
      ]),
    ).toBe(false);
    expect(
      annotationComplete(schema, [
        { key: "name", disposition: "PRESENT", lines: [line] },
        { key: "issuer", disposition: "NOT_PRESENT", lines: [] },
      ]),
    ).toBe(true);
    expect(
      annotationComplete(schema, [
        { key: "name", disposition: "PRESENT", lines: [{ ...line, text: "" }] },
        { key: "issuer", disposition: "UNREADABLE", lines: [] },
      ]),
    ).toBe(false);
  });
  it("updates geometry without touching literal text, field status or other fields", () => {
    const fields = [
      { key: "name", disposition: "PRESENT", lines: [line] },
      { key: "issuer", disposition: "NOT_PRESENT", lines: [] },
    ] as AnnotationFieldAnswerDto[];
    const next = replaceAnnotationLine(fields, "l", {
      quad: [0, 0, 0.1, 0, 0.1, 0.1, 0, 0.1],
    });
    expect(next[0].lines[0].quad).toEqual([0, 0, 0.1, 0, 0.1, 0.1, 0, 0.1]);
    expect(next[0].lines[0].text).toBe("ИВАНОВ");
    expect(next[1]).toBe(fields[1]);
    expect(fields[0].lines[0].quad).toEqual(line.quad);
  });
});
