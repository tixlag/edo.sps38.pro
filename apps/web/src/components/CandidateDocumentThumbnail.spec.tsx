import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CandidateDocumentThumbnail } from "./CandidateDocumentThumbnail";

const mockApi = vi.hoisted(() => ({
  getCandidatePreviousDocumentOriginal: vi.fn(),
}));

vi.mock("@edo/api-client", () => ({
  getCandidatePreviousDocumentOriginal: (
    ...args: Parameters<typeof mockApi.getCandidatePreviousDocumentOriginal>
  ) => mockApi.getCandidatePreviousDocumentOriginal(...args),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("CandidateDocumentThumbnail", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;
  let createdUrls: string[] = [];
  let revokedUrls: string[] = [];

  beforeEach(() => {
    createdUrls = [];
    revokedUrls = [];
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;

    URL.createObjectURL = vi.fn((_blob: Blob) => {
      const url = `blob:http://localhost/${Math.random().toString(36).slice(2)}`;
      createdUrls.push(url);
      return url;
    });

    URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url);
    });
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.clearAllMocks();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  async function render(props: {
    candidateId: string;
    documentId: string;
    originalAvailable: boolean;
    title: string;
    className?: string;
    onClick?: () => void;
  }) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<CandidateDocumentThumbnail {...props} />);
    });
  }

  it("renders placeholder when originalAvailable is false and makes no network request", async () => {
    await render({
      candidateId: "cand-1",
      documentId: "doc-1",
      originalAvailable: false,
      title: "Паспорт РФ",
    });

    expect(container?.textContent).toContain("Оригинал недоступен");
    expect(mockApi.getCandidatePreviousDocumentOriginal).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("loads blob and creates image thumbnail when original is available", async () => {
    const fakeBlob = new Blob(["fake-image-bytes"], { type: "image/png" });
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValueOnce(fakeBlob);

    await render({
      candidateId: "cand-1",
      documentId: "doc-1",
      originalAvailable: true,
      title: "Скан паспорта",
    });

    // Wait for the async blob load and state update
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockApi.getCandidatePreviousDocumentOriginal).toHaveBeenCalledWith(
      "cand-1",
      "doc-1",
      expect.any(AbortSignal),
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(fakeBlob);

    const img = container?.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("alt")).toBe("Скан паспорта");
    expect(img?.getAttribute("src")).toBe(createdUrls[0]);
  });

  it("revokes object URL upon component unmount", async () => {
    const fakeBlob = new Blob(["fake-image-bytes"], { type: "image/png" });
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValueOnce(fakeBlob);

    await render({
      candidateId: "cand-1",
      documentId: "doc-1",
      originalAvailable: true,
      title: "Скан паспорта",
    });

    await act(async () => {
      await Promise.resolve();
    });

    const activeUrl = createdUrls[0];
    expect(activeUrl).toBeDefined();

    await act(async () => {
      root?.unmount();
      root = undefined;
    });

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(activeUrl);
  });

  it("opens document in a new window when button is clicked", async () => {
    const fakeBlob = new Blob(["fake-image-bytes"], { type: "image/jpeg" });
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValueOnce(fakeBlob);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    await render({
      candidateId: "cand-1",
      documentId: "doc-1",
      originalAvailable: true,
      title: "Скан паспорта",
    });

    await act(async () => {
      await Promise.resolve();
    });

    const button = container?.querySelector(
      'button[aria-label="Открыть документ: Скан паспорта"]',
    ) as HTMLButtonElement;
    expect(button).toBeTruthy();

    await act(async () => {
      button.click();
    });

    expect(openSpy).toHaveBeenCalledWith(
      createdUrls[0],
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("renders PDF object preview when blob is a PDF", async () => {
    const fakeBlob = new Blob(["fake-pdf-bytes"], { type: "application/pdf" });
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValueOnce(fakeBlob);

    await render({
      candidateId: "cand-1",
      documentId: "doc-1",
      originalAvailable: true,
      title: "Договор.pdf",
    });

    await act(async () => {
      await Promise.resolve();
    });

    const pdfObject = container?.querySelector("object");
    expect(pdfObject).toBeTruthy();
    expect(pdfObject?.getAttribute("type")).toBe("application/pdf");
    expect(pdfObject?.getAttribute("data")).toContain(createdUrls[0]);
  });
});
