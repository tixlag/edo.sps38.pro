import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { CandidatePreviousDocumentsDto } from "@edo/api-client";
import { CandidateDrawerHistorySection } from "./CandidateDrawerHistorySection";

const mockApi = vi.hoisted(() => ({
  getCandidatePreviousDocumentOriginal: vi.fn(),
  useListCandidatePreviousDocuments: vi.fn(),
}));

vi.mock("@edo/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@edo/api-client")>();
  return {
    ...actual,
    getCandidatePreviousDocumentOriginal: (
      ...args: Parameters<typeof mockApi.getCandidatePreviousDocumentOriginal>
    ) => mockApi.getCandidatePreviousDocumentOriginal(...args),
    useListCandidatePreviousDocuments: (
      ...args: Parameters<typeof mockApi.useListCandidatePreviousDocuments>
    ) => mockApi.useListCandidatePreviousDocuments(...args),
  };
});

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("CandidateDrawerHistorySection", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:http://localhost/test");
    URL.revokeObjectURL = vi.fn();
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValue(
      new Blob(["test-binary"]),
    );
    mockApi.useListCandidatePreviousDocuments.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.clearAllMocks();
  });

  async function renderSection(
    props: Parameters<typeof CandidateDrawerHistorySection>[0],
  ) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<CandidateDrawerHistorySection {...props} />);
    });
  }

  const sampleData: CandidatePreviousDocumentsDto = {
    employmentHistory: {
      available: true,
      items: [
        {
          eventType: "HIRE",
          eventDate: "2021-03-01",
          startDate: "2021-03-01",
        },
        {
          eventType: "DISMISSAL",
          eventDate: "2023-08-31",
          startDate: null,
        },
      ],
    },
    edoDocuments: [
      {
        id: "edo-1",
        title: "Заявление о приёме",
        currentVersion: 2,
        status: "APPROVED",
      },
    ],
    items: [
      {
        id: "erp-1",
        title: "Трудовая книжка",
        documentUid: "uid-tk",
        status: "CONFIRMED",
        originalAvailable: true,
        expiresAt: null,
        reviewedBy: null,
        reviewedAt: null,
        fields: {
          series: "TK-1",
          number: "987654",
        },
      },
    ],
  };

  it("is collapsed by default and displays total records count in badge", async () => {
    await renderSection({
      candidateId: "cand-1",
      data: sampleData,
    });

    expect(container?.textContent).toContain("История документов");
    // 1 edoDoc + 1 erp item = 2 total
    expect(container?.textContent).toContain("2");

    // Collapsed: items are not visible
    expect(container?.textContent).not.toContain("Кадровая история в ERP");
    expect(container?.textContent).not.toContain("Заявление о приёме");
  });

  it("expands on header click and displays ERP employment history", async () => {
    await renderSection({
      candidateId: "cand-1",
      data: sampleData,
    });

    const headerButton = container?.querySelector("button");
    expect(headerButton).toBeTruthy();

    await act(async () => {
      headerButton?.click();
    });

    expect(container?.textContent).toContain("Кадровая история в ERP");
    expect(container?.textContent).toContain("Приём · 01.03.2021");
    expect(container?.textContent).toContain("Увольнение · 31.08.2023");
  });

  it("displays historical EDO documents and allows opening them", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => ({
      location: { href: "" },
      opener: null,
    } as unknown as Window));

    await renderSection({
      candidateId: "cand-1",
      data: sampleData,
      defaultOpen: true,
    });

    expect(container?.textContent).toContain(
      "Документы прошлых оформлений в ЭДО",
    );
    expect(container?.textContent).toContain("Заявление о приёме");
    expect(container?.textContent).toContain("Версия 2 · Одобрен");

    const openEdoBtn = container?.querySelector(
      'button[aria-label="Открыть оригинал: Заявление о приёме"]',
    ) as HTMLButtonElement;
    expect(openEdoBtn).toBeTruthy();

    await act(async () => {
      openEdoBtn.click();
    });

    expect(mockApi.getCandidatePreviousDocumentOriginal).toHaveBeenCalledWith(
      "cand-1",
      "edo-1",
    );
    expect(openSpy).toHaveBeenCalled();
  });

  it("displays historical ERP documents with requisites and open button", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => ({
      location: { href: "" },
      opener: null,
    } as unknown as Window));

    await renderSection({
      candidateId: "cand-1",
      data: sampleData,
      defaultOpen: true,
    });

    expect(container?.textContent).toContain("Прежние документы физлица из ERP");
    expect(container?.textContent).toContain("Трудовая книжка");
    expect(container?.textContent).toContain("Актуален и подтверждён");
    expect(container?.textContent).toContain("Серия/номер: TK-1 987654");

    const openErpBtn = container?.querySelector(
      'button[aria-label="Открыть оригинал: Трудовая книжка"]',
    ) as HTMLButtonElement;
    expect(openErpBtn).toBeTruthy();

    await act(async () => {
      openErpBtn.click();
    });

    expect(mockApi.getCandidatePreviousDocumentOriginal).toHaveBeenCalledWith(
      "cand-1",
      "erp-1",
    );
    expect(openSpy).toHaveBeenCalled();
  });

  it("handles loading and error states properly", async () => {
    const onRetry = vi.fn();

    await renderSection({
      candidateId: "cand-1",
      isLoading: true,
      defaultOpen: true,
    });
    expect(container?.textContent).toContain("Загрузка истории документов…");

    await renderSection({
      candidateId: "cand-1",
      isError: true,
      defaultOpen: true,
      onRetry,
    });
    expect(container?.textContent).toContain(
      "Не удалось загрузить историю документов.",
    );

    const retryBtn = [...(container?.querySelectorAll("button") ?? [])].find(
      (btn) => btn.textContent?.includes("Повторить"),
    );
    expect(retryBtn).toBeTruthy();

    await act(async () => {
      retryBtn?.click();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
