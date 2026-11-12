import { describe, expect, it, vi } from "vitest";
import { DocumentReadService } from "../src/documents/document-read.service";
import { DocumentAccessService } from "../src/documents/document-access.service";
import type { CandidateProfileDto } from "../src/documents/dto/document.dto";
import type { AuthPrincipal } from "../src/auth/auth-principal";

describe("document delivery summaries", () => {
  it("exposes only the safe current-version explanation", async () => {
    const prisma = {
      document: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "doc",
            status: "APPROVED",
            currentVersion: 2,
            documentType: { code: "INN", title: "ИНН", erpUid: "uid" },
            versions: [
              {
                version: 1,
                status: "RETURNED",
                delivery: {
                  status: "REQUIRES_MANUAL",
                  errorCode: "PRIVATE_ERROR",
                },
              },
              {
                version: 2,
                status: "APPROVED",
                delivery: {
                  status: "REQUIRES_MANUAL",
                  errorCode: "ERP_HTTP_422",
                },
              },
            ],
          },
          {
            id: "previous",
            status: "APPROVED",
            currentVersion: 1,
            documentType: { code: "SNILS", title: "СНИЛС", erpUid: "snils" },
            versions: [{
              version: 1,
              status: "APPROVED",
              ocrSource: "PREVIOUS_LINK",
              ocrRaw: { source: "ERP" },
              delivery: null,
            }],
          },
        ]),
      },
    };
    const reads = new DocumentReadService(
      prisma as never,
      null as never,
      null as never,
    );
    const { items } = await reads.documents({ id: "doc" });
    expect(items[0]).toMatchObject({
      status: "APPROVED",
      deliveryStatus: "REQUIRES_MANUAL",
      deliveryErrorReason: "1С отклонила файл",
      deliveredHistorically: false,
    });
    expect(items[1]).toMatchObject({ deliveryStatus: null, deliveryErrorReason: null, deliveredHistorically: true });
    expect(JSON.stringify(items[0])).not.toContain("PRIVATE_ERROR");
    expect(JSON.stringify(items[0])).not.toContain("ERP_HTTP_422");
  });
  it("counts current delivery issues in one scoped batch independently of ERP reuse", async () => {
    const type = (id: string, required: boolean) => ({
      id,
      code: id,
      erpUid: id,
      stage: 7,
      requiredForAll: required,
      allRu: false,
      allForeign: false,
      positions: required ? [] : [{ code1c: "job", required: false }],
      catalogSyncedAt: new Date(),
    });
    const deliveryDoc = (
      id: string,
      status: string | null,
      older = "REQUIRES_MANUAL",
    ) => ({
      candidateId: "c",
      documentTypeId: id,
      currentVersion: 2,
      versions: [
        { version: 1, delivery: { status: older } },
        { version: 2, delivery: status ? { status } : null },
      ],
    });
    const previousLinked = (id: string, raw: Record<string, unknown>) => ({
      candidateId: "c",
      documentTypeId: id,
      currentVersion: 1,
      versions: [{ version: 1, delivery: null, ocrSource: "PREVIOUS_LINK", ocrRaw: raw }],
    });
    const prisma = {
      document: {
        groupBy: vi.fn().mockResolvedValue(
          ["license", "tachograph", "inn", "other", "previous", "unconfirmed"].map((documentTypeId) => ({
            candidateId: "c",
            documentTypeId,
            status: "APPROVED",
            _count: { _all: 1 },
          })),
        ),
        findMany: vi
          .fn()
          .mockResolvedValue([
            deliveryDoc("license", "SENT"),
            deliveryDoc("tachograph", "REQUIRES_MANUAL"),
            deliveryDoc("inn", null),
            deliveryDoc("other", "PENDING"),
            previousLinked("previous", { source: "ERP" }),
            previousLinked("unconfirmed", { source: "EDO" }),
          ]),
      },
      documentType: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            type("license", true),
            type("tachograph", false),
            type("inn", false),
            type("other", false),
            type("previous", false),
            type("unconfirmed", false),
          ]),
      },
      candidatePreviousDocument: {
        findMany: vi.fn().mockResolvedValue([
          {
            candidateId: "c",
            documentUid: "tachograph",
            status: "CONFIRMED",
            originalAvailable: true,
            originalVerified: true,
            expiresAt: null,
          },
        ]),
      },
    };
    const scope = { candidate: { citizenship: "ru" } };
    const access = { documentWhere: vi.fn(() => scope) };
    const reads = new DocumentReadService(
      prisma as never,
      access as unknown as DocumentAccessService,
      null as never,
    );
    const profile = {
      id: "c",
      reviewGroup: "RU",
      citizenship: "ru",
      positionCode: "job",
      sexKnown: false,
    } as CandidateProfileDto;
    await reads.enrichReviewCandidates(
      { accessRules: { 20002: [] } } as unknown as AuthPrincipal,
      [profile],
    );
    expect(profile.stageProgress?.[0]).toMatchObject({
      deliveryProblemCount: 3,
      required: { approved: 1 },
    });
    expect(prisma.document.findMany).toHaveBeenCalledOnce();
    expect(prisma.document.findMany.mock.calls[0][0].where).toMatchObject({
      ...scope,
      candidateId: { in: ["c"] },
      status: { in: ["APPROVED", "SIGNED"] },
      currentVersion: { gt: 0 },
    });
  });
});
