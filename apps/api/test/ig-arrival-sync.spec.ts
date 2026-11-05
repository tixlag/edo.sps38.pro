import { describe, expect, it, vi } from "vitest";
import { IgArrivalSyncWorker } from "../src/documents/ig-arrival-sync.worker";
const personUid = "00000000-0000-4000-8000-000000000001",
  memberUid = "00000000-0000-4000-8000-000000000002";
const value = {
  personUid,
  code1c: "worker",
  revision: 1,
  state: "CURRENT",
  currentArrivalMemberUid: memberUid,
  participations: [
    {
      arrivalMemberUid: memberUid,
      arrivalDate: "2026-11-05",
      locationUid: null,
      locationCode1c: null,
      locationName: null,
      cancelled: false,
    },
  ],
};
function fixture() {
  const erp = {
    arrivalPage: vi.fn(async () => ({ items: [value], nextCursor: null })),
  };
  const projection = { apply: vi.fn(async () => true) };
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    igArrivalIssue: {
      createMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    igArrivalPerson: {
      findMany: vi.fn(async () => [] as unknown[]),
      updateMany,
    },
  };
  const transaction = vi.fn(
    async (fn: (value: typeof prisma) => Promise<unknown>) => fn(prisma),
  );
  Object.assign(prisma, { $transaction: transaction });
  const config = {
    get: (key: string) =>
      ({
        EDO_ARRIVAL_SYNC_ENABLED: "true",
        EDO_ARRIVAL_CONTEXTS_URL:
          "http://127.0.0.1:1/surveys-service/api/internal/edo/arrival-contexts",
        EDO_ADAPTATION_SYNC_TOKEN: "test",
        NODE_ENV: "test",
      })[key],
  };
  const audit = { logInTransaction: vi.fn(async () => undefined) };
  const worker = new IgArrivalSyncWorker(
    prisma as never,
    erp as never,
    projection as never,
    config as never,
    audit as never,
  );
  return { erp, projection, prisma, worker, audit };
}
describe("IG arrival synchronization", () => {
  it("continues valid people after an invalid source item and never archives missing people", async () => {
    const { erp, projection, worker } = fixture();
    erp.arrivalPage.mockResolvedValueOnce({
      items: [{ ...value, revision: 0 }, value],
      nextCursor: null,
    } as never);
    await worker.sync();
    expect(projection.apply).toHaveBeenCalledTimes(1);
    expect(projection.apply).toHaveBeenCalledWith(value);
  });
  it("does not clear a newer diagnostic when a stale state is replayed", async () => {
    const { worker, projection, prisma } = fixture();
    projection.apply.mockResolvedValueOnce(false as never);
    await worker.sync();
    expect(prisma.igArrivalIssue.updateMany).not.toHaveBeenCalled();
  });
  it("records source issues without personal data and keeps valid records", async () => {
    const { erp, projection, worker, audit } = fixture();
    erp.arrivalPage.mockResolvedValueOnce({
      items: [value],
      nextCursor: null,
      issues: [{ personUid, code: "SOURCE_INVALID" }],
    } as never);
    await worker.sync();
    expect(projection.apply).toHaveBeenCalledOnce();
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ after: { codes: ["SOURCE_INVALID"] } }),
    );
    expect(JSON.stringify(audit.logInTransaction.mock.calls)).not.toContain(
      personUid,
    );
  });
  it("records a person conflict and continues with the next valid person", async () => {
    const { erp, projection, worker, prisma, audit } = fixture();
    const next = {
      ...value,
      personUid: "00000000-0000-4000-8000-000000000009",
      code1c: "other",
    };
    erp.arrivalPage.mockResolvedValueOnce({
      items: [value, next],
      nextCursor: null,
    });
    projection.apply.mockRejectedValueOnce(
      new Error("ARRIVAL_MEMBER_OWNER_CONFLICT"),
    );
    await worker.sync();
    expect(projection.apply).toHaveBeenCalledTimes(2);
    expect(prisma.igArrivalIssue.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            code: "ARRIVAL_MEMBER_OWNER_CONFLICT",
            revision: 1n,
          }),
        ],
      }),
    );
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        after: { codes: ["ARRIVAL_MEMBER_OWNER_CONFLICT"] },
      }),
    );
  });
  it("persists acknowledgement only for exact revision and receipt", async () => {
    const { prisma, worker } = fixture();
    prisma.igArrivalPerson.findMany.mockResolvedValue([
      { personUid, revision: 1n, sourceHash: "hash", sourcePayload: value },
    ] as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              personUid,
              revision: 1,
              state: "CURRENT",
              currentArrivalMemberUid: memberUid,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    try {
      await worker.sync();
      expect(prisma.igArrivalPerson.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            personUid,
            revision: 1n,
            sourceHash: "hash",
          }),
          data: expect.objectContaining({
            syncPending: false,
            syncedRevision: 1n,
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("forwards the unchanged source snapshot with its revision", async () => {
    const { prisma, worker } = fixture();
    prisma.igArrivalPerson.findMany.mockResolvedValue([
      { personUid, revision: 1n, sourceHash: "hash", sourcePayload: value },
    ] as never);
    const sender = vi.fn(
      async (_url: unknown, _options: { body?: string }) =>
        new Response(
          JSON.stringify({
            personUid,
            revision: 1,
            state: "CURRENT",
            currentArrivalMemberUid: memberUid,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", sender);
    try {
      await worker.sync();
      expect(sender.mock.calls[0][1].body).toBe(JSON.stringify(value));
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("leaves delivery pending when receipt conflicts", async () => {
    const { prisma, worker } = fixture();
    prisma.igArrivalPerson.findMany.mockResolvedValue([
      { personUid, revision: 1n, sourceHash: "hash", sourcePayload: value },
    ] as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              personUid,
              revision: 2,
              state: "CURRENT",
              currentArrivalMemberUid: memberUid,
            }),
            { status: 200 },
          ),
      ),
    );
    try {
      await worker.sync();
      expect(prisma.igArrivalPerson.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ syncPending: false }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
