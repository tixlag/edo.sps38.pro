import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalOcrService } from "../src/ocr/external-ocr.service";
import {
  documentReturnReason,
  validateDocumentCheck,
} from "../src/ocr/document-check";
import type { OcrRequest } from "../src/ocr/ocr.service";

const request: OcrRequest = {
  jobId: "job",
  documentId: "doc",
  version: 1,
  documentTypeCode: "MEDICAL_CERTIFICATE",
  documentUid: "other-document",
  citizenship: "ru",
  files: [
    {
      id: "one",
      ordinal: 0,
      mimeType: "image/png",
      pageCount: 1,
      downloadUrl: "https://storage.test/one",
    },
    {
      id: "two",
      ordinal: 1,
      mimeType: "application/pdf",
      pageCount: 2,
      downloadUrl: "https://storage.test/two",
    },
  ],
};
const page = (
  file_index: number,
  page_number: number,
  verdict = "DOCUMENT",
) => ({
  file_index,
  page_number,
  verdict,
  reason: null,
  non_document_scores: Array(4).fill(verdict === "NON_DOCUMENT" ? 0.999 : 0.01),
});
const response = () => ({
  policy_version: "document-check-v1",
  model: "google/siglip2-base-patch16-224",
  model_revision: "75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2",
  elapsed_ms: 123,
  pages: [page(0, 1), page(1, 1), page(1, 2, "NON_DOCUMENT")],
});
const service = (extra: Record<string, string> = {}) =>
  new ExternalOcrService({
    get: (key: string) =>
      ({
        OCR_MODE: "external",
        OCR_UZ_BASE_URL: "http://ocr.test:8000",
        OCR_RU_BASE_URL: "http://ocr.test:8001",
        OCR_DOCUMENT_CHECK_ENABLED: "true",
        ...extra,
      })[key],
  } as never);
const fetchResponse = (result: unknown) => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response("one"))
    .mockResolvedValueOnce(new Response("two"))
    .mockResolvedValueOnce(
      result instanceof Response ? result : Response.json(result),
    );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
afterEach(() => vi.unstubAllGlobals());

describe("document presence before field OCR", () => {
  it("checks unsupported documents too and returns the bad PDF page with the original ordinal", async () => {
    const fetcher = fetchResponse(response());
    const result = await service().recognize(
      request,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      outcome: "REJECTED",
      rejectionKind: "NON_DOCUMENT",
      issues: [
        {
          code: "POOR_IMAGE_QUALITY",
          message: "Документ не надлежащего качества",
          fileOrdinal: 1,
          pageNumber: 2,
        },
      ],
    });
    expect(String(fetcher.mock.calls[2][0])).toBe(
      "http://ocr.test:8000/document-check",
    );
    expect(fetcher.mock.calls[2][1].body.getAll("files")).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      result.outcome === "REJECTED" &&
        documentReturnReason(result.issues, request.files),
    ).toBe("Документ не надлежащего качества. файл № 2, страница 2");
  });

  it.each(["DOCUMENT", "UNCERTAIN"])(
    "routes %s documents without a field profile",
    async (verdict) => {
      const body = response();
      body.pages = [
        page(0, 1, verdict),
        page(1, 1, verdict),
        page(1, 2, verdict),
      ];
      fetchResponse(body);
      const actual = await service().recognize(
        request,
        new AbortController().signal,
      );
      expect(actual).toMatchObject(
        verdict === "DOCUMENT"
          ? {
              outcome: "SUCCEEDED",
              fields: {},
              raw: { documentCheck: { status: "COMPLETED" } },
            }
          : {
              outcome: "REJECTED",
              rejectionKind: "NON_DOCUMENT",
              issues: [
                { fileOrdinal: 0, pageNumber: 1 },
                { fileOrdinal: 1, pageNumber: 1 },
                { fileOrdinal: 1, pageNumber: 2 },
              ],
            },
      );
    },
  );

  it.each([
    (body: ReturnType<typeof response>) => {
      body.pages.pop();
    },
    (body: ReturnType<typeof response>) => {
      body.pages[0] = page(9, 1);
    },
    (body: ReturnType<typeof response>) => {
      body.pages[0] = page(0, 2);
    },
    (body: ReturnType<typeof response>) => {
      body.pages[0] = page(1, 1);
    },
    (body: ReturnType<typeof response>) => {
      body.pages[2].non_document_scores[2] = 0.98;
    },
    (body: ReturnType<typeof response>) => {
      body.model_revision = "other";
    },
  ])(
    "does not return a document on invalid/partial classification",
    async (change) => {
      const body = response();
      change(body);
      expect(() => validateDocumentCheck(body, request.files)).toThrow();
      fetchResponse(body);
      await expect(
        service().recognize(request, new AbortController().signal),
      ).resolves.toMatchObject({
        outcome: "SUCCEEDED",
        raw: { documentCheck: { status: "UNAVAILABLE" } },
      });
    },
  );

  it.each([404, 429, 500, 503])(
    "fails open on classifier HTTP %s",
    async (status) => {
      fetchResponse(new Response("private server error", { status }));
      await expect(
        service().recognize(request, new AbortController().signal),
      ).resolves.toMatchObject({
        outcome: "SUCCEEDED",
        fields: {},
        raw: { documentCheck: { status: "UNAVAILABLE" } },
      });
    },
  );

  it("runs field OCR after the independent check without downloading files again", async () => {
    const body = response();
    body.pages = [page(0, 1), page(1, 1), page(1, 2)];
    const fetcher = fetchResponse(body).mockResolvedValueOnce(
      Response.json({ data: {}, ocr_fields: [] }),
    );
    await expect(
      service().recognize(
        { ...request, documentUid: undefined, documentTypeCode: "PASSPORT" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      outcome: "SUCCEEDED",
      fields: {},
      raw: { recognition: "NO_FIELDS" },
    });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(String(fetcher.mock.calls[3][0])).toContain(":8001/parse?");
  });

  it("keeps UZ no-fields HTTP 400 available for manual review", async () => {
    const body = response();
    body.pages = [page(0, 1), page(1, 1), page(1, 2)];
    fetchResponse(body).mockResolvedValueOnce(
      new Response("private diagnostic", { status: 400 }),
    );
    await expect(
      service().recognize(
        {
          ...request,
          documentUid: undefined,
          documentTypeCode: "PASSPORT",
          citizenship: "uz",
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ outcome: "SUCCEEDED", fields: {} });
  });

  it("can disable checking without calling the classifier", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("input"));
    vi.stubGlobal("fetch", fetcher);
    await expect(
      service({ OCR_DOCUMENT_CHECK_ENABLED: "false" }).recognize(
        request,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      outcome: "SUCCEEDED",
      raw: { documentCheck: { status: "DISABLED" } },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("treats a classifier timeout as unavailable without cancelling the upload's processing", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("one"))
      .mockResolvedValueOnce(new Response("two"))
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.throwIfAborted();
            init.signal.addEventListener(
              "abort",
              () => reject(init.signal.reason),
              { once: true },
            );
          }),
      );
    vi.stubGlobal("fetch", fetcher);
    const caller = new AbortController();
    await expect(
      service({ OCR_DOCUMENT_CHECK_TIMEOUT_MS: "5" }).recognize(
        request,
        caller.signal,
      ),
    ).resolves.toMatchObject({
      outcome: "SUCCEEDED",
      raw: { documentCheck: { status: "UNAVAILABLE" } },
    });
    expect(caller.signal.aborted).toBe(false);
  });

  it("numbers photos from one and groups PDF pages in the return reason", () => {
    expect(
      documentReturnReason(
        [
          {
            code: "POOR_IMAGE_QUALITY",
            message: "reason",
            fileOrdinal: 0,
            pageNumber: 1,
          },
          {
            code: "POOR_IMAGE_QUALITY",
            message: "reason",
            fileOrdinal: 1,
            pageNumber: 1,
          },
          {
            code: "POOR_IMAGE_QUALITY",
            message: "reason",
            fileOrdinal: 1,
            pageNumber: 2,
          },
        ],
        request.files,
      ),
    ).toBe(
      "Документ не надлежащего качества. фото № 1; файл № 2, страницы 1, 2",
    );
  });
});
