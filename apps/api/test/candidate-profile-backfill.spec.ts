import { describe, expect, it, vi } from "vitest";
import { CandidateProfileBackfill } from "../src/documents/candidate-profile-backfill";

const uuid = "019d0a2a-f080-762e-b2d0-c7bb7ddb1922";
const owner = {
  id: "c1",
  chatUuid: uuid,
  code1c: null,
  profileSyncedAt: null,
  fullName: null,
};
const context = {
  chatUuid: uuid,
  candidateSnapshot: {
    uuid,
    name: "Иван Петров",
    citizenship: "RU",
    position: { code: "P1" },
  },
};
function setup() {
  const tx = {
    $queryRaw: vi.fn(),
    candidate: {
      findUnique: vi.fn().mockResolvedValue(owner),
      update: vi.fn(),
    },
  };
  const prisma = {
    candidate: { findMany: vi.fn().mockResolvedValue([owner]) },
    $transaction: vi.fn(
      async (action: (client: typeof tx) => Promise<unknown>) => action(tx),
    ),
  };
  const audit = { logInTransaction: vi.fn() };
  const load = vi.fn().mockResolvedValue(context);
  const run = (apply = false) =>
    new CandidateProfileBackfill(prisma as never, audit as never, load).run({
      apply,
      limit: 5,
      signal: new AbortController().signal,
    });
  return { tx, prisma, audit, load, run };
}
describe("candidate profile backfill", () => {
  it("previews fields without writing and never returns profile values", async () => {
    const { run, prisma, audit } = setup();
    const report = await run();
    expect(report.results[0]).toMatchObject({
      candidateId: "c1",
      status: "WOULD_SYNC",
    });
    expect(JSON.stringify(report)).not.toContain("Иван");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.logInTransaction).not.toHaveBeenCalled();
    expect(prisma.candidate.findMany.mock.calls[0][0]).toMatchObject({
      where: { profileSyncedAt: null },
      take: 6,
    });
  });
  it("stores the normalized profile and audit in the same locked transaction", async () => {
    const { run, tx, audit } = setup();
    const report = await run(true);
    expect(report.synced).toBe(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.candidate.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: expect.objectContaining({
        fullName: "Иван Петров",
        citizenship: "ru",
        positionCode: "P1",
        profileSyncedAt: expect.any(Date),
      }),
    });
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        entityType: "Candidate",
        entityId: "c1",
        action: "DATA_IMPORTED",
        before: expect.objectContaining({ fullName: null }),
      }),
    );
  });
  it("skips a concurrent upload or a changed owner identity after locking", async () => {
    for (const current of [
      { ...owner, profileSyncedAt: new Date() },
      { ...owner, chatUuid: "changed" },
      { ...owner, code1c: "changed" },
      null,
    ]) {
      const { run, tx } = setup();
      tx.candidate.findUnique.mockResolvedValue(current);
      expect((await run(true)).results[0].status).toBe("SKIPPED_CONCURRENT");
      expect(tx.candidate.update).not.toHaveBeenCalled();
    }
  });
  it.each([
    [{ ...context, chatUuid: "wrong" }, "IDENTITY_MISMATCH"],
    [
      {
        ...context,
        candidateSnapshot: { ...context.candidateSnapshot, uuid: "wrong" },
      },
      "IDENTITY_MISMATCH",
    ],
    [{ ...context, candidateSnapshot: { uuid } }, "MISSING_FULL_NAME"],
    [
      {
        ...context,
        candidateSnapshot: {
          ...context.candidateSnapshot,
          birthDate: "1990-02-31",
        },
      },
      "INVALID_PROFILE",
    ],
  ])("rejects incomplete or mismatched source cards", async (value, status) => {
    const { run, load, prisma } = setup();
    load.mockResolvedValue(value);
    expect((await run(true)).results[0].status).toBe(status);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it("reports unavailable sources without writes or leaking server errors", async () => {
    const { run, load, prisma } = setup();
    load.mockRejectedValue(new Error("LK_HTTP_503"));
    expect((await run(true)).failed).toBe(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    load.mockRejectedValue(new Error("sensitive server body"));
    expect(JSON.stringify(await run(true))).not.toContain("sensitive");
  });
  it("propagates audit failure out of the transaction and reports no successful import", async () => {
    const { run, audit } = setup();
    audit.logInTransaction.mockRejectedValue(new Error("audit down"));
    expect(await run(true)).toMatchObject({ synced: 0, failed: 1 });
  });
});
