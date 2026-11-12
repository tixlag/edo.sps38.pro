import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  CandidateDocumentSummaryDto,
  PreviousDocumentAvailabilityDto,
} from "@edo/api-client";
import { CandidatePreviousDocumentCard } from "./CandidatePreviousDocumentCard";

const api = vi.hoisted(() => ({ original: vi.fn(), version: vi.fn() }));
vi.mock("@edo/api-client", async (original) => ({
  ...(await original<typeof import("@edo/api-client")>()),
  getCandidatePreviousDocumentOriginal: (...args: unknown[]) =>
    api.original(...args),
}));
vi.mock("../../../../packages/api-client/src/mutator/custom-instance", () => ({
  customInstance: (...args: unknown[]) => api.version(...args),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const current = (
  changes: Partial<CandidateDocumentSummaryDto> = {},
): CandidateDocumentSummaryDto => ({
  id: "edo",
  documentUid: "uid",
  documentTypeCode: "SNILS",
  title: "СНИЛС",
  status: "APPROVED",
  currentVersion: 2,
  revision: 1,
  deliveryStatus: "SENT",
  pendingDeliveryVersions: [],
  submittedAt: null,
  reviewedAt: null,
  reviewedBy: null,
  ocrStatus: null,
  ocrErrorCode: null,
  ...changes,
});
const previous = (
  changes: Partial<PreviousDocumentAvailabilityDto> = {},
): PreviousDocumentAvailabilityDto => ({
  id: "erp",
  documentUid: "uid",
  documentTypeCode: "SNILS",
  title: "СНИЛС",
  source: "ERP",
  sourceDescription: "Из ERP",
  category: "required",
  state: "REUSED",
  originalAvailable: true,
  expiresAt: null,
  recordedAt: null,
  fields: {},
  ...changes,
});

describe("candidate document card", () => {
  let root: Root;
  let node: HTMLDivElement;
  afterEach(async () => {
    await act(async () => root?.unmount());
    node?.remove();
    vi.clearAllMocks();
  });
  async function render(
    props: Partial<Parameters<typeof CandidatePreviousDocumentCard>[0]> = {},
  ) {
    api.version.mockResolvedValue({ status: "APPROVED", files: [] });
    api.original.mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await act(async () =>
      root.render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <CandidatePreviousDocumentCard
            candidateId="candidate"
            title="СНИЛС"
            {...props}
          />
        </QueryClientProvider>,
      ),
    );
  }
  it.each(["RU", "IG"] as const)(
    "always uses EDO over a credited ERP original for %s",
    async (reviewGroup) => {
      const onReviewCurrent = vi.fn(),
        onOpenPrevious = vi.fn();
      await render({
        reviewGroup,
        currentDocument: current({
          status: "IN_REVIEW",
          deliveryStatus: "NONE",
        }),
        previousDocument: previous(),
        onReviewCurrent,
        onOpenPrevious,
      });
      expect(node.textContent).toContain("Из ЭДО");
      expect(node.textContent).not.toContain("Из ERP");
      expect(node.textContent).toContain("Ожидает проверки");
      expect(node.textContent).not.toContain("Зачтён");
      expect(api.original).not.toHaveBeenCalled();
      await act(async () =>
        node
          .querySelector<HTMLButtonElement>('button[title="Открыть документ"]')!
          .click(),
      );
      await act(async () =>
        [...node.querySelectorAll("button")]
          .find((b) => b.textContent === "Проверить документ")!
          .click(),
      );
      expect(onReviewCurrent).toHaveBeenNthCalledWith(1, "edo", 2);
      expect(onReviewCurrent).toHaveBeenNthCalledWith(2, "edo", 2);
      expect(onOpenPrevious).not.toHaveBeenCalled();
    },
  );
  it.each(["compact", "expanded"] as const)(
    "has one outline EDO opening action in %s mode",
    async (mode) => {
      await render({
        mode,
        currentDocument: current(),
        previousDocument: previous(),
      });
      const buttons = [...node.querySelectorAll("button")].filter(
        (b) => b.textContent === "Открыть документ",
      );
      expect(buttons).toHaveLength(1);
      expect(buttons[0].className).toContain("border-[var(--border)]");
      expect(buttons[0].className).toContain("h-8");
      expect(node.textContent).not.toContain("Оригинал из ERP");
      expect(node.querySelectorAll("h3")).toHaveLength(1);
    },
  );
  it.each([
    ["SENT", "Сохранён в ERP"],
    ["PENDING", "Отправляется в ERP"],
    ["SENDING", "Отправляется в ERP"],
    ["REQUIRES_MANUAL", "Не сохранён в ERP"],
    ["WAITING_CONTRACT", "Отправка в ERP недоступна"],
    [null, "Сохранение в ERP не подтверждено"],
    ["UNKNOWN", "Сохранение в ERP не подтверждено"],
  ])("shows approval delivery %s truthfully", async (deliveryStatus, label) => {
    await render({
      currentDocument: current({
        deliveryStatus,
        deliveryErrorReason:
          deliveryStatus === "REQUIRES_MANUAL" ? "1С отклонила файл" : null,
      }),
    });
    expect(node.textContent).toContain(label);
    expect(node.textContent).not.toContain("Документ принят");
    if (deliveryStatus === "REQUIRES_MANUAL") {
      expect(node.textContent).toContain("1С отклонила файл");
      expect(node.textContent).toContain("Документ сохранён в ЭДО");
    }
  });
  it("does not let a credited ERP copy hide an EDO delivery failure", async () => {
    await render({
      currentDocument: current({ deliveryStatus: "REQUIRES_MANUAL" }),
      previousDocument: previous(),
    });
    expect(node.textContent).toContain("Не сохранён в ERP");
    expect(node.textContent).not.toContain("Зачтён ранее");
    expect(api.original).not.toHaveBeenCalled();
  });
  it("does not attach the rejection of v1 to the accepted current v2", async () => {
    const returned = {
      version: 1,
      rejectionReason: "Старая причина",
      reviewedAt: null,
      reviewedBy: null,
      submittedAt: null,
      supersededByVersion: 2,
    };
    await render({
      currentDocument: current({ returnedVersions: [returned] }),
      returnedVersion: returned,
    });
    expect(node.textContent).toContain("Сохранён в ERP");
    expect(node.textContent).not.toContain("Старая причина");
    expect(node.textContent).not.toContain("Возвращён");
  });
  it("keeps a returned EDO version primary, with its own reason and no binary read", async () => {
    const onReviewCurrent = vi.fn();
    await render({
      currentDocument: current({
        status: "RETURNED",
        returnedVersions: [
          {
            version: 2,
            rejectionReason: "Нечитаемый снимок",
            reviewedAt: null,
            reviewedBy: null,
            submittedAt: null,
            supersededByVersion: null,
          },
        ],
      }),
      previousDocument: previous(),
      onReviewCurrent,
    });
    expect(node.textContent).toContain("Возвращён");
    expect(node.textContent).toContain("Нечитаемый снимок");
    expect(api.version).not.toHaveBeenCalled();
    expect(api.original).not.toHaveBeenCalled();
    await act(async () =>
      node
        .querySelector<HTMLButtonElement>('button[title="Открыть документ"]')!
        .click(),
    );
    expect(onReviewCurrent).toHaveBeenCalledWith("edo", 2);
  });
  it.each(["compact", "expanded"] as const)(
    "opens only the ERP original when EDO is absent in %s",
    async (mode) => {
      const onOpenPrevious = vi.fn();
      await render({ mode, previousDocument: previous(), onOpenPrevious });
      expect(node.textContent).toContain("Из ERP");
      expect(api.version).not.toHaveBeenCalled();
      await act(async () =>
        node
          .querySelector<HTMLButtonElement>('button[title="Открыть документ"]')!
          .click(),
      );
      await act(async () =>
        node
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Открыть оригинал: СНИЛС"]',
          )!
          .click(),
      );
      expect(onOpenPrevious).toHaveBeenNthCalledWith(1, "erp");
      expect(onOpenPrevious).toHaveBeenNthCalledWith(2, "erp");
    },
  );
  it("keeps an unavailable ERP file as a disabled placeholder", async () => {
    await render({
      previousDocument: previous({
        originalAvailable: false,
        state: "ORIGINAL_UNAVAILABLE",
      }),
    });
    expect(node.querySelector("h3")?.textContent).toBe("СНИЛС");
    expect(
      node.querySelector<HTMLButtonElement>(
        'button[aria-label="Открыть оригинал: СНИЛС"]',
      )!.disabled,
    ).toBe(true);
    expect(api.original).not.toHaveBeenCalled();
  });
  it("preserves expiry and requisites of a lone ERP document", async () => {
    await render({
      previousDocument: previous({
        state: "EXPIRED",
        expiresAt: "2020-01-01",
        fields: { series: "12", number: "34" },
      }),
    });
    expect(node.textContent).toContain("Нужна замена");
    expect(node.textContent).toContain("Срок действия истёк");
    expect(node.textContent).toContain("Серия/номер: 12 34");
  });
  it.each([
    ["DRAFT", "Продолжить загрузку"],
    ["IN_REVIEW", "Проверить документ"],
    ["APPROVED", "Открыть документ"],
  ] as const)(
    "labels reviewer upload in %s by its actual state",
    async (status, label) => {
      await render({
        currentDocument: current({ status, uploadOrigin: "REVIEWER" }),
      });
      expect(
        [...node.querySelectorAll("button")].some(
          (b) => b.textContent === label,
        ),
      ).toBe(true);
    },
  );
  it("keeps the missing title without opening actions", async () => {
    await render({ isMissing: true, status: "MISSING" });
    expect(node.textContent).toContain("Не загружен");
    expect(node.querySelector("h3")?.textContent).toBe("СНИЛС");
    expect(node.querySelector("button")).toBeNull();
  });
  it("shows an old return only in the explicit archive context and opens that version", async () => {
    const returned = {
      version: 1,
      rejectionReason: "Старая причина",
      reviewedAt: null,
      reviewedBy: null,
      submittedAt: null,
      supersededByVersion: 2,
    };
    const onReviewCurrent = vi.fn();
    await render({
      currentDocument: current({ returnedVersions: [returned] }),
      returnedVersion: returned,
      returnedHistory: true,
      onReviewCurrent,
    });
    expect(node.textContent).toContain("Старая причина");
    expect(node.textContent).toContain("Возвращён");
    expect(api.version).not.toHaveBeenCalled();
    await act(async () =>
      [...node.querySelectorAll("button")]
        .find((b) => b.textContent === "Открыть документ")!
        .click(),
    );
    expect(onReviewCurrent).toHaveBeenCalledWith("edo", 1);
  });
});
