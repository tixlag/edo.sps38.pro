import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.module';

export const LK_RECONCILIATION_LOCK_KEY = 'edo:lk-reconciliation-lock';
export const LK_RECONCILIATION_LOCK_TTL_MS = 30_000;
export const LK_RECONCILIATION_HEARTBEAT_MS = 10_000;

export interface ReconciliationLockHandle {
  token: string;
  /** True when backed by real Redis; false = degraded no-op (Redis down). */
  distributed: boolean;
  release: () => Promise<boolean>;
}

/**
 * Distributed coordination for periodic LK reconciliation vs the live RabbitMQ
 * consumer (Redis lock, race-safe).
 *
 * Why: location events are not published yet and some legacy LK write paths
 * have no events, so periodic full snapshots are REQUIRED. Without
 * coordination a snapshot and live events can interleave on the projection
 * (no reliable LK revision/updatedAt), which is unsafe.
 *
 * Protocol:
 * - sync acquires `edo:lk-reconciliation-lock` via SET NX PX (token ownership);
 * - live consumer checks `isLocked()` before APPLYING an event; while locked it
 *   waits (poll with backoff, message stays unacked — no tight nack/requeue
 *   loop, no poison requeue). Buffered Rabbit events replay after release;
 * - lock has TTL (crash-safe: a dead sync never blocks the consumer forever);
 * - heartbeat renews TTL only while the owner still holds it (Lua
 *   compare-and-expire); release deletes only its own token (Lua
 *   compare-and-del), so a foreign process can never unlock us;
 * - when Redis is unavailable (local docs/CI without Redis) the lock degrades
 *   to a local no-op: `tryAcquire` returns a non-distributed handle and
 *   `isLocked` returns false. Production MUST use shared Redis.
 *
 * Flows:
 * - initial bootstrap: lk:topology (queue buffers) -> lk:sync (snapshot,
 *   consumer disabled in-process) -> boot API (consumer replays, live mode).
 * - periodic: acquire lock -> consumer pauses apply -> full snapshot ->
 *   markMissing on success -> release -> consumer replays queue -> live mode.
 *   On snapshot failure markMissing is skipped but the lock is still released.
 */
@Injectable()
export class LkReconciliationLockService {
  private readonly logger = new Logger(LkReconciliationLockService.name);

  constructor(private readonly redis: RedisService) {}

  get key(): string {
    return LK_RECONCILIATION_LOCK_KEY;
  }

  async isLocked(): Promise<boolean> {
    try {
      const v = await this.redis.get(this.key);
      return v != null;
    } catch {
      return false;
    }
  }

  async tryAcquire(ttlMs = LK_RECONCILIATION_LOCK_TTL_MS): Promise<ReconciliationLockHandle | null> {
    const token = randomUUID();
    let res: boolean | null;
    try {
      res = await this.redis.setNxPx(this.key, token, ttlMs);
    } catch {
      res = null;
    }
    if (res === null) {
      // Redis unavailable: degraded local mode so `lk:sync`/tests work without
      // shared Redis. Consumer will not pause (isLocked=false).
      this.logger.warn(
        'Redis unavailable for reconciliation lock; proceeding without distributed coordination',
      );
      return { token: `local-${token}`, distributed: false, release: async () => true };
    }
    if (!res) return null;
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          const renewed = await this.redis.compareAndExpire(this.key, token, ttlMs);
          if (!renewed) {
            // Lost ownership (expired/stolen): stop renewing; sync should finish
            // quickly and release (no-op) — consumer resumes after TTL.
            clearInterval(heartbeat);
          }
        } catch {
          // ignore: next tick retries
        }
      })();
    }, Math.max(1000, Math.floor(ttlMs / 3)));
    // Don't keep scripts/tests alive just for the heartbeat.
    const t = heartbeat as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
    let released = false;
    return {
      token,
      distributed: true,
      release: async () => {
        if (released) return false;
        released = true;
        clearInterval(heartbeat);
        try {
          const out = await this.redis.compareAndDel(this.key, token);
          return out === true;
        } catch {
          return false;
        }
      },
    };
  }

  /** Release by explicit token (ownership-checked). Foreign tokens fail. */
  async releaseToken(token: string): Promise<boolean> {
    try {
      const out = await this.redis.compareAndDel(this.key, token);
      return out === true;
    } catch {
      return false;
    }
  }
}
