import { describe, expect, it, vi } from "vitest";
import { resolveCandidateIdentity } from "../src/documents/candidate-identity";

const erpUid = "11111111-1111-4111-8111-111111111111";
const chatUuid = "22222222-2222-4222-8222-222222222222";
const card = (values: Record<string, unknown>) => ({
  personUid: null,
  reviewGroup: "RU",
  _count: { documents: 0, previousDocuments: 0 },
  ...values,
});

function fixture(
  ghost: Record<string, unknown>,
  real: Record<string, unknown>,
) {
  const candidate = {
    findMany: vi.fn(async () => [
      card({ id: "catalog", erpUid, chatUuid: null, ...ghost }),
      card({ id: "existing", erpUid: null, chatUuid, ...real }),
    ]),
    delete: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
  };
  return { candidate, $queryRaw: vi.fn(async () => []) };
}

describe("existing candidate projection preservation", () => {
  it.each([
    [{ _count: { documents: 0, previousDocuments: 1 } }, {}],
    [{}, { erpUid: "33333333-3333-4333-8333-333333333333" }],
    [{}, { reviewGroup: "IG" }],
    [
      { personUid: "44444444-4444-4444-8444-444444444444" },
      { personUid: "55555555-5555-4555-8555-555555555555" },
    ],
  ])(
    "refuses ambiguous projection reconciliation without deleting document history: %j",
    async (ghost, real) => {
      const tx = fixture(ghost, real);
      await expect(
        resolveCandidateIdentity(tx as never, {
          identityKey: `erp:${erpUid}`,
          erpUid,
          chatUuid,
          reviewGroup: "RU",
        }),
      ).rejects.toThrow("CANDIDATE_IDENTITY_CONFLICT");
      expect(tx.candidate.delete).not.toHaveBeenCalled();
      expect(tx.candidate.update).not.toHaveBeenCalled();
    },
  );
});
