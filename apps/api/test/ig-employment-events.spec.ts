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
    ).resolves.toEqual({ candidateId: "existing", known: true });
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
    ).resolves.toEqual({ candidateId: "old", known: true });
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
    ).resolves.toEqual({ candidateId: "from-upload", known: true });
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

  it("rejects grant when request personUid mismatches ERP identity", async () => {
    const erp = {
      identity: vi.fn().mockResolvedValue({
        reviewGroup: "IG",
        recipientType: "person",
        personUid: "00000000-0000-4000-8000-000000000001",
        code1C: "worker",
      }),
    };
    const service = new IgEmploymentService(
      {} as never,
      erp as never,
      {} as never,
    );
    await expect(
      service.applyGrant({
        id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
        employeeCode1c: "worker",
        citizenship: "UZ",
        personUid: "00000000-0000-4000-8000-999999999999",
        createdAt: "2026-11-03T00:00:00.000Z",
      }),
    ).rejects.toThrow("ERP_PERSON_IDENTITY_MISMATCH");
  });

  it("rejects grant when citizenship is RU", async () => {
    const erp = {
      identity: vi.fn().mockResolvedValue({
        reviewGroup: "IG",
        recipientType: "person",
        personUid: "00000000-0000-4000-8000-000000000001",
        code1C: "worker",
      }),
    };
    const service = new IgEmploymentService(
      {} as never,
      erp as never,
      {} as never,
    );
    await expect(
      service.applyGrant({
        id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
        employeeCode1c: "worker",
        citizenship: "RU",
        createdAt: "2026-11-03T00:00:00.000Z",
      }),
    ).rejects.toThrow("ERP_PERSON_IDENTITY_MISMATCH");
  });

  it("handles enabled=false without creating candidate if none exists and records event with candidateId=null", async () => {
    const tx = {
      igEmploymentState: {
        upsert: vi.fn(),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ currentCandidate: null }),
      },
      $queryRaw: vi.fn(),
      igGrantEvent: { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn() },
      candidate: { create: vi.fn(), delete: vi.fn() },
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
      { logInTransaction: vi.fn() } as never,
    );
    const result = await service.applyGrant({
      id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      employeeCode1c: "worker",
      citizenship: "UZ",
      enabled: false,
      createdAt: "2026-11-03T00:00:00.000Z",
    });
    expect(result).toEqual({ candidateId: null, known: false });
    expect(tx.candidate.create).not.toHaveBeenCalled();
    expect(tx.candidate.delete).not.toHaveBeenCalled();
    expect(tx.igGrantEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "worker",
          candidateId: null,
          enabled: false,
        }),
      }),
    );
  });

  it("handles enabled=false without deleting existing candidate or documents", async () => {
    const candidate = {
      id: "cand-1",
      code1c: "worker",
      personUid: "00000000-0000-4000-8000-000000000001",
      reviewGroup: "IG",
    };
    const tx = {
      igEmploymentState: {
        upsert: vi.fn(),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ currentCandidate: candidate }),
      },
      $queryRaw: vi.fn(),
      igGrantEvent: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      candidate: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
        delete: vi.fn(),
      },
      document: { delete: vi.fn(), deleteMany: vi.fn() },
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
    const audit = { logInTransaction: vi.fn() };
    const service = new IgEmploymentService(
      prisma as never,
      erp as never,
      audit as never,
    );
    const result = await service.applyGrant({
      id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
      employeeCode1c: "worker",
      citizenship: "UZ",
      enabled: false,
      createdAt: "2026-11-03T00:00:00.000Z",
    });
    expect(result).toEqual({ candidateId: "cand-1", known: true });
    expect(tx.candidate.delete).not.toHaveBeenCalled();
    expect(tx.document.delete).not.toHaveBeenCalled();
    expect(tx.document.deleteMany).not.toHaveBeenCalled();
    expect(tx.igGrantEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
          code1c: "worker",
          candidateId: "cand-1",
          enabled: false,
        }),
      }),
    );
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        after: { source: "ADAPTATION_ACCESS", enabled: false },
      }),
    );
  });

  describe("idempotency and payload hash verification", () => {
    it("rejects repeat grant when citizenship changes with identical operationId", async () => {
      const tx = {
        igEmploymentState: { upsert: vi.fn() },
        $queryRaw: vi.fn(),
        igGrantEvent: {
          findUnique: vi.fn().mockResolvedValue({
            id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
            code1c: "worker",
            candidateId: "cand-1",
            payloadHash: "hash-of-uz",
          }),
        },
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
          citizenship: "TJ",
          createdAt: "2026-11-03T00:00:00.000Z",
        }),
      ).rejects.toThrow("IG_GRANT_EVENT_CONFLICT");
    });

    it("rejects repeat grant when enabled status changes with identical operationId", async () => {
      const tx = {
        igEmploymentState: { upsert: vi.fn() },
        $queryRaw: vi.fn(),
        igGrantEvent: {
          findUnique: vi.fn().mockResolvedValue({
            id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
            code1c: "worker",
            candidateId: "cand-1",
            payloadHash: "hash-of-enabled-true",
          }),
        },
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
          enabled: false,
          createdAt: "2026-11-03T00:00:00.000Z",
        }),
      ).rejects.toThrow("IG_GRANT_EVENT_CONFLICT");
    });

    it("rejects repeat grant on historical event (without payloadHash) when fields mismatch", async () => {
      const tx = {
        igEmploymentState: { upsert: vi.fn() },
        $queryRaw: vi.fn(),
        igGrantEvent: {
          findUnique: vi.fn().mockResolvedValue({
            id: "58da5ed9-5eaa-4a36-9aa1-87379cc2bce9",
            code1c: "worker",
            candidateId: "cand-1",
            payloadHash: null,
            citizenship: "uz",
            enabled: true,
          }),
        },
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
          enabled: false,
          createdAt: "2026-11-03T00:00:00.000Z",
        }),
      ).rejects.toThrow("IG_GRANT_EVENT_CONFLICT");
    });
  });
});
