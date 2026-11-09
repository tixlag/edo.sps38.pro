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
function fixture(customConfig?: Record<string, string | undefined>) {
  const erp = {
    arrivalPage: vi.fn(async () => ({ items: [value], nextCursor: null })),
  };
  const projection = { apply: vi.fn(async () => true) };
  const updateMany = vi.fn(async () => ({ count: 1 }));
  let factsFinishedGeneration: bigint | null = 1n;
  let syncStateRow: {
    id: string;
    cursor: string | null;
    completedAt: Date | null;
    lockToken: string | null;
    lockExpiresAt: Date | null;
    generation: bigint;
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
        if (where.id === "singleton" && syncStateRow)
          return { ...syncStateRow, factsFinishedGeneration };
        return null;
      }),
      create: vi.fn(async ({ data }: { data: any }) => {
        syncStateRow = {
          id: data.id,
          cursor: data.cursor ?? null,
          completedAt: data.completedAt ?? null,
          lockToken: data.lockToken ?? null,
          lockExpiresAt: data.lockExpiresAt ?? null,
          generation: BigInt(data.generation ?? 0n),
          updatedAt: new Date(),
        };
        return syncStateRow;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: any; data: any }) => {
          if (!syncStateRow || syncStateRow.id !== where.id) {
            return { count: 0 };
          }
          if (
            where.generation !== undefined &&
            syncStateRow.generation !== BigInt(where.generation)
          ) {
            return { count: 0 };
          }
          if (
            where.lockToken !== undefined &&
            syncStateRow.lockToken !== where.lockToken
          ) {
            return { count: 0 };
          }
          syncStateRow = {
            ...syncStateRow,
            ...(data.cursor !== undefined ? { cursor: data.cursor } : {}),
            ...(data.completedAt !== undefined
              ? { completedAt: data.completedAt }
              : {}),
            ...(data.lockToken !== undefined
              ? { lockToken: data.lockToken }
              : {}),
            ...(data.lockExpiresAt !== undefined
              ? { lockExpiresAt: data.lockExpiresAt }
              : {}),
            ...(data.generation !== undefined
              ? { generation: BigInt(data.generation) }
              : {}),
            updatedAt: new Date(),
          };
          return { count: 1 };
        },
      ),
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
              lockToken: null,
              lockExpiresAt: null,
              generation: 0n,
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
    get: (key: string) => {
      const merged: Record<string, string | undefined> = {
        EDO_ARRIVAL_SYNC_ENABLED: "true",
        EDO_ARRIVAL_CONTEXTS_URL:
          "http://127.0.0.1:1/surveys-service/api/internal/edo/arrival-contexts",
        EDO_ADAPTATION_SYNC_TOKEN: "test",
        NODE_ENV: "test",
        ...customConfig,
      };
      return merged[key];
    },
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
    setFactsFinishedGeneration: (generation: bigint | null) => {
      factsFinishedGeneration = generation;
    },
  };
}
describe("IG arrival synchronization", () => {
  it("does not deliver before a complete facts scan", async () => {
    const { worker, prisma, setFactsFinishedGeneration } = fixture();
    setFactsFinishedGeneration(null);
    const sender = vi.fn();
    vi.stubGlobal("fetch", sender);
    try {
      await worker.sync();
      expect(prisma.igArrivalPerson.findMany).not.toHaveBeenCalled();
      expect(sender).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
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
      expect(prisma.igArrivalPerson.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ factsSeenGeneration: { lte: 1n } }),
        }),
      );
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
    expect(prisma.igArrivalSyncState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "singleton" }),
        data: expect.objectContaining({ cursor: "cursor-100" }),
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
      expect(prisma.igArrivalSyncState.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "singleton" }),
          data: expect.objectContaining({ cursor: "time-cursor-1" }),
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
      lockToken: null,
      lockExpiresAt: null,
      generation: 0n,
      updatedAt: new Date(),
    });

    erp.arrivalPage.mockResolvedValueOnce({
      items: [value],
      nextCursor: null,
    });

    await worker.sync();
    expect(erp.arrivalPage).toHaveBeenCalledWith(100, "existing-cursor");
    expect(prisma.igArrivalSyncState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "singleton" }),
        data: expect.objectContaining({
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
      lockToken: null,
      lockExpiresAt: null,
      generation: 0n,
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

    expect(prisma.igArrivalSyncState.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "singleton" }),
        data: expect.objectContaining({ cursor: null }),
      }),
    );
    expect(projection.apply).toHaveBeenCalledWith(value);
  });

  it("skips run when lease is held by another worker", async () => {
    const { erp, worker, setSyncState } = fixture();
    setSyncState({
      id: "singleton",
      cursor: "cursor-active",
      completedAt: null,
      lockToken: "other-worker-token",
      lockExpiresAt: new Date(Date.now() + 60_000),
      generation: 1n,
      updatedAt: new Date(),
    });

    await worker.sync();
    expect(erp.arrivalPage).not.toHaveBeenCalled();
  });

  it("rejects cursor write when lease was stolen and generation bumped", async () => {
    const { erp, worker, setSyncState, getSyncState } = fixture();
    setSyncState({
      id: "singleton",
      cursor: "cursor-1",
      completedAt: null,
      lockToken: null,
      lockExpiresAt: null,
      generation: 1n,
      updatedAt: new Date(),
    });

    erp.arrivalPage.mockImplementation(async () => {
      setSyncState({
        id: "singleton",
        cursor: "cursor-stolen",
        completedAt: null,
        lockToken: "new-winner-token",
        lockExpiresAt: new Date(Date.now() + 100_000),
        generation: 3n,
        updatedAt: new Date(),
      });
      return { items: [value], nextCursor: null };
    });

    await worker.sync();
    expect(getSyncState()?.cursor).toBe("cursor-stolen");
    expect(getSyncState()?.generation).toBe(3n);
  });

  describe("FIX-07: surveys decoupling", () => {
    it("imports arrivals from ERP when surveys is completely unconfigured", async () => {
      const { erp, projection, worker, prisma } = fixture({
        EDO_ARRIVAL_CONTEXTS_URL: undefined,
        EDO_ADAPTATION_SYNC_TOKEN: undefined,
      });

      await expect(worker.sync()).resolves.toBeUndefined();
      expect(erp.arrivalPage).toHaveBeenCalledTimes(1);
      expect(projection.apply).toHaveBeenCalledWith(value);
      // No surveys fetch attempt made, no rows updated by delivery
      expect(prisma.igArrivalPerson.findMany).not.toHaveBeenCalled();
    });

    it("continues importing from ERP when surveys delivery encounters network error", async () => {
      const { erp, projection, worker, prisma } = fixture();
      prisma.igArrivalPerson.findMany.mockResolvedValueOnce([
        { personUid, revision: 1n, sourceHash: "hash", sourcePayload: value },
      ] as never);

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("Connection refused (ECONNREFUSED)");
        }),
      );

      try {
        await expect(worker.sync()).resolves.toBeUndefined();
        expect(erp.arrivalPage).toHaveBeenCalledTimes(1);
        expect(projection.apply).toHaveBeenCalledWith(value);
        expect(prisma.igArrivalPerson.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ personUid, revision: 1n }),
            data: { syncError: "ARRIVAL_SURVEYS_UNCONFIRMED" },
          }),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("breaks delivery loop without blocking ERP import when surveys returns HTTP 500", async () => {
      const { erp, projection, worker, prisma } = fixture();
      prisma.igArrivalPerson.findMany.mockResolvedValueOnce([
        { personUid, revision: 1n, sourceHash: "hash", sourcePayload: value },
        {
          personUid: "00000000-0000-4000-8000-000000000099",
          revision: 1n,
          sourceHash: "hash2",
          sourcePayload: { ...value, personUid: "00000000-0000-4000-8000-000000000099" },
        },
      ] as never);

      const fetchMock = vi.fn(
        async () => new Response("Internal Server Error", { status: 500 }),
      );
      vi.stubGlobal("fetch", fetchMock);

      try {
        await expect(worker.sync()).resolves.toBeUndefined();
        expect(erp.arrivalPage).toHaveBeenCalledTimes(1);
        expect(projection.apply).toHaveBeenCalledWith(value);
        // Only 1 attempt made before breaking out of the delivery loop on 500
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(prisma.igArrivalPerson.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ personUid, revision: 1n }),
            data: { syncError: "ARRIVAL_SURVEYS_UNCONFIRMED" },
          }),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("clears syncError and marks syncPending false once surveys recovers", async () => {
      const { worker, prisma } = fixture();
      prisma.igArrivalPerson.findMany.mockResolvedValueOnce([
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
            where: expect.objectContaining({ personUid, revision: 1n }),
            data: {
              syncPending: false,
              syncedRevision: 1n,
              syncError: null,
            },
          }),
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("safely skips delivery and completes ERP sync if surveys URL is invalid", async () => {
      const { erp, projection, worker, prisma } = fixture({
        EDO_ARRIVAL_CONTEXTS_URL: "http://example.test/invalid/path",
      });

      await expect(worker.sync()).resolves.toBeUndefined();
      expect(erp.arrivalPage).toHaveBeenCalledTimes(1);
      expect(projection.apply).toHaveBeenCalledWith(value);
      expect(prisma.igArrivalPerson.findMany).not.toHaveBeenCalled();
    });
  });
});
