import { describe, expect, it, vi } from "vitest";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";
import { ErpWorkspaceClient } from "../src/documents/erp-workspace.client";
import { ErpCandidateClient } from "../src/documents/erp-candidate.client";
import { CandidatePreviousDocumentsSyncService } from "../src/documents/candidate-previous-documents-sync.service";
import { IgProfileEnrichmentService } from "../src/documents/ig-profile-enrichment.service";

describe("IgProfileEnrichmentService DI & Integration (FIX-01)", () => {
  it("resolves all required dependencies via Nest DI without @Optional()", async () => {
    const prismaMock = {
      candidate: {
        findUniqueOrThrow: vi.fn(),
        update: vi.fn(),
      },
      $transaction: vi.fn(),
    };

    const auditMock = {
      logInTransaction: vi.fn(),
    };

    const erpMock = {
      identity: vi.fn(),
      request: vi.fn(),
      employmentHistory: vi.fn(),
      probePersonOriginal: vi.fn(),
    };

    const configMock = {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === "EDO_ARRIVAL_SYNC_ENABLED") return "false";
        return null;
      }),
    };

    const candidatesClientMock = {
      findByEmployeeCode: vi.fn(),
    };

    const previousDocsSyncMock = {
      syncPreviousDocuments: vi.fn().mockResolvedValue({ items: [] }),
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        IgProfileEnrichmentService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditService, useValue: auditMock },
        { provide: ErpWorkspaceClient, useValue: erpMock },
        { provide: ConfigService, useValue: configMock },
        { provide: ErpCandidateClient, useValue: candidatesClientMock },
        { provide: CandidatePreviousDocumentsSyncService, useValue: previousDocsSyncMock },
      ],
    }).compile();

    const service = moduleRef.get<IgProfileEnrichmentService>(IgProfileEnrichmentService);
    expect(service).toBeDefined();

    const injectedPreviousDocs = moduleRef.get<CandidatePreviousDocumentsSyncService>(
      CandidatePreviousDocumentsSyncService,
    );
    expect(injectedPreviousDocs).toBe(previousDocsSyncMock);

    // Verify background worker invokes previous documents sync
    const candidate = {
      id: "cand-di-1",
      reviewGroup: "IG",
      code1c: "IG-DI-001",
      personUid: "11111111-2222-3333-4444-555555555555",
      chatUuid: null,
      citizenship: "uz",
      positionCode: "POS-1",
      profileSyncedAt: new Date(),
      previousDocumentsSyncedAt: null,
    };

    prismaMock.candidate.findUniqueOrThrow.mockResolvedValue(candidate);

    const result = await service.enrichCandidate("cand-di-1");
    expect(result.documentsSynced).toBe(true);
    expect(previousDocsSyncMock.syncPreviousDocuments).toHaveBeenCalledWith(
      "cand-di-1",
      "system:profile-enrichment",
    );
  });

  it("fails and does not mark success when personUid and code1c mismatch in ERP identity", async () => {
    const candidate = {
      id: "cand-di-2",
      reviewGroup: "IG",
      code1c: "IG-DI-002",
      personUid: "11111111-2222-3333-4444-555555555555",
      chatUuid: null,
      citizenship: "tj",
      positionCode: null,
      profileSyncedAt: null,
      previousDocumentsSyncedAt: null,
    };

    const prismaMock = {
      candidate: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
        update: vi.fn(),
      },
    };

    const erpMock = {
      identity: vi.fn().mockResolvedValue({
        recipientType: "person",
        reviewGroup: "IG",
        code1C: "IG-DI-002",
        // Different personUid
        personUid: "99999999-9999-9999-9999-999999999999",
      }),
    };

    const candidatesClientMock = {
      findByEmployeeCode: vi.fn(),
    };

    const previousDocsSyncMock = {
      syncPreviousDocuments: vi.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        IgProfileEnrichmentService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditService, useValue: { logInTransaction: vi.fn() } },
        { provide: ErpWorkspaceClient, useValue: erpMock },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("false") } },
        { provide: ErpCandidateClient, useValue: candidatesClientMock },
        { provide: CandidatePreviousDocumentsSyncService, useValue: previousDocsSyncMock },
      ],
    }).compile();

    const service = moduleRef.get<IgProfileEnrichmentService>(IgProfileEnrichmentService);

    await expect(service.enrichCandidate("cand-di-2")).rejects.toThrow("ERP_PERSON_IDENTITY_MISMATCH");
    expect(prismaMock.candidate.update).not.toHaveBeenCalled();
    expect(previousDocsSyncMock.syncPreviousDocuments).not.toHaveBeenCalled();
  });

  it("does not falsely mark sync as completed when ERP candidate endpoint is unavailable", async () => {
    const candidate = {
      id: "cand-di-3",
      reviewGroup: "IG",
      code1c: "IG-DI-003",
      personUid: "11111111-2222-3333-4444-555555555555",
      chatUuid: null,
      citizenship: "kg",
      positionCode: null,
      profileSyncedAt: null,
      previousDocumentsSyncedAt: null,
    };

    const prismaMock = {
      candidate: {
        findUniqueOrThrow: vi.fn().mockResolvedValue(candidate),
        update: vi.fn(),
      },
    };

    const erpMock = {
      identity: vi.fn().mockResolvedValue({
        recipientType: "person",
        reviewGroup: "IG",
        code1C: "IG-DI-003",
        personUid: "11111111-2222-3333-4444-555555555555",
      }),
    };

    const candidatesClientMock = {
      findByEmployeeCode: vi.fn().mockRejectedValue(new Error("ERP connection timed out")),
    };

    const previousDocsSyncMock = {
      syncPreviousDocuments: vi.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        IgProfileEnrichmentService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditService, useValue: { logInTransaction: vi.fn() } },
        { provide: ErpWorkspaceClient, useValue: erpMock },
        { provide: ConfigService, useValue: { get: vi.fn().mockReturnValue("false") } },
        { provide: ErpCandidateClient, useValue: candidatesClientMock },
        { provide: CandidatePreviousDocumentsSyncService, useValue: previousDocsSyncMock },
      ],
    }).compile();

    const service = moduleRef.get<IgProfileEnrichmentService>(IgProfileEnrichmentService);

    await expect(service.enrichCandidate("cand-di-3")).rejects.toThrow("ERP connection timed out");
    expect(prismaMock.candidate.update).not.toHaveBeenCalled();
    expect(previousDocsSyncMock.syncPreviousDocuments).not.toHaveBeenCalled();
  });
});
