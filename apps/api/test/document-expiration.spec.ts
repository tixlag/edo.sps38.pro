import { describe, it, expect, vi, beforeEach } from "vitest";
import { DocumentExpirationService } from "../src/expiration/document-expiration.service";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { LkNotificationService } from "../src/lk/lk-notification.service";
import type { AuthPrincipal } from "../src/auth/auth-principal";
import { EdoAccessRule } from "../src/auth/edo-access-rule";

describe("DocumentExpirationService", () => {
  let service: DocumentExpirationService;
  let prismaMock: any;
  let lkNotificationMock: any;

  beforeEach(() => {
    let alertSequence = 0;
    prismaMock = {
      document: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({ id: "doc" }),
        count: vi.fn().mockResolvedValue(0),
        update: vi.fn(),
      },
      documentVersion: {
        update: vi.fn(),
      },
      candidatePreviousDocument: {
        findMany: vi.fn(),
        findFirst: vi.fn().mockResolvedValue({ id: "prev" }),
        count: vi.fn().mockResolvedValue(0),
      },
      documentExpirationAlert: {
        findMany: vi.fn(),
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn().mockImplementation(({ data }) =>
          Promise.resolve({ id: `alert-${++alertSequence}`, attemptCount: data.attemptCount }),
        ),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        deleteMany: vi.fn(),
      },
      employee: {
        findMany: vi.fn(),
      },
      lkEmployee: {
        findMany: vi.fn(),
      },
    };

    lkNotificationMock = {
      sendNotification: vi.fn().mockResolvedValue({ success: true, broadcastUuid: "bcast-test" }),
    };

    service = new DocumentExpirationService(
      prismaMock as unknown as PrismaService,
      lkNotificationMock as unknown as LkNotificationService,
    );
  });

  it("calculates summary correctly according to review permissions", async () => {
    const principalRu: AuthPrincipal = {
      uuid: "user-1",
      code_1c: "HR001",
      accessRules: {
        [String(EdoAccessRule.DOCUMENT_REVIEW_RU)]: [],
      },
    };

    const fixedNow = new Date("2026-11-03T04:00:00.000Z");

    prismaMock.document.count.mockImplementation(async ({ where }: { where: { expiresAt: { gte?: Date; lte: Date } } }) => {
      const gte = where.expiresAt.gte?.toISOString().slice(0, 10);
      return ["2026-11-19", "2026-11-05", "2026-11-04"].includes(gte ?? "") || !gte ? 1 : 0;
    });

    const summary = await service.getSummary(principalRu, fixedNow);

    expect(summary.totalExpiring).toBe(4);
    expect(summary.warning30d).toBe(1);
    expect(summary.critical7d).toBe(1);
    expect(summary.expired).toBe(1);
    expect(summary.emergency1d).toBe(1);
    expect(prismaMock.document.count).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          { candidate: { OR: [{ chatUuid: { not: null } }, { citizenship: "ru" }] } },
          { candidateId: null },
        ]),
      }),
    }));
  });

  it("places today and tomorrow in the buckets used by dashboard filters", async () => {
    const principal = { uuid: "hr", accessRules: { [String(EdoAccessRule.DOCUMENT_REVIEW_RU)]: [] } } as AuthPrincipal;
    prismaMock.document.count.mockImplementation(async ({ where }: { where: { expiresAt: { gte?: Date; lte: Date } } }) => {
      const dates = ["2026-11-03", "2026-11-04"];
      return dates.filter((value) => (!where.expiresAt.gte || value >= where.expiresAt.gte.toISOString().slice(0, 10)) && value <= where.expiresAt.lte.toISOString().slice(0, 10)).length;
    });
    const summary = await service.getSummary(principal, new Date("2026-11-03T04:00:00Z"));
    expect(summary.expired).toBe(1);
    expect(summary.emergency1d).toBe(1);
  });

  it("dispatches alerts and deduplicates to avoid resending the same threshold", async () => {
    const fixedNow = new Date("2026-11-03T04:00:00.000Z");

    prismaMock.document.findMany.mockResolvedValueOnce([
      {
        id: "doc-patent",
        expiresAt: new Date("2026-11-10T00:00:00.000Z"), // 7 days remaining
        reviewGroup: "IG",
        documentType: { title: "Патент на работу" },
        candidate: {
          id: "cand-1",
          code1c: "КАНД001",
          fullName: "Ахмедов Б.С.",
          managerCode1c: "МЕН001",
        },
        expirationAlerts: [],
      },
    ]);

    prismaMock.candidatePreviousDocument.findMany.mockResolvedValueOnce([]);

    const result = await service.scanAndDispatchAlerts(fixedNow);

    expect(result.scanned).toBe(1);
    expect(result.alertsSent).toBe(1);
    expect(lkNotificationMock.sendNotification).toHaveBeenCalledTimes(1);
    expect(lkNotificationMock.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringContaining("Патент на работу"),
        targetType: "document_expiration",
        recipientCodes1c: ["МЕН001"],
        idempotencyKey: "document-expiration:alert-1",
      }),
    );
    expect(prismaMock.documentExpirationAlert.create).toHaveBeenCalled();
    expect(prismaMock.documentExpirationAlert.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ documentId: "doc-patent", thresholdDays: { gt: 7 } }),
      data: expect.objectContaining({ status: "SUPERSEDED" }),
    }));
  });

  it("does not send to the employee when a manager is missing", async () => {
    prismaMock.document.findMany.mockResolvedValueOnce([{
      id: "doc-no-manager", expiresAt: new Date("2026-11-10T00:00:00Z"),
      documentType: { title: "Патент" },
      candidate: { code1c: "EMP001", fullName: "Кандидат", managerCode1c: null },
    }]);
    prismaMock.candidatePreviousDocument.findMany.mockResolvedValueOnce([]);
    const result = await service.scanAndDispatchAlerts(new Date("2026-11-03T04:00:00Z"));
    expect(result.alertsSent).toBe(0);
    expect(lkNotificationMock.sendNotification).not.toHaveBeenCalled();
    expect(prismaMock.documentExpirationAlert.create).not.toHaveBeenCalled();
  });

  it("does not send when the manager changes between scanning and acquiring the alert", async () => {
    prismaMock.document.findMany.mockResolvedValueOnce([{ id: "doc", expiresAt: new Date("2026-11-10T00:00:00Z"),
      documentType: { title: "Патент" }, candidate: { managerCode1c: "old", fullName: "Имя" } }]);
    prismaMock.candidatePreviousDocument.findMany.mockResolvedValueOnce([]);
    prismaMock.document.findFirst.mockResolvedValueOnce(null);
    await service.scanAndDispatchAlerts(new Date("2026-11-03T04:00:00Z"));
    expect(lkNotificationMock.sendNotification).not.toHaveBeenCalled();
    expect(prismaMock.documentExpirationAlert.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SUPERSEDED" }) }));
  });

  it("reclaims a superseded A alert with the same key when manager A returns after B", async () => {
    const now = new Date("2026-11-03T04:00:00Z");
    const expiresAt = new Date("2026-11-10T00:00:00Z");
    prismaMock.document.findMany.mockResolvedValueOnce([{ id: "doc", expiresAt,
      documentType: { title: "Патент" }, candidate: { managerCode1c: "A", fullName: "Имя" } }]);
    prismaMock.candidatePreviousDocument.findMany.mockResolvedValueOnce([]);
    prismaMock.documentExpirationAlert.create.mockRejectedValueOnce({ code: "P2002" });
    prismaMock.documentExpirationAlert.findFirst.mockResolvedValueOnce({ id: "alert-A", status: "SUPERSEDED", attemptCount: 1 });
    prismaMock.documentExpirationAlert.updateMany.mockResolvedValue({ count: 1 });
    await service.scanAndDispatchAlerts(now);
    expect(prismaMock.documentExpirationAlert.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ documentId: "doc", expiresAt, thresholdDays: 7, recipientCode1c: "A" }),
    }));
    expect(prismaMock.documentExpirationAlert.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "alert-A", OR: expect.arrayContaining([{ status: "SUPERSEDED" }]) }),
      data: expect.objectContaining({ status: "CLAIMED", leaseToken: expect.any(String) }),
    }));
    expect(lkNotificationMock.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      recipientCodes1c: ["A"], idempotencyKey: "document-expiration:alert-A",
    }));
  });

  it("merges bounded document pages with exact totals and stable date order", async () => {
    const principal = { uuid: "hr", accessRules: { [String(EdoAccessRule.DOCUMENT_REVIEW_RU)]: [] } } as AuthPrincipal;
    const candidate = { fullName: "Имя", managerCode1c: "HR", chatUuid: "chat", citizenship: "ru" };
    prismaMock.document.count.mockResolvedValueOnce(2);
    prismaMock.candidatePreviousDocument.count.mockResolvedValueOnce(1);
    prismaMock.document.findMany.mockResolvedValueOnce([
      { id: "a", candidateId: "c", candidate, documentType: { title: "A" }, expiresAt: new Date("2026-11-04T00:00:00Z") },
      { id: "b", candidateId: "c", candidate, documentType: { title: "B" }, expiresAt: new Date("2026-11-06T00:00:00Z") },
    ]);
    prismaMock.candidatePreviousDocument.findMany.mockResolvedValueOnce([
      { id: "p", candidateId: "c", candidate, title: "P", expiresAt: new Date("2026-11-05T00:00:00Z") },
    ]);
    const result = await service.getItems(principal, { offset: 1, limit: 1 }, new Date("2026-11-03T04:00:00Z"));
    expect(result.total).toBe(3);
    expect(result.items.map((x) => x.id)).toEqual(["prev-p"]);
    expect(prismaMock.document.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 100, orderBy: [{ expiresAt: "asc" }, { id: "asc" }] }));
  });

  it("records failed delivery for retry and reclaims it when the backoff has elapsed", async () => {
    const fixedNow = new Date("2026-11-03T04:00:00.000Z");
    const document = {
      id: "doc-retry",
      expiresAt: new Date("2026-11-10T00:00:00.000Z"),
      documentType: { title: "Патент" },
      candidate: {
        id: "cand-retry",
        code1c: "КАНД001",
        fullName: "Петров А.А.",
        managerCode1c: "МЕН001",
      },
    };
    prismaMock.document.findMany
      .mockResolvedValueOnce([document])
      .mockResolvedValueOnce([document]);
    prismaMock.candidatePreviousDocument.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    lkNotificationMock.sendNotification
      .mockResolvedValueOnce({ success: false, error: "LK unavailable" })
      .mockResolvedValueOnce({ success: true, broadcastUuid: "broadcast-retry" });
    prismaMock.documentExpirationAlert.create
      .mockImplementationOnce(({ data }) =>
        Promise.resolve({ id: "alert-1", attemptCount: data.attemptCount }),
      )
      .mockRejectedValueOnce({ code: "P2002" });
    prismaMock.documentExpirationAlert.findFirst.mockResolvedValueOnce({
      id: "alert-1",
      status: "RETRY",
      attemptCount: 1,
    });
    prismaMock.documentExpirationAlert.updateMany.mockResolvedValue({ count: 1 });

    const firstResult = await service.scanAndDispatchAlerts(fixedNow);
    expect(firstResult.alertsSent).toBe(0);
    expect(prismaMock.documentExpirationAlert.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "alert-1", leaseToken: expect.any(String) }),
        data: expect.objectContaining({ status: "RETRY", lastError: "LK unavailable" }),
      }),
    );

    const secondResult = await service.scanAndDispatchAlerts(
      new Date(fixedNow.getTime() + 60 * 60 * 1000),
    );
    expect(secondResult.alertsSent).toBe(1);
    expect(prismaMock.documentExpirationAlert.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "alert-1" }),
        data: expect.objectContaining({ status: "CLAIMED" }),
      }),
    );
    expect(prismaMock.documentExpirationAlert.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "alert-1", leaseToken: expect.any(String) }),
        data: expect.objectContaining({ status: "SENT", broadcastUuid: "broadcast-retry" }),
      }),
    );
  });

  it("retries a due alert without scanning documents and preserves its idempotency key", async () => {
    const now = new Date("2026-11-03T04:00:00.000Z");
    const expiresAt = new Date("2026-11-10T00:00:00.000Z");
    const alert = {
      id: "alert-retry", documentId: "doc-1", previousDocId: null, candidateId: "candidate-1",
      employeeId: null, recipientCode1c: "HR1", recipientRole: "manager", documentTitle: "Патент",
      expiresAt, thresholdDays: 7, status: "RETRY", attemptCount: 1,
      document: { status: "APPROVED", expiresAt, candidateId: "candidate-1", documentType: { title: "Патент" },
        candidate: { fullName: "Иванов", managerCode1c: "HR1", chatUuid: null, citizenship: "uz" } },
      previousDoc: null,
    };
    prismaMock.documentExpirationAlert.findMany.mockResolvedValueOnce([alert]);
    let leaseToken = "";
    prismaMock.documentExpirationAlert.updateMany.mockImplementation(async ({ data }: { data: { leaseToken?: string } }) => {
      if (data.leaseToken) leaseToken = data.leaseToken;
      return { count: 1 };
    });
    prismaMock.documentExpirationAlert.findUnique.mockImplementation(async () => ({ ...alert, status: "CLAIMED", leaseToken }));
    const result = await service.retryDueAlerts(now);
    expect(result.sent).toBe(1);
    expect(prismaMock.document.findMany).not.toHaveBeenCalled();
    expect(lkNotificationMock.sendNotification).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "document-expiration:alert-retry", recipientCodes1c: ["HR1"],
    }));
  });

  it("supersedes a due alert when its manager has changed", async () => {
    const now = new Date("2026-11-03T04:00:00.000Z");
    const expiresAt = new Date("2026-11-10T00:00:00.000Z");
    const alert = {
      id: "stale", documentId: "doc-1", previousDocId: null, recipientCode1c: "old", expiresAt, thresholdDays: 7,
      document: { status: "APPROVED", expiresAt, candidate: { managerCode1c: "new" } }, previousDoc: null,
    };
    prismaMock.documentExpirationAlert.findMany.mockResolvedValueOnce([alert]);
    let leaseToken = "";
    prismaMock.documentExpirationAlert.updateMany.mockImplementation(async ({ data }: { data: { leaseToken?: string } }) => {
      if (data.leaseToken) leaseToken = data.leaseToken;
      return { count: 1 };
    });
    prismaMock.documentExpirationAlert.findUnique.mockImplementation(async () => ({ ...alert, status: "CLAIMED", leaseToken }));
    await service.retryDueAlerts(now);
    expect(lkNotificationMock.sendNotification).not.toHaveBeenCalled();
    expect(prismaMock.documentExpirationAlert.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "stale" }), data: expect.objectContaining({ status: "SUPERSEDED" }),
    }));
  });
});
