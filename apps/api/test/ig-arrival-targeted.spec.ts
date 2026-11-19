import { expect, it, vi } from "vitest";
import { IgArrivalFactsProjectionService } from "../src/documents/ig-arrival-facts-projection.service";
it("rejects incomplete targeted snapshots before changing arrival facts", async () => {
  const prisma = { $transaction: vi.fn() };
  const service = new IgArrivalFactsProjectionService(
    prisma as any,
    {} as any,
    { identity: vi.fn() } as any,
  );
  await expect(
    service.applyTargeted(
      {
        personUid: "11111111-1111-4111-8111-111111111111",
        code1c: "IG",
        participations: [],
      },
      {
        recipientType: "person",
        reviewGroup: "IG",
        personUid: "11111111-1111-4111-8111-111111111111",
        code1C: "IG",
        erpUid: null,
        chatUuid: null,
      },
      false,
    ),
  ).rejects.toThrow("ARRIVAL_SNAPSHOT_INCOMPLETE");
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it("does not create a person for an unknown authoritative deletion", async () => {
  const prisma = {
    igArrivalPerson: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(),
  };
  const service = new IgArrivalFactsProjectionService(
    prisma as any,
    {} as any,
    {} as any,
  );
  await service.applyTargetedDeletion("11111111-1111-4111-8111-111111111111");
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
it("rejects a tombstone when stored identity is not verified", async () => {
  const prisma = {
    igArrivalPerson: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ code1c: "IG", igVerified: false }),
    },
    $transaction: vi.fn(),
  };
  const service = new IgArrivalFactsProjectionService(
    prisma as any,
    {} as any,
    {} as any,
  );
  await expect(
    service.applyTargetedDeletion("11111111-1111-4111-8111-111111111111"),
  ).rejects.toThrow("ERP_PERSON_IDENTITY_UNAVAILABLE");
  expect(prisma.$transaction).not.toHaveBeenCalled();
});
