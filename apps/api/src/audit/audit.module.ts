import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditLogsService } from './audit-logs.service';
import { AuditController } from './audit.controller';

@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditLogsService],
  exports: [AuditService],
})
export class AuditModule {}
