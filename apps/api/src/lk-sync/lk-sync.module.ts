import { Module } from '@nestjs/common';
import { LkReferenceSyncService } from './lk-reference-sync.service';
import { LkReconciliationLockService } from './lk-reconciliation-lock.service';
import { DbFencingService } from './lk-fencing.service';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [AuditModule],
  providers: [LkReferenceSyncService, LkReconciliationLockService, DbFencingService],
  exports: [LkReferenceSyncService, LkReconciliationLockService, DbFencingService],
})
export class LkSyncModule {}
