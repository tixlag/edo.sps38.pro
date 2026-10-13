import { Module } from '@nestjs/common';
import { LkEventHandler } from './lk-event.handler';
import { LkEventConsumer } from './lk-event.consumer';
import { LkSyncModule } from '../lk-sync/lk-sync.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [LkSyncModule, AuditModule],
  providers: [LkEventHandler, LkEventConsumer],
  exports: [LkEventHandler],
})
export class LkEventsModule {}
