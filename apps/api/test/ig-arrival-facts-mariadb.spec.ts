import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { IgArrivalFactsWorker } from "../src/documents/ig-arrival-facts-worker";
import { IgArrivalRegistryService } from "../src/documents/ig-arrival-registry.service";
import { IgArrivalFactsProjectionService } from "../src/documents/ig-arrival-facts-projection.service";

const db = process.env.EDO_FACTS_TEST_DATABASE_URL;
if (db && db !== "mysql://root:arrival_v2_test@127.0.0.1:13387/edo")
  throw new Error("Refuse non-task database");
describe.skipIf(!db)("factual arrivals in isolated MariaDB", () => {
  let prisma: PrismaService, service: IgArrivalFactsProjectionService;
  const personUid = randomUUID(),
    locationUid = randomUUID(),
    token = randomUUID();
  const lease = { lockToken: token, generation: 100n };
  const period = "2026-11-05T13:20:45";
  const sourceKey = `${period}|${personUid}|${locationUid}`;
  const item = {
    personUid,
    code1c: null,
    participations: [
      {
        sourceKey,
        period,
        arrivalMemberUid: null,
        arrivalDate: "2026-11-06",
        arrivalDateTime: null,
        locationUid,
        locationCode1c: null,
        locationName: "Site",
        cancelled: false,
        latestSiteStatusCancelled: null,
        fullName: "Person",
        managerCode1c: null,
      },
    ],
  };
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: db });
    await prisma.igArrivalSyncState.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        lockToken: token,
        generation: 100n,
        lockExpiresAt: new Date(Date.now() + 60000),
      },
      update: {
        lockToken: token,
        generation: 100n,
        lockExpiresAt: new Date(Date.now() + 60000),
      },
    });
    service = new IgArrivalFactsProjectionService(
      prisma,
      { logInTransaction: vi.fn() } as never,
      {
        identity: vi.fn().mockRejectedValue(new Error("unavailable")),
      } as never,
    );
  });
  afterAll(async () => {
    await prisma.igArrivalPerson.deleteMany({ where: { personUid } });
    await prisma.$disconnect();
  });
  it("replays a legacy fact idempotently and updates its date without replacing its UID", async () => {
    await service.apply(item, lease, []);
    const first = await prisma.igArrivalMember.findUniqueOrThrow({
      where: { sourceKey },
    });
    await service.apply(item, lease, []);
    expect(
      (await prisma.igArrivalPerson.findUniqueOrThrow({ where: { personUid } }))
        .revision,
    ).toBe(1n);
    await service.apply(
      {
        ...item,
        participations: [
          { ...item.participations[0], arrivalDate: "2026-11-07" },
        ],
      },
      lease,
      [],
    );
    const updated = await prisma.igArrivalMember.findUniqueOrThrow({
      where: { sourceKey },
    });
    expect(updated.arrivalMemberUid).toBe(first.arrivalMemberUid);
    expect(updated.arrivalDate).toBe("2026-11-07");
  });
  it("preserves a uniquely proven source UUID when the source key moves", async () => {
    const uid = randomUUID();
    const p = randomUUID(),
      loc1 = randomUUID(),
      loc2 = randomUUID();
    const f = {
      ...item.participations[0],
      locationUid: loc1,
      sourceKey: `${period}|${p}|${loc1}`,
      arrivalMemberUid: uid,
    };
    await service.apply(
      { personUid: p, code1c: null, participations: [f] },
      lease,
      [],
    );
    const moved = {
      ...f,
      locationUid: loc2,
      sourceKey: `${period}|${p}|${loc2}`,
    };
    await service.apply(
      { personUid: p, code1c: null, participations: [moved] },
      lease,
      [],
    );
    expect(
      (
        await prisma.igArrivalMember.findUniqueOrThrow({
          where: { sourceKey: moved.sourceKey },
        })
      ).arrivalMemberUid,
    ).toBe(uid);
    await prisma.igArrivalPerson.delete({ where: { personUid: p } });
  });
  it("lists an unverified factual arrival while hiding candidate data", async () => {
    const registry = new IgArrivalRegistryService(prisma);
    const principal = { uuid: "test", accessRules: { "20011": [] } } as never;
    const groups = await registry.groups(principal, {});
    const group = groups.items.find(
      (g) => g.arrivalDate === "2026-11-07" && g.locationUid === locationUid,
    );
    expect(group).toBeDefined();
    const rows = await registry.participations(principal, {
      groupKey: group!.groupKey,
    });
    expect(rows.items).toContainEqual(
      expect.objectContaining({
        personUid,
        candidateId: null,
        action: "NONE",
        documentStatus: "UNKNOWN",
      }),
    );
  });
  it("keeps unverified facts visible without granting a candidate binding", async () => {
    const p = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
    });
    expect(p.candidateId).toBeNull();
    expect(p.igVerified).toBe(false);
    expect(p.bindingError).toBeTruthy();
  });
  it("archives a missing fact only after two complete fenced passes", async () => {
    const legacyUid = randomUUID();
    await prisma.igArrivalMember.create({
      data: { arrivalMemberUid: legacyUid, personUid, cancelled: false },
    });
    await service.finish(lease);
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 101n },
    });
    await service.finish({ ...lease, generation: 101n });
    expect(
      (await prisma.igArrivalMember.findUniqueOrThrow({ where: { sourceKey } }))
        .factsArchived,
    ).toBe(false);
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 102n },
    });
    await service.finish({ ...lease, generation: 102n });
    expect(
      (await prisma.igArrivalMember.findUniqueOrThrow({ where: { sourceKey } }))
        .factsArchived,
    ).toBe(true);
    expect(
      (
        await prisma.igArrivalMember.findUniqueOrThrow({
          where: { arrivalMemberUid: legacyUid },
        })
      ).factsArchived,
    ).toBe(true);
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 100n },
    });
  });
  it("verifies source identity before associating a candidate", async () => {
    const p = randomUUID(),
      loc = randomUUID(),
      uid = randomUUID(),
      code = `ig-${randomUUID()}`;
    const f = {
      ...item.participations[0],
      locationUid: loc,
      sourceKey: `${period}|${p}|${loc}`,
      arrivalMemberUid: uid,
    };
    const identity = vi.fn(async () => ({
      personUid: p,
      code1C: code,
      recipientType: "person",
      reviewGroup: "IG",
      chatUuid: null,
      erpUid: null,
    }));
    const verified = new IgArrivalFactsProjectionService(
      prisma,
      { logInTransaction: vi.fn() } as never,
      { identity } as never,
    );
    await verified.apply(
      { personUid: p, code1c: code, participations: [f] },
      lease,
      [],
    );
    const linked = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid: p },
    });
    expect(linked.igVerified).toBe(true);
    expect(linked.candidateId).toBeTruthy();
    identity.mockRejectedValueOnce(new Error("unavailable"));
    await verified.apply(
      { personUid: p, code1c: code, participations: [f] },
      lease,
      [],
    );
    const unavailable = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid: p },
    });
    expect(unavailable.igVerified).toBe(false);
    expect(unavailable.candidateId).toBe(linked.candidateId);
    expect(unavailable.bindingError).toBeTruthy();
    await verified.apply(
      { personUid: p, code1c: code, participations: [f] },
      lease,
      [],
    );
    const restored = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid: p },
    });
    expect(restored.revision).toBeGreaterThan(unavailable.revision);
    const revision = restored.revision;
    await verified.apply(
      { personUid: p, code1c: code, participations: [f] },
      lease,
      [],
    );
    expect(
      (
        await prisma.igArrivalPerson.findUniqueOrThrow({
          where: { personUid: p },
        })
      ).revision,
    ).toBe(revision);
    await prisma.igArrivalPerson.delete({ where: { personUid: p } });
    await prisma.igEmploymentState.deleteMany({ where: { code1c: code } });
    await prisma.candidate.deleteMany({ where: { id: linked.candidateId! } });
  });
  it("changes Surveys context and revision after two absent passes", async () => {
    const p = randomUUID(),
      loc = randomUUID(),
      uid = randomUUID(),
      code = `ig-${randomUUID()}`;
    const f = {
      ...item.participations[0],
      locationUid: loc,
      sourceKey: `${period}|${p}|${loc}`,
      arrivalMemberUid: uid,
    };
    const erp = {
      identity: vi.fn(async () => ({
        personUid: p,
        code1C: code,
        recipientType: "person",
        reviewGroup: "IG",
        chatUuid: null,
        erpUid: null,
      })),
    };
    const svc = new IgArrivalFactsProjectionService(
      prisma,
      { logInTransaction: vi.fn() } as never,
      erp as never,
    );
    await svc.apply(
      { personUid: p, code1c: code, participations: [f] },
      lease,
      [],
    );
    const initial = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid: p },
    });
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 201n },
    });
    await svc.finish({ ...lease, generation: 201n });
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 202n },
    });
    await svc.finish({ ...lease, generation: 202n });
    const archived = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid: p },
    });
    expect(archived.revision).toBeGreaterThan(initial.revision);
    expect(archived.sourcePayload).toMatchObject({
      state: "NONE",
      currentArrivalMemberUid: null,
    });
    expect(archived.syncPending).toBe(true);
    await prisma.igArrivalPerson.delete({ where: { personUid: p } });
    await prisma.igEmploymentState.deleteMany({ where: { code1c: code } });
    await prisma.candidate.deleteMany({ where: { id: initial.candidateId! } });
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 100n },
    });
  });
  it("hides trusted candidate binding until its generation completes", async () => {
    const p = randomUUID(),
      loc = randomUUID(),
      uid = randomUUID(),
      code = `ig-${randomUUID()}`;
    const f = {
      ...item.participations[0],
      locationUid: loc,
      sourceKey: `${period}|${p}|${loc}`,
      arrivalMemberUid: uid,
    };
    const svc = new IgArrivalFactsProjectionService(
      prisma,
      { logInTransaction: vi.fn() } as never,
      {
        identity: vi.fn(async () => ({
          personUid: p,
          code1C: code,
          recipientType: "person",
          reviewGroup: "IG",
          chatUuid: null,
          erpUid: null,
        })),
      } as never,
    );
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 300n },
    });
    const currentLease = { ...lease, generation: 300n };
    await svc.apply(
      { personUid: p, code1c: code, participations: [f] },
      currentLease,
      [],
    );
    const registry = new IgArrivalRegistryService(prisma),
      principal = { uuid: "test", accessRules: { "20011": [] } } as never;
    const groups = await registry.groups(principal, {}),
      group = groups.items.find((g) => g.locationUid === loc)!;
    expect(
      (await registry.participations(principal, { groupKey: group.groupKey }))
        .items[0].candidateId,
    ).toBeNull();
    await svc.finish(currentLease);
    const candidateId = (
      await registry.participations(principal, { groupKey: group.groupKey })
    ).items[0].candidateId;
    expect(candidateId).toBeTruthy();
    await prisma.igArrivalPerson.delete({ where: { personUid: p } });
    await prisma.igEmploymentState.deleteMany({ where: { code1c: code } });
    await prisma.candidate.deleteMany({ where: { id: candidateId! } });
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 100n },
    });
  });
  it("shows all duplicated source UUID facts separately with warnings and without candidates", async () => {
    const people = [randomUUID(), randomUUID()],
      loc = randomUUID(),
      uid = randomUUID();
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 400n },
    });
    const lease400 = { ...lease, generation: 400n };
    const svc = new IgArrivalFactsProjectionService(
      prisma,
      { logInTransaction: vi.fn() } as never,
      {
        identity: vi.fn().mockRejectedValue(new Error("unavailable")),
      } as never,
    );
    for (const p of people) {
      const key = `${period}|${p}|${loc}`;
      await svc.apply(
        {
          personUid: p,
          code1c: null,
          participations: [
            {
              ...item.participations[0],
              locationUid: loc,
              sourceKey: key,
              arrivalMemberUid: uid,
            },
          ],
        },
        lease400,
        [{ code: "DUPLICATE_ARRIVAL_MEMBER_UID", sourceKey: key }],
      );
    }
    await svc.finish(lease400);
    const members = await prisma.igArrivalMember.findMany({
      where: { personUid: { in: people } },
    });
    expect(members).toHaveLength(2);
    expect(new Set(members.map((m) => m.arrivalMemberUid)).size).toBe(2);
    expect(
      members.every(
        (m) => m.arrivalMemberUid !== uid && m.sourceMemberUid === uid,
      ),
    ).toBe(true);
    const registry = new IgArrivalRegistryService(prisma),
      principal = { uuid: "test", accessRules: { "20011": [] } } as never;
    const group = (await registry.groups(principal, {})).items.find(
      (g) => g.locationUid === loc,
    )!;
    const rows = (
      await registry.participations(principal, { groupKey: group.groupKey })
    ).items;
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (r) =>
          r.candidateId === null &&
          r.approvedDocuments === 0 &&
          r.action === "NONE" &&
          r.issueCodes.includes("DUPLICATE_ARRIVAL_MEMBER_UID"),
      ),
    ).toBe(true);
    await prisma.igArrivalPerson.deleteMany({
      where: { personUid: { in: people } },
    });
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 100n },
    });
  });
  it("preserves a legacy UUID and its candidate documents in the cancelled archive", async () => {
    const p = randomUUID(),
      loc = randomUUID(),
      uid = randomUUID(),
      code = `ig-${randomUUID()}`;
    const candidate = await prisma.candidate.create({
      data: {
        identityKey: `ig-person:${p}`,
        personUid: p,
        code1c: code,
        reviewGroup: "IG",
        citizenship: "uz",
      },
    });
    const type = await prisma.documentType.create({
      data: {
        code: `DOC_${randomUUID()}`,
        title: "Existing",
        erpUid: randomUUID(),
      },
    });
    const doc = await prisma.document.create({
      data: {
        candidateId: candidate.id,
        documentTypeId: type.id,
        status: "APPROVED",
        versions: {
          create: { version: 1, status: "APPROVED", storageKey: "test" },
        },
      },
    });
    await prisma.igArrivalPerson.create({
      data: {
        personUid: p,
        code1c: code,
        candidateId: candidate.id,
        state: "CURRENT",
        revision: 1n,
        sourceHash: "legacy",
        sourcePayload: {},
        igVerified: true,
        members: { create: { arrivalMemberUid: uid, cancelled: false } },
      },
    });
    const f = {
      ...item.participations[0],
      locationUid: loc,
      sourceKey: `${period}|${p}|${loc}`,
      arrivalMemberUid: uid,
    };
    const svc = new IgArrivalFactsProjectionService(
      prisma,
      { logInTransaction: vi.fn() } as never,
      {
        identity: vi.fn(async () => ({
          personUid: p,
          code1C: code,
          recipientType: "person",
          reviewGroup: "IG",
          chatUuid: null,
          erpUid: null,
        })),
      } as never,
    );
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 500n },
    });
    await svc.apply(
      { personUid: p, code1c: code, participations: [f] },
      { ...lease, generation: 500n },
      [],
    );
    await svc.finish({ ...lease, generation: 500n });
    expect(
      (
        await prisma.igArrivalMember.findUniqueOrThrow({
          where: { sourceKey: f.sourceKey },
        })
      ).arrivalMemberUid,
    ).toBe(uid);
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 501n },
    });
    await svc.apply(
      {
        personUid: p,
        code1c: code,
        participations: [{ ...f, cancelled: true }],
      },
      { ...lease, generation: 501n },
      [],
    );
    await svc.finish({ ...lease, generation: 501n });
    const registry = new IgArrivalRegistryService(prisma),
      principal = { uuid: "test", accessRules: { "20011": [] } } as never;
    const group = (
      await registry.groups(principal, { archive: "archive", q: code })
    ).items[0];
    const row = (
      await registry.participations(principal, {
        archive: "archive",
        q: code,
        groupKey: group.groupKey,
      })
    ).items[0];
    expect(row).toMatchObject({
      arrivalMemberUid: uid,
      candidateId: candidate.id,
      approvedDocuments: 1,
      participationStatus: "CANCELLED",
    });
    expect(
      (await prisma.document.findUniqueOrThrow({ where: { id: doc.id } }))
        .candidateId,
    ).toBe(candidate.id);
    await prisma.igArrivalPerson.delete({ where: { personUid: p } });
    await prisma.igEmploymentState.deleteMany({ where: { code1c: code } });
    await prisma.document.delete({ where: { id: doc.id } });
    await prisma.candidate.delete({ where: { id: candidate.id } });
    await prisma.documentType.delete({ where: { id: type.id } });
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 100n },
    });
  });
  it("quarantines an earlier trusted owner as soon as a duplicate UID is reported", async () => {
    const p1 = randomUUID(),
      p2 = randomUUID(),
      loc = randomUUID(),
      uid = randomUUID(),
      code = `ig-${randomUUID()}`;
    const f1 = {
      ...item.participations[0],
      locationUid: loc,
      sourceKey: `${period}|${p1}|${loc}`,
      arrivalMemberUid: uid,
    };
    const f2 = { ...f1, sourceKey: `${period}|${p2}|${loc}` };
    const svc = new IgArrivalFactsProjectionService(
      prisma,
      { logInTransaction: vi.fn() } as never,
      {
        identity: vi.fn(async () => ({
          personUid: p1,
          code1C: code,
          recipientType: "person",
          reviewGroup: "IG",
          chatUuid: null,
          erpUid: null,
        })),
      } as never,
    );
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 600n },
    });
    await svc.apply(
      { personUid: p1, code1c: code, participations: [f1] },
      { ...lease, generation: 600n },
      [],
    );
    await svc.finish({ ...lease, generation: 600n });
    const registry = new IgArrivalRegistryService(prisma),
      principal = { uuid: "test", accessRules: { "20011": [] } } as never;
    const group = (await registry.groups(principal, { q: code })).items[0];
    const before = (
      await registry.participations(principal, {
        q: code,
        groupKey: group.groupKey,
      })
    ).items[0];
    expect(before.candidateId).toBeTruthy();
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 601n },
    });
    await svc.apply(
      { personUid: p2, code1c: null, participations: [f2] },
      { ...lease, generation: 601n },
      [{ code: "DUPLICATE_ARRIVAL_MEMBER_UID", sourceKey: f2.sourceKey }],
    );
    const after = (
      await registry.participations(principal, {
        q: code,
        groupKey: group.groupKey,
      })
    ).items[0];
    expect(after.candidateId).toBeNull();
    expect(after.issueCodes).toContain("DUPLICATE_ARRIVAL_MEMBER_UID");
    await prisma.igArrivalMember.update({
      where: { arrivalMemberUid: uid },
      data: { factsIdentityIssue: "ARRIVAL_IDENTITY_CONFLICT" },
    });
    await svc.apply(
      { personUid: p2, code1c: null, participations: [f2] },
      { ...lease, generation: 601n },
      [{ code: "DUPLICATE_ARRIVAL_MEMBER_UID", sourceKey: f2.sourceKey }],
    );
    expect(
      (
        await prisma.igArrivalMember.findUniqueOrThrow({
          where: { arrivalMemberUid: uid },
        })
      ).factsIdentityIssue,
    ).toBe("ARRIVAL_IDENTITY_CONFLICT");
    await svc.apply(
      { personUid: p1, code1c: code, participations: [f1] },
      { ...lease, generation: 601n },
      [],
    );
    expect(
      (
        await prisma.igArrivalMember.findUniqueOrThrow({
          where: { arrivalMemberUid: uid },
        })
      ).factsIdentityIssue,
    ).toBe("ARRIVAL_IDENTITY_CONFLICT");
    await prisma.igArrivalPerson.deleteMany({
      where: { personUid: { in: [p1, p2] } },
    });
    await prisma.igEmploymentState.deleteMany({ where: { code1c: code } });
    await prisma.candidate.deleteMany({ where: { id: before.candidateId! } });
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: { generation: 100n },
    });
  });
  it("resumes a logical scan across fenced leases and finishes its original generation", async () => {
    const p = randomUUID(),
      loc = randomUUID(),
      key = `${period}|${p}|${loc}`;
    const data = {
      personUid: p,
      code1c: null,
      participations: [
        { ...item.participations[0], locationUid: loc, sourceKey: key },
      ],
    };
    const erp = {
      arrivalFactsPage: vi
        .fn()
        .mockResolvedValueOnce({
          contractVersion: 2,
          items: [data],
          nextCursor: "next",
          issues: [],
        })
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValueOnce({
          contractVersion: 2,
          items: [],
          nextCursor: null,
          issues: [],
        }),
      identity: vi.fn(),
    };
    const svc = new IgArrivalFactsProjectionService(
      prisma,
      { logInTransaction: vi.fn() } as never,
      erp as never,
    );
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: {
        lockToken: null,
        lockExpiresAt: null,
        cursor: null,
        factsScanGeneration: null,
        factsScanIncomplete: false,
        generation: 700n,
      },
    });
    const worker = new IgArrivalFactsWorker(
      prisma,
      erp as never,
      svc,
      { get: vi.fn() } as never,
      {} as never,
      { logInTransaction: vi.fn() } as never,
    );
    await expect(worker.sync()).rejects.toThrow("network");
    const paused = await prisma.igArrivalSyncState.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(paused.cursor).toBe("next");
    expect(paused.factsScanGeneration).toBe(701n);
    await worker.sync();
    const finished = await prisma.igArrivalSyncState.findUniqueOrThrow({
      where: { id: "singleton" },
    });
    expect(finished.generation).toBe(702n);
    expect(finished.factsFinishedGeneration).toBe(701n);
    expect(
      (
        await prisma.igArrivalPerson.findUniqueOrThrow({
          where: { personUid: p },
        })
      ).factsSeenGeneration,
    ).toBe(701n);
    await prisma.igArrivalPerson.delete({ where: { personUid: p } });
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: {
        lockToken: token,
        lockExpiresAt: new Date(Date.now() + 60000),
        generation: 100n,
      },
    });
  });
  it("rejects a superseded lease before mutating facts", async () => {
    await expect(
      service.apply(item, { ...lease, generation: 99n }, []),
    ).rejects.toThrow("ARRIVAL_SYNC_FENCING_CONFLICT");
  });
});
