import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { AuditService } from "../src/audit/audit.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { CandidateCatalogProjectionService } from "../src/documents/candidate-catalog-projection.service";
import { ErpChangeInboxService } from "../src/documents/erp-change-inbox";
import { ErpEventSyncService } from "../src/documents/erp-event-sync.service";
import { IgArrivalFactsProjectionService } from "../src/documents/ig-arrival-facts-projection.service";
import { IgArrivalProjectionService } from "../src/documents/ig-arrival-projection.service";

const db = process.env.EDO_TARGETED_TEST_DATABASE_URL;
if (db && !/^mysql:\/\/[^@/]+@127\.0\.0\.1:(3307|3308)\/edo$/.test(db))
  throw new Error("Refusing non-disposable database");

describe.skipIf(!db)("durable person event processing", () => {
  const uid = randomUUID();
  const candidateUid = randomUUID();
  const code1c = `fixture-${uid}`;
  const prisma = new PrismaService({ datasourceUrl: db });
  const audit = new AuditService(prisma);
  const inbox = new ErpChangeInboxService(prisma);
  afterAll(async () => {
    await prisma.erpChangeInbox.deleteMany({
      where: { uid: { in: [uid, candidateUid] } },
    });
    await prisma.candidate.deleteMany({ where: { erpUid: candidateUid } });
    await prisma.igArrivalPerson.deleteMany({ where: { personUid: uid } });
    await prisma.$disconnect();
  });

  it("applies ARRIVALS without a local candidate and preserves a later document event", async () => {
    const event = [
      { eventId: randomUUID(), uid, target: "PERSON", changes: ["ARRIVALS"] },
    ] as Parameters<typeof inbox.accept>[0];
    await inbox.accept(event);
    await inbox.accept(event);
    const where = { target_uid: { target: "PERSON", uid } };
    expect(
      (await prisma.erpChangeInbox.findUniqueOrThrow({ where })).revision,
    ).toBe(1n);
    const erp = {
      identity: vi.fn(),
      igPersonSnapshotBatch: vi.fn(async () => {
        await inbox.accept([
          {
            eventId: randomUUID(),
            uid,
            target: "PERSON",
            changes: ["DOCUMENTS"],
          },
        ]);
        return {
          items: [
            {
              personUid: uid,
              identity: {
                recipientType: "person",
                reviewGroup: "IG",
                personUid: uid,
                code1C: code1c,
                erpUid: null,
                chatUuid: null,
              },
              arrivals: { personUid: uid, code1c, participations: [] },
              arrivalsComplete: true,
            },
          ],
        };
      }),
    };
    const service = new ErpEventSyncService(
      prisma,
      inbox,
      erp as never,
      new CandidateCatalogProjectionService(prisma, audit),
      new IgArrivalFactsProjectionService(prisma, audit, erp as never),
      {} as never,
      { publish: vi.fn().mockResolvedValue(null) } as never,
      audit,
      new ConfigService({ ERP_CHANGE_SYNC_MODE: "events" }),
      new IgArrivalProjectionService(prisma, erp as never, audit),
    );
    expect(await service.run(new AbortController().signal)).toBe(true);
    expect(erp.igPersonSnapshotBatch).toHaveBeenCalledWith(
      [{ personUid: uid, changes: ["ARRIVALS"] }],
      expect.any(AbortSignal),
    );
    expect(erp.identity).not.toHaveBeenCalled();
    const person = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid: uid },
    });
    expect(person.candidateId).toBeNull();
    expect(person.code1c).toBe(code1c);
    const settled = await prisma.erpChangeInbox.findUniqueOrThrow({ where });
    expect(settled.arrivalsRevision).toBe(0n);
    expect(settled.documentsRevision).toBe(2n);
    expect(settled.notifyAt).toBeInstanceOf(Date);
    await prisma.erpChangeInbox.delete({ where });
  });

  it("applies a deleted profile to the ERP UUID without resolving a conflicting chat", async () => {
    const conflictingChat = randomUUID();
    const row = await prisma.candidate.create({
      data: {
        erpUid: candidateUid,
        reviewGroup: "RU",
        identityKey: `erp-candidate:${candidateUid}`,
      },
    });
    await inbox.accept([
      {
        eventId: randomUUID(),
        uid: candidateUid,
        target: "CANDIDATE",
        changes: ["PROFILE"],
      },
    ]);
    const erp = {
      candidateProfilesBatch: vi.fn(async () => ({
        items: [
          {
            candidateUid,
            profile: {
              erpUid: candidateUid,
              deleted: true,
              chatUuid: conflictingChat,
            },
          },
        ],
      })),
    };
    const redis = {
      setNxPxStrict: vi.fn().mockResolvedValue(true),
      compareAndDelStrict: vi.fn().mockResolvedValue(true),
      publish: vi.fn().mockResolvedValue(1),
    };
    const projection = new CandidateCatalogProjectionService(prisma, audit);
    const apply = vi.spyOn(projection, "applyRows");
    const service = new ErpEventSyncService(
      prisma,
      inbox,
      erp as never,
      projection,
      {} as never,
      {} as never,
      redis as never,
      audit,
      new ConfigService({ ERP_CHANGE_SYNC_MODE: "events" }),
      {} as never,
    );
    expect(await service.run(new AbortController().signal)).toBe(true);
    expect(apply).toHaveBeenCalledWith(
      [],
      expect.any(String),
      expect.any(Object),
    );
    const updated = await prisma.candidate.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(updated.erpDeleted).toBe(true);
    expect(updated.chatUuid).toBeNull();
    const settled = await prisma.erpChangeInbox.findUniqueOrThrow({
      where: { target_uid: { target: "CANDIDATE", uid: candidateUid } },
    });
    expect(settled.profileRevision).toBe(0n);
    expect(settled.dueAt).toBeNull();
  });
});
