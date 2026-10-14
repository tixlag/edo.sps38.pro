import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
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
    @Req() req?: FastifyRequest,
  ): Promise<MeResponseDto> {
    // Read the raw Authorization header via @Req() (FastifyRequest headers) so
    // Swagger does NOT emit a required header parameter for getMe in
    // openapi.json (an explicit Headers decorator for authorization leaks
    // into the contract as required header `authorization`). The raw header never leaves
    // the backend: only the extracted bearer token is forwarded to LK.
    const raw = req?.headers?.authorization;
    const header = Array.isArray(raw) ? raw[0] : raw;
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;
    return this.me.get(principal, token || undefined);
  }
}
