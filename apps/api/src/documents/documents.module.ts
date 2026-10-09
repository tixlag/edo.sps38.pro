import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { OcrModule } from "../ocr/ocr.module";
import {
  CandidateIntegrationController,
  DocumentsController,
} from "./documents.controller";
import { DocumentAccessService } from "./document-access.service";
import { DocumentReadService } from "./document-read.service";
import { DocumentReviewService } from "./document-review.service";
import { DocumentIngestionService } from "./document-ingestion.service";
import { DocumentUploadService } from "./document-upload.service";
import { LkInternalGuard } from "./lk-internal.guard";

@Module({
  imports: [PrismaModule, AuditModule, StorageModule, OcrModule],
  controllers: [CandidateIntegrationController, DocumentsController],
  providers: [
    DocumentAccessService,
    DocumentReadService,
    DocumentReviewService,
    DocumentIngestionService,
    DocumentUploadService,
    LkInternalGuard,
  ],
})
export class DocumentsModule {}
