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
  it("shows only the passport number as required for an IG candidate, including existing versions", async () => {
    const { row, reads, principal } = fixture();
    Object.assign(row.document, {
      documentType: { code: "PASSPORT", erpUid: null },
      candidate: { chatUuid: null, citizenship: "uz" },
    });
    row.fields.push({ ...row.fields[0], name: "number", required: false });
    const result = await reads.version(
      "document",
      4,
      principal({ "20010": [] }),
    );
    expect(result.fields.map(({ name, required }) => [name, required])).toEqual(
      [
        ["issueDate", false],
        ["optional", false],
        ["number", true],
        ["lastNameLatin", false],
        ["firstNameLatin", false],
        ["middleNameLatin", false],
      ],
    );
    expect(result.fields.every((field) => field.reviewVisible)).toBe(true);
    expect(result.ocrFields.map((field) => field.name)).toEqual(["date_issue"]);
    expect(result.fields[0]).toMatchObject({
      originalValue: "2026-10-20",
      ocrText: "20.10.2026",
      regions: [expect.objectContaining({ id: "box" })],
    });
  });
  it("recovers existing Uzbek OCR observations for optional Latin fields without overwriting entered values", async () => {
    const { row, reads, principal } = fixture();
    Object.assign(row.document, {
      documentType: { code: "PASSPORT", erpUid: null },
      candidate: { chatUuid: null, citizenship: "uz" },
    });
    row.ocrFields.push({
      ...row.ocrFields[0],
      name: "pas_patronymic",
      documentFieldName: null,
      value: "",
    });
    row.ocrFields.push({
      ...row.ocrFields[0],
      name: "pas_patronymic",
      documentFieldName: null,
      value: "VALIYEVICH",
    });
    row.fields.push({
      ...row.fields[0],
      name: "firstNameLatin",
      required: false,
      value: "ALI",
      originalValue: null,
      ocrText: null,
    });
    const result = await reads.version(
      "document",
      4,
      principal({ "20010": [] }),
    );
    expect(
      result.fields.find((field) => field.name === "middleNameLatin"),
    ).toMatchObject({
      required: false,
      originalValue: "VALIYEVICH",
      value: null,
    });
    expect(
      result.fields.find((field) => field.name === "firstNameLatin")?.value,
    ).toBe("ALI");
  });
  it("does not expose optional passport OCR observations without the OCR-details right", async () => {
    const { row, reads, principal } = fixture();
    Object.assign(row.document, {
      documentType: { code: "PASSPORT", erpUid: null },
      candidate: { chatUuid: null, citizenship: "uz" },
    });
    row.ocrFields.push({
      ...row.ocrFields[0],
      name: "pas_patronymic",
      documentFieldName: null,
      value: "VALIYEVICH",
    });
    const result = await reads.version(
      "document",
      4,
      principal({ "20011": [] }),
    );
    expect(
      result.fields.find((field) => field.name === "middleNameLatin"),
    ).toMatchObject({ reviewVisible: true, originalValue: null, regions: [] });
    expect(
      result.ocrFields.some((field) => field.name === "pas_patronymic"),
    ).toBe(false);
  });
  it("allows a number to be entered when an existing IG passport has no number field", async () => {
    const { row, reads } = fixture();
    Object.assign(row.document, {
      documentType: { code: "PASSPORT", erpUid: null },
      candidate: { chatUuid: null, citizenship: "uz" },
    });
    const result = await reads.version("document", 4);
    expect(
      result.fields.find((field) => field.name === "number"),
    ).toMatchObject({ required: true, value: null, kind: "text" });
  });
  it.each([
    [
      { code: "PASSPORT", erpUid: null },
      { chatUuid: "chat", citizenship: "uz" },
    ],
    [
      { code: "MIGRATION_CARD", erpUid: null },
      { chatUuid: null, citizenship: "uz" },
    ],
  ])(
    "preserves catalog requirements for other review groups and documents",
    async (documentType, candidate) => {
      const { row, reads } = fixture();
      Object.assign(row.document, { documentType, candidate });
      const result = await reads.version("document", 4);
      expect(result.fields.map((field) => field.required)).toEqual([
        true,
        false,
      ]);
    },
  );
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
      expect(result.raw).toEqual(
        rule === "20009" ? { allFields: "PROTECTED" } : null,
      );
    },
  );

  it("redacts technical ERP and worker diagnostics but retains business status", async () => {
    const { reads, row, principal } = fixture();
    Object.assign(row, {
      job: {
        id: "private-job",
        status: "FAILED",
        errorCode: "PRIVATE",
        cleanupPending: true,
      },
      delivery: {
        status: "REQUIRES_MANUAL",
        errorCode: "PRIVATE",
        attempts: [
          {
            id: "private-attempt",
            actorId: "private-actor",
            startedAt: new Date(),
            finishedAt: null,
            responseBody: "PRIVATE",
            httpStatus: 500,
          },
        ],
      },
    });
    const reviewer = await reads.publicVersion(
      "document",
      4,
      principal({ "20002": [] }),
    );
    expect(reviewer.job).toBeNull();
    expect(reviewer.delivery).toEqual({
      status: "REQUIRES_MANUAL",
      errorCode: null,
      errorReason: null,
      attempts: [],
    });
    const admin = await reads.publicVersion(
      "document",
      4,
      principal({ "20009": [] }),
    );
    expect(admin.job?.id).toBe("private-job");
    expect(admin.delivery?.attempts[0].responseBody).toBe("PRIVATE");
  });

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
