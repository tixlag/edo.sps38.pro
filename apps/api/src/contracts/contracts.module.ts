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

@Module({
  imports: [AuditModule, StorageModule],
  controllers: [ContractsController, MyContractsController],
  providers: [
    ContractsService,
    ZupDocumentsClient,
    ContractFileService,
    ContractObjectsService,
  ],
})
export class ContractsModule {}
