import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { IgArrivalProjectionService } from "../src/documents/ig-arrival-projection.service";
import { IgArrivalSyncWorker } from "../src/documents/ig-arrival-sync.worker";
const db = process.env.EDO_TEST_DATABASE_URL;
if (db && !db.startsWith("mysql://root:ig-isolated-test-20261105@127.0.0.1:"))
  throw new Error("Refuse non-task database");
describe.skipIf(!db)("IG arrival durable synchronization", () => {
  const personUid = randomUUID(),
    memberUid = randomUUID(),
    code1c = `test-${randomUUID()}`;
  const item = {
    personUid,
    code1c,
    revision: 1,
    state: "CURRENT" as const,
    currentArrivalMemberUid: memberUid,
    participations: [
      {
        arrivalMemberUid: memberUid,
        arrivalDate: "2026-11-05",
        locationUid: randomUUID(),
        locationCode1c: null,
        locationName: "Site",
        cancelled: false,
      },
    ],
  };
  let prisma: PrismaService;
  beforeAll(() => {
    prisma = new PrismaService({ datasourceUrl: db });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    const personHash = createHash("sha256").update(personUid).digest("hex");
    const issues = await prisma.igArrivalIssue.findMany({
      where: { personHash },
    });
    await prisma.auditLog.deleteMany({
      where: {
        entityId: { in: [personHash, ...issues.map((issue) => issue.id)] },
      },
    });
    await prisma.igArrivalIssue.deleteMany({ where: { personHash } });
    await prisma.igArrivalPerson.deleteMany({ where: { personUid } });
    await prisma.igEmploymentState.deleteMany({ where: { code1c } });
    await prisma.candidate.deleteMany({ where: { code1c } });
    await prisma.$disconnect();
  });
  it("persists failed survey delivery and retries the exact committed revision", async () => {
    const erp = {
      arrivalPage: vi.fn(async () => ({ items: [item], nextCursor: null })),
      identity: vi.fn(async () => ({
        personUid,
        code1C: code1c,
        recipientType: "person",
        reviewGroup: "IG",
        erpUid: null,
        chatUuid: null,
      })),
    };
    const audit = new AuditService(prisma);
    const projection = new IgArrivalProjectionService(
      prisma,
      erp as never,
      audit,
    );
    const config = {
      get: (key: string) =>
        ({
          EDO_ARRIVAL_CONTEXTS_URL:
            "http://127.0.0.1:1/surveys-service/api/internal/edo/arrival-contexts",
          EDO_ADAPTATION_SYNC_TOKEN: "test",
          NODE_ENV: "test",
        })[key],
    };
    const worker = new IgArrivalSyncWorker(
      prisma,
      erp as never,
      projection,
      config as never,
      audit,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("synthetic offline");
      }),
    );
    await worker.sync();
    let saved = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
    });
    expect(saved.syncPending).toBe(true);
    expect(saved.syncedRevision).toBe(0n);
    expect(saved.syncError).toBe("ARRIVAL_SURVEYS_UNCONFIRMED");
    const sender = vi.fn(async (_url: unknown, options: { body?: string }) => {
      expect(JSON.parse(String(options.body))).toEqual(item);
      return new Response(
        JSON.stringify({
          personUid,
          revision: 1,
          state: "CURRENT",
          currentArrivalMemberUid: memberUid,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", sender);
    await worker.sync();
    saved = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
    });
    expect(saved.syncPending).toBe(false);
    expect(saved.syncedRevision).toBe(1n);
    expect(saved.syncError).toBeNull();
    expect(sender).toHaveBeenCalledOnce();
    erp.arrivalPage.mockResolvedValueOnce({
      items: [item],
      nextCursor: null,
      issues: [{ personUid, code: "SOURCE_INVALID" }],
    } as never);
    await worker.sync();
    const personHash = createHash("sha256").update(personUid).digest("hex");
    const issue = await prisma.igArrivalIssue.findFirstOrThrow({
      where: { personHash, active: true },
    });
    expect(issue.code).toBe("SOURCE_INVALID");
    const auditRow = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: issue.id },
    });
    expect(auditRow.after).toEqual({ codes: ["SOURCE_INVALID"] });
    await worker.sync();
    expect(
      (
        await prisma.igArrivalIssue.findUniqueOrThrow({
          where: { id: issue.id },
        })
      ).active,
    ).toBe(false);
  });
  it("enforces lease concurrency and fencing on real MariaDB", async () => {
    const erp = {
      arrivalPage: vi.fn(async () => ({ items: [], nextCursor: null })),
    };
    const audit = new AuditService(prisma);
    const projection = new IgArrivalProjectionService(
      prisma,
      erp as never,
      audit,
    );
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
    const worker1 = new IgArrivalSyncWorker(
      prisma,
      erp as never,
      projection,
      config as never,
      audit,
    );
    const worker2 = new IgArrivalSyncWorker(
      prisma,
      erp as never,
      projection,
      config as never,
      audit,
    );

    // Seed singleton with active lease held by worker1
    await prisma.igArrivalSyncState.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        lockToken: "worker-1-token",
        lockExpiresAt: new Date(Date.now() + 60_000),
        generation: 10n,
      },
      update: {
        lockToken: "worker-1-token",
        lockExpiresAt: new Date(Date.now() + 60_000),
        generation: 10n,
      },
    });

    // worker2 tries to run while worker1 lease is active
    await worker2.sync();
    expect(erp.arrivalPage).not.toHaveBeenCalled();

    // Expire lease
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: {
        lockExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    // worker2 now takes over expired lease
    await worker2.sync();
    expect(erp.arrivalPage).toHaveBeenCalled();

    const state = await prisma.igArrivalSyncState.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(state.generation).toBeGreaterThan(10n);
  });
});
