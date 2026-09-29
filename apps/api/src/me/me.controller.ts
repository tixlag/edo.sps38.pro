import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { AuthPrincipal } from '../auth/auth-principal';
import { resolveLocationScope } from '../auth/access-rules';
import { MeResponseDto } from './dto/me-response.dto';

@ApiTags('me')
@ApiBearerAuth('access-jwt')
@Controller('v1/me')
export class MeController {
  @Get()
  @ApiOperation({ summary: 'Current principal (permissions + location scope)', operationId: 'getMe' })
  @ApiResponse({ status: 200, type: MeResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token' })
  getMe(@CurrentPrincipal() principal?: AuthPrincipal): MeResponseDto {
    const scope = resolveLocationScope(principal);
    return {
      uuid: principal?.uuid ?? '',
      code1c: principal?.code1c ?? null,
      permissions: principal?.accessRules ?? {},
      locationScope: scope,
    };
  }
}
