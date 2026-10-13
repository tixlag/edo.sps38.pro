import { Controller, Get, HttpCode, Optional, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { HealthResponseDto, IntegrationHealthDto, ReadyResponseDto } from './dto/health-response.dto';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitmqService } from '../rabbitmq/rabbitmq.module';
import { RedisService } from '../redis/redis.module';
import { LkReconciliationLockService } from '../lk-sync/lk-reconciliation-lock.service';

const FRESHNESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbitmq: RabbitmqService,
    private readonly redis: RedisService,
    @Optional() private readonly reconciliationLock?: LkReconciliationLockService,
  ) {
    void this.reconciliationLock;
  }

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
  @ApiResponse({ status: 200, type: ReadyResponseDto, description: 'All required deps up' })
  @ApiResponse({ status: 503, type: ReadyResponseDto, description: 'MariaDB or RabbitMQ down' })
  @HttpCode(200)
  async ready(@Res({ passthrough: true }) reply: { status: (code: number) => unknown }): Promise<ReadyResponseDto> {
    const mariadb = await this.checkMaria();
    const rabbitmq = await this.checkRabbit();
    const redis = await this.checkRedis();
    // Redis is optional cache: reported but does not fail readiness.
    const ready = mariadb.ok && rabbitmq.ok;
    const status = ready ? 'ready' : 'not-ready';
    if (!ready) {
      reply.status(503);
    }
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

  @Public()
  @Get('integration')
  @ApiOperation({
    summary: 'Integration health: Redis coordination, consumer, bootstrap, freshness (does not gate reads)',
    operationId: 'getHealthIntegration',
  })
  @ApiResponse({ status: 200, type: IntegrationHealthDto })
  @HttpCode(200)
  async integration(): Promise<IntegrationHealthDto> {
    const time = new Date().toISOString();
    // Redis coordination (fail-closed signal, but reads stay available).
    let redis: { status: string; ok: boolean; error?: string };
    try {
      const ok = await this.redis.ping();
      redis = ok ? { status: 'up', ok: true } : { status: 'down', ok: false, error: 'Redis unreachable (consumer paused, sync refused)' };
    } catch (err) {
      redis = { status: 'down', ok: false, error: (err as Error).message.slice(0, 200) };
    }
    // Consumer/reconnect state (best-effort; absent in sync CLI context).
    let consumer: { status: string; ok: boolean; error?: string };
    try {
      const state = this.rabbitmq.getReconnectState();
      const consuming = state.consuming && !state.scheduled;
      consumer = consuming
        ? { status: 'up', ok: true }
        : { status: 'degraded', ok: false, error: state.scheduled ? 'reconnect scheduled' : 'consumer not subscribed' };
    } catch {
      consumer = { status: 'unknown', ok: false, error: 'consumer state unavailable' };
    }
    // Bootstrap: any FINISHED sync run exists.
    let bootstrap: { status: string; ok: boolean; error?: string };
    let lastSyncRunId: string | undefined;
    let lastSyncFinishedAt: string | undefined;
    let freshness: { status: string; ok: boolean; error?: string };
    try {
      const db = this.prisma as unknown as {
        lkSyncRun?: { findFirst: (a: unknown) => Promise<{ runId: string; finishedAt: Date | null } | null> };
      };
      const last = db.lkSyncRun ? await db.lkSyncRun.findFirst({ where: { status: 'FINISHED' }, orderBy: { finishedAt: 'desc' } }) : null;
      if (last) {
        bootstrap = { status: 'up', ok: true };
        lastSyncRunId = last.runId;
        lastSyncFinishedAt = last.finishedAt?.toISOString();
        const age = last.finishedAt ? Date.now() - last.finishedAt.getTime() : Number.POSITIVE_INFINITY;
        freshness =
          age <= FRESHNESS_MAX_AGE_MS
            ? { status: 'up', ok: true }
            : { status: 'stale', ok: false, error: `last successful sync ${Math.round(age / 3600000)}h ago (max 24h)` };
      } else {
        bootstrap = { status: 'missing', ok: false, error: 'no successful LK sync yet (run lk:sync after lk:topology)' };
        freshness = { status: 'unknown', ok: false, error: 'no successful sync to measure freshness' };
      }
    } catch (err) {
      bootstrap = { status: 'unknown', ok: false, error: (err as Error).message.slice(0, 200) };
      freshness = { status: 'unknown', ok: false, error: 'freshness check failed' };
    }
    // Queue depths (best-effort; never fail the endpoint, never hide damage).
    // Missing queues are explicit errors, not zeros: zero means "empty and
    // present". A missing EDO queue degrades integration health (DLX hops may
    // drop messages) without gating reads of existing data.
    let pendingMessages: number | undefined;
    let dlqMessages: number | undefined;
    let queueErrors: string[] | undefined;
    try {
      const depths = await this.rabbitmq.checkQueueDepths().catch(() => null);
      if (depths) {
        pendingMessages = depths.main;
        dlqMessages = depths.dlq;
        if (depths.errors.length > 0) queueErrors = depths.errors;
      }
    } catch {
      // ignore
    }
    const status =
      redis.ok && consumer.ok && bootstrap.ok && freshness.ok && (queueErrors?.length ?? 0) === 0
        ? 'healthy'
        : 'degraded';
    return { status, time, redis, consumer, bootstrap, freshness, pendingMessages, dlqMessages, queueErrors, lastSyncRunId, lastSyncFinishedAt };
  }
}
