import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaService } from "../src/prisma/prisma.service";
import { IgArrivalProjectionService } from "../src/documents/ig-arrival-projection.service";
import { IgArrivalRegistryService } from "../src/documents/ig-arrival-registry.service";
import { arrivalStateSchema } from "../src/documents/ig-arrival-contract";
const db = process.env.EDO_TEST_DATABASE_URL;
if (db && db !== "mysql://root:ig-isolated-test-20261105@127.0.0.1:33307/edo")
  throw new Error("Refuse non-task database");
describe.skipIf(!db)("IG registry on isolated MariaDB", () => {
  const personUid = randomUUID(),
    member = randomUUID(),
    historical = randomUUID(),
    historicalActive = randomUUID(),
    removed = randomUUID(),
    location = randomUUID(),
    code1c = `registry-${randomUUID()}`;
  const conflictPerson = randomUUID(),
    conflictMember = randomUUID(),
    conflictCancelled = randomUUID(),
    conflictCode = `registry-conflict-${randomUUID()}`;
  const reviewer = { accessRules: { "20011": [] } } as never;
  let prisma: PrismaService,
    projection: IgArrivalProjectionService,
    registry: IgArrivalRegistryService;
  const participation = (uid: string, cancelled = false) => ({
    arrivalMemberUid: uid,
    arrivalDate: "2026-11-05",
    arrivalDateTime: "2026-11-05T13:20:45",
    locationUid: location,
    locationCode1c: null,
    locationName: "Registry Site",
    cancelled,
    fullName: "Registry Example",
  });
  const source = (
    revision: number,
    participations: ReturnType<typeof participation>[],
  ) =>
    arrivalStateSchema.parse({
      personUid,
      code1c,
      revision,
      state: "CURRENT",
      currentArrivalMemberUid: member,
      participations,
    });
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: db });
    projection = new IgArrivalProjectionService(
      prisma,
      {
        identity: vi.fn().mockResolvedValue({
          personUid,
          code1C: code1c,
          recipientType: "person",
          reviewGroup: "IG",
          erpUid: null,
          chatUuid: null,
        }),
      } as never,
      { logInTransaction: vi.fn() } as never,
    );
    registry = new IgArrivalRegistryService(prisma);
    await projection.apply(
      source(1, [participation(member), participation(removed)]),
    );
    await projection.apply(
      source(2, [
        participation(member),
        participation(historical, true),
        participation(historicalActive),
      ]),
    );
    await prisma.igArrivalPerson.create({
      data: {
        personUid: conflictPerson,
        code1c: conflictCode,
        revision: 1n,
        state: "CONFLICT",
        sourceHash: "conflict",
        sourcePayload: {},
        igVerified: true,
        members: {
          create: [
            { ...participation(conflictMember), lastSeenRevision: 1n },
            { ...participation(conflictCancelled, true), lastSeenRevision: 1n },
          ],
        },
      },
    });
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.igArrivalPerson.deleteMany({
      where: { personUid: { in: [personUid, conflictPerson] } },
    });
    await prisma.igEmploymentState.deleteMany({ where: { code1c } });
    await prisma.candidate.deleteMany({ where: { code1c } });
    await prisma.$disconnect();
  });
  it("keeps conflict members exclusively in issues", async () => {
    const groups = await registry.groups(reviewer, { q: "Registry Example" });
    const assigned = groups.items.find((x) => x.group === "assigned")!;
    const issues = groups.items.find((x) => x.group === "issues")!;
    expect(issues).toBeTruthy();
    const issueRows = await registry.participations(reviewer, {
      q: "Registry Example",
      groupKey: issues.groupKey,
      needsAttention: true,
    });
    expect(issueRows.items[0]).toMatchObject({
      candidateId: null,
      needsAttention: true,
      issueCodes: expect.arrayContaining(["PROFILE_MISSING"]),
    });
    const page = await registry.participations(reviewer, {
      q: "Registry Example",
      groupKey: assigned.groupKey,
    });
    expect(page.items.map((x) => x.arrivalMemberUid)).toEqual([member]);
  });
  it("places explicitly cancelled conflict participation in archive issues", async () => {
    const page = await registry.participations(reviewer, {
      q: conflictCode,
      archive: "archive",
      groupKey: "issues",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      arrivalMemberUid: conflictCancelled,
      participationStatus: "CANCELLED",
      personState: "CONFLICT",
      needsAttention: true,
    });
  });
  it("paginates groups and people, binds cursors to filters, and counts before search", async () => {
    const prefix = `page-${randomUUID()}`;
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const members = ids.map(() => randomUUID());
    const site1 = randomUUID(),
      site2 = randomUUID();
    try {
      for (let i = 0; i < ids.length; i++) {
        await prisma.igArrivalPerson.create({
          data: {
            personUid: ids[i],
            code1c: `${prefix}-${i}`,
            revision: 1n,
            state: "CURRENT",
            sourceHash: "x",
            sourcePayload: {},
            igVerified: i !== 3,
            members: {
              create: {
                ...participation(members[i]),
                fullName: `${prefix} name ${i}`,
                locationUid: i === 2 ? site2 : site1,
                arrivalDate: i === 2 ? "2026-11-06" : "2026-11-05",
                lastSeenRevision: 1n,
              },
            },
          },
        });
        await prisma.igArrivalPerson.update({
          where: { personUid: ids[i] },
          data: { currentMemberUid: members[i] },
        });
      }
      const first = await registry.groups(reviewer, { q: prefix, limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).toBeTruthy();
      const second = await registry.groups(reviewer, {
        q: prefix,
        limit: 1,
        cursor: first.nextCursor!,
      });
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(first.items[0]).toMatchObject({
        arrivalDate: "2026-11-05",
        participationCount: 2,
        totalParticipationCount: 2,
      });
      expect(second.items[0]).toMatchObject({
        arrivalDate: "2026-11-06",
        participationCount: 1,
      });
      await expect(
        registry.groups(reviewer, {
          q: prefix + "x",
          limit: 1,
          cursor: first.nextCursor!,
        }),
      ).rejects.toThrow();
      const p1 = await registry.participations(reviewer, {
        q: prefix,
        groupKey: first.items[0].groupKey,
        limit: 1,
      });
      expect(p1.nextCursor).toBeTruthy();
      const p2 = await registry.participations(reviewer, {
        q: prefix,
        groupKey: first.items[0].groupKey,
        limit: 1,
        cursor: p1.nextCursor!,
      });
      expect(p2.nextCursor).toBeNull();
      expect(
        new Set([p1.items[0].arrivalMemberUid, p2.items[0].arrivalMemberUid]),
      ).toEqual(new Set(members.slice(0, 2)));
      const filtered = await registry.groups(reviewer, {
        q: `${prefix}-0`,
        documentStatus: "UNKNOWN",
        needsAttention: true,
        dateFrom: "2026-11-05",
        dateTo: "2026-11-05",
      });
      expect(filtered.items[0]).toMatchObject({
        participationCount: 1,
        totalParticipationCount: 2,
        needsAttentionCount: 1,
      });
      expect(
        (await registry.groups(reviewer, { q: prefix, dateFrom: "2026-11-07" }))
          .items,
      ).toEqual([]);
      expect(
        (await registry.groups(reviewer, { q: prefix, needsAttention: false }))
          .items,
      ).toEqual([]);
      expect(
        (
          await registry.groups(reviewer, {
            q: prefix,
            documentStatus: "APPROVED",
          })
        ).items,
      ).toEqual([]);
    } finally {
      await prisma.igArrivalPerson.deleteMany({
        where: { personUid: { in: ids } },
      });
    }
  });
  it("finds only verified registry locations by name and exact UUID", async () => {
    const matches = await registry.locations(reviewer, { q: "Registry Site" });
    expect(matches.items).toContainEqual({
      locationUid: location,
      locationName: "Registry Site",
    });
    const exact = await registry.locations(reviewer, { locationUid: location });
    expect(exact.items).toEqual([
      { locationUid: location, locationName: "Registry Site" },
    ]);
  });
  it("keeps document, delivery and completion statuses independent", async () => {
    const person = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
    });
    const candidateId = person.candidateId!;
    const returned = await prisma.document.create({
      data: { candidateId, status: "RETURNED" },
    });
    const approved = await prisma.document.create({
      data: {
        candidateId,
        status: "APPROVED",
        versions: {
          create: {
            version: 1,
            status: "APPROVED",
            storageKey: "test",
            delivery: { create: { status: "WAITING_CONTRACT", payload: {} } },
          },
        },
      },
      include: { versions: { include: { delivery: true } } },
    });
    try {
      const group = (await registry.groups(reviewer, { q: code1c })).items[0];
      const read = async () =>
        (
          await registry.participations(reviewer, {
            q: code1c,
            groupKey: group.groupKey,
          })
        ).items[0];
      expect(await read()).toMatchObject({
        documentStatus: "UNKNOWN",
        erpDeliveryStatus: "NEEDS_ATTENTION",
        employmentStatus: "IN_PROGRESS",
        needsAttention: true,
      });
      await prisma.document.delete({ where: { id: returned.id } });
      const delivery = approved.versions[0].delivery!;
      await prisma.erpDocumentDelivery.update({
        where: { id: delivery.id },
        data: { status: "PENDING" },
      });
      expect(await read()).toMatchObject({
        documentStatus: "UNKNOWN",
        erpDeliveryStatus: "PENDING",
        employmentStatus: "IN_PROGRESS",
      });
      await prisma.erpDocumentDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SENT",
          attempts: {
            create: {
              actorId: "test",
              receiptValidated: true,
              startedAt: new Date("2026-11-01T00:00:00Z"),
              finishedAt: new Date("2026-11-01T00:00:01Z"),
            },
          },
        },
      });
      expect(await read()).toMatchObject({
        documentStatus: "UNKNOWN",
        erpDeliveryStatus: "CONFIRMED",
        confirmedDocuments: 1,
        employmentStatus: "IN_PROGRESS",
      });
      await prisma.erpDocumentAttempt.create({
        data: {
          deliveryId: delivery.id,
          actorId: "test",
          receiptValidated: false,
          startedAt: new Date("2026-11-02T00:00:00Z"),
          finishedAt: new Date("2026-11-02T00:00:01Z"),
          errorCode: "BAD_RECEIPT",
        },
      });
      expect(await read()).toMatchObject({
        erpDeliveryStatus: "NEEDS_ATTENTION",
        confirmedDocuments: 0,
      });
      await prisma.documentVersion.update({
        where: { id: approved.versions[0].id },
        data: { ocrSource: "PREVIOUS_LINK", ocrRaw: { source: "ERP" } },
      });
      expect(await read()).toMatchObject({
        erpDeliveryStatus: "CONFIRMED",
        confirmedDocuments: 1,
        needsAttention: true,
      });
    } finally {
      await prisma.document.deleteMany({
        where: { id: { in: [returned.id, approved.id] } },
      });
    }
  });
  it("selects latest snapshot, keeps archive, and paginates filtered groups and members", async () => {
    const groups = await registry.groups(reviewer, { q: code1c, limit: 1 });
    expect(groups.items).toHaveLength(1);
    expect(groups.items[0]).toMatchObject({
      arrivalDate: "2026-11-05",
      locationUid: location,
      participationCount: 1,
    });
    const page = await registry.participations(reviewer, {
      q: code1c,
      groupKey: groups.items[0].groupKey,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      arrivalMemberUid: member,
      arrivalDateTime: "2026-11-05T13:20:45",
      participationStatus: "CURRENT",
      oneCEmploymentStatus: "UNKNOWN",
    });
    const archived = await registry.participations(reviewer, {
      q: code1c,
      archive: "archive",
      groupKey: groups.items[0].groupKey,
    });
    expect(
      archived.items.map((x) => [x.arrivalMemberUid, x.participationStatus]),
    ).toEqual(
      expect.arrayContaining([
        [historical, "CANCELLED"],
        [historicalActive, "HISTORICAL"],
      ]),
    );
    expect(archived.items).toHaveLength(2);
    expect(
      (
        await prisma.igArrivalMember.findUniqueOrThrow({
          where: { arrivalMemberUid: removed },
        })
      ).lastSeenRevision,
    ).toBe(1n);
  });
  it("accepts idempotent replay and refuses stale or conflicting revisions", async () => {
    const current = source(2, [
      participation(member),
      participation(historical, true),
      participation(historicalActive),
    ]);
    expect(await projection.apply(current)).toBe(true);
    expect(await projection.apply(source(1, [participation(member)]))).toBe(
      false,
    );
    const altered = source(2, [
      { ...participation(member), arrivalDateTime: "2026-11-05T15:20:45" },
      participation(historical, true),
      participation(historicalActive),
    ]);
    await expect(projection.apply(altered)).rejects.toThrow(
      "ARRIVAL_REVISION_CONFLICT",
    );
    const row = await prisma.igArrivalMember.findUniqueOrThrow({
      where: { arrivalMemberUid: member },
    });
    expect(row).toMatchObject({
      lastSeenRevision: 2n,
      arrivalDateTime: "2026-11-05T13:20:45",
    });
  });
  it("backfills only members in saved source payload and preserves unknown times", async () => {
    await prisma.igArrivalMember.updateMany({
      where: { personUid },
      data: { lastSeenRevision: null, arrivalDateTime: null },
    });
    const migration = readFileSync(
      resolve(
        __dirname,
        "../../../prisma/migrations/20261108010000_ig_arrival_registry_presence/migration.sql",
      ),
      "utf8",
    );
    const update = migration.match(
      /UPDATE `ig_arrival_members` m[\s\S]*?;/,
    )?.[0];
    expect(update).toBeTruthy();
    await prisma.$executeRawUnsafe(
      update!.slice(0, -1) + " AND p.`personUid` = ?",
      personUid,
    );
    const rows = await prisma.igArrivalMember.findMany({
      where: { personUid },
      orderBy: { arrivalMemberUid: "asc" },
    });
    expect(rows.find((x) => x.arrivalMemberUid === member)).toMatchObject({
      lastSeenRevision: 2n,
      arrivalDateTime: null,
    });
    expect(rows.find((x) => x.arrivalMemberUid === historical)).toMatchObject({
      lastSeenRevision: 2n,
      arrivalDateTime: null,
    });
    expect(rows.find((x) => x.arrivalMemberUid === removed)).toMatchObject({
      lastSeenRevision: null,
      arrivalDateTime: null,
    });
  });
});
