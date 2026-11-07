import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CandidateDocumentSummaryDto,
  MissingDocumentTypeDto,
  PreviousDocumentAvailabilityDto,
} from "@edo/api-client";
import { CandidateStageAccordion } from "./CandidateStageAccordion";

vi.mock("@edo/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@edo/api-client")>();
  return {
    ...actual,
    getCandidatePreviousDocumentOriginal: vi
      .fn()
      .mockResolvedValue(new Blob(["test"])),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("CandidateStageAccordion", () => {
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

  async function renderAccordion(
    props: Parameters<typeof CandidateStageAccordion>[0],
  ) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<CandidateStageAccordion {...props} />);
    });
  }

  it("renders stage badge, title, progress counter and triggers onToggle", async () => {
    const onToggle = vi.fn();

    const requiredDocs: CandidateDocumentSummaryDto[] = [
      {
        id: "d1",
        documentUid: "uid-d1",
        deliveryStatus: "NONE",
        title: "Паспорт",
        documentTypeCode: "PASSPORT",
        status: "APPROVED",
        currentVersion: 1,
        revision: 1,
        ocrStatus: null,
        ocrErrorCode: null,
        pendingDeliveryVersions: [],
        submittedAt: null,
        reviewedAt: null,
        reviewedBy: null,
      },
    ];

    const missingDocs: MissingDocumentTypeDto[] = [
      { code: "SNILS", title: "СНИЛС" },
      { code: "INN", title: "ИНН" },
    ];

    await renderAccordion({
      stage: 1,
      title: "Этап 1 • Проверка документов",
      required: { documents: requiredDocs, missingDocuments: missingDocs },
      additional: { documents: [], missingDocuments: [] },
      previousDocuments: [],
      candidateId: "cand-1",
      isOpen: false,
      onToggle,
    });

    expect(container?.textContent).toContain("1");
    expect(container?.textContent).toContain("Этап 1 • Проверка документов");
    expect(container?.textContent).toContain("1 из 3");

    // Content should be hidden when closed
    expect(container?.textContent).not.toContain("Паспорт");
    expect(container?.textContent).not.toContain("СНИЛС");

    const headerButton = container?.querySelector("button");
    expect(headerButton).toBeTruthy();

    await act(async () => {
      headerButton?.click();
    });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders required and additional document cards when isOpen is true", async () => {
    const onReviewDocument = vi.fn();

    const requiredDocs: CandidateDocumentSummaryDto[] = [
      {
        id: "d1",
        documentUid: "uid-d1",
        deliveryStatus: "NONE",
        title: "Паспорт гражданина РФ",
        documentTypeCode: "PASSPORT",
        status: "APPROVED",
        currentVersion: 1,
        revision: 1,
        ocrStatus: null,
        ocrErrorCode: null,
        pendingDeliveryVersions: [],
        submittedAt: null,
        reviewedAt: null,
        reviewedBy: null,
      },
    ];

    const missingDocs: MissingDocumentTypeDto[] = [
      { code: "SNILS", title: "СНИЛС" },
    ];

    const additionalDocs: CandidateDocumentSummaryDto[] = [
      {
        id: "d2",
        documentUid: "uid-d2",
        deliveryStatus: "NONE",
        title: "Водительское удостоверение",
        documentTypeCode: "DRIVING_LICENSE",
        status: "IN_REVIEW",
        currentVersion: 1,
        revision: 1,
        ocrStatus: null,
        ocrErrorCode: null,
        pendingDeliveryVersions: [],
        submittedAt: null,
        reviewedAt: null,
        reviewedBy: null,
      },
    ];

    await renderAccordion({
      stage: 2,
      title: "Этап 2 • Дополнительные справки",
      required: { documents: requiredDocs, missingDocuments: missingDocs },
      additional: { documents: additionalDocs, missingDocuments: [] },
      previousDocuments: [],
      candidateId: "cand-1",
      isOpen: true,
      onToggle: vi.fn(),
      onReviewDocument,
    });

    expect(container?.textContent).toContain("Паспорт гражданина РФ");
    expect(container?.textContent).toContain("СНИЛС");
    expect(container?.textContent).toContain("Дополнительные");
    expect(container?.textContent).toContain("Водительское удостоверение");

    const reviewButton = [...(container?.querySelectorAll("button") ?? [])].find(
      (btn) => btn.textContent?.includes("Проверить документ"),
    );
    expect(reviewButton).toBeTruthy();

    await act(async () => {
      reviewButton?.click();
    });

    expect(onReviewDocument).toHaveBeenCalledWith("d2", 1);
  });

  it("counts reused previous documents into progress counter", async () => {
    const missingDocs: MissingDocumentTypeDto[] = [
      { code: "PASSPORT", title: "Паспорт" },
      { code: "SNILS", title: "СНИЛС" },
    ];

    const previousDocs: PreviousDocumentAvailabilityDto[] = [
      {
        id: "prev-snils",
        documentUid: "u1",
        documentTypeCode: "SNILS",
        title: "СНИЛС",
        category: "required",
        state: "REUSED",
        expiresAt: null,
        recordedAt: null,
        originalAvailable: true,
        source: "EDO",
        sourceDescription: "Из ЭДО",
        fields: {},
      },
    ];

    await renderAccordion({
      stage: null,
      title: "Вне этапов",
      required: { documents: [], missingDocuments: missingDocs },
      additional: { documents: [], missingDocuments: [] },
      previousDocuments: previousDocs,
      candidateId: "cand-1",
      isOpen: false,
      onToggle: vi.fn(),
    });

    expect(container?.textContent).toContain("Вне этапов");
    // 1 reused out of 2 total
    expect(container?.textContent).toContain("1 из 2");
  });
});
