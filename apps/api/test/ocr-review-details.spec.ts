import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { DocumentReadService } from "../src/documents/document-read.service";
import { DocumentsController } from "../src/documents/documents.controller";
import { REQUIRED_ACCESS_RULES_KEY } from "../src/auth/require-access-rule.decorator";
import { EdoAccessRule } from "../src/auth/edo-access-rule";

const region = {
  id: "box",
  fileId: "scan",
  file: { ordinal: 0 },
  pageNumber: 2,
  x: 0.1,
  y: 0.2,
  width: 0.3,
  height: 0.04,
  text: "RAW SEGMENT",
};
function fixture() {
  const field = {
    name: "issueDate",
    required: true,
    kind: "date",
    value: "2026-10-20",
    editedBy: null,
    submittedValue: "2026-10-20",
    originalValue: "2026-10-20",
    ocrText: "20.10.2026",
    regions: [region],
  };
  const observation = {
    name: "date_issue",
    documentFieldName: "issueDate",
    value: "20.10.2026",
    source: "GLM",
    paddleText: "PADDLE",
    paddleConfidence: 0.4,
    regions: [region, { ...region, id: "duplicate" }],
  };
  const row = {
    document: { documentType: null },
    status: "IN_REVIEW",
    revision: 5,
    reviewedBy: null,
    files: [],
    issues: [],
    job: null,
    delivery: null,
    ocrSource: "EXTERNAL",
    ocrRaw: { allFields: "PROTECTED" },
    fields: [field, { ...field, name: "optional", required: false }],
    ocrFields: [
      observation,
      { ...observation, name: "pas_nationality", documentFieldName: null },
    ],
  };
  const prisma = { documentVersion: { findUnique: vi.fn(async () => row) } };
  const access = { document: vi.fn(async () => ({})) };
  const reads = new DocumentReadService(
    prisma as never,
    access as never,
    {} as never,
  );
  const principal = (rules: Record<string, unknown>) =>
    ({ uuid: "reviewer", accessRules: rules }) as never;
  return { row, reads, prisma, access, principal };
}

describe("OCR review data boundaries", () => {
  it("does not invent a mismatch when either source has no value", async () => {
    const { row, reads } = fixture();
    row.fields[0].ocrText = "";
    expect((await reads.version("document", 4)).fields[0].mismatch).toBe(false);
    row.fields[0].ocrText = "20.10.2026";
    row.fields[0].submittedValue = "";
    expect((await reads.version("document", 4)).fields[0].mismatch).toBe(false);
  });
  it("retains a mismatch for different dates", async () => {
    const { reads, row } = fixture();
    row.fields[0].submittedValue = "2026-10-21";
    expect((await reads.version("document", 4)).fields[0].mismatch).toBe(true);
  });
  it("normalizes equivalent dates and redacts full OCR on the shared version serializer", async () => {
    const { reads } = fixture();
    const result = await reads.version("document", 4);
    expect(result.raw).toBeNull();
    expect(result.ocrFields.map((f) => f.name)).toEqual(["date_issue"]);
    expect(result.fields[0]).toMatchObject({
      value: "2026-10-20",
      originalValue: "2026-10-20",
      ocrText: "20.10.2026",
      mismatch: false,
    });
    expect(result.fields[1]).toMatchObject({
      originalValue: null,
      ocrText: null,
      mismatch: false,
      regions: [],
    });
  });

  it.each(["20010", "20009"])(
    "returns all observations and deduplicated regions with %s",
    async (rule) => {
      const { reads, access, principal } = fixture();
      const result = await reads.ocrDetails(
        "document",
        4,
        principal({ [rule]: [] }),
      );
      expect(access.document).toHaveBeenCalledWith(
        "document",
        expect.anything(),
      );
      expect(result.fields).toHaveLength(2);
      expect(result.fields[0].regions).toEqual([
        expect.objectContaining({
          fileOrdinal: 0,
          pageNumber: 2,
          text: "RAW SEGMENT",
        }),
      ]);
      expect(result.raw).toEqual({ allFields: "PROTECTED" });
    },
  );

  it("denies a regular reviewer and inherited permissions before loading details", async () => {
    const { reads, access, principal, prisma } = fixture();
    for (const rules of [{ "20002": [] }, Object.create({ "20010": [] })])
      await expect(
        reads.ocrDetails("document", 4, principal(rules)),
      ).rejects.toThrow("Missing required EDO access rule");
    expect(access.document).not.toHaveBeenCalled();
    expect(prisma.documentVersion.findUnique).not.toHaveBeenCalled();
    expect(
      Reflect.getMetadata(
        REQUIRED_ACCESS_RULES_KEY,
        DocumentsController.prototype.ocrDetails,
      ),
    ).toEqual([EdoAccessRule.OCR_DETAILS_VIEW]);
  });

  it("keeps location scope mandatory even with the details rule", async () => {
    const { reads, access, principal, prisma } = fixture();
    access.document.mockRejectedValue(
      new NotFoundException("Document not found"),
    );
    await expect(
      reads.ocrDetails("document", 4, principal({ "20010": [] })),
    ).rejects.toThrow("Document not found");
    expect(prisma.documentVersion.findUnique).not.toHaveBeenCalled();
  });

  it.each(["case", "spaces", "saved correction"])(
    "keeps exact original mismatch: %s",
    async (scenario) => {
      const { row, reads } = fixture();
      Object.assign(row.fields[0], {
        kind: "text",
        submittedValue: "Иванов",
        originalValue: "ИВАНОВ",
        ocrText: scenario === "spaces" ? "Иванов " : "ИВАНОВ",
        value: scenario === "saved correction" ? "ИВАНОВ" : "Иванов",
      });
      expect((await reads.version("document", 4)).fields[0].mismatch).toBe(
        true,
      );
    },
  );
});
