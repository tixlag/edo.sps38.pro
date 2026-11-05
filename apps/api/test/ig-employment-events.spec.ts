import { describe, expect, it, vi } from "vitest";
import { IgEmploymentService } from "../src/documents/ig-employment.service";

describe("IG employment grant events", () => {
  it("does not create a second candidate when the event was already committed", async () => {
    const tx = {
      igEmploymentState: { upsert: vi.fn() },
      $queryRaw: vi.fn(),
      igGrantEvent: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ candidateId: "existing", code1c: "worker" }),
      },
      candidate: { create: vi.fn() },
    };
    const prisma = { $transaction: vi.fn((fn) => fn(tx)) };
    const erp = {
      identity: vi.fn().mockResolvedValue({
        reviewGroup: "IG",
        recipientType: "person",
        personUid: "00000000-0000-4000-8000-000000000001",
        code1C: "worker",
      }),
    };
    const service = new IgEmploymentService(
      prisma as never,
      erp as never,
      {} as never,
    );
    await expect(
      service.applyGrant({
        id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
        employeeCode1c: "worker",
        citizenship: "UZ",
        createdAt: "2026-11-03T00:00:00.000Z",
      }),
    ).resolves.toBe("existing");
    expect(tx.candidate.create).not.toHaveBeenCalled();
  });
  it("does not invent a new cycle from a later grant after completion", async () => {
    const previous = {
      id: "old",
      code1c: "worker",
      personUid: "00000000-0000-4000-8000-000000000001",
      citizenship: "uz",
      chatUuid: null,
      igCompletedAt: new Date("2026-11-02T00:00:00.000Z"),
    };
    const tx = {
      igEmploymentState: {
        upsert: vi.fn(),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ currentCandidate: previous }),
        update: vi.fn(),
      },
      $queryRaw: vi.fn(),
      igGrantEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      candidate: {
        create: vi.fn().mockResolvedValue({ id: "new" }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(previous),
      },
      lkEmployee: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const prisma = { $transaction: vi.fn((fn) => fn(tx)) };
    const erp = {
      identity: vi.fn().mockResolvedValue({
        reviewGroup: "IG",
        recipientType: "person",
        personUid: previous.personUid,
        code1C: "worker",
      }),
    };
    const audit = { logInTransaction: vi.fn() };
    const service = new IgEmploymentService(
      prisma as never,
      erp as never,
      audit as never,
    );
    await expect(
      service.applyGrant({
        id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
        employeeCode1c: "worker",
        citizenship: "UZ",
        createdAt: "2026-11-03T00:00:00.000Z",
      }),
    ).resolves.toBe("old");
    expect(tx.candidate.create).not.toHaveBeenCalled();
    expect(tx.igEmploymentState.update).toHaveBeenCalledWith({
      where: { code1c: "worker" },
      data: { currentCandidateId: "old" },
    });
  });
  it("attaches a later access grant to an open cycle started by an upload", async () => {
    const current = {
      id: "from-upload",
      code1c: "worker",
      personUid: "00000000-0000-4000-8000-000000000001",
      citizenship: "uz",
      chatUuid: null,
      igCompletedAt: null,
    };
    const tx = {
      igEmploymentState: {
        upsert: vi.fn(),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ currentCandidate: current }),
        update: vi.fn(),
      },
      $queryRaw: vi.fn(),
      igGrantEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      candidate: {
        create: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue(current),
      },
    };
    const prisma = { $transaction: vi.fn((fn) => fn(tx)) };
    const erp = {
      identity: vi.fn().mockResolvedValue({
        reviewGroup: "IG",
        recipientType: "person",
        personUid: current.personUid,
        code1C: "worker",
      }),
    };
    const service = new IgEmploymentService(
      prisma as never,
      erp as never,
      { logInTransaction: vi.fn() } as never,
    );
    await expect(
      service.applyGrant({
        id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
        employeeCode1c: "worker",
        citizenship: "UZ",
        createdAt: "2026-11-03T00:00:00.000Z",
      }),
    ).resolves.toBe("from-upload");
    expect(tx.candidate.create).not.toHaveBeenCalled();
  });
  it("populates a new IG case from the verified ERP profile when LK projection is not available", async () => {
    const tx = {
      igEmploymentState: {
        upsert: vi.fn(),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ currentCandidate: null }),
        update: vi.fn(),
      },
      $queryRaw: vi.fn(),
      igGrantEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      candidate: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "new" }),
      },
      lkEmployee: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const prisma = { $transaction: vi.fn((fn) => fn(tx)) };
    const erp = {
      identity: vi.fn().mockResolvedValue({
        reviewGroup: "IG",
        recipientType: "person",
        personUid: "00000000-0000-4000-8000-000000000001",
        code1C: "worker",
      }),
    };
    const candidateClient = {
      findByEmployeeCode: vi.fn().mockResolvedValue({
        name: "Тестовый сотрудник",
        position: { code: "pos", name: "Сварщик" },
      }),
    };
    const service = new IgEmploymentService(
      prisma as never,
      erp as never,
      { logInTransaction: vi.fn() } as never,
      candidateClient as never,
    );
    await service.applyGrant({
      id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      employeeCode1c: "worker",
      citizenship: "UZ",
      createdAt: "2026-11-03T00:00:00.000Z",
    });
    expect(tx.candidate.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fullName: "Тестовый сотрудник",
          positionCode: "pos",
        }),
      }),
    );
  });
});
