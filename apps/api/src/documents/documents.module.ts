import { Module } from "@nestjs/common";
import { RedisModule } from "../redis/redis.module";
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

import { ManualDocumentService } from "./manual-document.service";
import { DocumentCatalogService } from "./document-catalog.service";
import { DocumentPdfService } from "./document-pdf.service";
import { DocumentDeliveryService } from "./document-delivery.service";
import {
  DocumentEventsService,
  DocumentStreamGuard,
} from "./document-events.service";
import {
  ManualDocumentIntegrationController,
  ManualDocumentReviewController,
  CandidateDocumentEventsController,
  CandidateDocumentUploadController,
} from "./manual-documents.controller";
import {
  DocumentUploadGrantGuard,
  DocumentUploadGrantService,
} from "./document-upload-grant.service";

@Module({
  imports: [PrismaModule, AuditModule, StorageModule, OcrModule, RedisModule],
  controllers: [
    CandidateIntegrationController,
    DocumentsController,
    ManualDocumentIntegrationController,
    ManualDocumentReviewController,
    CandidateDocumentEventsController,
    CandidateDocumentUploadController,
  ],
  providers: [
    DocumentAccessService,
    DocumentReadService,
    DocumentReviewService,
    DocumentIngestionService,
    DocumentUploadService,
    LkInternalGuard,
    ManualDocumentService,
    DocumentCatalogService,
    DocumentPdfService,
    DocumentDeliveryService,
    DocumentEventsService,
    DocumentStreamGuard,
    DocumentUploadGrantService,
    DocumentUploadGrantGuard,
  ],
})
export class DocumentsModule {}
