import { Module } from '@nestjs/common';
import { LkReferenceSyncService } from './lk-reference-sync.service';
import { LkReconciliationLockService } from './lk-reconciliation-lock.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [LkReferenceSyncService, LkReconciliationLockService],
  exports: [LkReferenceSyncService, LkReconciliationLockService],
})
export class LkSyncModule {}
