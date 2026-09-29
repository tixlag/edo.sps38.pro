import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { HealthResponseDto, ReadyResponseDto } from './dto/health-response.dto';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitmqService } from '../rabbitmq/rabbitmq.module';
import { RedisService } from '../redis/redis.module';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbitmq: RabbitmqService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'Service health check (legacy, same as live)', operationId: 'getHealth' })
  @ApiResponse({ status: 200, type: HealthResponseDto })
  health(): HealthResponseDto {
    return { status: 'ok', version: '0.1.0', time: new Date().toISOString() };
  }

  @Public()
  @Get('live')
  @ApiOperation({ summary: 'Liveness: process is running', operationId: 'getHealthLive' })
  @ApiResponse({ status: 200, type: HealthResponseDto })
  live(): HealthResponseDto {
    return { status: 'ok', version: '0.1.0', time: new Date().toISOString() };
  }

  @Public()
  @Get('ready')
  @ApiOperation({ summary: 'Readiness: MariaDB, RabbitMQ, Redis checks', operationId: 'getHealthReady' })
  @ApiResponse({ status: 200, type: ReadyResponseDto })
  async ready(): Promise<ReadyResponseDto> {
    const mariadb = await this.checkMaria();
    const rabbitmq = await this.checkRabbit();
    const redis = await this.checkRedis();
    // Redis is optional cache: reported but does not fail readiness.
    const status = mariadb.ok && rabbitmq.ok ? 'ready' : 'not-ready';
    return { status, mariadb, rabbitmq, redis };
  }

  private async checkMaria() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up', ok: true };
    } catch (err) {
      return { status: 'down', ok: false, error: (err as Error).message.slice(0, 300) };
    }
  }

  private async checkRabbit() {
    const ok = await this.rabbitmq.checkHealth();
    return ok ? { status: 'up', ok: true } : { status: 'down', ok: false, error: 'RabbitMQ unreachable' };
  }

  private async checkRedis() {
    const ok = await this.redis.ping();
    return ok ? { status: 'up', ok: true } : { status: 'down', ok: false, error: 'Redis unreachable' };
  }
}
