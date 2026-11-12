import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { join } from "path";
import { validateEnv } from "../config/env.validation";
import { PrismaModule } from "../prisma/prisma.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { RedisModule } from "../redis/redis.module";
import { DocumentAccessService } from "./document-access.service";
import { DocumentCatalogService } from "./document-catalog.service";
import { DocumentReadService } from "./document-read.service";
import { ManualDocumentService } from "./manual-document.service";
import { DocumentUploadService } from "./document-upload.service";
import { DocumentPdfService } from "./document-pdf.service";
import { DocumentDeliveryService } from "./document-delivery.service";

const ROOT_ENV = join(__dirname, "..", "..", "..", "..", ".env");

/**
 * Minimal context for `erp:retry`.
 *
 * It provides the delivery graph only (no live workers, no LK consumer, no
 * OCR worker), so the operator command can rebuild an approved artifact and
 * repeat one delivery without touching the running API.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: [ROOT_ENV, ".env"],
    }),
    PrismaModule,
    AuditModule,
    StorageModule,
    RedisModule,
  ],
  providers: [
    DocumentAccessService,
    DocumentCatalogService,
    DocumentReadService,
    ManualDocumentService,
    DocumentUploadService,
    DocumentPdfService,
    DocumentDeliveryService,
  ],
  exports: [DocumentPdfService, DocumentDeliveryService],
})
export class ErpRetryModule {}
