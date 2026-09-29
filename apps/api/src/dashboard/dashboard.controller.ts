import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { DashboardResponseDto } from './dto/dashboard-response.dto';

@ApiTags('dashboard')
@ApiBearerAuth('access-jwt')
@Controller('v1/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({ summary: 'Dashboard summary (seed-backed for first slice)', operationId: 'getDashboard' })
  @ApiResponse({ status: 200, type: DashboardResponseDto })
  @ApiResponse({ status: 401, description: 'Missing bearer token' })
  get(): DashboardResponseDto {
    return this.dashboard.get();
  }
}
