import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { DashboardResponseDto } from './dto/dashboard-response.dto';
import { RequireAccessRule } from '../auth/require-access-rule.decorator';
import { EdoAccessRule } from '../auth/edo-access-rule';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { AuthPrincipal } from '../auth/auth-principal';

@ApiTags('dashboard')
@ApiBearerAuth('access-jwt')
@Controller('v1/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({ summary: 'Current dashboard summary within user location scope', operationId: 'getDashboard' })
  @ApiResponse({ status: 200, type: DashboardResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token' })
  @ApiResponse({ status: 403, description: 'Missing required EDO access rule' })
  get(@CurrentPrincipal() principal?: AuthPrincipal): Promise<DashboardResponseDto> {
    return this.dashboard.get(principal);
  }
}
