import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../src/prisma/prisma.service";
import { IgArrivalFactsProjectionService } from "../src/documents/ig-arrival-facts-projection.service";

const db = process.env.EDO_TARGETED_TEST_DATABASE_URL;
if (db && db !== "mysql://edo:edo_disposable@127.0.0.1:3307/edo")
  throw new Error("Refuse non-disposable database");
describe.skipIf(!db)("targeted arrival projection", () => {
  const personUid = randomUUID(),
    locationUid = randomUUID(),
    memberUid = randomUUID();
  const code1c = `T-${personUid}`;
  const period = "2026-11-05T13:20:45";
  const prisma = new PrismaService({ datasourceUrl: db });
  const erp = { identity: vi.fn() };
  const service = new IgArrivalFactsProjectionService(
    prisma,
    { logInTransaction: vi.fn() } as never,
    erp as never,
  );
  afterAll(async () => {
    await prisma.igArrivalPerson.deleteMany({ where: { personUid } });
    await prisma.$disconnect();
  });
  it("projects and deletes a person without a lease or candidate, preserving revision for Surveys", async () => {
    const identity = {
      recipientType: "person",
      reviewGroup: "IG",
      personUid,
      code1C: code1c,
      erpUid: null,
      chatUuid: null,
    };
    const fact = {
      sourceKey: `${period}|${personUid}|${locationUid}`,
      period,
      arrivalMemberUid: memberUid,
      arrivalDate: "2026-11-06",
      arrivalDateTime: null,
      locationUid,
      locationCode1c: null,
      locationName: "Site",
      cancelled: false,
      latestSiteStatusCancelled: null,
      fullName: "Person",
      managerCode1c: null,
    };
    await service.applyTargeted(
      { personUid, code1c, participations: [fact] },
      identity,
      true,
    );
    const person = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
    });
    expect(person.factsSeenGeneration).toBeNull();
    expect(person.targetedPendingRevision).toBe(person.revision);
    expect(person.candidateId).toBeNull();
    expect(erp.identity).not.toHaveBeenCalled();
    await service.applyTargetedDeletion(personUid);
    const deleted = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid },
    });
    expect(deleted.state).toBe("NONE");
    expect(deleted.revision).toBeGreaterThan(person.revision);
    expect(deleted.targetedPendingRevision).toBe(deleted.revision);
    expect(
      (
        await prisma.igArrivalMember.findUniqueOrThrow({
          where: { arrivalMemberUid: memberUid },
        })
      ).factsArchived,
    ).toBe(true);
  });
});

describe.skipIf(!db)("targeted versus full scan ordering", () => {
  const uid = randomUUID(),
    location = randomUUID(),
    member = randomUUID(),
    token = randomUUID();
  const code = `T-${uid}`,
    period = "2026-11-05T13:20:45";
  const prisma = new PrismaService({ datasourceUrl: db });
  const service = new IgArrivalFactsProjectionService(
    prisma,
    { logInTransaction: vi.fn() } as never,
    {
      identity: vi.fn(async () => ({
        recipientType: "person",
        reviewGroup: "IG",
        personUid: uid,
        code1C: code,
        erpUid: null,
        chatUuid: null,
      })),
    } as never,
  );
  afterAll(async () => {
    await prisma.igArrivalPerson.deleteMany({ where: { personUid: uid } });
    await prisma.igArrivalSyncState.updateMany({
      where: { id: "singleton", lockToken: token },
      data: { lockToken: null, lockExpiresAt: null },
    });
    await prisma.$disconnect();
  });
  it("does not overwrite or mark missing a targeted update newer than a full scan", async () => {
    const startedAt = new Date(Date.now() - 10_000);
    const lease = {
      lockToken: token,
      generation: 987654n,
      scanStartedAt: startedAt,
    };
    await prisma.igArrivalSyncState.upsert({
      where: { id: "singleton" },
      create: {
        id: "singleton",
        lockToken: token,
        generation: lease.generation,
        lockExpiresAt: new Date(Date.now() + 60_000),
      },
      update: {
        lockToken: token,
        generation: lease.generation,
        lockExpiresAt: new Date(Date.now() + 60_000),
        factsFinishedGeneration: null,
      },
    });
    const identity = {
      recipientType: "person",
      reviewGroup: "IG",
      personUid: uid,
      code1C: code,
      erpUid: null,
      chatUuid: null,
    };
    const fact = {
      sourceKey: `${period}|${uid}|${location}`,
      period,
      arrivalMemberUid: member,
      arrivalDate: "2026-11-06",
      arrivalDateTime: null,
      locationUid: location,
      locationCode1c: null,
      locationName: "Site",
      cancelled: false,
      latestSiteStatusCancelled: null,
      fullName: "Person",
      managerCode1c: null,
    };
    await service.applyTargeted(
      { personUid: uid, code1c: code, participations: [fact] },
      identity,
      true,
    );
    await service.apply(
      { personUid: uid, code1c: code, participations: [] },
      lease,
      [],
    );
    await service.finish(lease);
    const person = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid: uid },
    });
    const saved = await prisma.igArrivalMember.findUniqueOrThrow({
      where: { arrivalMemberUid: member },
    });
    expect(person.state).toBe("CURRENT");
    expect((person.sourcePayload as { state: string }).state).toBe("CURRENT");
    expect(saved.factsMissingPasses).toBe(0);
    expect(saved.factsArchived).toBe(false);
  });
  it("does not overwrite a targeted update arriving after the finish candidate query", async () => {
    const identity = {
      recipientType: "person",
      reviewGroup: "IG",
      personUid: uid,
      code1C: code,
      erpUid: null,
      chatUuid: null,
    };
    const makeFact = (arrivalDate: string) => ({
      sourceKey: `${period}|${uid}|${location}`,
      period,
      arrivalMemberUid: member,
      arrivalDate,
      arrivalDateTime: null,
      locationUid: location,
      locationCode1c: null,
      locationName: "Site",
      cancelled: false,
      latestSiteStatusCancelled: null,
      fullName: "Person",
      managerCode1c: null,
    });
    await service.applyTargeted(
      {
        personUid: uid,
        code1c: code,
        participations: [makeFact("2026-11-06")],
      },
      identity,
      true,
    );
    await prisma.igArrivalPerson.update({
      where: { personUid: uid },
      data: { targetedAppliedAt: new Date("2000-01-01") },
    });
    await prisma.igArrivalMember.update({
      where: { arrivalMemberUid: member },
      data: { factsMissingPasses: 1 },
    });
    const [clock] = await prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT CURRENT_TIMESTAMP(3) AS now`;
    const lease = {
      lockToken: token,
      generation: 987655n,
      scanStartedAt: clock.now,
    };
    await prisma.igArrivalSyncState.update({
      where: { id: "singleton" },
      data: {
        lockToken: token,
        generation: lease.generation,
        lockExpiresAt: new Date(Date.now() + 60_000),
        factsFinishedGeneration: null,
      },
    });
    let injected = false;
    const wrapped = {
      $transaction: (fn: (tx: any) => Promise<unknown>, options: any) =>
        prisma.$transaction(
          async (tx) =>
            fn(
              new Proxy(tx, {
                get(target, property) {
                  if (property !== "igArrivalPerson")
                    return Reflect.get(target, property);
                  return new Proxy(target.igArrivalPerson, {
                    get(model, operation) {
                      if (operation !== "findMany")
                        return Reflect.get(model, operation);
                      return async (...args: any[]) => {
                        const rows = await (model.findMany as any)(...args);
                        if (!injected) {
                          injected = true;
                          await service.applyTargeted(
                            {
                              personUid: uid,
                              code1c: code,
                              participations: [makeFact("2026-11-08")],
                            },
                            identity,
                            true,
                          );
                        }
                        return rows;
                      };
                    },
                  });
                },
              }),
            ),
          options,
        ),
    };
    const finishing = new IgArrivalFactsProjectionService(
      wrapped as never,
      { logInTransaction: vi.fn() } as never,
      {} as never,
    );
    await finishing.finish(lease);
    const person = await prisma.igArrivalPerson.findUniqueOrThrow({
      where: { personUid: uid },
    });
    expect(
      (
        person.sourcePayload as {
          participations: Array<{ arrivalDate: string }>;
        }
      ).participations[0].arrivalDate,
    ).toBe("2026-11-08");
    expect(
      (
        await prisma.igArrivalMember.findUniqueOrThrow({
          where: { arrivalMemberUid: member },
        })
      ).factsArchived,
    ).toBe(false);
  });
});
