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
  files: OcrInputFile[];
}

export const ocrIssueSchema = z.object({
  code: z.enum(["DOCUMENT_TYPE_MISMATCH", "POOR_IMAGE_QUALITY"]),
  message: z.string().min(1).max(1024),
  fileOrdinal: z.number().int().nonnegative().nullable().default(null),
  pageNumber: z.number().int().positive().nullable().default(null),
});

const fieldsSchema = z
  .record(z.string().min(1).max(128), z.string().max(16_384).nullable())
  .refine((v) => Object.keys(v).length <= 200, "Too many fields");

export const ocrResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("SUCCEEDED"),
    source: z.enum(["STUB", "EXTERNAL"]),
    fields: fieldsSchema,
    raw: z.record(z.unknown()),
  }),
  z.object({
    outcome: z.literal("REJECTED"),
    source: z.enum(["STUB", "EXTERNAL"]),
    issues: z.array(ocrIssueSchema).min(1).max(100),
    raw: z.record(z.unknown()),
  }),
]);
export type OcrResult = z.infer<typeof ocrResultSchema>;

export abstract class OcrService {
  abstract isAvailable(): boolean;
  abstract recognize(
    request: OcrRequest,
    signal: AbortSignal,
  ): Promise<OcrResult>;
}
