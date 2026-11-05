import { describe, expect, it, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
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
  let syncStateRow: {
    id: string;
    cursor: string | null;
    completedAt: Date | null;
    updatedAt: Date;
  } | null = null;
  const prisma = {
    igArrivalIssue: {
      createMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    igArrivalPerson: {
      findMany: vi.fn(async () => [] as unknown[]),
      updateMany,
    },
    igArrivalSyncState: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "singleton") return syncStateRow;
        return null;
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { id: string };
          create: {
            id: string;
            cursor?: string | null;
            completedAt?: Date | null;
          };
          update: { cursor?: string | null; completedAt?: Date | null };
        }) => {
          if (!syncStateRow) {
            syncStateRow = {
              id: where.id,
              cursor: create.cursor ?? null,
              completedAt: create.completedAt ?? null,
              updatedAt: new Date(),
            };
          } else {
            syncStateRow = {
              ...syncStateRow,
              ...(update.cursor !== undefined ? { cursor: update.cursor } : {}),
              ...(update.completedAt !== undefined
                ? { completedAt: update.completedAt }
                : {}),
              updatedAt: new Date(),
            };
          }
          return syncStateRow;
        },
      ),
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
  return {
    erp,
    projection,
    prisma,
    worker,
    audit,
    getSyncState: () => syncStateRow,
    setSyncState: (row: typeof syncStateRow) => {
      syncStateRow = row;
    },
  };
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

  it("continues from saved cursor when page limit is reached", async () => {
    const { erp, worker, prisma, getSyncState } = fixture();
    erp.arrivalPage.mockImplementation(
      async (_limit: number, cursor?: string) => {
        const idx = cursor ? parseInt(cursor.replace("cursor-", ""), 10) : 0;
        return {
          items: [value],
          nextCursor: `cursor-${idx + 1}`,
        };
      },
    );

    await worker.sync();
    expect(erp.arrivalPage).toHaveBeenCalledTimes(100);
    expect(prisma.igArrivalSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "singleton" },
        update: expect.objectContaining({ cursor: "cursor-100" }),
      }),
    );
    expect(getSyncState()?.cursor).toBe("cursor-100");

    // Next sync tick: should resume from cursor-100
    erp.arrivalPage.mockClear();
    erp.arrivalPage.mockResolvedValueOnce({
      items: [value],
      nextCursor: null,
    });

    await worker.sync();
    expect(erp.arrivalPage).toHaveBeenCalledWith(100, "cursor-100");
  });

  it("continues from saved cursor when time limit (deadline) is reached", async () => {
    const { erp, worker, prisma, getSyncState } = fixture();
    let now = 1000000;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);

    erp.arrivalPage.mockImplementation(
      async (_limit: number, cursor?: string) => {
        const idx = cursor
          ? parseInt(cursor.replace("time-cursor-", ""), 10)
          : 0;
        if (idx === 1) {
          now += 300_001;
        }
        return {
          items: [value],
          nextCursor: `time-cursor-${idx + 1}`,
        };
      },
    );

    try {
      await worker.sync();
      expect(prisma.igArrivalSyncState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "singleton" },
          update: expect.objectContaining({ cursor: "time-cursor-1" }),
        }),
      );
      expect(getSyncState()?.cursor).toBe("time-cursor-1");

      // Next tick resumes from time-cursor-1
      erp.arrivalPage.mockClear();
      erp.arrivalPage.mockResolvedValueOnce({
        items: [value],
        nextCursor: null,
      });

      await worker.sync();
      expect(erp.arrivalPage).toHaveBeenCalledWith(100, "time-cursor-1");
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("resets cursor to null and sets completedAt when stream end is reached", async () => {
    const { erp, worker, prisma, setSyncState, getSyncState } = fixture();
    setSyncState({
      id: "singleton",
      cursor: "existing-cursor",
      completedAt: null,
      updatedAt: new Date(),
    });

    erp.arrivalPage.mockResolvedValueOnce({
      items: [value],
      nextCursor: null,
    });

    await worker.sync();
    expect(erp.arrivalPage).toHaveBeenCalledWith(100, "existing-cursor");
    expect(prisma.igArrivalSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "singleton" },
        create: expect.objectContaining({
          cursor: null,
          completedAt: expect.any(Date),
        }),
        update: expect.objectContaining({
          cursor: null,
          completedAt: expect.any(Date),
        }),
      }),
    );
    expect(getSyncState()?.cursor).toBeNull();
    expect(getSyncState()?.completedAt).toBeInstanceOf(Date);

    // Next sync starts from beginning (undefined cursor)
    erp.arrivalPage.mockClear();
    erp.arrivalPage.mockResolvedValueOnce({
      items: [value],
      nextCursor: null,
    });
    await worker.sync();
    expect(erp.arrivalPage).toHaveBeenCalledWith(100, undefined);
  });

  it("catches INVALID_CURSOR error, resets saved cursor in db to null, and restarts from beginning", async () => {
    const { erp, worker, prisma, setSyncState, projection } = fixture();
    setSyncState({
      id: "singleton",
      cursor: "stale-cursor-400",
      completedAt: null,
      updatedAt: new Date(),
    });

    erp.arrivalPage.mockImplementation(
      async (_limit: number, cursor?: string) => {
        if (cursor === "stale-cursor-400") {
          throw new BadRequestException("INVALID_CURSOR");
        }
        return {
          items: [value],
          nextCursor: null,
        };
      },
    );

    await worker.sync();

    expect(erp.arrivalPage).toHaveBeenNthCalledWith(1, 100, "stale-cursor-400");
    expect(erp.arrivalPage).toHaveBeenNthCalledWith(2, 100, undefined);

    expect(prisma.igArrivalSyncState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "singleton" },
        update: expect.objectContaining({ cursor: null }),
      }),
    );
    expect(projection.apply).toHaveBeenCalledWith(value);
  });
});
