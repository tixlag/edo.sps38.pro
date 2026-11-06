import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { IgArrivalProjectionService } from "../src/documents/ig-arrival-projection.service";
import { IgArrivalQueueService } from "../src/documents/ig-arrival-queue.service";
import { arrivalStateSchema } from "../src/documents/ig-arrival-contract";
const db = process.env.EDO_TEST_DATABASE_URL;
if (db && db !== "mysql://root:ig-isolated-test-20261105@127.0.0.1:33307/edo")
  throw new Error("Refuse non-task database");
describe.skipIf(!db)("arrival queue verified IG direction", () => {
  let prisma: PrismaService;
  const persons: string[] = [],
    codes: string[] = [];
  const reviewer = { uuid: "reviewer", accessRules: { "20011": [] } } as never;
  const create = () => {
    const personUid = randomUUID(),
      code1c = `i-${randomUUID()}`,
      memberUid = randomUUID(),
      locationUid = randomUUID();
    persons.push(personUid);
    codes.push(code1c);
    return arrivalStateSchema.parse({
      personUid,
      code1c,
      revision: 1,
      state: "CURRENT",
      currentArrivalMemberUid: memberUid,
      participations: [
        {
          arrivalMemberUid: memberUid,
          arrivalDate: "2026-11-05",
          locationUid,
          locationName: "Object",
          locationCode1c: null,
          fullName: "Private name",
          cancelled: false,
        },
      ],
    });
  };
  const good = (item: ReturnType<typeof create>) => ({
    personUid: item.personUid,
    code1C: item.code1c,
    recipientType: "person",
    reviewGroup: "IG",
    erpUid: null,
    chatUuid: null,
  });
  beforeAll(() => {
    prisma = new PrismaService({ datasourceUrl: db });
  });
  afterAll(async () => {
    await prisma.igArrivalPerson.deleteMany({
      where: { personUid: { in: persons } },
    });
    await prisma.igEmploymentState.deleteMany({
      where: { code1c: { in: codes } },
    });
    await prisma.candidate.deleteMany({ where: { code1c: { in: codes } } });
    await prisma.$disconnect();
  });
  it.each(["ru", "other-person", "unavailable"])(
    "hides %s identity from IG groups and people",
    async (reason) => {
      const item = create();
      const identity =
        reason === "unavailable"
          ? vi
              .fn()
              .mockRejectedValue(
                new ServiceUnavailableException("ERP_UNAVAILABLE"),
              )
          : vi.fn().mockResolvedValue(
              reason === "ru"
                ? {
                    ...good(item),
                    reviewGroup: "RU",
                    recipientType: "candidate",
                    erpUid: randomUUID(),
                  }
                : { ...good(item), personUid: randomUUID() },
            );
      const projection = new IgArrivalProjectionService(
        prisma,
        { identity } as never,
        { logInTransaction: vi.fn() } as never,
      );
      await projection.apply(item);
      const queue = new IgArrivalQueueService(prisma);
      expect((await queue.groups(reviewer, { q: item.code1c })).items).toEqual(
        [],
      );
      expect(
        (
          await queue.people(reviewer, {
            group: "assigned",
            arrivalDate: "2026-11-05",
            locationUid: item.participations[0].locationUid!,
            q: item.code1c,
          })
        ).items,
      ).toEqual([]);
    },
  );
  it("keeps proven IG on outage, quarantines explicit ERP conflict, and restores on recheck", async () => {
    const item = create();
    const identity = vi.fn().mockResolvedValue(good(item));
    const projection = new IgArrivalProjectionService(
      prisma,
      { identity } as never,
      { logInTransaction: vi.fn() } as never,
    );
    const queue = new IgArrivalQueueService(prisma);
    await projection.apply(item);
    expect(
      (await queue.groups(reviewer, { q: item.code1c })).items,
    ).toHaveLength(1);
    identity.mockClear();
    await projection.apply(item);
    expect(identity).not.toHaveBeenCalled();
    const newer = { ...item, revision: 2 };
    identity.mockRejectedValueOnce(
      new ServiceUnavailableException("ERP_UNAVAILABLE"),
    );
    await projection.apply(newer);
    expect(
      (await queue.groups(reviewer, { q: item.code1c })).items,
    ).toHaveLength(1);
    identity.mockRejectedValueOnce(
      new ConflictException("CURRENT_CANDIDATE_AMBIGUOUS"),
    );
    await projection.apply(newer);
    expect(
      (await queue.groups(reviewer, { q: item.code1c })).items,
    ).toHaveLength(0);
    await projection.apply(newer);
    expect(
      (await queue.groups(reviewer, { q: item.code1c })).items,
    ).toHaveLength(1);
    identity.mockClear();
    expect(await projection.apply(item)).toBe(false);
    expect(identity).not.toHaveBeenCalled();
    identity.mockRejectedValueOnce(
      new ServiceUnavailableException("ERP_WORKSPACE_CONTRACT_ERROR"),
    );
    await projection.apply({ ...newer, revision: 3 });
    expect(
      (await queue.groups(reviewer, { q: item.code1c })).items,
    ).toHaveLength(0);
  });
  it("matches equivalent UUID casing from ERP before granting IG visibility", async () => {
    const item = create();
    const projection = new IgArrivalProjectionService(
      prisma,
      {
        identity: vi
          .fn()
          .mockResolvedValue({
            ...good(item),
            personUid: item.personUid.toUpperCase(),
          }),
      } as never,
      { logInTransaction: vi.fn() } as never,
    );
    await projection.apply(item);
    expect(
      (
        await new IgArrivalQueueService(prisma).groups(reviewer, {
          q: item.code1c,
        })
      ).items,
    ).toHaveLength(1);
  });
  it("keeps verified IG visible when candidate binding is ambiguous", async () => {
    const item = create();
    await prisma.candidate.createMany({
      data: [1, 2].map(() => ({
        identityKey: `test:${randomUUID()}`,
        code1c: item.code1c,
        personUid: item.personUid,
        reviewGroup: "IG" as const,
      })),
    });
    const projection = new IgArrivalProjectionService(
      prisma,
      { identity: vi.fn().mockResolvedValue(good(item)) } as never,
      { logInTransaction: vi.fn() } as never,
    );
    await projection.apply(item);
    const queue = new IgArrivalQueueService(prisma);
    expect((await queue.groups(reviewer, { q: item.code1c })).items).toEqual([
      expect.objectContaining({
        group: "assigned",
        total: 1,
        needsAttention: 1,
      }),
    ]);
    expect(
      (
        await queue.people(reviewer, {
          group: "assigned",
          arrivalDate: "2026-11-05",
          locationUid: item.participations[0].locationUid!,
          q: item.code1c,
        })
      ).items[0],
    ).toMatchObject({
      candidateId: null,
      issueCode: "ARRIVAL_OWNER_AMBIGUOUS",
    });
    await expect(
      queue.groups({ uuid: "ru", accessRules: { "20002": [] } } as never, {}),
    ).rejects.toThrow();
  });
});
