import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import {
  OcrService,
  ocrSourceRegionSchema,
  type OcrRequest,
  type OcrResult,
  type OcrField,
} from "./ocr.service";
import { resolveOcrProfile, type OcrProfile } from "./ocr-profile";

const vendorRegion = z
  .object({
    file_index: z.number().int().nonnegative(),
    page_number: z.number().int().positive(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    text: z.string().max(16384).nullable().optional(),
  })
  .transform(({ file_index, page_number, ...region }) => ({
    ...region,
    fileOrdinal: file_index,
    pageNumber: page_number,
  }))
  .pipe(ocrSourceRegionSchema);

const vendorField = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .refine(
      (name) => !["__proto__", "constructor", "prototype"].includes(name),
    ),
  value: z.string().max(16384).nullable(),
  source: z.enum(["PADDLE", "GLM", "MIXED"]),
  paddle_text: z.string().max(16384).nullable(),
  paddle_confidence: z.number().finite().min(0).max(1).nullable(),
  regions: z.array(vendorRegion).max(200).optional(),
});
const ruResponse = z.object({
  data: z
    .object({ doc_type: z.literal("passport_ru").optional() })
    .passthrough(),
  ocr_fields: z.array(vendorField).max(2000),
});
const uzResponse = z
  .array(
    z.object({
      type: z.enum(["passport", "migration_card"]),
      fields: z.record(z.unknown()),
      ocr_fields: z.array(vendorField).max(2000),
    }),
  )
  .max(100);

const mapping: Record<OcrProfile, Record<string, string>> = {
  passport_ru: {
    series: "series",
    number: "number",
    date_issue: "issueDate",
    issued_by: "issuedBy",
    issued_by_code: "departmentCode",
  },
  passport_uz: {
    pas_number: "number",
    pas_date_of_issue: "issueDate",
    pas_date_of_expiry: "expiryDate",
    pas_authority: "issuedBy",
    pas_surname: "lastNameLatin",
    pas_name: "firstNameLatin",
  },
  migration_card: {
    mg_series: "series",
    mg_number: "number",
    mg_surname_lat: "lastNameLatin",
  },
};

function calendarDate(value: string): string | null {
  const match = /^(\d{2})[./-](\d{2})[./-](\d{4})$/.exec(value.trim());
  const iso = match ? `${match[3]}-${match[2]}-${match[1]}` : value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(Date.parse(iso)))
    return null;
  return new Date(iso).toISOString().slice(0, 10) === iso ? iso : null;
}

export function normalizeOcrResponse(
  profile: OcrProfile,
  input: unknown,
): OcrResult {
  const docs =
    profile === "passport_ru"
      ? [ruResponse.parse(input)]
      : uzResponse.parse(input);
  const expected = profile === "passport_uz" ? "passport" : "migration_card";
  const selected = docs.filter(
    (doc) => !("type" in doc) || doc.type === expected,
  );
  const rejected = (
    code: "DOCUMENT_TYPE_MISMATCH" | "POOR_IMAGE_QUALITY",
  ): OcrResult => ({
    outcome: "REJECTED",
    source: "EXTERNAL",
    raw: { profile },
    issues: [
      {
        code,
        message:
          code === "DOCUMENT_TYPE_MISMATCH"
            ? "Распознан другой тип документа"
            : "Не удалось распознать поля документа",
        fileOrdinal: null,
        pageNumber: null,
      },
    ],
  });
  if (!selected.length)
    return rejected(
      docs.length ? "DOCUMENT_TYPE_MISMATCH" : "POOR_IMAGE_QUALITY",
    );
  const fields: Record<string, string | null> = {};
  const fieldTexts: Record<string, string> = {};
  const regions: Extract<OcrResult, { outcome: "SUCCEEDED" }>["regions"] = [];
  const ocrFields: OcrField[] = [];
  for (const doc of selected)
    for (const field of doc.ocr_fields) {
      const documentFieldName = mapping[profile][field.name] ?? null;
      const ocrFieldOrdinal = ocrFields.length;
      ocrFields.push({
        name: field.name,
        documentFieldName,
        value: field.value,
        source: field.source,
        paddleText: field.paddle_text,
        paddleConfidence: field.paddle_confidence,
        ...(field.regions ? { regions: field.regions } : {}),
      });
      let value = field.value;
      if (
        !documentFieldName ||
        !value?.trim() ||
        fields[documentFieldName] != null
      )
        continue;
      const assign = (
        name: string,
        normalized: string | null,
        text: string,
      ) => {
        if (
          fields[name] !== undefined &&
          (fields[name] !== null || normalized === null)
        )
          return;
        for (let index = regions.length - 1; index >= 0; index--)
          if (regions[index].fieldName === name) regions.splice(index, 1);
        fields[name] = normalized;
        fieldTexts[name] = text;
        regions.push(
          ...(field.regions ?? []).map((region) => ({
            ...region,
            fieldName: name,
            ocrFieldOrdinal,
          })),
        );
      };
      if (["issueDate", "expiryDate"].includes(documentFieldName))
        value = calendarDate(value);
      if (profile === "passport_uz" && field.name === "pas_number") {
        const split = /^([A-Z]{2})(\d{7})$/.exec(value!.trim());
        if (split) {
          assign("series", split[1], split[1]);
          assign("number", split[2], split[2]);
          continue;
        }
      }
      assign(documentFieldName, value, field.value!);
    }
  if (!ocrFields.some((field) => field.value?.trim()))
    return rejected("POOR_IMAGE_QUALITY");
  // Keep useful raw recognition, excluding debug paths, filenames and server diagnostics.
  return {
    outcome: "SUCCEEDED",
    source: "EXTERNAL",
    fields,
    fieldTexts,
    ocrFields,
    regions,
    raw: { profile, ocrFields },
  };
}

/** Bounded body reader: do not buffer untrusted responses before checking their size. */
async function readBody(response: Response, max: number): Promise<Buffer> {
  if (!response.body) throw new Error("OCR_CONTRACT_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > max) throw new Error("OCR_CONTRACT_INVALID");
      chunks.push(item.value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

@Injectable()
export class ExternalOcrService extends OcrService {
  constructor(private readonly config: ConfigService) {
    super();
  }
  isAvailable(): boolean {
    return this.config.get("OCR_MODE") === "external";
  }
  private endpoint(profile: OcrProfile): URL {
    try {
      const url = new URL(
        this.config.get<string>(
          profile === "passport_ru" ? "OCR_RU_BASE_URL" : "OCR_UZ_BASE_URL",
        ) ?? "",
      );
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${profile === "passport_ru" ? "parse" : "recognize"}`;
      url.searchParams.set("debug", "false");
      if (profile === "passport_ru") {
        url.searchParams.set("doc_type", "passport_ru");
        url.searchParams.set("ocr_engine", "paddle");
      }
      return url;
    } catch {
      throw new Error("OCR_NOT_CONFIGURED");
    }
  }
  async recognize(
    request: OcrRequest,
    caller: AbortSignal,
  ): Promise<OcrResult> {
    if (!this.isAvailable()) throw new Error("OCR_NOT_CONFIGURED");
    const profile = resolveOcrProfile(request);
    if (!profile) throw new Error("OCR_UNSUPPORTED_DOCUMENT");
    const endpoint = this.endpoint(profile);
    const signal = AbortSignal.any([
      caller,
      AbortSignal.timeout(
        Number(this.config.get("OCR_REQUEST_TIMEOUT_MS") ?? 240000),
      ),
    ]);
    const form = new FormData();
    let total = 0;
    for (const file of request.files) {
      const download = await fetch(file.downloadUrl, {
        signal,
        redirect: "error",
      });
      if (!download.ok) {
        await download.body?.cancel();
        throw new Error("OCR_DOWNLOAD_FAILED");
      }
      const bytes = await readBody(download, 10 * 1024 * 1024);
      total += bytes.length;
      if (total > 50 * 1024 * 1024) throw new Error("OCR_CONTRACT_INVALID");
      const extension =
        (
          {
            "image/jpeg": "jpg",
            "image/png": "png",
            "image/webp": "webp",
            "application/pdf": "pdf",
          } as Record<string, string>
        )[file.mimeType] ?? "bin";
      form.append(
        "files",
        new Blob([new Uint8Array(bytes)], { type: file.mimeType }),
        `document-${file.ordinal}.${extension}`,
      );
    }
    const response = await fetch(endpoint, {
      method: "POST",
      body: form,
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (profile !== "passport_ru" && response.status === 400)
        return {
          outcome: "REJECTED",
          source: "EXTERNAL",
          raw: { profile },
          issues: [
            {
              code: "POOR_IMAGE_QUALITY",
              message: "Не удалось распознать документ",
              fileOrdinal: null,
              pageNumber: null,
            },
          ],
        };
      throw new Error(
        response.status >= 400 &&
          response.status < 500 &&
          ![408, 429].includes(response.status)
          ? "OCR_CONTRACT_INVALID"
          : "OCR_UNAVAILABLE",
      );
    }
    const bytes = await readBody(response, 2 * 1024 * 1024);
    let body: unknown;
    try {
      body = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("OCR_CONTRACT_INVALID");
    }
    return normalizeOcrResponse(profile, body);
  }
}
