import { describe, expect, it } from "vitest";
import type { DocumentFieldDto, DocumentVersionDto } from "@edo/api-client";
import { getRequiredReviewFields } from "./document-review-fields";

function field(
  name: string,
  required: boolean,
  properties: Partial<DocumentFieldDto> = {},
): DocumentFieldDto {
  return {
    name,
    required,
    label: name,
    kind: "text",
    value: "Текущее значение",
    originalValue: "OCR",
    submittedValue: "Кандидат",
    editedBy: null,
    mismatch: true,
    regions: [],
    ...properties,
  };
}

function version(fields: DocumentFieldDto[]): DocumentVersionDto {
  return {
    documentId: "doc-required",
    version: 1,
    revision: 0,
    status: "IN_REVIEW",
    ocrSource: "EXTERNAL",
    fields,
    files: [],
    issues: [],
    job: null,
    raw: null,
    approvedAt: null,
    approvedBy: null,
    rejectionReason: null,
    delivery: null,
  };
}

describe("required document review fields", () => {
  it("keeps required OCR/candidate/mismatch data and excludes optional regions", () => {
    const required = field("number", true, {
      regions: [
        {
          id: "number-region",
          fileId: "scan",
          fileOrdinal: 0,
          pageNumber: 2,
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.1,
          text: "OCR",
        },
      ],
    });
    const data = version([field("comment", false), required]);

    expect(getRequiredReviewFields(data)).toEqual([required]);
    expect(getRequiredReviewFields(data)[0]).toBe(required);
    expect(data.fields).toHaveLength(2);
  });

  it("includes positionUid when selected by the document catalog", () => {
    expect(
      getRequiredReviewFields(
        version([field("positionUid", true), field("number", true)]),
      ).map((item) => item.name),
    ).toEqual(["number", "positionUid"]);
  });

  it("does not fall back to optional fields when none are required", () => {
    expect(
      getRequiredReviewFields(version([field("comment", false)])),
    ).toEqual([]);
  });

  it("preserves required fields in historical read-only versions", () => {
    const data = version([field("number", true), field("comment", false)]);
    data.status = "APPROVED";
    expect(getRequiredReviewFields(data).map((item) => item.name)).toEqual([
      "number",
    ]);
  });

  it("retains established OCR ordering without mutating the API payload", () => {
    const data = version([
      field("issued_at", true),
      field("comment", false),
      field("first_name", true),
      field("last_name", true),
    ]);
    expect(getRequiredReviewFields(data).map((item) => item.name)).toEqual([
      "last_name",
      "first_name",
      "issued_at",
    ]);
    expect(data.fields.map((item) => item.name)).toEqual([
      "issued_at",
      "comment",
      "first_name",
      "last_name",
    ]);
  });

  it("preserves catalog field order for documents without OCR", () => {
    const data = version([field("number", true), field("series", true)]);
    data.ocrSource = null;
    expect(getRequiredReviewFields(data).map((item) => item.name)).toEqual([
      "number",
      "series",
    ]);
  });
});
