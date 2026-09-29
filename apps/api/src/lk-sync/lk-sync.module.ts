import { Module } from '@nestjs/common';
import { LkReferenceSyncService } from './lk-reference-sync.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [LkReferenceSyncService],
  exports: [LkReferenceSyncService],
})
export class LkSyncModule {}
