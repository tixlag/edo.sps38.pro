import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { LkModule } from "../lk/lk.module";
import { DocumentExpirationService } from "./document-expiration.service";
import { DocumentExpirationController } from "./document-expiration.controller";
import { ExpirationRetryWorker } from "./expiration-retry.worker";

@Module({
  imports: [PrismaModule, LkModule],
  controllers: [DocumentExpirationController],
  providers: [DocumentExpirationService, ExpirationRetryWorker],
  exports: [DocumentExpirationService],
})
export class ExpirationModule {}
