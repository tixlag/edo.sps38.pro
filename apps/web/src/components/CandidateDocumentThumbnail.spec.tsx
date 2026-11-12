import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CandidateDocumentThumbnail } from "./CandidateDocumentThumbnail";

const mockApi = vi.hoisted(() => ({
  getCandidatePreviousDocumentOriginal: vi.fn(),
  getDocumentVersion: vi.fn(),
  getDocumentFileBinary: vi.fn(),
  getPage: vi.fn(),
}));

vi.mock("@edo/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@edo/api-client")>()),
  getCandidatePreviousDocumentOriginal: (...args: unknown[]) =>
    mockApi.getCandidatePreviousDocumentOriginal(...args),
}));
vi.mock("../../../../packages/api-client/src/mutator/custom-instance", () => ({
  customInstance: (config: { url: string }) =>
    config.url.endsWith("/file")
      ? mockApi.getDocumentFileBinary(config)
      : mockApi.getDocumentVersion(config),
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({ getPage: mockApi.getPage }),
    destroy: async () => undefined,
  }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("CandidateDocumentThumbnail", () => {
  let root: Root | undefined;
  let client: QueryClient;
  let container: HTMLDivElement | undefined;
  let originalCreateObjectURL: typeof URL.createObjectURL;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL;
  let createdUrls: string[] = [];
  let revokedUrls: string[] = [];

  beforeEach(() => {
    mockApi.getPage.mockResolvedValue({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 900 * scale,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    });
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
    vi.useRealTimers();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  });

  async function render(
    props: Parameters<typeof CandidateDocumentThumbnail>[0],
  ) {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root?.render(
        <QueryClientProvider client={client}>
          <CandidateDocumentThumbnail {...props} />
        </QueryClientProvider>,
      );
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
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValueOnce(
      fakeBlob,
    );

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
    expect(img?.className).toContain("object-contain");
  });

  it("revokes object URL upon component unmount", async () => {
    const fakeBlob = new Blob(["fake-image-bytes"], { type: "image/png" });
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValueOnce(
      fakeBlob,
    );

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
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValueOnce(
      fakeBlob,
    );
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
      container?.querySelector("img")?.dispatchEvent(new Event("load"));
    });
    await act(async () => {
      button.click();
    });

    expect(openSpy).toHaveBeenCalledWith(
      createdUrls[0],
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("renders the first PDF page with PDF.js", async () => {
    const fakeBlob = new Blob(["fake-pdf-bytes"], { type: "application/pdf" });
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValueOnce(
      fakeBlob,
    );

    await render({
      candidateId: "cand-1",
      documentId: "doc-1",
      originalAvailable: true,
      title: "Договор.pdf",
    });

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(container?.querySelector("canvas")).toBeTruthy();
    expect(mockApi.getPage).toHaveBeenCalledWith(1);
  });
  it("loads the EDO version and its first retained file only after visibility", async () => {
    let intersect:
      | ((
          entries: IntersectionObserverEntry[],
          observer: IntersectionObserver,
        ) => void)
      | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(
          callback: (
            entries: IntersectionObserverEntry[],
            observer: IntersectionObserver,
          ) => void,
        ) {
          intersect = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    mockApi.getDocumentVersion.mockResolvedValue({
      status: "APPROVED",
      files: [
        { id: "deleted", deleted: true, ordinal: 0 },
        { id: "second", deleted: false, ordinal: 2 },
        { id: "first", deleted: false, ordinal: 1, mimeType: "image/webp" },
      ],
    });
    mockApi.getDocumentFileBinary.mockResolvedValue(
      new Blob(["image"], { type: "image/webp" }),
    );
    try {
      await render({
        candidateId: "candidate",
        documentId: "edo",
        version: 3,
        originalAvailable: true,
        title: "ИНН",
      });
      expect(mockApi.getDocumentVersion).not.toHaveBeenCalled();
      await act(async () => {
        intersect?.(
          [{ isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(mockApi.getDocumentVersion).toHaveBeenCalledWith(
        expect.objectContaining({ url: "/api/v1/documents/edo/versions/3" }),
      );
      expect(mockApi.getDocumentFileBinary).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "/api/v1/documents/edo/versions/3/files/first/file",
        }),
      );
      await vi.waitFor(async () => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        expect(container?.querySelector("img")).toBeTruthy();
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["RETURNED", "EMPTY", "DENIED"])(
    "keeps %s EDO files unavailable without breaking opening versions",
    async (state) => {
      mockApi.getDocumentVersion.mockResolvedValue({
        status: state === "RETURNED" ? "RETURNED" : "APPROVED",
        files:
          state === "EMPTY"
            ? []
            : [
                {
                  id: "first",
                  deleted: false,
                  ordinal: 0,
                  mimeType: "image/png",
                },
              ],
      });
      mockApi.getDocumentFileBinary.mockRejectedValue(new Error("403"));
      const onClick = vi.fn();
      await render({
        candidateId: "candidate",
        documentId: "edo",
        version: 1,
        originalAvailable: true,
        title: "ИНН",
        onClick,
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      await vi.waitFor(async () => {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        expect(container?.textContent).toContain("Превью недоступно");
      });
      if (state !== "DENIED")
        expect(mockApi.getDocumentFileBinary).not.toHaveBeenCalled();
      await act(async () =>
        container
          ?.querySelector<HTMLButtonElement>('button[title="Открыть документ"]')
          ?.click(),
      );
      expect(onClick).toHaveBeenCalledOnce();
    },
  );
  it("stops waiting after 30 seconds, aborts a slow ERP request, and supports retry and opening", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    mockApi.getCandidatePreviousDocumentOriginal.mockImplementationOnce(
      (_candidate: string, _document: string, value: AbortSignal) => {
        signal = value;
        return new Promise(() => undefined);
      },
    );
    mockApi.getCandidatePreviousDocumentOriginal.mockResolvedValueOnce(
      new Blob(["image"], { type: "image/png" }),
    );
    const onClick = vi.fn();
    await render({
      candidateId: "c",
      documentId: "p",
      originalAvailable: true,
      title: "Паспорт",
      onClick,
    });
    expect(
      container?.querySelector('[aria-label="Загрузка превью"]'),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(signal!.aborted).toBe(true);
    expect(container?.textContent).toContain("Превью недоступно");
    expect(
      container?.querySelector('[aria-label="Загрузка превью"]'),
    ).toBeNull();
    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>('button[title="Открыть документ"]')!
        .click(),
    );
    expect(onClick).toHaveBeenCalledOnce();
    await act(async () =>
      container
        ?.querySelector<HTMLButtonElement>(
          'button[aria-label="Повторить загрузку превью: Паспорт"]',
        )!
        .click(),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container?.querySelector("img")).toBeTruthy();
  });
  it("keeps a ready EDO image visible throughout a background refetch", async () => {
    vi.useFakeTimers();
    mockApi.getDocumentVersion.mockResolvedValue({
      status: "APPROVED",
      files: [
        { id: "first", deleted: false, ordinal: 0, mimeType: "image/png" },
      ],
    });
    mockApi.getDocumentFileBinary.mockResolvedValue(
      new Blob(["first"], { type: "image/png" }),
    );
    await render({
      candidateId: "c",
      documentId: "edo",
      version: 1,
      originalAvailable: true,
      title: "ИНН",
    });
    // Metadata and binary queries notify React in separate timer turns.
    for (let i=0;i<3;i++) await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(container?.querySelector("img")).toBeTruthy();
    await act(async () =>
      container?.querySelector("img")!.dispatchEvent(new Event("load")),
    );
    const src = container?.querySelector("img")?.src;
    let resolve: (value: Blob) => void = () => undefined;
    mockApi.getDocumentFileBinary.mockImplementationOnce(
      () => new Promise<Blob>((done) => (resolve = done)),
    );
    let pending: Promise<void>;
    await act(async () => {
      pending = client.refetchQueries({
        queryKey: ["/api/v1/documents/edo/versions/1/files/first/file"],
      });
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(container?.querySelector("img")?.src).toBe(src);
    expect(
      container?.querySelector('[aria-label="Загрузка превью"]'),
    ).toBeNull();
    await act(async () => {
      resolve(new Blob(["second"], { type: "image/png" }));
      await pending!;
      await vi.advanceTimersByTimeAsync(20);
    });
  });
});
