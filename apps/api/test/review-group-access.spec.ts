import { describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import {
  candidateReviewGroup,
  reviewGroupWhere,
} from "../src/documents/review-group";
import { DocumentAccessService } from "../src/documents/document-access.service";
import { DocumentReadService } from "../src/documents/document-read.service";
import { CandidateCardCache } from "../src/documents/candidate-card-cache";
import { AuditLogsService } from "../src/audit/audit-logs.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";

const principal = (rules: Record<string, string[]>): AuthPrincipal => ({
  uuid: "reviewer",
  code1c: null,
  sid: null,
  deviceId: null,
  expiresAt: null,
  accessRules: { "20000": [], "20008": [], ...rules },
});

describe("review group isolation", () => {
  it.each([{ "20009": [] }, { "20002": [], "20011": [] }])(
    "does not add an empty relation filter when both groups are granted: %j",
    (rules) => {
      const access = new DocumentAccessService(null as never);
      expect(access.documentReviewWhere(principal(rules))).toEqual({});
      const scoped = principal({ ...rules, "20007": ["98"] });
      delete scoped.accessRules["20008"];
      // Review rights cover all locations, including RU+IG without 20009.
      expect(access.documentReviewWhere(scoped)).toEqual(
        access.documentWhere(scoped),
      );
    },
  );

  it.each([
    [{ chatUuid: "chat", citizenship: "uz" }, "RU"],
    [{ chatUuid: null, citizenship: "ru" }, "RU"],
    [{ chatUuid: null, citizenship: "RU" }, "RU"],
    [{ chatUuid: null, citizenship: "uz" }, "IG"],
    [{ chatUuid: null, citizenship: null }, "IG"],
  ] as const)("classifies %j as %s", (candidate, group) => {
    expect(candidateReviewGroup(candidate)).toBe(group);
  });

  it("keeps NULL citizenship in IG and requires both no chat and no RU citizenship", () => {
    expect(reviewGroupWhere("IG")).toEqual({
      AND: [
        { chatUuid: null },
        { OR: [{ citizenship: null }, { citizenship: { not: "ru" } }] },
      ],
    });
  });

  it("blocks a RU reviewer from requesting the IG queue before any query", async () => {
    const prisma = { candidate: { findMany: vi.fn() } };
    const access = new DocumentAccessService(prisma as never);
    const reads = new DocumentReadService(
      prisma as never,
      access,
      null as never,
    );
    await expect(
      reads.candidateReviewQueue(principal({ "20002": [] }), {
        reviewGroup: "IG",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.candidate.findMany).not.toHaveBeenCalled();
  });

  it("removes geography for reviewers while retaining group access against an employee relation bypass", () => {
    const access = new DocumentAccessService(null as never);
    const ru = principal({ "20002": [], "20007": ["98"] });
    delete ru.accessRules["20008"];
    expect(access.documentWhere(ru)).toEqual({
      AND: [
        {},
        { OR: [{ candidate: reviewGroupWhere("RU") }, { candidateId: null }] },
      ],
    });
  });

  it("allows both groups for full access and audit, while an IG reviewer gets only IG candidates", () => {
    const access = new DocumentAccessService(null as never);
    expect(access.candidateWhere(principal({ "20009": [] }))).toEqual({});
    expect(access.candidateWhere(principal({ "20005": [] }))).toEqual({});
    expect(access.candidateWhere(principal({ "20011": [] }))).toEqual(
      reviewGroupWhere("IG"),
    );
  });

  it("does not let audit plus RU rights grant IG mutation access", () => {
    const access = new DocumentAccessService(null as never);
    const reviewer = principal({ "20002": [], "20005": [] });
    expect(access.candidateWhere(reviewer)).toEqual({});
    expect(access.documentReviewWhere(reviewer)).toEqual({
      AND: [
        {},
        {
          OR: [{ candidate: reviewGroupWhere("RU") }, { candidateId: null }],
        },
      ],
    });
  });

  it("does not expose legacy employee-only documents to an IG reviewer", () => {
    const access = new DocumentAccessService(null as never);
    expect(access.documentWhere(principal({ "20011": [] }))).toEqual({
      AND: [
        {},
        {
          OR: [{ candidate: reviewGroupWhere("IG") }],
        },
      ],
    });
  });

  it("keeps employee-only document audit entries out of the IG history even with all-location scope", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const audit = new AuditLogsService({ $queryRaw: query } as never);
    await audit.list(principal({ "20011": [] }), { mine: true });
    const sql = query.mock.calls[0][0] as { sql: string };
    expect(sql.sql).toContain("d.candidateId IS NOT NULL");
    expect(sql.sql).toContain("c.chatUuid IS NULL");
  });

  it("applies the same requested-group guard to facets, selectors and the legacy queue", async () => {
    const reads = new DocumentReadService(
      null as never,
      new DocumentAccessService(null as never),
      null as never,
    );
    const reviewer = principal({ "20002": [] });
    await expect(
      reads.reviewDocumentFacets(reviewer, "IG"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      reads.reviewCandidates(reviewer, { reviewGroup: "IG" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      reads.reviewDocuments(reviewer, { reviewGroup: "IG" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("validates code_1c cache entries without requiring a chat uuid", async () => {
    const snapshot = {
      uuid: null,
      code1C: "000123",
      citizenship: "uz",
      position: { code: "POS1" },
    };
    const cache = new CandidateCardCache({
      evalStrict: vi.fn(async () =>
        JSON.stringify({ snapshot, freshUntil: 123 }),
      ),
    } as never);
    expect(await cache.get("code_1c:000123")).toMatchObject({ snapshot });
    await expect(cache.get("code_1c:other")).rejects.toThrow();
    await expect(
      cache.get("019d0a2a-f080-762e-b2d0-c7bb7ddb1922"),
    ).rejects.toThrow();
  });
});
