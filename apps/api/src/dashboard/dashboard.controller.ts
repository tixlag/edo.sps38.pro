import { Controller, Get, Query } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { DashboardService } from "./dashboard.service";
import {
  DashboardResponseDto,
  DashboardQueryDto,
} from "./dto/dashboard-response.dto";
import { RequireAccessRule } from "../auth/require-access-rule.decorator";
import { EdoAccessRule } from "../auth/edo-access-rule";
import { CurrentPrincipal } from "../auth/current-principal.decorator";
import type { AuthPrincipal } from "../auth/auth-principal";

@ApiTags("dashboard")
@ApiBearerAuth("access-jwt")
@Controller("v1/dashboard")
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequireAccessRule(EdoAccessRule.ACCESS)
  @ApiOperation({
    summary:
      "Candidate document acceptance summary within permitted review groups",
    operationId: "getDashboard",
  })
  @ApiResponse({ status: 200, type: DashboardResponseDto })
  @ApiResponse({ status: 400, description: "Invalid dashboard filters" })
  @ApiResponse({ status: 401, description: "Missing or invalid bearer token" })
  @ApiResponse({ status: 403, description: "Missing required EDO access rule" })
  get(
    @CurrentPrincipal() principal: AuthPrincipal,
    @Query() query: DashboardQueryDto,
  ): Promise<DashboardResponseDto> {
    return this.dashboard.get(principal, query);
  }
}
