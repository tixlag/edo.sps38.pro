import { describe, expect, it } from 'vitest';
import { HealthController } from '../src/health/health.controller';

function controller(mariaOk: boolean, rabbitOk: boolean, redisOk: boolean) {
  const prisma = { $queryRaw: async () => (mariaOk ? [1] : Promise.reject(new Error('db down'))) } as never;
  const rabbitmq = { checkHealth: async () => rabbitOk } as never;
  const redis = { ping: async () => redisOk } as never;
  return new HealthController(prisma, rabbitmq, redis);
}

describe('GET /api/health/ready HTTP status', () => {
  it('returns 200 when MariaDB+RabbitMQ are up (Redis optional)', async () => {
    const c = controller(true, true, false);
    let statusCode = 200;
    const reply = { status: (c: number) => { statusCode = c; } } as never;
    const body = await c.ready(reply);
    expect(body.status).toBe('ready');
    expect(statusCode).toBe(200);
  });

  it('returns 503 when MariaDB is down', async () => {
    const c = controller(false, true, true);
    let statusCode = 200;
    const reply = { status: (c: number) => { statusCode = c; } } as never;
    const body = await c.ready(reply);
    expect(body.status).toBe('not-ready');
    expect(statusCode).toBe(503);
  });

  it('returns 503 when RabbitMQ is down, even if Redis is up', async () => {
    const c = controller(true, false, true);
    let statusCode = 200;
    const reply = { status: (c: number) => { statusCode = c; } } as never;
    const body = await c.ready(reply);
    expect(body.status).toBe('not-ready');
    expect(statusCode).toBe(503);
  });

  it('Redis alone never breaks readiness', async () => {
    const c = controller(true, true, false);
    let statusCode = 200;
    const reply = { status: (c: number) => { statusCode = c; } } as never;
    const body = await c.ready(reply);
    expect(body.redis.ok).toBe(false);
    expect(body.status).toBe('ready');
    expect(statusCode).toBe(200);
  });
});
