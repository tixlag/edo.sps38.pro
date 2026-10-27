import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { DocumentAccessService } from "../documents/document-access.service";
import { AnnotationService } from "./annotation.service";
import { AnnotationSourceService } from "./annotation-source.service";
import { AnnotationCatalogService } from "./annotation-catalog.service";
import {
  AnnotationsController,
  AnnotationSourcesController,
  AnnotationCatalogsController,
} from "./annotations.controller";
@Module({
  imports: [PrismaModule, AuditModule, StorageModule],
  controllers: [
    AnnotationsController,
    AnnotationSourcesController,
    AnnotationCatalogsController,
  ],
  providers: [
    DocumentAccessService,
    AnnotationService,
    AnnotationSourceService,
    AnnotationCatalogService,
  ],
})
export class AnnotationsModule {}
