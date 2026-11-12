import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  useGetDocumentInfo,
  useRetryReviewerDocumentDelivery,
  type DocumentVersionDto,
} from "@edo/api-client";
import { DocumentReviewDialog } from "./DocumentReviewDialog";

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ proceed: vi.fn(), reset: vi.fn() }),
}));

vi.mock("@edo/api-client", () => ({
  useGetDocumentInfo: vi.fn(),
  useRetryReviewerDocumentDelivery: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
  })),
}));

vi.mock("./DocumentReviewWorkspace", () => ({
  DocumentReviewWorkspace: () => <div data-testid="workspace" />,
}));

vi.mock("./PreviousDocumentEditor", () => ({
  PreviousDocumentEditor: () => <div data-testid="previous-editor" />,
}));

vi.mock("./ReviewerDocumentUpload", () => ({
  ReviewerDocumentUpload: () => <div data-testid="reviewer-upload" />,
}));

vi.mock("../lib/use-live-document-version", () => ({
  useLiveDocumentVersion: vi.fn(),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const { useLiveDocumentVersion } =
  await import("../lib/use-live-document-version");

function versionData(overrides: Partial<DocumentVersionDto> = {}) {
  return {
    documentId: "doc-1",
    candidateId: "cand-1",
    version: 1,
    reviewGroup: "RU",
    status: "APPROVED",
    revision: 2,
    title: "ИНН",
    uploadOrigin: "CANDIDATE",
    delivery: {
      status: "REQUIRES_MANUAL",
      errorCode: null,
      errorReason: "1С отклонила файл: некорректный формат",
      attempts: [],
    },
    files: [],
    fields: [],
    ...overrides,
  } as unknown as DocumentVersionDto;
}

describe("DocumentReviewDialog delivery actions", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.mocked(useRetryReviewerDocumentDelivery).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isError: false,
    } as never);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.clearAllMocks();
  });

  async function renderDialog(props: {
    version?: number;
    currentVersion?: number;
    returned?: boolean;
  }) {
    const currentVersion = props.currentVersion ?? 1;
    vi.mocked(useGetDocumentInfo).mockReturnValue({
      data: {
        documentId: "doc-1",
        candidateId: "cand-1",
        title: "ИНН",
        currentVersion,
        status: "APPROVED",
        pendingDeliveryVersions: [],
        returnedVersions: props.returned
          ? [{ version: 1, rejectionReason: "Старая причина" }]
          : [],
      },
    } as never);
    vi.mocked(useLiveDocumentVersion).mockReturnValue({
      data: versionData({ version: props.version ?? currentVersion }),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as never);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <DocumentReviewDialog
          candidateId="cand-1"
          documentId="doc-1"
          version={props.version ?? currentVersion}
          onClose={vi.fn()}
          chooseVersion={vi.fn()}
          onUploaded={vi.fn()}
        />,
      );
    });
  }

  it("offers the delivery retry for the current version", async () => {
    await renderDialog({ version: 2, currentVersion: 2 });
    const retry = [...(container?.querySelectorAll("button") ?? [])].find(
      (btn) => btn.textContent?.includes("Повторить отправку в ERP"),
    );
    expect(retry).toBeTruthy();
    expect(container?.textContent).toContain(
      "1С отклонила файл: некорректный формат",
    );
  });

  it("hides the delivery retry for a historic version but keeps it viewable", async () => {
    await renderDialog({ version: 1, currentVersion: 2 });
    const retry = [...(container?.querySelectorAll("button") ?? [])].find(
      (btn) => btn.textContent?.includes("Повторить отправку в ERP"),
    );
    expect(retry).toBeUndefined();
    // The historic version itself stays available
    expect(container?.textContent).toContain("Историческая версия 1");
    expect(container?.querySelector('[data-testid="workspace"]')).toBeTruthy();
  });
  it("labels current and returned EDO versions without offering ERP copies", async () => {
    await renderDialog({ currentVersion: 2, version: 2, returned: true });
    const options = [...container!.querySelectorAll("option")].map(
      (option) => option.textContent,
    );
    expect(options).toEqual(["2 — текущая", "1 — возвращена"]);
    expect(container?.textContent).not.toContain("Старая причина");
    expect(container?.textContent).toContain("Не сохранён в ERP");
  });
});
