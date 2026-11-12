import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CandidateDocumentSummaryDto,
  MissingDocumentTypeDto,
  ReviewStageProgressDto,
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

vi.mock("../../../../packages/api-client/src/mutator/custom-instance", () => ({
  customInstance: () => Promise.resolve({ status: "APPROVED", files: [] }),
}));

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
      root?.render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <CandidateStageAccordion {...props} />
        </QueryClientProvider>,
      );
    });
  }

  it("renders stage badge, title once with progress counter and triggers onToggle", async () => {
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
    // Displays how many documents loaded and how many remaining
    expect(container?.textContent).toContain("1 из 3");
    expect(container?.textContent).toContain("ещё нужно 2");

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

    const reviewButton = [
      ...(container?.querySelectorAll("button") ?? []),
    ].find((btn) => btn.textContent?.includes("Проверить документ"));
    expect(reviewButton).toBeTruthy();

    await act(async () => {
      reviewButton?.click();
    });

    expect(onReviewDocument).toHaveBeenCalledWith("d2", 1);
  });

  it("renders inline StageRing with progress when provided, without duplicate counters in header", async () => {
    const onToggle = vi.fn();
    const progress: ReviewStageProgressDto = {
      stage: 1,
      required: {
        approved: 1,
        reused: 1,
        signed: 0,
        inReview: 0,
        uploaded: 0,
        ocrPending: 0,
        ocrFailed: 0,
        returned: 0,
        expired: 0,
        draft: 0,
        missing: 1,
      },
      additional: {
        approved: 0,
        reused: 0,
        signed: 0,
        inReview: 0,
        uploaded: 0,
        ocrPending: 0,
        ocrFailed: 0,
        returned: 0,
        expired: 0,
        draft: 0,
        missing: 0,
      },
    };

    await renderAccordion({
      stage: 1,
      title: "Этап 1",
      required: { documents: [], missingDocuments: [] },
      additional: { documents: [], missingDocuments: [] },
      previousDocuments: [],
      candidateId: "cand-1",
      isOpen: false,
      progress,
      onToggle,
    });

    expect(container?.textContent).toContain("Этап 1");
    // Displays how many documents confirmed and how many remaining
    expect(container?.textContent).toContain("2 из 3");
    expect(container?.textContent).toContain("ещё нужно 1");

    // Title should only appear once (not duplicated under diagram)
    const matches = container?.textContent?.match(/Этап 1/g) ?? [];
    expect(matches.length).toBe(1);

    // The inline StageRing button exists and has accessible label
    const ringButton = container?.querySelector(
      '[aria-label*="Статистика документов"]',
    );
    expect(ringButton).toBeTruthy();

    // Clicking ring button also triggers onToggle
    await act(async () => {
      (ringButton as HTMLElement)?.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
  it("keeps INN and SNILS as separate named cards in stage 2", async () => {
    await renderAccordion({
      stage: 2,
      title: "Этап 2",
      candidateId: "candidate",
      isOpen: true,
      onToggle: vi.fn(),
      required: {
        documents: [
          {
            id: "inn",
            documentUid: "inn",
            documentTypeCode: "INN",
            title: "ИНН",
            status: "APPROVED",
            currentVersion: 1,
            deliveryStatus: "SENT",
          },
          {
            id: "snils",
            documentUid: "snils",
            documentTypeCode: "SNILS",
            title: "СНИЛС",
            status: "APPROVED",
            currentVersion: 1,
            deliveryStatus: "SENT",
          },
        ] as CandidateDocumentSummaryDto[],
        missingDocuments: [],
      },
      additional: { documents: [], missingDocuments: [] },
      previousDocuments: [],
    });
    const titles = [...container!.querySelectorAll("h3")].filter((el) =>
      ["ИНН", "СНИЛС"].includes(el.textContent ?? ""),
    );
    expect(titles.map((el) => el.textContent)).toEqual(["ИНН", "СНИЛС"]);
    expect(titles[0].closest("article")).not.toBe(titles[1].closest("article"));
  });
  it("shows delivery problems on a collapsed stage while keeping approved required counters", async () => {
    await renderAccordion({
      stage: 7,
      title: "Этап 7",
      candidateId: "candidate",
      isOpen: false,
      onToggle: vi.fn(),
      required: { documents: [], missingDocuments: [] },
      additional: { documents: [], missingDocuments: [] },
      previousDocuments: [],
      progress: {
        stage: 7,
        required: { approved: 1 },
        additional: { approved: 1 },
        deliveryProblemCount: 1,
      } as ReviewStageProgressDto,
    });
    expect(container?.textContent).toContain("Проверено: 1 из 1");
    expect(container?.textContent).toContain("Проблемы отправки: 1");
  });
});
