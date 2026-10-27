import { z } from "zod";
import type { OcrInputFile, OcrResult } from "./ocr.service";
import { readOcrBody } from "./ocr-http";

export const NON_DOCUMENT_REASON = "Документ не надлежащего качества";

export function documentCheckEnabled(config?: {
  get(key: string): unknown;
}): boolean {
  return config?.get("OCR_DOCUMENT_CHECK_ENABLED") !== "false";
}

const checkResponse = z.object({
  policy_version: z.literal("document-check-v1"),
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
});

type CheckResponse = z.infer<typeof checkResponse>;
export type DocumentCheckResult =
  | { status: "COMPLETED"; result: CheckResponse }
  | { status: "DISABLED" | "UNAVAILABLE" };

export function validateDocumentCheck(
  input: unknown,
  files: OcrInputFile[],
): CheckResponse {
  const result = checkResponse.parse(input);
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
  return result;
}

export async function checkDocumentPresence(
  baseUrl: string | undefined,
  form: FormData,
  files: OcrInputFile[],
  caller: AbortSignal,
  timeoutMs: number,
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
      result: validateDocumentCheck(JSON.parse(bytes.toString("utf8")), files),
    };
  } catch {
    // Only an explicit, fully validated NON_DOCUMENT result may return a
    // document. Outages, missing endpoints and invalid/partial results fail open.
    caller.throwIfAborted();
    return { status: "UNAVAILABLE" };
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
