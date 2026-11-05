import { describe, expect, it, vi } from "vitest";
import { IgArrivalQueueService } from "../src/documents/ig-arrival-queue.service";
const principal = (rules: Record<string, unknown>) =>
  ({ uuid: "reviewer", accessRules: rules }) as never;
describe("IG arrival grouped queue", () => {
  it("requires IG review and does not use location grants as review rights", async () => {
    const db = { $queryRaw: vi.fn() };
    const service = new IgArrivalQueueService(db as never);
    await expect(
      service.groups(principal({ "20007": [1] }), {}),
    ).rejects.toThrow();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
  it("returns bounded summaries to IG reviewer with no location rights", async () => {
    const db = {
      $queryRaw: vi.fn(async () => [
        {
          arrivalDate: "2026-11-05",
          locationUid: "00000000-0000-4000-8000-000000000002",
          locationName: "Object",
          total: 2n,
          approved: 1n,
          confirmed: 0n,
          issues: 0n,
          waitingDocuments: 2n,
          inReview: 0n,
          returned: 0n,
          completed: 0n,
          sending: 0n,
          needsAttention: 0n,
        },
      ]),
    };
    const service = new IgArrivalQueueService(db as never);
    const result = await service.groups(principal({ "20011": [] }), {
      limit: 1,
    });
    expect(result.items).toEqual([
      {
        group: "assigned",
        arrivalDate: "2026-11-05",
        locationUid: "00000000-0000-4000-8000-000000000002",
        locationName: "Object",
        total: 2,
        approved: 1,
        confirmed: 0,
        issues: 0,
        waitingDocuments: 2,
        inReview: 0,
        returned: 0,
        completed: 0,
        sending: 0,
        needsAttention: 0,
      },
    ]);
  });
  it("requires a complete calendar and location key for assigned people", async () => {
    const service = new IgArrivalQueueService({ $queryRaw: vi.fn() } as never);
    await expect(
      service.people(principal({ "20009": [] }), {
        group: "assigned",
        arrivalDate: "2026-02-30",
        locationUid: "00000000-0000-4000-8000-000000000002",
      }),
    ).rejects.toThrow();
  });
});
