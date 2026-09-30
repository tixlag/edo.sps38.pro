import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Shared Redis for cache/locks/ephemeral state only (NOT a primary queue).
 * Production must point REDIS_URL to the shared ecosystem Redis.
 * Tolerant when Redis is absent (local docs/CI builds): operations no-op null.
 *
 * Lock primitives (SET NX PX + Lua compare-and-delete/extend) power the
 * distributed LK reconciliation lock. They return `null` when Redis is
 * unavailable so callers can degrade safely (log + proceed without
 * coordination); they never throw for connection issues.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis | null = null;

  constructor(private readonly config: ConfigService) {
    const url =
      this.config.get<string>('REDIS_URL') ?? process.env.REDIS_URL ?? 'redis://localhost:6380';
    try {
      const parsed = new URL(url);
      this.client = new Redis({
        host: parsed.hostname || 'localhost',
        port: Number(parsed.port || 6379),
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        lazyConnect: true,
      });
      this.client.on('error', () => {
        // Swallow connection errors: Redis is optional cache, readiness reports it.
      });
      void this.client.connect().catch(() => undefined);
    } catch {
      this.client = null;
    }
  }

  async ping(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client) return;
    try {
      if (ttlSeconds) await this.client.set(key, value, 'EX', ttlSeconds);
      else await this.client.set(key, value);
    } catch {
      // cache must never break main flow
    }
  }

  /**
   * Atomic acquire: SET key value PX ttlMs NX.
   * Returns true when the lock was acquired, false when held by someone else,
   * null when Redis is unavailable (caller degrades safely).
   */
  async setNxPx(key: string, value: string, pxMs: number): Promise<boolean | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.set(key, value, 'PX', pxMs, 'NX');
      return res === 'OK';
    } catch {
      return null;
    }
  }

  /**
   * Release only if the stored value equals the owner token (Lua compare-and-del).
   * Returns true when the lock was released by its owner.
   */
  async compareAndDel(key: string, expected: string): Promise<boolean | null> {
    if (!this.client) return null;
    try {
      const res = (await this.client.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        key,
        expected,
      )) as number;
      return res === 1;
    } catch {
      return null;
    }
  }

  /**
   * Extend TTL only if the stored value equals the owner token (Lua compare-pexpire).
   * Returns true when the TTL was renewed by its owner.
   */
  async compareAndExpire(key: string, expected: string, pxMs: number): Promise<boolean | null> {
    if (!this.client) return null;
    try {
      const res = (await this.client.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`,
        1,
        key,
        expected,
        String(pxMs),
      )) as number;
      return res === 1;
    } catch {
      return null;
    }
  }

  async onModuleDestroy() {
    try {
      await this.client?.quit();
    } catch {
      // ignore
    }
  }
}

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
