import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { igUploadOwner } from "../src/documents/ig-upload-owner";
import { IgArrivalQueueService } from "../src/documents/ig-arrival-queue.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IgArrivalProjectionService } from "../src/documents/ig-arrival-projection.service";
import { arrivalStateSchema } from "../src/documents/ig-arrival-contract";
const db = process.env.EDO_TEST_DATABASE_URL;
if (db && db !== "mysql://root:ig-isolated-test-20261105@127.0.0.1:33307/edo")
  throw new Error("Refuse non-task database");
describe.skipIf(!db)("IG arrival projection on task MariaDB", () => {
  const personUid = randomUUID(),
    memberUid = randomUUID(),
    secondMember = randomUUID(),
    objectUid = randomUUID(),
    code1c = `ig-${randomUUID()}`;
  let prisma: PrismaService, service: IgArrivalProjectionService;
  let testTypeId: string | undefined;
  const raceCode1 = `ig-${randomUUID()}`,
    raceCode2 = `ig-${randomUUID()}`,
    racePerson1 = randomUUID(),
    racePerson2 = randomUUID();
  const orphanCode = `ig-${randomUUID()}`,
    orphanPerson = randomUUID(),
    orphanMember = randomUUID();
  const otherCode = `ig-${randomUUID()}`,
    otherPerson = randomUUID(),
    otherMember = randomUUID();
  const identity = vi.fn(async () => ({
    personUid,
    code1C: code1c,
    recipientType: "person" as const,
    reviewGroup: "IG" as const,
    erpUid: null,
    chatUuid: null,
  }));
  const source = (
    revision: number,
    state: "CURRENT" | "NONE" = "CURRENT",
    member = memberUid,
  ) =>
    arrivalStateSchema.parse({
      personUid,
      code1c,
      revision,
      state,
      currentArrivalMemberUid: state === "CURRENT" ? member : null,
      participations: [
        {
          arrivalMemberUid: member,
          arrivalDate: "2026-11-05",
          locationUid: objectUid,
          locationCode1c: null,
          locationName: "Site",
          cancelled: state === "NONE",
        },
      ],
    });
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: db });
    service = new IgArrivalProjectionService(
      prisma,
      { identity } as never,
      { logInTransaction: vi.fn() } as never,
    );
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.igArrivalPerson.deleteMany({
      where: {
        personUid: {
          in: [personUid, otherPerson, orphanPerson, racePerson1, racePerson2],
        },
      },
    });
    await prisma.igEmploymentState.deleteMany({
      where: {
        code1c: { in: [code1c, otherCode, orphanCode, raceCode1, raceCode2] },
      },
    });
    await prisma.candidate.deleteMany({
      where: {
        code1c: { in: [code1c, otherCode, orphanCode, raceCode1, raceCode2] },
      },
    });
    if (testTypeId)
      await prisma.documentType.deleteMany({ where: { id: testTypeId } });
    await prisma.$disconnect();
  });
  it("serializes replay and stale revisions, moves current, cancels and retains history", async () => {
    await Promise.all([service.apply(source(1)), service.apply(source(1))]);
    let row = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
      include: { members: true },
    });
    expect(row.revision).toBe(1n);
    expect(row.members).toHaveLength(1);
    expect(row.candidateId).toBeTruthy();
    const queue = new IgArrivalQueueService(prisma);
    const reviewer = { uuid: "test", accessRules: { "20011": [] } } as never;
    const groups = await queue.groups(reviewer, { q: code1c });
    expect(groups.items).toEqual([
      expect.objectContaining({
        group: "assigned",
        arrivalDate: "2026-11-05",
        locationUid: objectUid,
        total: 1,
        approved: 0,
        confirmed: 0,
      }),
    ]);
    const people = await queue.people(reviewer, {
      group: "assigned",
      arrivalDate: "2026-11-05",
      locationUid: objectUid,
      q: code1c,
    });
    expect(people.items).toEqual([
      expect.objectContaining({
        personUid,
        code1c,
        candidateId: row.candidateId,
        arrivalMemberUid: memberUid,
      }),
    ]);
    expect(groups.items[0]).toMatchObject({
      waitingDocuments: 1,
      inReview: 0,
      returned: 0,
      sending: 0,
      completed: 0,
      needsAttention: 0,
    });
    expect(people.items[0]).toMatchObject({
      primaryStatus: "waitingDocuments",
      needsAttention: false,
    });
    await prisma.candidate.update({
      where: { id: row.candidateId! },
      data: { igRequirementsConflict: true },
    });
    expect(
      (await queue.groups(reviewer, { q: code1c })).items[0],
    ).toMatchObject({ group: "assigned", needsAttention: 1 });
    expect(
      (
        await queue.people(reviewer, {
          group: "assigned",
          arrivalDate: "2026-11-05",
          locationUid: objectUid,
          q: code1c,
        })
      ).items[0],
    ).toMatchObject({
      needsAttention: true,
      issueCode: "ERP_IG_REQUIREMENTS_CONFLICT",
    });
    const type = await prisma.documentType.create({
      data: { code: `test-${randomUUID()}`, title: "Test" },
    });
    testTypeId = type.id;
    const doc = await prisma.document.create({
      data: {
        candidateId: row.candidateId!,
        documentTypeId: type.id,
        currentVersion: 1,
        status: "IN_REVIEW",
      },
    });
    await prisma.documentVersion.create({
      data: {
        documentId: doc.id,
        version: 1,
        storageKey: "test",
        status: "IN_REVIEW",
      },
    });
    expect(
      (await queue.groups(reviewer, { q: code1c })).items[0],
    ).toMatchObject({ inReview: 1, waitingDocuments: 0 });
    await prisma.document.update({
      where: { id: doc.id },
      data: { status: "RETURNED" },
    });
    expect(
      (await queue.groups(reviewer, { q: code1c })).items[0],
    ).toMatchObject({ returned: 1 });
    await prisma.document.update({
      where: { id: doc.id },
      data: { status: "APPROVED" },
    });
    await prisma.documentVersion.updateMany({
      where: { documentId: doc.id },
      data: { status: "APPROVED" },
    });
    expect(
      (await queue.groups(reviewer, { q: code1c })).items[0],
    ).toMatchObject({ sending: 1, completed: 0 });
    await prisma.candidate.update({
      where: { id: row.candidateId! },
      data: {
        igCompletionVerified: true,
        igCompletedAt: new Date(),
        igRequirementsConflict: false,
      },
    });
    expect(
      (await queue.groups(reviewer, { q: code1c })).items[0],
    ).toMatchObject({ completed: 1 });
    const candidateId = row.candidateId;
    identity.mockRejectedValueOnce(new Error("unavailable"));
    await service.apply(source(1));
    row = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
      include: { members: true },
    });
    expect(row.candidateId).toBe(candidateId);
    expect(row.bindingError).toBe("ERP_PERSON_IDENTITY_UNAVAILABLE");
    expect(
      (await queue.groups(reviewer, { q: code1c })).items[0],
    ).toMatchObject({ group: "assigned", needsAttention: 1 });
    await service.apply(source(1));
    row = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
      include: { members: true },
    });
    expect(row.candidateId).toBe(candidateId);
    expect(row.bindingError).toBeNull();
    identity.mockResolvedValueOnce({
      personUid: randomUUID(),
      code1C: code1c,
      recipientType: "person",
      reviewGroup: "IG",
      erpUid: null,
      chatUuid: null,
    });
    await service.apply(source(1));
    row = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
      include: { members: true },
    });
    expect(row.candidateId).toBeNull();
    expect(row.bindingError).toBe("ERP_PERSON_IDENTITY_MISMATCH");
    expect(
      (await queue.groups(reviewer, { q: code1c })).items[0],
    ).toMatchObject({ group: "assigned", needsAttention: 1 });
    await service.apply(source(1));
    row = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
      include: { members: true },
    });
    expect(row.candidateId).toBe(candidateId);
    expect(await prisma.candidate.count({ where: { code1c } })).toBe(1);
    const changedSameRevision = source(1);
    changedSameRevision.participations[0].locationName = "Conflicting label";
    await expect(service.apply(changedSameRevision)).rejects.toThrow(
      "ARRIVAL_REVISION_CONFLICT",
    );
    const foreign = new IgArrivalProjectionService(
      prisma,
      {
        identity: vi.fn(async () => ({
          personUid: otherPerson,
          code1C: otherCode,
          recipientType: "person",
          reviewGroup: "IG",
          erpUid: null,
          chatUuid: null,
        })),
      } as never,
      { logInTransaction: vi.fn() } as never,
    );
    const stolen = arrivalStateSchema.parse({
      ...source(1),
      personUid: otherPerson,
      code1c: otherCode,
    });
    await expect(foreign.apply(stolen)).rejects.toThrow(
      "ARRIVAL_MEMBER_OWNER_CONFLICT",
    );
    expect(
      (
        await prisma.igArrivalMember.findUniqueOrThrow({
          where: { arrivalMemberUid: memberUid },
        })
      ).personUid,
    ).toBe(personUid);
    const moved = source(2);
    moved.participations[0].arrivalDate = "2026-11-06";
    moved.participations[0].fullName = "Updated Name";
    await service.apply(moved);
    expect(await service.apply(source(1))).toBe(false);
    row = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
      include: { members: true },
    });
    expect(row.revision).toBe(2n);
    expect(row.members[0].arrivalDate).toBe("2026-11-06");
    expect(
      (await queue.groups(reviewer, { q: "Updated Name" })).items[0],
    ).toMatchObject({ arrivalDate: "2026-11-06", total: 1 });
    expect(
      (
        await queue.people(reviewer, {
          group: "assigned",
          arrivalDate: "2026-11-06",
          locationUid: objectUid,
          q: "Updated Name",
        })
      ).items[0],
    ).toMatchObject({ fullName: "Updated Name" });
    await expect(
      service.apply({ ...moved, code1c: "other" }),
    ).rejects.toThrow();
    await service.apply(source(3, "NONE"));
    row = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
      include: { members: true },
    });
    expect(row.currentMemberUid).toBeNull();
    expect(row.members).toHaveLength(1);
    expect((await queue.groups(reviewer, { q: code1c })).items).toHaveLength(0);
    await service.apply(source(4, "CURRENT", secondMember));
    row = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
      include: { members: true },
    });
    expect(row.members).toHaveLength(2);
    expect(row.currentMemberUid).toBe(secondMember);
    const conflict = source(5, "NONE", secondMember);
    conflict.state = "CONFLICT";
    await service.apply(conflict);
    const issues = await queue.groups(reviewer, { q: code1c });
    expect(issues.items).toEqual([
      expect.objectContaining({ group: "issues", total: 1 }),
    ]);
    expect(
      (await queue.people(reviewer, { group: "issues", q: code1c })).items[0],
    ).toMatchObject({
      state: "CONFLICT",
      issueCode: "ARRIVAL_SOURCE_CONFLICT",
    });
  });
  it("binds an upload-first person without creating another case", async () => {
    const owner = await prisma.$transaction((tx) =>
      igUploadOwner(tx, otherCode, "uz"),
    );
    const other = new IgArrivalProjectionService(
      prisma,
      {
        identity: vi.fn(async () => ({
          personUid: otherPerson,
          code1C: otherCode,
          recipientType: "person",
          reviewGroup: "IG",
          erpUid: null,
          chatUuid: null,
        })),
      } as never,
      { logInTransaction: vi.fn() } as never,
    );
    const item = arrivalStateSchema.parse({
      personUid: otherPerson,
      code1c: otherCode,
      revision: 1,
      state: "CURRENT",
      currentArrivalMemberUid: otherMember,
      participations: [
        {
          arrivalMemberUid: otherMember,
          arrivalDate: null,
          locationUid: null,
          locationCode1c: null,
          locationName: null,
          cancelled: false,
        },
      ],
    });
    await other.apply(item);
    const projected = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid: otherPerson },
    });
    expect(projected.candidateId).toBe(owner.id);
    expect(
      (await prisma.candidate.findUniqueOrThrow({ where: { id: owner.id } }))
        .personUid,
    ).toBe(otherPerson);
    expect(await prisma.candidate.count({ where: { code1c: otherCode } })).toBe(
      1,
    );
    const queue = new IgArrivalQueueService(prisma);
    const reviewer = { uuid: "test", accessRules: { "20011": [] } } as never;
    expect((await queue.groups(reviewer, { q: otherCode })).items).toEqual([
      expect.objectContaining({ group: "issues", total: 1 }),
    ]);
    expect(
      (await queue.people(reviewer, { group: "issues", q: otherCode })).items,
    ).toEqual([
      expect.objectContaining({
        personUid: otherPerson,
        issueCode: "ARRIVAL_GROUP_UNASSIGNED",
      }),
    ]);
  });
  it("reuses one verified existing case even when its state pointer is absent", async () => {
    const owner = await prisma.candidate.create({
      data: {
        identityKey: `legacy:${randomUUID()}`,
        code1c: orphanCode,
        personUid: orphanPerson,
        reviewGroup: "IG",
        citizenship: "uz",
      },
    });
    const projection = new IgArrivalProjectionService(
      prisma,
      {
        identity: vi.fn(async () => ({
          personUid: orphanPerson,
          code1C: orphanCode,
          recipientType: "person",
          reviewGroup: "IG",
          erpUid: null,
          chatUuid: null,
        })),
      } as never,
      { logInTransaction: vi.fn() } as never,
    );
    await projection.apply(
      arrivalStateSchema.parse({
        personUid: orphanPerson,
        code1c: orphanCode,
        revision: 1,
        state: "CURRENT",
        currentArrivalMemberUid: orphanMember,
        participations: [
          {
            arrivalMemberUid: orphanMember,
            arrivalDate: null,
            locationUid: null,
            locationCode1c: null,
            locationName: null,
            cancelled: false,
          },
        ],
      }),
    );
    expect(
      (
        await prisma.igArrivalPerson.findUniqueOrThrow({
          where: { personUid: orphanPerson },
        })
      ).candidateId,
    ).toBe(owner.id);
    expect(
      await prisma.candidate.count({ where: { code1c: orphanCode } }),
    ).toBe(1);
  });
  it("does not allow concurrent people to claim the same participation", async () => {
    const shared = randomUUID();
    const build = (personUid: string, code1c: string) =>
      arrivalStateSchema.parse({
        personUid,
        code1c,
        revision: 1,
        state: "CURRENT",
        currentArrivalMemberUid: shared,
        participations: [
          {
            arrivalMemberUid: shared,
            arrivalDate: "2026-11-05",
            locationUid: objectUid,
            locationCode1c: null,
            locationName: "Site",
            cancelled: false,
          },
        ],
      });
    const serviceFor = (personUid: string, code1c: string) =>
      new IgArrivalProjectionService(
        prisma,
        {
          identity: vi.fn(async () => ({
            personUid,
            code1C: code1c,
            recipientType: "person",
            reviewGroup: "IG",
            erpUid: null,
            chatUuid: null,
          })),
        } as never,
        { logInTransaction: vi.fn() } as never,
      );
    const result = await Promise.allSettled([
      serviceFor(racePerson1, raceCode1).apply(build(racePerson1, raceCode1)),
      serviceFor(racePerson2, raceCode2).apply(build(racePerson2, raceCode2)),
    ]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(result.filter((item) => item.status === "rejected")).toHaveLength(1);
    const owned = await prisma.igArrivalMember.findUniqueOrThrow({
      where: { arrivalMemberUid: shared },
    });
    expect([racePerson1, racePerson2]).toContain(owned.personUid);
  });
});
