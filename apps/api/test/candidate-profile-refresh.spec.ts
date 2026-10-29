import { describe, expect, it, vi } from "vitest";
import { CandidateProfileRefresh } from "../src/documents/candidate-profile-refresh";
import { loadCandidateRefresh } from "../src/documents/load-candidate-refresh";

describe("candidate profile refresh", () => {
  it("refreshes a code-only candidate even when the ERP card contains an unlinked chat UUID", async () => {
    const links = { byUuid: vi.fn() };
    const erp = {
      findByEmployeeCode: vi
        .fn()
        .mockResolvedValue({
          uuid: "00000000-0000-4000-8000-000000000001",
          code1C: "E1",
        }),
    };
    const result = await loadCandidateRefresh(
      { code1c: "E1", chatUuid: null },
      new AbortController().signal,
      links as never,
      erp as never,
    );
    expect(result).toMatchObject({ code1c: "E1", chatUuid: null });
    expect(links.byUuid).not.toHaveBeenCalled();
  });
  it("previews an existing employee profile without writing and applies it with an audit", async () => {
    const row = {
      id: "c1",
      chatUuid: null,
      code1c: "E1",
      updatedAt: new Date("2026-01-01"),
      fullName: "Старое имя",
    };
    const tx = {
      $queryRaw: vi.fn(),
      candidate: {
        findUnique: vi.fn().mockResolvedValue(row),
        update: vi.fn(),
      },
    };
    const db = {
      candidate: { findMany: vi.fn().mockResolvedValue([row]) },
      $transaction: vi.fn(async (f) => f(tx)),
    };
    const audit = { logInTransaction: vi.fn() };
    const load = vi.fn().mockResolvedValue({
      code1c: "E1",
      chatUuid: null,
      candidateSnapshot: { name: "Новое имя", sex: "female", sexKnown: true },
    });
    const service = new CandidateProfileRefresh(
      db as never,
      audit as never,
      load,
    );
    const options = { limit: 10, signal: new AbortController().signal };
    expect(
      (await service.run({ ...options, apply: false })).results[0],
    ).toMatchObject({
      status: "WOULD_SYNC",
      fields: expect.arrayContaining(["fullName", "sex"]),
    });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(
      (await service.run({ ...options, apply: true })).results[0].status,
    ).toBe("SYNCED");
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        before: expect.objectContaining({ fullName: "Старое имя" }),
        after: expect.objectContaining({ fullName: "Новое имя" }),
      }),
    );
  });
  it("does not update a changed identity or a concurrently edited profile", async () => {
    const row = {
      id: "c1",
      chatUuid: null,
      code1c: "E1",
      updatedAt: new Date("2026-01-01"),
    };
    const current = { ...row, updatedAt: new Date("2026-01-02") };
    const tx = {
      $queryRaw: vi.fn(),
      candidate: {
        findUnique: vi.fn().mockResolvedValue(current),
        update: vi.fn(),
      },
    };
    const db = {
      candidate: { findMany: vi.fn().mockResolvedValue([row]) },
      $transaction: vi.fn(async (f) => f(tx)),
    };
    const audit = { logInTransaction: vi.fn() };
    const load = vi.fn().mockResolvedValue({
      code1c: "wrong",
      chatUuid: null,
      candidateSnapshot: { name: "Имя" },
    });
    const service = new CandidateProfileRefresh(
      db as never,
      audit as never,
      load,
    );
    const options = {
      limit: 10,
      apply: true,
      signal: new AbortController().signal,
    };
    expect((await service.run(options)).results[0].status).toBe(
      "IDENTITY_MISMATCH",
    );
    load.mockResolvedValue({
      code1c: "E1",
      chatUuid: null,
      candidateSnapshot: { name: "Имя" },
    });
    expect((await service.run(options)).results[0].status).toBe(
      "SKIPPED_CONCURRENT",
    );
    expect(tx.candidate.update).not.toHaveBeenCalled();
    expect(audit.logInTransaction).not.toHaveBeenCalled();
  });
});
