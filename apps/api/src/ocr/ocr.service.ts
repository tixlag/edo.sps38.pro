import { z } from "zod";

export interface OcrInputFile {
  id: string;
  ordinal: number;
  mimeType: string;
  pageCount: number;
  downloadUrl: string;
}

/** EDO's internal adapter input; this is NOT the external vendor's wire contract. */
export interface OcrRequest {
  jobId: string;
  documentId: string;
  version: number;
  documentTypeCode: string;
  documentUid?: string | null;
  citizenship?: string | null;
  files: OcrInputFile[];
}

export const ocrIssueSchema = z.object({
  code: z.enum(["DOCUMENT_TYPE_MISMATCH", "POOR_IMAGE_QUALITY"]),
  message: z.string().min(1).max(1024),
  fileOrdinal: z.number().int().nonnegative().nullable().default(null),
  pageNumber: z.number().int().positive().nullable().default(null),
});

/** Coordinates in the displayed source page, never in a detector crop. */
export const ocrSourceRegionSchema = z
  .object({
    fileOrdinal: z.number().int().nonnegative(),
    pageNumber: z.number().int().positive(),
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
    text: z.string().max(16_384).nullable().optional(),
  })
  .refine(
    (r) => r.x + r.width <= 1.000001 && r.y + r.height <= 1.000001,
    "OCR region exceeds page bounds",
  );

export const ocrFieldSchema = z.object({
  name: z.string().min(1).max(128),
  documentFieldName: z.string().min(1).max(128).nullable(),
  value: z.string().max(16384).nullable(),
  source: z.enum(["PADDLE", "GLM", "MIXED"]),
  paddleText: z.string().max(16384).nullable(),
  paddleConfidence: z.number().finite().min(0).max(1).nullable(),
  regions: z.array(ocrSourceRegionSchema).max(200).optional(),
});
export type OcrField = z.infer<typeof ocrFieldSchema>;

const fieldsSchema = z
  .record(z.string().min(1).max(128), z.string().max(16_384).nullable())
  .refine((v) => Object.keys(v).length <= 200, "Too many fields")
  .refine(
    (v) =>
      Object.keys(v).every(
        (name) => !["__proto__", "constructor", "prototype"].includes(name),
      ),
    "Invalid OCR field name",
  );

/** Internal adapter geometry; vendor pixels/polygons must be converted here. */
export const ocrRegionSchema = z
  .object({
    fieldName: z.string().min(1).max(128),
    ocrFieldOrdinal: z.number().int().nonnegative().optional(),
    fileOrdinal: z.number().int().nonnegative(),
    pageNumber: z.number().int().positive(),
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
    text: z.string().max(16_384).nullable().optional(),
  })
  .refine(
    (region) =>
      region.x + region.width <= 1.000001 &&
      region.y + region.height <= 1.000001,
    "OCR region exceeds page bounds",
  );

export const ocrResultSchema = z
  .discriminatedUnion("outcome", [
    z.object({
      outcome: z.literal("SUCCEEDED"),
      source: z.enum(["STUB", "EXTERNAL"]),
      fields: fieldsSchema,
      fieldTexts: fieldsSchema.optional(),
      ocrFields: z.array(ocrFieldSchema).max(2000).optional(),
      regions: z.array(ocrRegionSchema).max(2000).optional(),
      raw: z.record(z.unknown()),
    }),
    z.object({
      outcome: z.literal("REJECTED"),
      // Internal discriminator; OCR failure/empty fields must never return a document.
      rejectionKind: z.literal("NON_DOCUMENT").optional(),
      source: z.enum(["STUB", "EXTERNAL"]),
      issues: z.array(ocrIssueSchema).min(1).max(100),
      raw: z.record(z.unknown()),
    }),
  ])
  .superRefine((result, context) => {
    if (
      result.outcome === "SUCCEEDED" &&
      (result.ocrFields ?? []).reduce(
        (count, field) => count + (field.regions?.length ?? 0),
        0,
      ) > 2000
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ocrFields"],
        message: "Too many OCR regions",
      });
    if (result.outcome === "SUCCEEDED")
      for (const [index, region] of (result.regions ?? []).entries()) {
        if (
          !Object.prototype.hasOwnProperty.call(result.fields, region.fieldName)
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["regions", index, "fieldName"],
            message: "OCR region references an unknown field",
          });
        if (
          region.ocrFieldOrdinal !== undefined &&
          !result.ocrFields?.[region.ocrFieldOrdinal]
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["regions", index],
            message: "Unknown OCR observation",
          });
      }
  });
export type OcrResult = z.infer<typeof ocrResultSchema>;

export function validateOcrResult(
  input: unknown,
  files: Pick<OcrInputFile, "ordinal" | "pageCount">[],
): OcrResult {
  const result = ocrResultSchema.parse(input);
  if (result.outcome === "SUCCEEDED")
    for (const region of [
      ...(result.regions ?? []),
      ...(result.ocrFields ?? []).flatMap((field) => field.regions ?? []),
    ]) {
      const file = files.find((item) => item.ordinal === region.fileOrdinal);
      if (!file || region.pageNumber > file.pageCount)
        throw new Error("OCR_CONTRACT_INVALID");
    }
  return result;
}

export abstract class OcrService {
  abstract isAvailable(): boolean;
  abstract recognize(
    request: OcrRequest,
    signal: AbortSignal,
  ): Promise<OcrResult>;
}
