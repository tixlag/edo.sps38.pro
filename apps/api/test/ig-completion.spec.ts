import { describe, expect, it, vi } from "vitest";
import {
  igRequiredDocumentsComplete,
  tryCompleteIgEmployment,
  usablePreviousUids,
} from "../src/documents/ig-completion";
import { EMPLOYMENT_PATENT_UID } from "../src/documents/reemployment-document-policy";
import { MIGRATION_UID } from "../src/ocr/ocr-profile";

const receipt = () => ({
  receiptValidated: true,
  finishedAt: new Date(),
  errorCode: null,
});
const approved = (documentTypeId: string) => ({
  documentTypeId,
  status: "APPROVED",
  currentVersion: 1,
  versions: [
    {
      version: 1,
      status: "APPROVED",
      delivery: {
        status: "SENT",
        transport: "multipart-v2",
        attempts: [receipt()],
      },
    },
  ],
});
const types = [
  { id: "migration", erpUid: MIGRATION_UID },
  { id: "patent", erpUid: EMPLOYMENT_PATENT_UID },
  { id: "passport", erpUid: "6ffb1fd5-8341-11eb-ba8b-00259002db81" },
];
describe("IG completion", () => {
  it("keeps a reusable original while a new upload remains an unsubmitted draft", () => {
    expect(
      igRequiredDocumentsComplete(
        [types[2]],
        [{ ...approved("passport"), status: "DRAFT" }],
        [types[2].erpUid],
      ),
    ).toBe(true);
    expect(
      igRequiredDocumentsComplete(
        [types[2]],
        [{ ...approved("passport"), status: "IN_REVIEW" }],
        [types[2].erpUid],
      ),
    ).toBe(false);
  });
  it("requires confirmed latest version, not a stale or missing receipt", () => {
    const doc = approved("passport");
    doc.currentVersion = 2;
    expect(igRequiredDocumentsComplete([types[2]], [doc], [])).toBe(false);
    doc.versions.push({
      version: 2,
      status: "APPROVED",
      delivery: {
        status: "SENT",
        transport: "multipart-v2",
        attempts: [receipt()],
      },
    });
    expect(igRequiredDocumentsComplete([types[2]], [doc], [])).toBe(true);
    doc.versions[1].delivery.attempts[0].receiptValidated = false;
    expect(igRequiredDocumentsComplete([types[2]], [doc], [])).toBe(false);
    doc.versions[1].delivery.attempts = [];
    expect(igRequiredDocumentsComplete([types[2]], [doc], [])).toBe(false);
  });
  it("does not accept old patent or migration but permits a valid ordinary document", () => {
    expect(
      igRequiredDocumentsComplete(
        types,
        [approved("migration"), approved("patent")],
        [types[2].erpUid],
      ),
    ).toBe(true);
    expect(
      igRequiredDocumentsComplete(
        types,
        [approved("migration")],
        [EMPLOYMENT_PATENT_UID, types[2].erpUid],
      ),
    ).toBe(false);
    expect(
      igRequiredDocumentsComplete(
        types,
        [approved("patent")],
        [MIGRATION_UID, types[2].erpUid],
      ),
    ).toBe(false);
    expect(
      igRequiredDocumentsComplete(
        [types[2]],
        [{ ...approved("passport"), status: "RETURNED" }],
        [types[2].erpUid],
      ),
    ).toBe(false);
  });
  it("does not invent a mandatory patent or migration when ERP did not require them", () => {
    expect(
      igRequiredDocumentsComplete([types[2]], [approved("passport")], []),
    ).toBe(true);
  });
  it("excludes expired, invalid and fresh-only prior records", () => {
    expect(
      usablePreviousUids([
        { documentUid: EMPLOYMENT_PATENT_UID, expiresAt: null, fields: {} },
        {
          documentUid: "expired",
          expiresAt: new Date("2000-01-01"),
          fields: {},
        },
        {
          documentUid: "invalid",
          expiresAt: null,
          fields: { isInvalid: true },
        },
        { documentUid: "valid", expiresAt: null, fields: {} },
      ]),
    ).toEqual(["valid"]);
  });
  it("counts a previously confirmed registration original with unknown expiry", () => {
    const uid = "26b930ce-6462-11ec-80cc-002590854e7f";
    const previous = usablePreviousUids([
      { documentUid: uid, expiresAt: null, fields: {} },
    ]);
    expect(previous).toEqual([uid]);
    expect(
      igRequiredDocumentsComplete(
        [{ id: "registration", erpUid: uid }],
        [],
        previous,
      ),
    ).toBe(true);
  });
  it("blocks whole employment and records a catalog conflict when required patent or migration is absent", async () => {
    const candidate = {
      id: "current",
      igCompletedAt: null,
      igCompletionVerified: false,
      igRequirementsConflict: false,
      positionCode: "1",
      citizenship: "uz",
      sexKnown: false,
      projectCode: null,
    };
    const tx = {
      igEmploymentState: {
        findFirst: vi.fn().mockResolvedValue({ currentCandidate: candidate }),
      },
      documentType: {
        findMany: vi.fn().mockResolvedValue([
          {
            ...types[2],
            requiredForAll: true,
            allRu: false,
            allForeign: false,
            positions: [],
          },
        ]),
      },
      document: { findMany: vi.fn().mockResolvedValue([approved("passport")]) },
      candidatePreviousDocument: { findMany: vi.fn().mockResolvedValue([]) },
      candidate: { update: vi.fn() },
    };
    const audit = { logInTransaction: vi.fn() };
    await tryCompleteIgEmployment(
      tx as never,
      audit as never,
      "current",
      "reviewer",
      "request",
    );
    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: "current" },
      data: { igRequirementsConflict: true },
    });
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: expect.objectContaining({
          reason: "ERP_IG_REQUIREMENTS_CONFLICT",
        }),
      }),
    );
  });

  it.each(["by", "kz", "am", "kg"])("does not require an allForeign patent for %s", async (citizenship) => {
    const candidate = {
      id: "current",
      igCompletedAt: null,
      igCompletionVerified: false,
      igRequirementsConflict: true,
      positionCode: "1",
      citizenship,
      sexKnown: false,
      projectCode: null,
    };
    const tx = {
      igEmploymentState: {
        findFirst: vi.fn().mockResolvedValue({ currentCandidate: candidate }),
      },
      documentType: {
        findMany: vi.fn().mockResolvedValue([
          {
            ...types[1], // patent remains in the ERP catalog
            requiredForAll: false, allRu: false, allForeign: true, positions: [],
          },
          {
            ...types[0], // migration card
            requiredForAll: false,
            allRu: false,
            allForeign: true,
            positions: [],
          },
        ]),
      },
      document: { findMany: vi.fn().mockResolvedValue([approved("migration")]) },
      candidatePreviousDocument: { findMany: vi.fn().mockResolvedValue([]) },
      candidate: { update: vi.fn() },
    };
    const audit = { logInTransaction: vi.fn() };
    await tryCompleteIgEmployment(
      tx as never,
      audit as never,
      "current",
      "reviewer",
      "request",
    );
    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: "current" },
      data: { igRequirementsConflict: false },
    });
    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: "current" },
      data: {
        igCompletedAt: expect.any(Date),
        igCompletionVerified: true,
      },
    });
  });
  it("records completion and its audit atomically after valid receipts", async () => {
    const candidate = {
      id: "current",
      igCompletedAt: new Date("2026-01-01"),
      igCompletionVerified: false,
      positionCode: "1",
      citizenship: "uz",
      sexKnown: false,
      projectCode: null,
    };
    const tx = {
      igEmploymentState: {
        findFirst: vi.fn().mockResolvedValue({ currentCandidate: candidate }),
      },
      documentType: {
        findMany: vi.fn().mockResolvedValue(
          types.map((type) => ({
            ...type,
            requiredForAll: true,
            allRu: false,
            allForeign: false,
            positions: [],
          })),
        ),
      },
      document: {
        findMany: vi
          .fn()
          .mockResolvedValue(types.map((type) => approved(type.id))),
      },
      candidatePreviousDocument: { findMany: vi.fn().mockResolvedValue([]) },
      candidate: { update: vi.fn() },
    };
    const audit = { logInTransaction: vi.fn() };
    await tryCompleteIgEmployment(
      tx as never,
      audit as never,
      "current",
      "reviewer",
      "request",
    );
    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: "current" },
      data: { igCompletedAt: expect.any(Date), igCompletionVerified: true },
    });
    expect(audit.logInTransaction).toHaveBeenCalled();
    expect(tx.candidatePreviousDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ originalVerified: true }),
      }),
    );
  });
});

describe("ERP catalog owns applicability", () => {
  it("does not force patent into the requirements when ERP marks it inapplicable", async () => {
    const { requiredApplicable, applicable } =
      await import("../src/documents/document-contract");
    const type = {
      erpUid: EMPLOYMENT_PATENT_UID,
      requiredForAll: false,
      allRu: false,
      allForeign: false,
      positions: [],
    };
    expect(requiredApplicable(type, "other", "uz")).toBe(false);
    expect(applicable(type, "other", "uz")).toBe(false);
  });
});
