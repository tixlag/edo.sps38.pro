import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { StorageModule } from "../storage/storage.module";
import {
  ContractsController,
  MyContractsController,
} from "./contracts.controller";
import { ContractsService } from "./contracts.service";
import { ZupDocumentsClient } from "./zup-documents.client";
import { ContractFileService } from "./contract-file.service";
import { ContractObjectsService } from "./contract-objects.service";
import { LkModule } from "../lk/lk.module";
import { ContractNotificationDeliveryService } from "./contract-notification-delivery.service";

@Module({
  imports: [AuditModule, StorageModule, LkModule],
  controllers: [ContractsController, MyContractsController],
  providers: [
    ContractsService,
    ZupDocumentsClient,
    ContractFileService,
    ContractObjectsService,
    ContractNotificationDeliveryService,
  ],
})
export class ContractsModule {}
