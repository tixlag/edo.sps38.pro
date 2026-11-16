import { DocumentsModule } from "../documents/documents.module";
import { CandidateWorkspaceService } from "./candidate-workspace.service";
import { CandidateWorkspaceController } from "./candidate-workspace.controller";
import { ErpWorkspaceClient } from "../documents/erp-workspace.client";
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import { RedisModule } from "../redis/redis.module";
import { DocumentAccessService } from "../documents/document-access.service";
import {
  CommunicationsController,
  CommunicationEventsController,
} from "./communications.controller";
import { CommunicationsService } from "./communications.service";
import { CandidateCatalogService } from "./candidate-catalog.service";
import { CommunicationEventsService } from "./communication-events.service";
import { ErpCommunicationsClient } from "./erp-communications.client";
import { LkChatClient } from "./lk-chat.client";
import { LkModule } from "../lk/lk.module";
import { EmploymentNotificationService } from "../documents/employment-notification.service";
@Module({
  imports: [
    PrismaModule,
    AuditModule,
    StorageModule,
    RedisModule,
    DocumentsModule,
    LkModule,
  ],
  controllers: [
    CandidateWorkspaceController,
    CommunicationsController,
    CommunicationEventsController,
  ],
  providers: [
    CandidateWorkspaceService,
    ErpWorkspaceClient,
    CommunicationsService,
    CandidateCatalogService,
    CommunicationEventsService,
    ErpCommunicationsClient,
    LkChatClient,
    EmploymentNotificationService,
    DocumentAccessService,
  ],
})
export class CommunicationsModule {}
