import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { IgEnrichmentQueueService } from "../src/documents/ig-enrichment-queue.service";
const db = process.env.EDO_FACTS_TEST_DATABASE_URL;
if (db && db !== "mysql://root:arrival_v2_test@127.0.0.1:13387/edo")
  throw new Error("Refuse non-task database");
describe.skipIf(!db)("durable employee enrichment", () => {
  let prisma: PrismaService, queue: any, id: string;
  const principal = { accessRules: { "20011": [] } } as never;
  const enrich = vi.fn();
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: db });
    id = (
      await prisma.candidate.create({
        data: {
          identityKey: `enrich-${randomUUID()}`,
          reviewGroup: "IG",
          code1c: `enrich-${randomUUID()}`,
          personUid: randomUUID(),
        },
      })
    ).id;
    queue = new (IgEnrichmentQueueService as any)(
      prisma,
      { enrichCandidate: enrich },
      new DocumentAccessService(prisma),
      { get: () => "false" },
    );
  });
  afterAll(async () => {
    await queue?.onModuleDestroy?.();
    await prisma.candidate.delete({ where: { id } });
    await prisma.$disconnect();
  });
  it("coalesces interactive requests durably and refuses non-reviewers", async () => {
    await expect(queue.request(id, { accessRules: {} })).rejects.toThrow();
    expect(await queue.request(id, principal)).toMatchObject({
      status: "PENDING",
      documentsReady: false,
    });
    await queue.request(id, principal);
    expect(
      await prisma.igEnrichmentJob.count({ where: { candidateId: id } }),
    ).toBe(1);
    expect(
      await prisma.igEnrichmentJob.findUnique({ where: { candidateId: id } }),
    ).toMatchObject({ priority: true, status: "PENDING" });
  });
  it("does not reset retry cooldown on repeated open", async () => {
    const retryAt = new Date(Date.now() + 60000);
    await prisma.igEnrichmentJob.update({
      where: { candidateId: id },
      data: { status: "RETRY", nextAttemptAt: retryAt, attempts: 2 },
    });
    expect(await queue.request(id, principal)).toMatchObject({
      status: "RETRY",
      retryAt: retryAt.toISOString(),
    });
    expect(
      (
        await prisma.igEnrichmentJob.findUniqueOrThrow({
          where: { candidateId: id },
        })
      ).attempts,
    ).toBe(2);
  });
  it("runs an interactive job once across two workers and reports ready after commit", async () => {
    await prisma.igEnrichmentJob.update({
      where: { candidateId: id },
      data: { status: "PENDING", nextAttemptAt: new Date(0) },
    });
    enrich.mockImplementationOnce(async (_id, options) => {
      await options.assertLease();
      await prisma.candidate.update({
        where: { id },
        data: {
          citizenship: "uz",
          positionCode: "position",
          profileSyncedAt: new Date(),
          previousDocumentsSyncedAt: new Date(),
        },
      });
      return { profileSynced: true, documentsSynced: true };
    });
    const other = new (IgEnrichmentQueueService as any)(
      prisma,
      { enrichCandidate: enrich },
      new DocumentAccessService(prisma),
      { get: () => "false" },
    );
    await Promise.all([queue.runLane("priority"), other.runLane("priority")]);
    expect(enrich).toHaveBeenCalledTimes(1);
    expect(await queue.status(id)).toMatchObject({
      status: "READY",
      profileReady: true,
      documentsReady: true,
    });
    await other.onModuleDestroy();
  });
  it("recovers expired leases but rejects writes by a stale worker", async () => {
    const expired = new Date(Date.now() - 60000);
    await prisma.igEnrichmentLane.update({
      where: { id: "priority" },
      data: { leaseToken: randomUUID(), leaseExpiresAt: expired },
    });
    await prisma.igEnrichmentJob.update({
      where: { candidateId: id },
      data: {
        status: "RUNNING",
        leaseToken: randomUUID(),
        leaseExpiresAt: expired,
        nextAttemptAt: expired,
      },
    });
    enrich.mockImplementationOnce(async (_id, options) => {
      await prisma.igEnrichmentJob.update({
        where: { candidateId: id },
        data: { leaseToken: randomUUID() },
      });
      await expect(options.assertLease()).rejects.toThrow(
        "ENRICHMENT_LEASE_LOST",
      );
      throw new Error("ENRICHMENT_LEASE_LOST");
    });
    await queue.runLane("priority");
    expect(
      (
        await prisma.igEnrichmentJob.findUniqueOrThrow({
          where: { candidateId: id },
        })
      ).status,
    ).toBe("RUNNING");
  });
  it("never demotes or steals an interactive job created during background discovery", async () => {
    const c = await prisma.candidate.create({
      data: {
        identityKey: `race-${randomUUID()}`,
        reviewGroup: "IG",
        code1c: `race-${randomUUID()}`,
        personUid: randomUUID(),
        updatedAt: new Date(0),
      },
    });
    const token = randomUUID();
    let discovered = false;
    const dbWithConcurrentRequest = {
      $transaction: (callback: any) =>
        prisma.$transaction(async (tx) =>
          callback(
            new Proxy(tx, {
              get(target, key) {
                if (key !== "candidate") return Reflect.get(target, key);
                return new Proxy(tx.candidate, {
                  get(delegate, method) {
                    if (method !== "findFirst")
                      return Reflect.get(delegate, method);
                    return async (args: any) => {
                      const result = await tx.candidate.findFirst(args);
                      if (result?.id === c.id && !discovered) {
                        discovered = true;
                        await queue.request(c.id, principal);
                        await prisma.igEnrichmentJob.update({
                          where: { candidateId: c.id },
                          data: {
                            status: "RUNNING",
                            priority: true,
                            leaseToken: token,
                            leaseExpiresAt: new Date(Date.now() + 60000),
                          },
                        });
                      }
                      return result;
                    };
                  },
                });
              },
            }),
          ),
        ),
    };
    try {
      const background = new (IgEnrichmentQueueService as any)(
        dbWithConcurrentRequest,
        { enrichCandidate: enrich },
        new DocumentAccessService(prisma),
        { get: () => "false" },
      );
      await background.runLane("background");
      expect(discovered).toBe(true);
      expect(
        await prisma.igEnrichmentJob.findUniqueOrThrow({
          where: { candidateId: c.id },
        }),
      ).toMatchObject({ status: "RUNNING", priority: true, leaseToken: token });
    } finally {
      await prisma.candidate.delete({ where: { id: c.id } });
    }
  });

  it("does not overwrite a priority lease created during background discovery", async () => {
    const c = await prisma.candidate.create({
      data: {
        identityKey: `race-${randomUUID()}`,
        reviewGroup: "IG",
        code1c: `race-${randomUUID()}`,
        personUid: randomUUID(),
      },
    });
    let discovered!: () => void, resume!: () => void, finish!: () => void;
    const discovery = new Promise<void>((resolve) => {
      discovered = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const wrapped = new Proxy(prisma, {
      get(target, prop) {
        if (prop !== "$transaction") return Reflect.get(target, prop);
        return (body: (tx: unknown) => Promise<unknown>) =>
          target.$transaction((tx) =>
            body(
              new Proxy(tx, {
                get(client, key) {
                  if (key !== "candidate") return Reflect.get(client, key);
                  return {
                    ...client.candidate,
                    findFirst: async (args: any) => {
                      const candidate = await client.candidate.findFirst({
                        ...args,
                        where: { AND: [args.where, { id: c.id }] },
                      });
                      discovered();
                      await resumed;
                      return candidate;
                    },
                  };
                },
              }),
            ),
          );
      },
    });
    const interactiveEnrich = vi.fn(async () => {
      await finished;
      return { profileSynced: false, documentsSynced: false };
    });
    const interactive = new (IgEnrichmentQueueService as any)(
      prisma,
      { enrichCandidate: interactiveEnrich },
      new DocumentAccessService(prisma),
      { get: () => "false" },
    );
    const background = new (IgEnrichmentQueueService as any)(
      wrapped,
      { enrichCandidate: interactiveEnrich },
      new DocumentAccessService(prisma),
      { get: () => "false" },
    );
    try {
      const backgroundRun = background.runLane("background");
      await discovery;
      await interactive.request(c.id, principal);
      const priorityRun = interactive.runLane("priority");
      while (!interactiveEnrich.mock.calls.length)
        await new Promise((resolve) => setTimeout(resolve, 5));
      const before = await prisma.igEnrichmentJob.findUniqueOrThrow({
        where: { candidateId: c.id },
      });
      resume();
      await backgroundRun;
      expect(
        await prisma.igEnrichmentJob.findUniqueOrThrow({
          where: { candidateId: c.id },
        }),
      ).toMatchObject({
        status: "RUNNING",
        priority: true,
        leaseToken: before.leaseToken,
      });
      expect(interactiveEnrich).toHaveBeenCalledTimes(1);
      finish();
      await priorityRun;
    } finally {
      resume();
      finish();
      await interactive.onModuleDestroy();
      await background.onModuleDestroy();
      await prisma.candidate.delete({ where: { id: c.id } });
    }
  });
  it("loads RU documents without a person link, keeps direction rights, and refreshes a ready snapshot", async () => {
    const c = await prisma.candidate.create({ data: { identityKey: `ru-docs-${randomUUID()}`, erpUid: randomUUID(), reviewGroup: "RU", citizenship: "ru", personUid: null, code1c: null } });
    const ru = { accessRules: { "20002": [] } } as never;
    try {
      await expect(queue.request(c.id, principal)).rejects.toThrow();
      expect(await queue.request(c.id, ru)).toMatchObject({ status: "PENDING", profileReady: true, documentsReady: false });
      enrich.mockImplementationOnce(async (candidateId, options) => {
        await options.assertLease();
        await prisma.candidate.update({ where: { id: candidateId }, data: { previousDocumentsSyncedAt: new Date() } });
        return { profileSynced: true, documentsSynced: true };
      });
      await queue.runLane("priority");
      expect(await queue.status(c.id)).toMatchObject({ status: "READY", documentsReady: true });
      expect(await queue.request(c.id, ru)).toMatchObject({ status: "PENDING", documentsReady: true });
      expect(await prisma.igEnrichmentJob.count({ where: { candidateId: c.id } })).toBe(1);
    } finally { await prisma.candidate.delete({ where: { id: c.id } }); }
  });

});
