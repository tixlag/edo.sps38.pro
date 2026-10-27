import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireAccessRule } from '../auth/require-access-rule.decorator';
import { EdoAccessRule } from '../auth/edo-access-rule';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { AuthPrincipal } from '../auth/auth-principal';
import { AuditLogsService } from './audit-logs.service';
import {
  AuditLogListDto,
  AuditLogQueryDto,
} from './dto/audit-log.dto';

@ApiTags('audit')
@ApiBearerAuth('access-jwt')
@Controller('v1/audit-logs')
export class AuditController {
  constructor(private readonly logs: AuditLogsService) {}

  @Get()
  // Guard passes for DOCUMENT_REVIEW or AUDIT_VIEW holders (FULL_ACCESS
  // implies both). The service additionally rejects bare DOCUMENT_REVIEW
  // callers on unfiltered history, so reviewers must use mine=true.
  @RequireAccessRule(EdoAccessRule.DOCUMENT_REVIEW_RU, EdoAccessRule.DOCUMENT_REVIEW_IG, EdoAccessRule.AUDIT_VIEW)
  @ApiOperation({
    summary: 'List audit history within user location scope',
    operationId: 'listAuditLogs',
  })
  @ApiResponse({ status: 200, type: AuditLogListDto })
  @ApiResponse({ status: 400, description: 'Invalid query or cursor' })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token' })
  @ApiResponse({ status: 403, description: 'Missing required EDO access rule' })
  list(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: AuditLogQueryDto,
  ): Promise<AuditLogListDto> {
    return this.logs.list(principal, query);
  }
}
