import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CandidateDocumentSummaryDto,
  PreviousDocumentAvailabilityDto,
  ReturnedDocumentVersionDto,
} from "@edo/api-client";
import { CandidatePreviousDocumentCard } from "./CandidatePreviousDocumentCard";

const mockApi = vi.hoisted(() => ({
  getCandidatePreviousDocumentOriginal: vi.fn().mockResolvedValue(new Blob(["test"])),
}));

vi.mock("@edo/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@edo/api-client")>();
  return {
    ...actual,
    getCandidatePreviousDocumentOriginal: (
      ...args: Parameters<typeof mockApi.getCandidatePreviousDocumentOriginal>
    ) => mockApi.getCandidatePreviousDocumentOriginal(...args),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("CandidatePreviousDocumentCard", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:http://localhost/test");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.clearAllMocks();
  });

  async function renderCard(props: Parameters<typeof CandidatePreviousDocumentCard>[0]) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<CandidatePreviousDocumentCard {...props} />);
    });
  }

  it("renders in compact mode for missing documents", async () => {
    await renderCard({
      candidateId: "cand-1",
      title: "ИНН",
      isMissing: true,
      status: "MISSING",
    });

    expect(container?.textContent).toContain("ИНН");
    expect(container?.textContent).toContain("Не загружен");
    // Compact mode shouldn't have previous version blocks or review buttons
    expect(container?.textContent).not.toContain("Документ из ERP");
    expect(container?.textContent).not.toContain("Проверить документ");
  });

  it("renders in compact mode for automatically reused documents without current doc", async () => {
    const prevDoc: PreviousDocumentAvailabilityDto = {
      id: "prev-1",
      documentUid: "uid-1",
      documentTypeCode: "SNILS",
      title: "СНИЛС",
      category: "required",
      state: "REUSED",
      expiresAt: null,
      recordedAt: null,
      originalAvailable: true,
      source: "EDO",
      sourceDescription: "Из прошлого оформления в ЭДО",
      fields: {},
    };

    await renderCard({
      candidateId: "cand-1",
      title: "СНИЛС",
      previousDocument: prevDoc,
      status: "REUSED",
    });

    expect(container?.textContent).toContain("СНИЛС");
    expect(container?.textContent).toContain("Зачтён ранее");
    expect(container?.textContent).not.toContain("Проверить документ");
  });

  it("renders in expanded mode with previous version details and open button", async () => {
    const prevDoc: PreviousDocumentAvailabilityDto = {
      id: "prev-passport",
      documentUid: "uid-2",
      documentTypeCode: "PASSPORT",
      title: "Паспорт РФ",
      category: "required",
      state: "REQUIRES_REVIEW",
      expiresAt: "2035-10-20",
      recordedAt: "2020-01-01",
      originalAvailable: true,
      source: "ERP",
      sourceDescription: "Из кадрового архива ERP",
      fields: {
        series: "4510",
        number: "123456",
        issuedAt: "2015-05-15",
      },
    };

    await renderCard({
      candidateId: "cand-1",
      title: "Паспорт гражданина РФ",
      previousDocument: prevDoc,
      status: "REQUIRES_REVIEW",
    });

    expect(container?.textContent).toContain("Паспорт гражданина РФ");
    expect(container?.textContent).toContain("Проверить актуальность");
    expect(container?.textContent).toContain("Документ из ERP");
    expect(container?.textContent).toContain("Из кадрового архива ERP");
    expect(container?.textContent).toContain("Срок действия: 20.10.2035");
    expect(container?.textContent).toContain("Серия/номер: 4510 123456");
    expect(container?.textContent).toContain("Выдан: 15.05.2015");

    const openBtn = [...(container?.querySelectorAll("button") ?? [])].find((btn) =>
      btn.textContent?.includes("Открыть документ"),
    );
    expect(openBtn).toBeTruthy();
  });

  it("displays expired warning when previous document expiry date is in the past", async () => {
    const prevDoc: PreviousDocumentAvailabilityDto = {
      id: "prev-patent",
      documentUid: "uid-3",
      documentTypeCode: "PATENT",
      title: "Патент на работу",
      category: "required",
      state: "EXPIRED",
      expiresAt: "2020-01-01",
      recordedAt: "2019-01-01",
      originalAvailable: true,
      source: "ERP",
      sourceDescription: "Из ERP",
      fields: {},
    };

    await renderCard({
      candidateId: "cand-1",
      title: "Патент на работу",
      previousDocument: prevDoc,
    });

    expect(container?.textContent).toContain("Нужна замена");
    expect(container?.textContent).toContain(
      "Срок действия истёк. Нужно загрузить снова",
    );
  });

  it("renders 'Проверить документ' action for current candidate document and triggers callback", async () => {
    const onReviewCurrent = vi.fn();
    const currDoc: CandidateDocumentSummaryDto = {
      id: "doc-in-review",
      documentUid: "uid-curr-1",
      deliveryStatus: "NONE",
      documentTypeCode: "MIGRATION_CARD",
      title: "Миграционная карта",
      status: "IN_REVIEW",
      currentVersion: 2,
      revision: 1,
      ocrStatus: null,
      ocrErrorCode: null,
      pendingDeliveryVersions: [],
      submittedAt: "2026-11-06T10:00:00Z",
      reviewedAt: null,
      reviewedBy: null,
    };

    await renderCard({
      candidateId: "cand-1",
      title: "Миграционная карта",
      currentDocument: currDoc,
      onReviewCurrent,
    });

    expect(container?.textContent).toContain("Ожидает проверки");
    expect(container?.textContent).toContain("Текущая версия: 2");

    const reviewBtn = [...(container?.querySelectorAll("button") ?? [])].find((btn) =>
      btn.textContent?.includes("Проверить документ"),
    );
    expect(reviewBtn).toBeTruthy();

    await act(async () => {
      reviewBtn?.click();
    });

    expect(onReviewCurrent).toHaveBeenCalledWith("doc-in-review", 2);
  });

  it("displays rejection reason when status is RETURNED", async () => {
    const currentDocument: CandidateDocumentSummaryDto = {
      id: "doc-returned",
      documentUid: "uid-returned",
      deliveryStatus: "NONE",
      documentTypeCode: "CONTRACT",
      title: "Трудовой договор",
      status: "RETURNED",
      currentVersion: 1,
      revision: 1,
      ocrStatus: null,
      ocrErrorCode: null,
      pendingDeliveryVersions: [],
      submittedAt: "2026-11-05T10:00:00Z",
      reviewedAt: "2026-11-05T12:00:00Z",
      reviewedBy: "ocr-document-check",
    };
    const returnedVersion: ReturnedDocumentVersionDto = {
      version: 1,
      rejectionReason: "Неразборчивая подпись и печать",
      reviewedAt: "2026-11-05T12:00:00Z",
      reviewedBy: "reviewer-uuid",
      submittedAt: "2026-11-05T10:00:00Z",
      supersededByVersion: null,
    };

    await renderCard({
      candidateId: "cand-1",
      title: "Трудовой договор",
      status: "RETURNED",
      currentDocument,
      returnedVersion,
    });

    expect(container?.textContent).toContain("Возвращён");
    expect(container?.textContent).toContain("Причина возврата:");
    expect(container?.textContent).toContain("Неразборчивая подпись и печать");
    expect(container?.textContent).toContain("Текущая версия: 1");
    expect(container?.textContent).not.toContain("Проверить документ");
  });

  it("calls getCandidatePreviousDocumentOriginal and opens tab when 'Открыть документ' is clicked", async () => {
    const fakeBlob = new Blob(["test"], { type: "application/pdf" });
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValueOnce(fakeBlob);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => ({
      location: { href: "" },
      opener: null,
    } as unknown as Window));

    const prevDoc: PreviousDocumentAvailabilityDto = {
      id: "prev-snils",
      documentUid: "snils-1",
      documentTypeCode: "SNILS",
      title: "СНИЛС",
      category: "required",
      state: "REQUIRES_REVIEW",
      expiresAt: null,
      recordedAt: null,
      originalAvailable: true,
      source: "EDO",
      sourceDescription: "Из ЭДО",
      fields: {},
    };

    await renderCard({
      candidateId: "cand-1",
      title: "СНИЛС",
      previousDocument: prevDoc,
    });

    const openBtn = container?.querySelector(
      'button[aria-label="Открыть оригинал: СНИЛС"]',
    ) as HTMLButtonElement;
    expect(openBtn).toBeTruthy();

    await act(async () => {
      openBtn.click();
    });

    expect(mockApi.getCandidatePreviousDocumentOriginal).toHaveBeenLastCalledWith(
      "cand-1",
      "prev-snils",
    );
    expect(openSpy).toHaveBeenCalled();
  });

  it("prioritizes currentDocument APPROVED status over previousDocument REQUIRES_REVIEW state", async () => {
    const prevDoc: PreviousDocumentAvailabilityDto = {
      id: "prev-patent",
      documentUid: "uid-patent",
      documentTypeCode: "PATENT",
      title: "Патент",
      category: "required",
      state: "REQUIRES_REVIEW",
      expiresAt: "2027-01-01",
      recordedAt: null,
      originalAvailable: true,
      source: "ERP",
      sourceDescription: "Из 1С",
      fields: {},
    };

    const currentDoc: CandidateDocumentSummaryDto = {
      id: "doc-approved-1",
      documentUid: "uid-curr-1",
      documentTypeCode: "PATENT",
      title: "Патент",
      status: "APPROVED",
      currentVersion: 1,
      deliveryStatus: "NONE",
      revision: 1,
      ocrStatus: null,
      ocrErrorCode: null,
      pendingDeliveryVersions: [],
      submittedAt: "2026-11-06T10:00:00Z",
      reviewedAt: null,
      reviewedBy: null,
    };

    await renderCard({
      candidateId: "cand-1",
      title: "Патент",
      status: "APPROVED",
      currentDocument: currentDoc,
      previousDocument: prevDoc,
    });

    expect(container?.textContent).toContain("Документ принят");
    expect(container?.textContent).not.toContain("Проверить актуальность");
  });

  it("prioritizes currentDocument IN_REVIEW status over previousDocument state", async () => {
    const prevDoc: PreviousDocumentAvailabilityDto = {
      id: "prev-patent",
      documentUid: "uid-patent",
      documentTypeCode: "PATENT",
      title: "Патент",
      category: "required",
      state: "REQUIRES_REVIEW",
      expiresAt: "2027-01-01",
      recordedAt: null,
      originalAvailable: true,
      source: "ERP",
      sourceDescription: "Из 1С",
      fields: {},
    };

    const currentDoc: CandidateDocumentSummaryDto = {
      id: "doc-in-review-1",
      documentUid: "uid-curr-1",
      documentTypeCode: "PATENT",
      title: "Патент",
      status: "IN_REVIEW",
      currentVersion: 1,
      deliveryStatus: "NONE",
      revision: 1,
      ocrStatus: null,
      ocrErrorCode: null,
      pendingDeliveryVersions: [],
      submittedAt: "2026-11-06T10:00:00Z",
      reviewedAt: null,
      reviewedBy: null,
    };

    await renderCard({
      candidateId: "cand-1",
      title: "Патент",
      status: "IN_REVIEW",
      currentDocument: currentDoc,
      previousDocument: prevDoc,
    });

    expect(container?.textContent).toContain("Ожидает проверки");
  });
  it("shows the approved ERP original and keeps the EDO upload reachable", async () => {
    const onReviewCurrent = vi.fn();
    await renderCard({ candidateId: "candidate", reviewGroup: "RU", title: "Паспорт", status: "IN_REVIEW",
      currentDocument: { id: "adaptation-doc", status: "IN_REVIEW", currentVersion: 1, deliveryStatus: "NONE" } as never,
      previousDocument: { id: "erp-original", title: "Паспорт", source: "ERP", state: "REUSED", originalAvailable: true, fields: {} } as never,
      onReviewCurrent,
    });
    expect(container?.textContent).toContain("Документ принят");
    expect(container?.textContent).toContain("Документ из ERP");
    // One document block only: the EDO upload is an action, not a second block
    expect(container?.textContent).not.toContain("Текущая версия");
    expect(container?.textContent).toContain("Загрузка в ЭДО: версия 1");
    expect(mockApi.getCandidatePreviousDocumentOriginal).toHaveBeenCalledWith("candidate", "erp-original", expect.any(AbortSignal));

    const edoBtn = [...(container?.querySelectorAll("button") ?? [])].find((btn) =>
      btn.textContent?.includes("Проверить документ"),
    );
    expect(edoBtn).toBeTruthy();
    await act(async () => {
      edoBtn?.click();
    });
    expect(onReviewCurrent).toHaveBeenCalledWith("adaptation-doc", 1);
  });

  it.each(["RU", "IG"] as const)(
    "behaves identically for %s candidates",
    async (reviewGroup) => {
      const onReviewCurrent = vi.fn();
      await renderCard({
        candidateId: "candidate",
        reviewGroup,
        title: "Паспорт",
        status: "IN_REVIEW",
        currentDocument: {
          id: "adaptation-doc",
          status: "IN_REVIEW",
          currentVersion: 1,
          deliveryStatus: "NONE",
        } as never,
        previousDocument: {
          id: "erp-original",
          title: "Паспорт",
          source: "ERP",
          state: "REUSED",
          originalAvailable: true,
          fields: {},
        } as never,
        onReviewCurrent,
      });
      expect(container?.textContent).toContain("Документ из ERP");
      expect(container?.textContent).toContain("Загрузка в ЭДО: версия 1");
      expect(container?.textContent).not.toContain("Текущая версия");
    },
  );

  it("makes a delivered EDO document the primary source", async () => {
    const onReviewCurrent = vi.fn();
    await renderCard({
      candidateId: "candidate",
      title: "Реквизиты банка",
      status: "APPROVED",
      currentDocument: {
        id: "edo-doc",
        status: "APPROVED",
        currentVersion: 2,
        deliveryStatus: "SENT",
        uploadOrigin: "CANDIDATE",
      } as never,
      previousDocument: {
        id: "erp-original",
        title: "Реквизиты банка",
        source: "ERP",
        state: "REUSED",
        originalAvailable: true,
        fields: {},
      } as never,
      onReviewCurrent,
    });
    // The EDO document won: no competing ERP block, versions stay reachable
    expect(container?.textContent).not.toContain("Документ из ERP");
    expect(container?.textContent).toContain("Текущая версия: 2");
    const openBtn = [...(container?.querySelectorAll("button") ?? [])].find((btn) =>
      btn.textContent?.includes("Открыть документ"),
    );
    expect(openBtn).toBeTruthy();
    await act(async () => {
      openBtn?.click();
    });
    expect(onReviewCurrent).toHaveBeenCalledWith("edo-doc", 2);
  });

  it("opens an EDO document in compact mode even without an ERP original", async () => {
    const onReviewCurrent = vi.fn();
    await renderCard({
      candidateId: "candidate",
      title: "ИНН",
      status: "APPROVED",
      currentDocument: {
        id: "inn-doc",
        status: "APPROVED",
        currentVersion: 1,
        deliveryStatus: "REQUIRES_MANUAL",
        uploadOrigin: "CANDIDATE",
      } as never,
      onReviewCurrent,
    });
    const openBtn = [...(container?.querySelectorAll("button") ?? [])].find((btn) =>
      btn.textContent?.includes("Открыть документ"),
    );
    expect(openBtn).toBeTruthy();
    await act(async () => {
      openBtn?.click();
    });
    expect(onReviewCurrent).toHaveBeenCalledWith("inn-doc", 1);
  });

  it("keeps a returned EDO document openable", async () => {
    const onReviewCurrent = vi.fn();
    await renderCard({
      candidateId: "candidate",
      title: "Трудовой договор",
      status: "RETURNED",
      currentDocument: {
        id: "returned-doc",
        status: "RETURNED",
        currentVersion: 1,
        deliveryStatus: "NONE",
        uploadOrigin: "CANDIDATE",
      } as never,
      onReviewCurrent,
    });
    expect(container?.textContent).toContain("Возвращён");
    const openBtn = [...(container?.querySelectorAll("button") ?? [])].find((btn) =>
      btn.textContent?.includes("Открыть документ"),
    );
    expect(openBtn).toBeTruthy();
    await act(async () => {
      openBtn?.click();
    });
    expect(onReviewCurrent).toHaveBeenCalledWith("returned-doc", 1);
  });
});
