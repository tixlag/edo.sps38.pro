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
@Module({
  imports: [PrismaModule, AuditModule, StorageModule, RedisModule],
  controllers: [CommunicationsController, CommunicationEventsController],
  providers: [
    CommunicationsService,
    CandidateCatalogService,
    CommunicationEventsService,
    ErpCommunicationsClient,
    LkChatClient,
    DocumentAccessService,
  ],
})
export class CommunicationsModule {}
