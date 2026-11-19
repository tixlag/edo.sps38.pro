import { expect, it } from "vitest";
import { uniquePreviousDocumentSourceIds } from "../src/documents/candidate-previous-documents-sync.service";
it("keeps real ERP IDs distinct from generated duplicate suffixes", () => {
  const rows = uniquePreviousDocumentSourceIds([
    { id: "A" },
    { id: "A" },
    { id: "A#2" },
  ]);
  expect(new Set(rows.map((row) => row.id)).size).toBe(3);
  expect(rows[2].id).toBe("A#2");
});

it("retains ERP person ownership metadata in a document snapshot", async () => {
  const { previousDocumentsSchema } =
    await import("../src/documents/erp-workspace.client");
  const personUid = "11111111-1111-4111-8111-111111111111";
  const result = previousDocumentsSchema.parse({
    items: [
      {
        id: "a",
        personUid,
        documentUid: null,
        title: "Document",
        fields: {},
        expiresAt: null,
        originalAvailable: false,
        recheckStatus: "ORIGINAL_UNAVAILABLE",
      },
    ],
  });
  expect(result.items[0]).toHaveProperty("personUid", personUid);
});

it("uses the candidate link captured at the latest RU snapshot to guard owner access", async () => {
  const { previousDocumentAccessible } =
    await import("../src/documents/previous-document-owner");
  const doc = {
    sourceId: "passport",
    sourceErpId: "passport",
    sourcePersonUid: "erp-person",
    sourceCandidatePersonUid: null,
  };
  expect(
    previousDocumentAccessible(doc, {
      reviewGroup: "RU",
      personUid: null,
      chatUuid: null,
      citizenship: "ru",
    }),
  ).toBe(true);
  expect(
    previousDocumentAccessible(doc, {
      reviewGroup: "RU",
      personUid: "new-person",
      chatUuid: null,
      citizenship: "ru",
    }),
  ).toBe(false);
  expect(
    previousDocumentAccessible(doc, {
      reviewGroup: "IG",
      personUid: "new-person",
      chatUuid: null,
      citizenship: "uz",
    }),
  ).toBe(false);
});
