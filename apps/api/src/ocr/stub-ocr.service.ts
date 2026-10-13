import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OcrService, type OcrRequest, type OcrResult } from "./ocr.service";

/** Explicit development fixture. It never evaluates document content or image quality. */
@Injectable()
export class StubOcrService extends OcrService {
  constructor(private readonly config: ConfigService) {
    super();
  }

  isAvailable(): boolean {
    return (
      this.config.get("OCR_MODE") === "stub" &&
      ["development", "test"].includes(
        this.config.get<string>("NODE_ENV") ?? "development",
      )
    );
  }

  async recognize(
    request: OcrRequest,
    signal: AbortSignal,
  ): Promise<OcrResult> {
    if (!this.isAvailable())
      throw new ServiceUnavailableException("OCR_NOT_CONFIGURED");
    signal.throwIfAborted();
    return {
      outcome: "SUCCEEDED",
      source: "STUB",
      fields: {
        document_type: request.documentTypeCode,
        document_number: "STUB-000000",
        holder_name: "TEST CANDIDATE",
      },
      raw: {
        source: "STUB",
        synthetic: true,
        documentTypeCode: request.documentTypeCode,
        files: request.files.map(({ ordinal, mimeType, pageCount }) => ({
          ordinal,
          mimeType,
          pageCount,
        })),
      },
    };
  }
}
