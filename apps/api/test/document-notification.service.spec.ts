import { describe, expect, it, vi } from "vitest";
import { DocumentNotificationService } from "../src/documents/document-notification.service";
import type { PrismaService } from "../src/prisma/prisma.service";
import type { LkNotificationService } from "../src/lk/lk-notification.service";

describe("DocumentNotificationService", () => {
  const createService = (overrides?: {
    prisma?: Partial<PrismaService>;
    lk?: Partial<LkNotificationService>;
  }) => {
    const prisma = {
      candidate: {
        findUnique: vi.fn(),
      },
      document: {
        findUnique: vi.fn(),
      },
      ...overrides?.prisma,
    } as unknown as PrismaService;

    const lk = {
      sendNotification: vi.fn().mockResolvedValue({ success: true, broadcastUuid: "broadcast-uuid-1" }),
      ...overrides?.lk,
    } as unknown as LkNotificationService;

    const service = new DocumentNotificationService(prisma, lk);
    return { service, prisma, lk };
  };

  it("sends OCR review-ready notification to RU manager with correct targetUrl", async () => {
    const { service, lk } = createService({
      prisma: {
        candidate: {
          findUnique: vi.fn().mockResolvedValue({
            id: "cand-ru-1",
            fullName: "Иванов Иван Иванович",
            managerCode1c: "HR-100",
            reviewGroup: "RU",
            citizenship: "ru",
            chatUuid: "chat-uuid-1",
          }),
        } as never,
        document: {
          findUnique: vi.fn().mockResolvedValue({
            id: "doc-1",
            documentType: {
              title: "Паспорт РФ",
              name: "Паспорт",
            },
          }),
        } as never,
      },
    });

    await service.notifyDocumentReadyForReview({
      documentId: "doc-1",
      version: 1,
      candidateId: "cand-ru-1",
    });

    expect(lk.sendNotification).toHaveBeenCalledTimes(1);
    expect(lk.sendNotification).toHaveBeenCalledWith({
      recipientCodes1c: ["HR-100"],
      title: "Документ готов к проверке",
      content: "OCR обработала документ «Паспорт РФ» кандидата **Иванов Иван Иванович**. Проверьте правильность распознанных данных.",
      type: "toast",
      targetType: "candidate_document_upload",
      targetUrl: "/review/candidates/cand-ru-1?document=doc-1",
      idempotencyKey: "document-review-ready:doc-1:1",
    });
  });

  it("sends OCR review-ready notification to IG manager with /review-ig URL", async () => {
    const { service, lk } = createService({
      prisma: {
        candidate: {
          findUnique: vi.fn().mockResolvedValue({
            id: "cand-ig-2",
            fullName: "Каримов Алишер",
            managerCode1c: "MGR-200",
            reviewGroup: "IG",
            citizenship: "uz",
            chatUuid: null,
          }),
        } as never,
        document: {
          findUnique: vi.fn().mockResolvedValue({
            id: "doc-2",
            documentType: {
              title: "Патент на работу",
              name: "Патент",
            },
          }),
        } as never,
      },
    });

    await service.notifyDocumentReadyForReview({
      documentId: "doc-2",
      version: 2,
      candidateId: "cand-ig-2",
    });

    expect(lk.sendNotification).toHaveBeenCalledTimes(1);
    expect(lk.sendNotification).toHaveBeenCalledWith({
      recipientCodes1c: ["MGR-200"],
      title: "Документ готов к проверке",
      content: "OCR обработала документ «Патент на работу» кандидата **Каримов Алишер**. Проверьте правильность распознанных данных.",
      type: "toast",
      targetType: "candidate_document_upload",
      targetUrl: "/review-ig?candidate=cand-ig-2",
      idempotencyKey: "document-review-ready:doc-2:2",
    });
  });

  it("resolves candidateId from document when not passed in params", async () => {
    const { service, lk } = createService({
      prisma: {
        document: {
          findUnique: vi.fn()
            .mockResolvedValueOnce({ candidateId: "cand-found-3" })
            .mockResolvedValueOnce({
              id: "doc-3",
              documentType: { title: "СНИЛС" },
            }),
        } as never,
        candidate: {
          findUnique: vi.fn().mockResolvedValue({
            id: "cand-found-3",
            fullName: "Петров Петр",
            managerCode1c: "HR-300",
            reviewGroup: "RU",
            citizenship: "ru",
            chatUuid: "chat-3",
          }),
        } as never,
      },
    });

    await service.notifyDocumentReadyForReview({
      documentId: "doc-3",
      version: 1,
    });

    expect(lk.sendNotification).toHaveBeenCalledTimes(1);
    expect(lk.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientCodes1c: ["HR-300"],
        targetUrl: "/review/candidates/cand-found-3?document=doc-3",
      }),
    );
  });

  it("does not send notification if managerCode1c is missing or empty", async () => {
    const { service, lk } = createService({
      prisma: {
        candidate: {
          findUnique: vi.fn().mockResolvedValue({
            id: "cand-no-mgr",
            fullName: "Безымянный",
            managerCode1c: null,
            citizenship: "ru",
          }),
        } as never,
      },
    });

    await service.notifyDocumentReadyForReview({
      documentId: "doc-4",
      version: 1,
      candidateId: "cand-no-mgr",
    });

    expect(lk.sendNotification).not.toHaveBeenCalled();
  });

  it("catches LK error gracefully without throwing", async () => {
    const { service } = createService({
      prisma: {
        candidate: {
          findUnique: vi.fn().mockResolvedValue({
            id: "cand-err",
            fullName: "Тестов Тест",
            managerCode1c: "HR-ERR",
            citizenship: "ru",
          }),
        } as never,
        document: {
          findUnique: vi.fn().mockResolvedValue({
            id: "doc-err",
            documentType: { title: "Паспорт" },
          }),
        } as never,
      },
      lk: {
        sendNotification: vi.fn().mockRejectedValue(new Error("LK network down")),
      },
    });

    await expect(
      service.notifyDocumentReadyForReview({
        documentId: "doc-err",
        version: 1,
        candidateId: "cand-err",
      }),
    ).resolves.not.toThrow();
  });
});
