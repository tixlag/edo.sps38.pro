import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { OcrService } from "./ocr.service";
import { StubOcrService } from "./stub-ocr.service";
import { OcrQueueService } from "./ocr-queue.service";
import { OcrWorkerService } from "./ocr-worker.service";

@Module({
  imports: [PrismaModule, AuditModule, StorageModule],
  providers: [
    StubOcrService,
    { provide: OcrService, useExisting: StubOcrService },
    OcrQueueService,
    OcrWorkerService,
  ],
  exports: [OcrService, OcrWorkerService],
})
export class OcrModule {}
