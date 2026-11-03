import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { CandidateWorkspaceService } from "../src/communications/candidate-workspace.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { AuditService } from "../src/audit/audit.service";
import type { DocumentAccessService } from "../src/documents/document-access.service";
import type { DocumentCatalogService } from "../src/documents/document-catalog.service";
import type { ErpWorkspaceClient } from "../src/documents/erp-workspace.client";

const personUid = "00000000-0000-4000-8000-000000000001";
const actor = (rules: Record<string, unknown>): AuthPrincipal => ({
  uuid: "reviewer",
  code1c: "reviewer-code",
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules: rules as AuthPrincipal["accessRules"],
});
function setup() {
  const row = {
    id: "candidate",
    code1c: "worker",
    personUid: null as string | null,
    erpUid: null,
    chatUuid: null,
    citizenship: "uz",
  };
  const tx = {
    $queryRaw: vi.fn(),
    candidate: {
      findFirst: vi.fn(async () => ({ ...row })),
      update: vi.fn(async ({ data }: { data: { personUid: string } }) => {
        row.personUid = data.personUid;
        return { ...row };
      }),
    },
    candidatePreviousDocument: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (arg: typeof tx) => unknown) => fn(tx)),
    candidatePreviousDocument: { findMany: vi.fn(async () => []) },
  };
  const audit = { logInTransaction: vi.fn() };
  const access = {
    candidate: vi.fn(async () => ({ ...row })),
    candidateWhere: vi.fn(() => ({})),
  };
  const erp = {
    identity: vi.fn(async () => ({
      reviewGroup: "IG",
      recipientType: "person",
      personUid,
      code1C: "worker",
    })),
    request: vi.fn(async () => ({ items: [] })),
  };
  const service = new CandidateWorkspaceService(
    prisma as unknown as PrismaService,
    erp as unknown as ErpWorkspaceClient,
    access as unknown as DocumentAccessService,
    audit as unknown as AuditService,
    new ConfigService({ JWT_SECRET: "secret" }),
    {} as DocumentCatalogService,
  );
  return { service, row, tx, erp, audit };
}
describe("IG previous ERP documents", () => {
  it("pins the ERP-confirmed person and imports only for the matching code", async () => {
    const { service, row, erp, audit } = setup();
    await expect(
      service.previous(row.id, actor({ "20011": [] })),
    ).resolves.toEqual({ items: [] });
    expect(row.personUid).toBe(personUid);
    expect(erp.request).toHaveBeenCalledWith(
      "person-documents-by-code",
      expect.anything(),
      { code1c: "worker", personUid },
    );
    expect(audit.logInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "CANDIDATE_LINKED" }),
    );
  });
  it("rejects changed ERP identity without importing another person's documents", async () => {
    const { service, row, erp } = setup();
    row.personUid = "00000000-0000-4000-8000-000000000002";
    await expect(
      service.previous(row.id, actor({ "20011": [] })),
    ).rejects.toThrow("ERP_PERSON_IDENTITY_MISMATCH");
    expect(erp.request).not.toHaveBeenCalled();
  });
  it("does not import if candidate identity changes while ERP is loading history", async () => {
    const { service, row, erp, tx } = setup();
    erp.request.mockImplementationOnce(async () => {
      row.personUid = "00000000-0000-4000-8000-000000000002";
      return { items: [] };
    });
    await expect(
      service.previous(row.id, actor({ "20011": [] })),
    ).rejects.toThrow("ERP_PERSON_IDENTITY_MISMATCH");
    expect(tx.candidatePreviousDocument.upsert).not.toHaveBeenCalled();
  });
  it("does not grant IG history to an RU-only reviewer", async () => {
    const { service, row, erp } = setup();
    await expect(
      service.previous(row.id, actor({ "20002": [] })),
    ).rejects.toThrow();
    expect(erp.identity).not.toHaveBeenCalled();
  });
  it.each([
    "39554ac3-6462-11ec-80cc-002590854e7f",
    "e87d5a10-d248-11eb-80c7-002590854e7f",
    null,
  ])(
    "does not confirm a previous IG document when it requires a new upload or has unknown type: %s",
    async (documentUid) => {
      const { service, row, tx } = setup();
      tx.candidatePreviousDocument.findFirst.mockResolvedValue({
        id: "old",
        documentUid,
        originalAvailable: true,
        status: "REQUIRES_REVIEW",
      } as never);
      await expect(
        service.recheck(row.id, "old", actor({ "20011": [] }), {
          status: "CONFIRMED",
        }),
      ).rejects.toThrow();
      expect(tx.candidatePreviousDocument.update).not.toHaveBeenCalled();
    },
  );
});
