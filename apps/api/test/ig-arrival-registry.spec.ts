import { describe, expect, it, vi } from "vitest";
import { IgArrivalRegistryService } from "../src/documents/ig-arrival-registry.service";

describe("IG arrival registry", () => {
  it("rejects an IG registry request without IG review permission", async () => {
    const service = new IgArrivalRegistryService({} as never);
    await expect(
      service.groups({ accessRules: {} } as never, {}),
    ).rejects.toThrow();
  });
  it("rejects RU-only and audit-only grants on every registry endpoint", async () => {
    const service = new IgArrivalRegistryService({} as never);
    for (const accessRules of [
      { "20002": [] },
      { "20003": [] },
      { "20008": [] },
    ]) {
      const principal = { accessRules } as never;
      await expect(service.groups(principal, {})).rejects.toThrow();
      await expect(
        service.participations(principal, { groupKey: "issues" }),
      ).rejects.toThrow();
      await expect(service.locations(principal, {})).rejects.toThrow();
    }
  });
  it("rejects invalid dates, tokens and filters even without HTTP validation", async () => {
    const service = new IgArrivalRegistryService({} as never);
    const principal = { accessRules: { "20011": [] } } as never;
    await expect(
      service.groups(principal, { dateFrom: "2026-02-30" }),
    ).rejects.toThrow();
    await expect(
      service.groups(principal, { cursor: "garbage" }),
    ).rejects.toThrow();
    await expect(
      service.participations(principal, { groupKey: "garbage" }),
    ).rejects.toThrow();
  });
  it("returns an empty page with the last completed sync", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      igArrivalSyncState: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ completedAt: new Date("2026-11-01T00:00:00Z"), factsFinishedGeneration: 1n }),
      },
    };
    const service = new IgArrivalRegistryService(prisma as never);
    await expect(
      service.groups({ accessRules: { "20011": [] } } as never, {}),
    ).resolves.toEqual({
      items: [],
      nextCursor: null,
      sync: { status: "COMPLETE", lastCompletedAt: "2026-11-01T00:00:00.000Z" },
    });
  });
  it("triggers catalog refresh without blocking listing when integration fails", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      igArrivalSyncState: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const ensure = vi.fn().mockRejectedValue(new Error("offline"));
    const service = new IgArrivalRegistryService(
      prisma as never,
      { ensure } as never,
    );
    await expect(
      service.groups({ accessRules: { "20011": [] } } as never, {}),
    ).resolves.toMatchObject({ items: [] });
    expect(ensure).toHaveBeenCalledOnce();
  });
  it("maps candidate citizenship and positionName in participations", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          arrivalMemberUid: "member-1",
          personUid: "person-1",
          code1c: "code-1",
          candidateId: "cand-1",
          fullName: "Еленский Руслан",
          citizenship: "by",
          positionName: "Механик",
          arrivalDate: "2026-11-02",
          arrivalDateTime: "2026-11-02T00:00:00",
          locationUid: "loc-1",
          locationName: "Site",
          factIdentityIssue: null,
          latestSiteStatusCancelled: false,
          participationStatus: "CURRENT",
          personState: "CURRENT",
          documentStatus: "IN_PROGRESS",
          approvedDocuments: 0n,
          confirmedDocuments: 0n,
          erpDeliveryStatus: "NOT_REQUIRED",
          employmentStatus: "IN_PROGRESS",
          needsAttention: 0,
          issueCode: null,
          sourceRevision: 1n,
          requirementsKnown: 1,
          deliveryNeedsAttention: 0,
          requiredCount: 5n,
          presentCount: 2n,
          acceptedCount: 2n,
          reviewCount: 1n,
          returnedCount: 0n,
          missingCount: 3n,
          processingCount: 0n,
          attentionCount: 0n,
          reviewAvailable: 1n,
          requirementsAction: "REVIEW",
        },
      ]),
      igArrivalSyncState: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const service = new IgArrivalRegistryService(prisma as never);
    const result = await service.participations(
      { accessRules: { "20011": [] } } as never,
      { groupKey: "issues" },
    );
    expect(result.items[0]).toMatchObject({
      fullName: "Еленский Руслан",
      citizenship: "by",
      positionName: "Механик",
      requirements: { known: true, required: 5 },
      action: "REVIEW",
    });
  });
});
