import { describe, expect, it } from "vitest";
import type { CandidatePreviousDocument } from "@prisma/client";
import {
  previousDocumentAvailability,
  previousDocumentState,
} from "../src/documents/previous-document-availability";
import { MIGRATION_UID } from "../src/ocr/ocr-profile";

const previous = (patch: Partial<CandidatePreviousDocument> = {}) => ({
  id: "old",
  documentUid: "PASSPORT-UID",
  status: "CONFIRMED" as const,
  fields: { recordDate: "2025-10-12" },
  expiresAt: new Date("2100-01-01"),
  originalAvailable: true,
  reviewedAt: new Date("2026-01-01"),
  ...patch,
});
const types = [
  {
    code: "PASSPORT",
    title: "Паспорт",
    erpUid: "passport-uid",
    category: "required" as const,
  },
];

describe("previous employment document availability", () => {
  it("presents a confirmed former original as reused without creating a current document", () => {
    expect(previousDocumentAvailability(types, [previous()], [], true)).toEqual(
      [
        {
          id: "old",
          documentUid: "passport-uid",
          documentTypeCode: "PASSPORT",
          title: "Паспорт",
          category: "required",
          state: "REUSED",
          expiresAt: "2100-01-01",
          recordedAt: "2025-10-12",
          originalAvailable: true,
        },
      ],
    );
  });
  it("does not treat an expired, invalid, unreviewed or unavailable original as reused", () => {
    for (const [patch, state] of [
      [{ expiresAt: new Date("2000-01-01") }, "EXPIRED"],
      [{ fields: { isInvalid: true } }, "REPLACE_REQUIRED"],
      [{ status: "REQUIRES_REVIEW" }, "REQUIRES_REVIEW"],
      [{ originalAvailable: false }, "ORIGINAL_UNAVAILABLE"],
    ] as const)
      expect(previousDocumentState(previous(patch), true)).toBe(state);
  });
  it("retains the requirement for a fresh migration document on an IG arrival", () => {
    expect(
      previousDocumentState(previous({ documentUid: MIGRATION_UID }), true),
    ).toBe("REPLACE_REQUIRED");
  });
  it("shows only one best original and preserves a submitted current replacement", () => {
    const versions = [
      previous({
        id: "expired",
        expiresAt: new Date("2000-01-01"),
        reviewedAt: new Date("2026-06-01"),
      }),
      previous(),
    ];
    expect(
      previousDocumentAvailability(types, versions, [], false).map(
        (row) => row.id,
      ),
    ).toEqual(["old"]);
    expect(
      previousDocumentAvailability(
        types,
        versions,
        [{ documentType: { erpUid: "PASSPORT-UID" }, status: "RETURNED" }],
        false,
      ),
    ).toEqual([]);
    expect(
      previousDocumentAvailability(
        types,
        versions,
        [{ documentType: { erpUid: "passport-uid" }, status: "DRAFT" }],
        false,
      ),
    ).toHaveLength(1);
  });
  it("never matches unrelated types or invents a date of provision", () => {
    expect(
      previousDocumentAvailability(
        types,
        [previous({ documentUid: "other" })],
        [],
        true,
      ),
    ).toEqual([]);
    expect(
      previousDocumentAvailability(
        types,
        [previous({ fields: { recordDate: "2026-02-31" } })],
        [],
        true,
      )[0].recordedAt,
    ).toBeNull();
  });
});
