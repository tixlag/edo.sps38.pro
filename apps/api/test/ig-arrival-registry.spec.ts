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
          .mockResolvedValue({ completedAt: new Date("2026-11-01T00:00:00Z") }),
      },
    };
    const service = new IgArrivalRegistryService(prisma as never);
    await expect(
      service.groups({ accessRules: { "20011": [] } } as never, {}),
    ).resolves.toEqual({
      items: [],
      nextCursor: null,
      sync: { lastCompletedAt: "2026-11-01T00:00:00.000Z" },
    });
  });
});
