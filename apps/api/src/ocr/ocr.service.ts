/**
 * Integration boundary for the external OCR service.
 * The OCR engine lives outside this repo — do NOT implement it here.
 *
 * Async model: upload -> save metadata/file -> RabbitMQ `edo.ocr.requested.v1` -> OCR service -> result -> document status.
 * TODO(ocr): plug the real OCR contract (endpoint, payload, auth) once provided.
 */
export interface OcrRequest {
  documentId: string;
  version: number;
  storageKey: string;
}

export interface OcrResult {
  documentId: string;
  version: number;
  raw: unknown;
  ok: boolean;
}

export abstract class OcrService {
  abstract enqueue(request: OcrRequest): Promise<void>;
}
