import { join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

// Load root .env explicitly when present (local dev); process env wins in CI.
// Missing file is fine.
dotenvConfig({ path: join(__dirname, '..', '..', '..', '.env') });

function redactedUrl(url: string): string {
  return url.replace(/:\/\/[^@]+@/, '://<redacted>@');
}

async function checkMariaDB(): Promise<{ ok: boolean; detail: string }> {
  const url = process.env.DATABASE_URL;
  if (!url) return { ok: false, detail: 'DATABASE_URL is not set' };
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    try {
      const rows = (await prisma.$queryRaw`SELECT DATABASE() AS db`) as Array<{ db: string | null }>;
      const db = rows[0]?.db ?? null;
      if (db !== 'edo') {
        return { ok: false, detail: `connected but current database is '${db}' (expected 'edo')` };
      }
      return { ok: true, detail: `connected, current database is 'edo' (${redactedUrl(url)})` };
    } finally {
      await prisma.$disconnect().catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message.slice(0, 160)}` };
  }
}

async function checkRedis(): Promise<{ ok: boolean; detail: string }> {
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  try {
    const { default: Redis } = await import('ioredis');
    const client = new Redis(url, { maxRetriesPerRequest: 1, enableReadyCheck: false, lazyConnect: true });
    try {
      await client.connect();
      const pong = await client.ping();
      return pong === 'PONG'
        ? { ok: true, detail: `PONG (${redactedUrl(url)})` }
        : { ok: false, detail: `unexpected PING reply: ${pong}` };
    } finally {
      await client.quit().catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message.slice(0, 160)}` };
  }
}

async function checkRabbit(): Promise<{ ok: boolean; detail: string }> {
  const url = process.env.RABBITMQ_URL;
  if (!url) return { ok: false, detail: 'RABBITMQ_URL is not set' };
  const exchange = process.env.LK_EVENTS_EXCHANGE ?? 'lk.events';
  try {
    const amqp = await import('amqplib');
    const conn = await amqp.connect(url);
    try {
      const ch = await conn.createChannel();
      try {
        // Passive-compatible check only: throws if the exchange is missing.
        await ch.checkExchange(exchange);
        return { ok: true, detail: `connected, exchange '${exchange}' exists (${redactedUrl(url)})` };
      } finally {
        await ch.close().catch(() => undefined);
      }
    } finally {
      await conn.close().catch(() => undefined);
    }
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message.slice(0, 160)}` };
  }
}

async function checkLkApi(): Promise<{ ok: boolean; detail: string }> {
  const token = process.env.LK_EDO_INTERNAL_TOKEN;
  if (!token) return { ok: true, detail: 'skipped (LK_EDO_INTERNAL_TOKEN not set)' };
  const base = (process.env.LK_BASE_URL ?? 'http://localhost:12000').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/internal/edo/v1/locations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${base}` };
    const body = (await res.json()) as unknown[];
    return { ok: true, detail: `${base} OK (${Array.isArray(body) ? body.length : '?'} locations)` };
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message.slice(0, 160)}` };
  }
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('EDO infra check (read-only, no mutations, no credentials printed)');
  const results: Array<[string, { ok: boolean; detail: string }]> = [
    ['MariaDB (shared LK server, database must be edo)', await checkMariaDB()],
    ['Redis (shared LK Redis)', await checkRedis()],
    ['RabbitMQ (shared LK broker)', await checkRabbit()],
    ['LK compact API (optional)', await checkLkApi()],
  ];
  let failed = 0;
  for (const [name, r] of results) {
    // eslint-disable-next-line no-console
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${name}: ${r.detail}`);
    if (!r.ok) failed += 1;
  }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
