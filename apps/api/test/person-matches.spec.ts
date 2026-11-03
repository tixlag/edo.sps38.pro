import { describe, expect, it, vi } from "vitest";
import { ConfigService } from "@nestjs/config";
import { CandidateWorkspaceService } from "../src/communications/candidate-workspace.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";
import type { ErpWorkspaceClient } from "../src/documents/erp-workspace.client";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { DocumentAccessService } from "../src/documents/document-access.service";
import type { AuditService } from "../src/audit/audit.service";
import type { DocumentCatalogService } from "../src/documents/document-catalog.service";

describe("ERP person match lookup", () => {
  const query = {
    lastName: "Иванов",
    firstName: "Иван",
    birthDate: "1990-02-03",
    latinName: "IVANOV IVAN",
  };
  const principal = (rules: Record<string, unknown>): AuthPrincipal => ({
    uuid: "reviewer",
    code1c: null,
    sid: null,
    deviceId: null,
    expiresAt: null,
    accessRules: rules as AuthPrincipal["accessRules"],
  });
  const setup = () => {
    const request = vi.fn().mockResolvedValue({
      items: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Иванов Иван",
          birthDate: query.birthDate,
          latinName: query.latinName,
          matchedCyrillic: true,
          matchedLatin: true,
        },
      ],
    });
    const service = new CandidateWorkspaceService(
      {} as PrismaService,
      { request } as unknown as ErpWorkspaceClient,
      {} as DocumentAccessService,
      {} as AuditService,
      new ConfigService({ JWT_SECRET: "test-secret" }),
      {} as DocumentCatalogService,
    );
    return { service, request };
  };
  it.each(["20002", "20011", "20009"])(
    "allows reviewer %s and signs the choice",
    async (rule) => {
      const { service, request } = setup();
      const result = await service.personMatches(
        principal({ [rule]: [] }),
        query,
      );
      expect(request).toHaveBeenCalledWith(
        "person-matches",
        expect.anything(),
        query,
      );
      expect(result.items[0].id).not.toBe(
        "00000000-0000-4000-8000-000000000001",
      );
      expect(result.items[0].matchedLatin).toBe(true);
    },
  );
  it("rejects unrelated permissions before querying ERP", async () => {
    const { service, request } = setup();
    await expect(
      service.personMatches(principal({ "20007": [] }), query),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
