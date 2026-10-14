import { Controller, Get, Headers } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import type { AuthPrincipal } from '../auth/auth-principal';
import { MeResponseDto } from './dto/me-response.dto';
import { MeService } from './me.service';

@ApiTags('me')
@ApiBearerAuth('access-jwt')
@Controller('v1/me')
export class MeController {
  constructor(private readonly me: MeService) {}
  @Get()
  @ApiOperation({ summary: 'Current LK profile, permissions and location scope', operationId: 'getMe' })
  @ApiResponse({ status: 200, type: MeResponseDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid bearer token' })
  getMe(
    @CurrentPrincipal() principal?: AuthPrincipal,
    @Headers('authorization') authorization?: string,
  ): Promise<MeResponseDto> {
    // Forward the user's own bearer token for server-side LK avatar enrichment
    // (fail-open inside the service). The raw header never leaves the backend.
    const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : undefined;
    return this.me.get(principal, token || undefined);
  }
}
