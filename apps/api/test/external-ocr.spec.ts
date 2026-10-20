import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExternalOcrService,
  normalizeOcrResponse,
} from "../src/ocr/external-ocr.service";
import {
  MIGRATION_UID,
  PASSPORT_UID,
  resolveOcrProfile,
} from "../src/ocr/ocr-profile";
import { validateOcrResult, type OcrRequest } from "../src/ocr/ocr.service";

const field = (
  name: string,
  value: string,
  source = "PADDLE",
  confidence = 0.93,
) => ({
  name,
  value,
  source,
  paddle_text: "ORIGINAL",
  paddle_confidence: confidence,
});
const request: OcrRequest = {
  jobId: "job",
  documentId: "doc",
  version: 1,
  documentTypeCode: "PASSPORT",
  documentUid: PASSPORT_UID,
  citizenship: "ru",
  files: [
    {
      id: "file",
      ordinal: 0,
      mimeType: "image/png",
      pageCount: 1,
      downloadUrl: "https://storage.test/signed",
    },
  ],
};
const service = (extra: Record<string, unknown> = {}) =>
  new ExternalOcrService({
    get: (key: string) =>
      ({
        OCR_MODE: "external",
        OCR_RU_BASE_URL: "http://ocr.test:8001",
        OCR_UZ_BASE_URL: "http://ocr.test:8000",
        ...extra,
      })[key],
  } as never);
afterEach(() => vi.unstubAllGlobals());

describe("OCR profiles and normalization without inference", () => {
  it("routes only the supported type/citizenship combinations", () => {
    expect(resolveOcrProfile(request)).toBe("passport_ru");
    expect(resolveOcrProfile({ ...request, citizenship: "uz" })).toBe(
      "passport_uz",
    );
    expect(resolveOcrProfile({ ...request, citizenship: "kg" })).toBeNull();
    expect(resolveOcrProfile({ ...request, documentUid: "other" })).toBeNull();
    expect(resolveOcrProfile({ ...request, documentUid: MIGRATION_UID })).toBe(
      "migration_card",
    );
  });
  it("preserves Paddle text/score after GLM and normalizes only valid dates", () => {
    const result = normalizeOcrResponse("passport_ru", {
      data: { doc_type: "passport_ru" },
      ocr_fields: [
        field("date_issue", "20.10.2026", "GLM", 0.4),
        field("first_name", "TEST"),
        field("issued_by_code", "000-000"),
      ],
    });
    expect(validateOcrResult(result, [])).toMatchObject({
      outcome: "SUCCEEDED",
      fields: { issueDate: "2026-10-20", departmentCode: "000-000" },
      ocrFields: [
        { source: "GLM", paddleText: "ORIGINAL", paddleConfidence: 0.4 },
        { name: "first_name", documentFieldName: null },
        {},
      ],
    });
    expect(
      result.outcome === "SUCCEEDED" && result.fields.first_name,
    ).toBeUndefined();
    const invalid = normalizeOcrResponse("passport_ru", {
      data: {},
      ocr_fields: [field("date_issue", "31.02.2026")],
    });
    expect(invalid.outcome === "SUCCEEDED" && invalid.fields).toEqual({});
  });
  it("splits only a complete UZ passport number and never maps entry dates to issueDate", () => {
    expect(
      normalizeOcrResponse("passport_uz", [
        {
          type: "passport",
          fields: {},
          ocr_fields: [field("pas_number", "AA1234567")],
        },
      ]),
    ).toMatchObject({ fields: { series: "AA", number: "1234567" } });
    expect(
      normalizeOcrResponse("migration_card", [
        {
          type: "migration_card",
          fields: {},
          ocr_fields: [
            field("mg_duration_from", "20.10.2026"),
            field("mg_series", "1234"),
          ],
        },
      ]),
    ).toMatchObject({ fields: { series: "1234" } });
  });
  it("reports mismatched/empty documents and rejects invalid confidence or missing provenance", () => {
    expect(
      normalizeOcrResponse("migration_card", [
        { type: "passport", fields: {}, ocr_fields: [] },
      ]),
    ).toMatchObject({
      outcome: "REJECTED",
      issues: [{ code: "DOCUMENT_TYPE_MISMATCH" }],
    });
    expect(normalizeOcrResponse("passport_uz", [])).toMatchObject({
      outcome: "REJECTED",
      issues: [{ code: "POOR_IMAGE_QUALITY" }],
    });
    expect(() =>
      normalizeOcrResponse("passport_ru", {
        data: {},
        ocr_fields: [field("number", "123", "PADDLE", 2)],
      }),
    ).toThrow();
    expect(() => normalizeOcrResponse("passport_ru", { data: {} })).toThrow();
  });
});

describe("external OCR HTTP adapter", () => {
  it.each(["ru", "uz"])(
    "downloads bounded files and sends multipart to the correct %s endpoint",
    async (citizenship) => {
      const output =
        citizenship === "ru"
          ? { data: {}, ocr_fields: [field("number", "123")] }
          : [
              {
                type: "passport",
                fields: {},
                ocr_fields: [field("pas_number", "AA1234567")],
              },
            ];
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response("image"))
        .mockResolvedValueOnce(Response.json(output));
      vi.stubGlobal("fetch", fetcher);
      expect(
        await service().recognize(
          { ...request, citizenship },
          new AbortController().signal,
        ),
      ).toMatchObject({ outcome: "SUCCEEDED" });
      const [url, init] = fetcher.mock.calls[1];
      expect(String(url)).toContain(
        citizenship === "ru" ? ":8001/parse?" : ":8000/recognize?",
      );
      expect(String(url)).toContain("debug=false");
      expect(init.body).toBeInstanceOf(FormData);
      expect(init.body.getAll("files")).toHaveLength(1);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.redirect).toBe("error");
    },
  );
  it("preserves cancellation and hides remote errors/bodies", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response("image"))
      .mockResolvedValueOnce(
        new Response("private diagnostic", { status: 503 }),
      );
    vi.stubGlobal("fetch", fetcher);
    await expect(
      service().recognize(request, new AbortController().signal),
    ).rejects.toThrow("OCR_UNAVAILABLE");
    const aborted = new AbortController();
    aborted.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init) => {
        init.signal.throwIfAborted();
      }),
    );
    await expect(
      service().recognize(request, aborted.signal),
    ).rejects.toThrow();
    expect(service({ OCR_MODE: "disabled" }).isAvailable()).toBe(false);
  });
  it("rejects oversized bodies before buffering them and malformed JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(new Uint8Array(10 * 1024 * 1024 + 1)),
        ),
    );
    await expect(
      service().recognize(request, new AbortController().signal),
    ).rejects.toThrow("OCR_CONTRACT_INVALID");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("image"))
        .mockResolvedValueOnce(new Response("not JSON")),
    );
    await expect(
      service().recognize(request, new AbortController().signal),
    ).rejects.toThrow("OCR_CONTRACT_INVALID");
  });
});
