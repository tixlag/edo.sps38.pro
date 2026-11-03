import { describe, expect, it, vi } from "vitest";
import {
  igRequiredDocumentsComplete,
  tryCompleteIgEmployment,
  usablePreviousUids,
} from "../src/documents/ig-completion";
import { EMPLOYMENT_PATENT_UID } from "../src/documents/reemployment-document-policy";
import { MIGRATION_UID } from "../src/ocr/ocr-profile";

describe("IG completion", () => {
  const types = [
    { id: "migration", erpUid: MIGRATION_UID },
    { id: "patent", erpUid: EMPLOYMENT_PATENT_UID },
    { id: "passport", erpUid: "6ffb1fd5-8341-11eb-ba8b-00259002db81" },
  ];
  it("requires fresh approved migration and patent even when old copies were confirmed", () => {
    const documents = [
      { documentTypeId: "migration", status: "APPROVED" },
      { documentTypeId: "passport", status: "APPROVED" },
    ];
    expect(
      igRequiredDocumentsComplete(types, documents, [EMPLOYMENT_PATENT_UID]),
    ).toBe(false);
    expect(
      igRequiredDocumentsComplete(
        types,
        [...documents, { documentTypeId: "patent", status: "APPROVED" }],
        [],
      ),
    ).toBe(true);
  });
  it("does not complete with an unavailable mandatory catalog type", () => {
    expect(
      igRequiredDocumentsComplete(
        types.slice(0, 1),
        [{ documentTypeId: "migration", status: "APPROVED" }],
        [],
      ),
    ).toBe(false);
  });
  it("allows a checked historical ordinary document", () => {
    expect(
      igRequiredDocumentsComplete(
        types,
        [
          { documentTypeId: "migration", status: "APPROVED" },
          { documentTypeId: "patent", status: "APPROVED" },
        ],
        [types[2].erpUid],
      ),
    ).toBe(true);
  });
  it("does not hide an unfinished replacement behind an older confirmed document", () => {
    expect(
      igRequiredDocumentsComplete(
        types,
        [
          { documentTypeId: "migration", status: "APPROVED" },
          { documentTypeId: "patent", status: "APPROVED" },
          { documentTypeId: "passport", status: "RETURNED" },
        ],
        [types[2].erpUid],
      ),
    ).toBe(false);
  });
  it("excludes old patents, expired and invalid records from reusable documents", () => {
    expect(
      usablePreviousUids([
        { documentUid: EMPLOYMENT_PATENT_UID, expiresAt: null, fields: {} },
        {
          documentUid: "expired",
          expiresAt: new Date("2000-01-01T00:00:00Z"),
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
  it("records completion and its audit together after all required documents are approved", async () => {
    const candidate = {
      id: "current",
      igCompletedAt: null,
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
        findMany: vi
          .fn()
          .mockResolvedValue(
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
          .mockResolvedValue(
            types.map((type) => ({
              documentTypeId: type.id,
              status: "APPROVED",
            })),
          ),
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
      data: { igCompletedAt: expect.any(Date) },
    });
    expect(audit.logInTransaction).toHaveBeenCalled();
  });
});
