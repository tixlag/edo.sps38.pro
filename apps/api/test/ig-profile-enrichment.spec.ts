import { describe, expect, it, vi } from "vitest";
import { IgProfileEnrichmentService } from "../src/documents/ig-profile-enrichment.service";

describe("IgProfileEnrichmentService", () => {
  it("enriches missing profile and previous documents for new IG candidate", async () => {
    const candidate = {
      id: "cand-1",
      reviewGroup: "IG",
      code1c: "IG-001",
      personUid: "11111111-1111-1111-1111-111111111111",
      chatUuid: null,
      fullName: null,
      positionCode: null,
      positionName: null,
      citizenship: "uz",
      profileSyncedAt: null,
      previousDocumentsSyncedAt: null,
    };

    const prisma = {
      candidate: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
        update: vi.fn().mockResolvedValue({ ...candidate, profileSyncedAt: new Date() }),
      },
      $transaction: vi.fn().mockImplementation(async (cb) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          candidate: {
            findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
            update: vi.fn().mockResolvedValue({ ...candidate, profileSyncedAt: new Date() }),
          },
        };
        return cb(tx);
      }),
    };

    const audit = { logInTransaction: vi.fn().mockResolvedValue(undefined) };
    const erp = {
      identity: vi.fn().mockResolvedValue({
        recipientType: "person",
        reviewGroup: "IG",
        code1C: "IG-001",
        personUid: "11111111-1111-1111-1111-111111111111",
      }),
    };
    const candidates = {
      findByEmployeeCode: vi.fn().mockResolvedValue({
        code1C: "IG-001",
        fullName: "Алиев Али",
        birthDate: "1995-05-15",
        position: { code: "POS-10", name: "Монтажник" },
        citizenship: "uz",
        citizenshipProvided: true,
      }),
    };
    const previousDocsSync = {
      syncPreviousDocuments: vi.fn().mockResolvedValue({ items: [] }),
    };
    const config = { get: vi.fn().mockReturnValue("false") };

    const service = new IgProfileEnrichmentService(
      prisma as any,
      audit as any,
      erp as any,
      config as any,
      candidates as any,
      previousDocsSync as any,
    );

    const result = await service.enrichCandidate("cand-1");
    expect(result.profileSynced).toBe(true);
    expect(result.documentsSynced).toBe(true);
    expect(candidates.findByEmployeeCode).toHaveBeenCalledWith("IG-001", expect.anything());
    expect(previousDocsSync.syncPreviousDocuments).toHaveBeenCalledWith("cand-1", "system:profile-enrichment");
  });

  it("never overwrites IG candidate citizenship with default ru", async () => {
    const candidate = {
      id: "cand-2",
      reviewGroup: "IG",
      code1c: "IG-002",
      personUid: "22222222-2222-2222-2222-222222222222",
      chatUuid: null,
      fullName: null,
      positionCode: null,
      positionName: null,
      citizenship: "tj",
      profileSyncedAt: null,
      previousDocumentsSyncedAt: null,
    };

    let updatedData: any = null;
    const prisma = {
      candidate: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
      },
      $transaction: vi.fn().mockImplementation(async (cb) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          candidate: {
            findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
            update: vi.fn().mockImplementation(({ data }) => {
              updatedData = data;
              return { ...candidate, ...data };
            }),
          },
        };
        return cb(tx);
      }),
    };

    const audit = { logInTransaction: vi.fn().mockResolvedValue(undefined) };
    const erp = {
      identity: vi.fn().mockResolvedValue({
        recipientType: "person",
        reviewGroup: "IG",
        code1C: "IG-002",
        personUid: "22222222-2222-2222-2222-222222222222",
      }),
    };
    const candidates = {
      findByEmployeeCode: vi.fn().mockResolvedValue({
        code1C: "IG-002",
        fullName: "Каримов Карим",
        position: { code: "POS-20", name: "Бетонщик" },
        citizenship: "ru",
        citizenshipProvided: false, // Defaulted by ERP normalization
      }),
    };
    const previousDocsSync = {
      syncPreviousDocuments: vi.fn().mockResolvedValue({ items: [] }),
    };
    const config = { get: vi.fn().mockReturnValue("false") };

    const service = new IgProfileEnrichmentService(
      prisma as any,
      audit as any,
      erp as any,
      config as any,
      candidates as any,
      previousDocsSync as any,
    );

    await service.enrichCandidate("cand-2");
    expect(updatedData).toBeDefined();
    expect(updatedData.citizenship).toBeUndefined(); // Did NOT set citizenship to ru
    expect(updatedData.positionCode).toBe("POS-20");
    expect(updatedData.profileSyncedAt).toBeInstanceOf(Date);
  });

  it("retains profileSyncedAt when documents fail and skips profile re-fetch on retry", async () => {
    const candidateInitial = {
      id: "cand-3",
      reviewGroup: "IG",
      code1c: "IG-003",
      personUid: "33333333-3333-3333-3333-333333333333",
      chatUuid: null,
      fullName: null,
      positionCode: null,
      positionName: null,
      citizenship: "uz",
      profileSyncedAt: null,
      previousDocumentsSyncedAt: null,
    };

    let savedProfile = false;
    const prisma = {
      candidate: {
        findUniqueOrThrow: vi.fn().mockImplementation(() =>
          Promise.resolve({
            ...candidateInitial,
            profileSyncedAt: savedProfile ? new Date() : null,
            positionCode: savedProfile ? "POS-30" : null,
          }),
        ),
      },
      $transaction: vi.fn().mockImplementation(async (cb) => {
        savedProfile = true;
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          candidate: {
            findUniqueOrThrow: vi.fn().mockResolvedValue(candidateInitial),
            update: vi.fn().mockResolvedValue({ ...candidateInitial, profileSyncedAt: new Date() }),
          },
        };
        return cb(tx);
      }),
    };

    const audit = { logInTransaction: vi.fn().mockResolvedValue(undefined) };
    const erp = {
      identity: vi.fn().mockResolvedValue({
        recipientType: "person",
        reviewGroup: "IG",
        code1C: "IG-003",
        personUid: "33333333-3333-3333-3333-333333333333",
      }),
    };
    const candidates = {
      findByEmployeeCode: vi.fn().mockResolvedValue({
        code1C: "IG-003",
        fullName: "Усманов Усман",
        position: { code: "POS-30", name: "Сварщик" },
        citizenship: "uz",
        citizenshipProvided: true,
      }),
    };
    const previousDocsSync = {
      syncPreviousDocuments: vi
        .fn()
        .mockRejectedValueOnce(new Error("ERP_DOCUMENTS_TIMEOUT"))
        .mockResolvedValueOnce({ items: [] }),
    };
    const config = { get: vi.fn().mockReturnValue("false") };

    const service = new IgProfileEnrichmentService(
      prisma as any,
      audit as any,
      erp as any,
      config as any,
      candidates as any,
      previousDocsSync as any,
    );

    // Run 1: Profile succeeds, document history fails
    await expect(service.enrichCandidate("cand-3")).rejects.toThrow("ERP_DOCUMENTS_TIMEOUT");
    expect(savedProfile).toBe(true);
    expect(candidates.findByEmployeeCode).toHaveBeenCalledTimes(1);

    // Run 2: Retry — profile is already synced, findByEmployeeCode is NOT called again
    const retryResult = await service.enrichCandidate("cand-3");
    expect(retryResult.profileSynced).toBe(true);
    expect(retryResult.documentsSynced).toBe(true);
    expect(candidates.findByEmployeeCode).toHaveBeenCalledTimes(1); // Not called a second time!
    expect(previousDocsSync.syncPreviousDocuments).toHaveBeenCalledTimes(2);
  });

  it("rejects enrichment on identity mismatch", async () => {
    const candidate = {
      id: "cand-4",
      reviewGroup: "IG",
      code1c: "IG-004",
      personUid: "44444444-4444-4444-4444-444444444444",
      chatUuid: null,
      profileSyncedAt: null,
      positionCode: null,
    };

    const prisma = {
      candidate: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
      },
    };
    const erp = {
      identity: vi.fn().mockResolvedValue({
        recipientType: "person",
        reviewGroup: "RU", // Mismatch!
        code1C: "IG-004",
        personUid: "44444444-4444-4444-4444-444444444444",
      }),
    };

    const service = new IgProfileEnrichmentService(
      prisma as any,
      {} as any,
      erp as any,
      { get: vi.fn().mockReturnValue("false") } as any,
      { findByEmployeeCode: vi.fn() } as any,
      {} as any,
    );

    await expect(service.enrichCandidate("cand-4")).rejects.toThrow("ERP_PERSON_IDENTITY_MISMATCH");
  });

  it("does not consider profile complete when citizenship is missing", async () => {
    const candidate = {
      id: "cand-missing-cit",
      reviewGroup: "IG",
      code1c: "IG-005",
      personUid: "55555555-5555-5555-5555-555555555555",
      chatUuid: null,
      fullName: null,
      positionCode: null,
      citizenship: null, // Initially null
      profileSyncedAt: null,
      previousDocumentsSyncedAt: null,
    };

    let updatedCandidateData: any = null;
    const prisma = {
      candidate: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
      },
      $transaction: vi.fn().mockImplementation(async (cb) => {
        const tx = {
          $queryRaw: vi.fn().mockResolvedValue([]),
          candidate: {
            findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
            update: vi.fn().mockImplementation(({ data }) => {
              updatedCandidateData = data;
              return { ...candidate, ...data };
            }),
          },
        };
        return cb(tx);
      }),
    };

    const audit = { logInTransaction: vi.fn().mockResolvedValue(undefined) };
    const erp = {
      identity: vi.fn().mockResolvedValue({
        recipientType: "person",
        reviewGroup: "IG",
        code1C: "IG-005",
        personUid: "55555555-5555-5555-5555-555555555555",
      }),
    };
    const candidates = {
      findByEmployeeCode: vi.fn().mockResolvedValue({
        code1C: "IG-005",
        fullName: "Норов Носир",
        position: { code: "POS-50", name: "Плотник" },
        citizenship: "ru", // Defaulted ru
        citizenshipProvided: false,
      }),
    };
    const previousDocsSync = {
      syncPreviousDocuments: vi.fn().mockResolvedValue({ items: [] }),
    };
    const config = { get: vi.fn().mockReturnValue("false") };

    const service = new IgProfileEnrichmentService(
      prisma as any,
      audit as any,
      erp as any,
      config as any,
      candidates as any,
      previousDocsSync as any,
    );

    const result = await service.enrichCandidate("cand-missing-cit");
    // Position was saved, but profile is NOT complete because citizenship is missing
    expect(updatedCandidateData).toBeDefined();
    expect(updatedCandidateData.positionCode).toBe("POS-50");
    expect(updatedCandidateData.citizenship).toBeUndefined();
    expect(updatedCandidateData.profileSyncedAt).toBeNull();
    expect(result.profileSynced).toBe(false);
    expect(result.documentsSynced).toBe(true);
  });

  it("prevents batch starvation by excluding candidates currently on cooldown from query", async () => {
    // 21 candidates in DB: first 20 have profileSyncNextAttemptAt in the future (cooldown)
    // 21st candidate is ready to be processed
    const futureDate = new Date(Date.now() + 300_000);
    const validCandidate = {
      id: "cand-21",
      reviewGroup: "IG",
      code1c: "IG-021",
      personUid: "21212121-2121-2121-2121-212121212121",
      chatUuid: null,
      citizenship: "uz",
      positionCode: "POS-21",
      profileSyncedAt: new Date(),
      previousDocumentsSyncedAt: null,
      profileSyncAttempts: 0,
      profileSyncNextAttemptAt: null,
    };

    let findManyWhereClause: any = null;
    const prisma = {
      candidate: {
        findMany: vi.fn().mockImplementation(({ where }) => {
          findManyWhereClause = where;
          // Returns only candidates whose retry time is null or <= now
          return Promise.resolve([validCandidate]);
        }),
        findUniqueOrThrow: vi.fn().mockResolvedValue(validCandidate),
        update: vi.fn().mockResolvedValue({ ...validCandidate, previousDocumentsSyncedAt: new Date() }),
      },
    };

    const erp = { identity: vi.fn() };
    const candidates = { findByEmployeeCode: vi.fn() };
    const previousDocsSync = {
      syncPreviousDocuments: vi.fn().mockResolvedValue({ items: [] }),
    };
    const config = { get: vi.fn().mockReturnValue("false") };

    const service = new IgProfileEnrichmentService(
      prisma as any,
      { logInTransaction: vi.fn() } as any,
      erp as any,
      config as any,
      candidates as any,
      previousDocsSync as any,
    );

    await service.sync();

    // Verify DB query filters out records in cooldown at database level
    expect(prisma.candidate.findMany).toHaveBeenCalledTimes(1);
    expect(findManyWhereClause.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          OR: [
            { profileSyncNextAttemptAt: null },
            { profileSyncNextAttemptAt: { lte: expect.any(Date) } },
          ],
        }),
      ]),
    );

    // Verify valid candidate was successfully enriched
    expect(previousDocsSync.syncPreviousDocuments).toHaveBeenCalledWith("cand-21", "system:profile-enrichment");
    expect(prisma.candidate.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cand-21" },
        data: expect.objectContaining({
          profileSyncNextAttemptAt: null,
          profileSyncAttempts: 0,
        }),
      }),
    );
  });
});
