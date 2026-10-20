import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { OcrService } from "./ocr.service";
import { StubOcrService } from "./stub-ocr.service";
import { ExternalOcrService } from "./external-ocr.service";
import { OcrQueueService } from "./ocr-queue.service";
import { OcrWorkerService } from "./ocr-worker.service";

@Module({
  imports: [PrismaModule, AuditModule, StorageModule],
  providers: [
    StubOcrService,
    ExternalOcrService,
    {
      provide: OcrService,
      inject: [ConfigService, StubOcrService, ExternalOcrService],
      useFactory: (
        config: ConfigService,
        stub: StubOcrService,
        external: ExternalOcrService,
      ) => (config.get("OCR_MODE") === "external" ? external : stub),
    },
    OcrQueueService,
    OcrWorkerService,
  ],
  exports: [OcrService, OcrWorkerService],
})
export class OcrModule {}
