import { describe, expect, it, vi } from "vitest";
import { DocumentReadService } from "../src/documents/document-read.service";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { buildCandidateProfileWhere } from "../src/documents/candidate-profile";
import type { AuthPrincipal } from "../src/auth/auth-principal";
const principal = {
  uuid: "ru",
  accessRules: { "20002": [] },
} as unknown as AuthPrincipal;
describe("exact operational queue filters", () => {
  it("uses current RETURNED when requested, preserves historical RETURNED otherwise", async () => {
    const findMany = vi.fn(async () => []);
    const service = new DocumentReadService(
      { document: { findMany } } as never,
      new DocumentAccessService(null as never),
      null as never,
    );
    await service.reviewDocuments(principal, {
      status: "RETURNED",
      currentStatus: "RETURNED",
    });
    expect(findMany.mock.calls[0][0].where.status).toBe("RETURNED");
    expect(findMany.mock.calls[0][0].where.versions).toBeUndefined();
    findMany.mockClear();
    await service.reviewDocuments(principal, { status: "RETURNED" });
    expect(findMany.mock.calls[0][0].where.versions).toEqual({
      some: { status: "RETURNED" },
    });
  });
  it("matches legacy manager names exactly without widening to managers with codes", () => {
    expect(buildCandidateProfileWhere({ managerName: "Анна" })).toEqual({
      AND: [
        { OR: [{ managerCode1c: null }, { managerCode1c: "" }] },
        { managerName: "Анна" },
      ],
    });
    expect(buildCandidateProfileWhere({ managerUnassigned: true })).toEqual({
      AND: [
        { OR: [{ managerCode1c: null }, { managerCode1c: "" }] },
        { OR: [{ managerName: null }, { managerName: "" }] },
      ],
    });
  });
});
