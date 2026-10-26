import { ErpWorkspaceClient } from "./erp-workspace.client";
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
import { DocumentOcrRetryService } from "./document-ocr-retry.service";
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

import {
  BrowserCandidateDocumentsController,
  MyCandidateDocumentsController,
} from "./candidate-browser.controller";
import { CandidateDocumentsService } from "./candidate-documents.service";
import { CandidateContextService } from "./candidate-context.service";
import { LkCandidateIdentityService } from "./lk-candidate-identity.service";
import { ErpCandidateClient } from "./erp-candidate.client";
import { CandidateCardCache } from "./candidate-card-cache";

@Module({
  imports: [PrismaModule, AuditModule, StorageModule, OcrModule, RedisModule],
  controllers: [
    BrowserCandidateDocumentsController,
    MyCandidateDocumentsController,
    CandidateIntegrationController,
    DocumentsController,
    ManualDocumentIntegrationController,
    ManualDocumentReviewController,
    CandidateDocumentEventsController,
    CandidateDocumentUploadController,
  ],
  exports: [CandidateContextService],
  providers: [
    ErpWorkspaceClient,
    CandidateDocumentsService,
    CandidateContextService,
    LkCandidateIdentityService,
    ErpCandidateClient,
    CandidateCardCache,
    DocumentAccessService,
    DocumentReadService,
    DocumentReviewService,
    DocumentOcrRetryService,
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
