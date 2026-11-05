import { z } from "zod";
import type { OcrInputFile, OcrResult } from "./ocr.service";
import { readOcrBody } from "./ocr-http";
import {
  canonicalDocumentType,
  isKnownDocumentType,
} from "./document-type-codes";

export const NON_DOCUMENT_REASON = "Документ не надлежащего качества";

export function documentCheckEnabled(config?: {
  get(key: string): unknown;
}): boolean {
  return config?.get("OCR_DOCUMENT_CHECK_ENABLED") !== "false";
}

const checkBase = z.object({
  policy_version: z.enum(["document-check-v1", "document-check-v2"]),
  model: z.literal("google/siglip2-base-patch16-224"),
  model_revision: z.literal("75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2"),
  elapsed_ms: z.number().finite().nonnegative(),
  pages: z
    .array(
      z.object({
        file_index: z.number().int().nonnegative(),
        page_number: z.number().int().positive(),
        verdict: z.enum(["DOCUMENT", "NON_DOCUMENT", "UNCERTAIN"]),
        reason: z
          .enum([
            "DISABLED",
            "UNAVAILABLE",
            "INFERENCE_UNAVAILABLE",
            "DECODE_UNAVAILABLE",
          ])
          .nullable(),
        non_document_scores: z.array(z.number().finite().min(0).max(1)).max(4),
      }),
    )
    .min(1)
    .max(100),
  expected_code: z.string().min(1).max(128).optional(),
  expected_title: z.string().max(512).nullable().optional(),
  expected_canonical_code: z.string().max(128).nullable().optional(),
  detected_code: z.string().max(128).nullable().optional(),
  detected_title: z.string().max(512).nullable().optional(),
  type_verdict: z.enum(["MATCH", "MISMATCH", "UNCERTAIN"]).optional(),
  rejection_reason: z.string().max(1024).nullable().optional(),
  source: z.enum(["GLM", "PADDLE_RULES"]).nullable().optional(),
  type_pages: z
    .array(
      z.object({
        file_index: z.number().int().nonnegative(),
        page_number: z.number().int().positive(),
        verdict: z.enum(["MATCH", "MISMATCH", "UNCERTAIN"]),
        detected_code: z.string().max(128).nullable(),
        source: z.enum(["GLM", "PADDLE_RULES"]).nullable(),
      }),
    )
    .max(100)
    .optional(),
});
const checkResponse = checkBase;

type CheckResponse = z.infer<typeof checkResponse>;
export type DocumentCheckResult =
  | { status: "COMPLETED"; result: CheckResponse }
  | { status: "DISABLED" | "UNAVAILABLE" };

export function validateDocumentCheck(
  input: unknown,
  files: OcrInputFile[],
  expectedCode?: string,
): CheckResponse {
  const result = checkResponse.parse(input);
  if (
    result.policy_version === "document-check-v2" &&
    (!expectedCode ||
      result.expected_code !== expectedCode ||
      !result.type_verdict ||
      !result.type_pages ||
      result.type_pages.length !== result.pages.length)
  )
    throw new Error("DOCUMENT_CHECK_INVALID");
  const expected = files.reduce((count, file) => count + file.pageCount, 0);
  const seen = new Set<string>();
  if (result.pages.length !== expected)
    throw new Error("DOCUMENT_CHECK_INVALID");
  for (const page of result.pages) {
    const file = files[page.file_index];
    const key = `${page.file_index}:${page.page_number}`;
    if (
      !file ||
      page.page_number > file.pageCount ||
      seen.has(key) ||
      page.reason !== null ||
      page.non_document_scores.length !== 4 ||
      (page.verdict === "NON_DOCUMENT" &&
        !page.non_document_scores.every((score) => score >= 0.99))
    ) {
      throw new Error("DOCUMENT_CHECK_INVALID");
    }
    seen.add(key);
  }
  if (result.policy_version === "document-check-v2") {
    const typeSeen = new Set<string>();
    for (const page of result.type_pages ?? []) {
      const key = `${page.file_index}:${page.page_number}`;
      if (!seen.has(key) || typeSeen.has(key))
        throw new Error("DOCUMENT_CHECK_INVALID");
      typeSeen.add(key);
    }
  }
  return result;
}

export async function checkDocumentPresence(
  baseUrl: string | undefined,
  form: FormData,
  files: OcrInputFile[],
  caller: AbortSignal,
  timeoutMs: number,
  expectedCode?: string,
): Promise<DocumentCheckResult> {
  try {
    const url = new URL(baseUrl ?? "");
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("DOCUMENT_CHECK_NOT_CONFIGURED");
    url.pathname = `${url.pathname.replace(/\/$/, "")}/document-check`;
    if (expectedCode) form.set("expected_code", expectedCode);
    const response = await fetch(url, {
      method: "POST",
      body: form,
      redirect: "error",
      signal: AbortSignal.any([caller, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("DOCUMENT_CHECK_UNAVAILABLE");
    }
    const bytes = await readOcrBody(response, 256 * 1024);
    return {
      status: "COMPLETED",
      result: validateDocumentCheck(
        JSON.parse(bytes.toString("utf8")),
        files,
        expectedCode,
      ),
    };
  } catch {
    // Outages, missing endpoints and invalid/partial results do not consume
    // a candidate's automatic return attempts.
    caller.throwIfAborted();
    return { status: "UNAVAILABLE" };
  } finally {
    form.delete("expected_code");
  }
}

export function nonDocumentResult(
  check: DocumentCheckResult,
  files: OcrInputFile[],
): OcrResult | null {
  if (check.status !== "COMPLETED") return null;
  const pages = check.result.pages.filter(
    (page) => page.verdict === "NON_DOCUMENT",
  );
  if (!pages.length) return null;
  return {
    outcome: "REJECTED",
    rejectionKind: "NON_DOCUMENT",
    source: "EXTERNAL",
    raw: { documentCheck: check },
    issues: pages.map((page) => ({
      code: "POOR_IMAGE_QUALITY",
      message: NON_DOCUMENT_REASON,
      fileOrdinal: files[page.file_index].ordinal,
      pageNumber: page.page_number,
    })),
  };
}

export function typeMismatchResult(
  check: DocumentCheckResult,
): OcrResult | null {
  if (check.status !== "COMPLETED") return null;
  const result = check.result;
  if (
    result.policy_version !== "document-check-v2" ||
    result.type_verdict !== "MISMATCH" ||
    !result.expected_title ||
    !result.detected_title ||
    !result.detected_code ||
    !result.expected_canonical_code ||
    !result.expected_code ||
    result.expected_canonical_code !==
      canonicalDocumentType(result.expected_code) ||
    !isKnownDocumentType(result.expected_canonical_code) ||
    !isKnownDocumentType(result.detected_code) ||
    result.detected_code === result.expected_canonical_code ||
    !result.type_pages?.length ||
    result.type_pages.some(
      (page) =>
        page.verdict !== "MISMATCH" ||
        page.detected_code !== result.detected_code ||
        !page.source ||
        !["GLM", "PADDLE_RULES"].includes(page.source),
    )
  )
    return null;
  const message =
    `Загружен документ «${result.detected_title}» вместо ожидаемого «${result.expected_title}». Пожалуйста, прикрепите верный документ.`.slice(
      0,
      1024,
    );
  return {
    outcome: "REJECTED",
    rejectionKind: "DOCUMENT_TYPE_MISMATCH",
    source: "EXTERNAL",
    raw: { documentCheck: check },
    issues: [
      {
        code: "DOCUMENT_TYPE_MISMATCH",
        message,
        fileOrdinal: null,
        pageNumber: null,
      },
    ],
  };
}

export function documentReturnReason(
  issues: Extract<OcrResult, { outcome: "REJECTED" }>["issues"],
  files: Pick<OcrInputFile, "ordinal" | "mimeType">[],
): string {
  // Ordinals are zero-based internally; user-facing photo/file numbers start at 1.
  const groups = new Map<number, number[]>();
  for (const issue of issues) {
    const ordinal = issue.fileOrdinal ?? 0;
    const pages = groups.get(ordinal) ?? [];
    if (issue.pageNumber !== null) pages.push(issue.pageNumber);
    groups.set(ordinal, pages);
  }
  const locations = [...groups].map(([ordinal, pages]) =>
    files.find((file) => file.ordinal === ordinal)?.mimeType ===
    "application/pdf"
      ? `файл № ${ordinal + 1}, ${pages.length > 1 ? "страницы" : "страница"} ${pages.join(", ")}`
      : `фото № ${ordinal + 1}`,
  );
  return `${NON_DOCUMENT_REASON}. ${locations.join("; ")}`.slice(0, 1024);
}
