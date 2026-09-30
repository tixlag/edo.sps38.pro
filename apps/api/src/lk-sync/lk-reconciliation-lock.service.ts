import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.module';

export const LK_RECONCILIATION_LOCK_KEY = 'edo:lk-reconciliation-lock';
export const LK_RECONCILIATION_LOCK_TTL_MS = 30_000;
export const LK_RECONCILIATION_HEARTBEAT_MS = 10_000;

export type ReconciliationState = 'locked' | 'unlocked' | 'unavailable';

/** Redis is down/unknown: periodic sync must NOT run without coordination. */
export class RedisUnavailableError extends Error {
  constructor(message = 'Shared Redis is unavailable; reconciliation lock state unknown (fail closed)') {
    super(message);
    this.name = 'RedisUnavailableError';
  }
}

/** Another process currently holds the reconciliation lock. */
export class ReconciliationInProgressError extends Error {
  constructor(message = 'Another LK reconciliation holds the distributed lock') {
    super(message);
    this.name = 'ReconciliationInProgressError';
  }
}

/** The lock was lost mid-snapshot (expired/stolen or Redis went down). */
export class LockOwnershipLostError extends Error {
  constructor(message = 'LK reconciliation lock ownership lost; snapshot aborted before marking') {
    super(message);
    this.name = 'LockOwnershipLostError';
  }
}

export interface ReconciliationLockHandle {
  token: string;
  /** True only while shared Redis still holds OUR token. Throws RedisUnavailableError when Redis is down. */
  isOwned: () => Promise<boolean>;
  /** Throws LockOwnershipLostError (or RedisUnavailableError) unless still owned. */
  assertOwned: () => Promise<void>;
  release: () => Promise<boolean>;
}

/**
 * Distributed coordination for periodic LK reconciliation vs the live RabbitMQ
 * consumer (shared LK Redis lock, race-safe, FAIL CLOSED).
 *
 * Why: location events are not published yet and some legacy LK write paths
 * have no events, so periodic full snapshots are REQUIRED. Without
 * coordination a snapshot and live events can interleave on the projection
 * (no reliable LK revision/updatedAt), which is unsafe.
 *
 * Protocol:
 * - sync acquires `edo:lk-reconciliation-lock` via SET NX PX (token ownership);
 *   a second concurrent sync gets `null` and must exit non-zero;
 * - if shared Redis is unavailable, `tryAcquire` THROWS RedisUnavailableError
 *   and the sync must NOT run (fail closed — there is no safe degraded mode);
 * - the live consumer checks `getState()` before APPLYING each event and pauses
 *   while `locked` AND while `unavailable` (messages stay unacked within
 *   prefetch — no tight nack/requeue loop). Buffered events replay after release;
 * - the lock has a TTL so a crashed sync never blocks the consumer forever;
 * - heartbeat renews the TTL only while the owner still holds it (`Lua
 *   compare-and-expire`); release deletes only its own token (`Lua
 *   compare-and-del`);
 * - long snapshots re-check ownership (before each resource, between employee
 *   pages, and immediately before markMissing). On ownership loss the sync
 *   aborts with LockOwnershipLostError and markMissing is NEVER executed
 *   without the lock. Partial upserts are tolerable: buffered events + the
 *   next coordinated snapshot repair the projection.
 *
 * Flows:
 * - initial bootstrap: lk:topology (queue buffers) -> lk:sync (snapshot,
 *   consumer disabled in-process) -> boot API (consumer replays, live mode).
 * - periodic: acquire lock -> consumer pauses apply -> full snapshot ->
 *   markMissing on success (ownership re-verified) -> release -> consumer
 *   replays queue -> live mode. Snapshot failure skips markMissing but still
 *   releases the lock.
 */
@Injectable()
export class LkReconciliationLockService {
  private readonly logger = new Logger(LkReconciliationLockService.name);

  constructor(private readonly redis: RedisService) {}

  get key(): string {
    return LK_RECONCILIATION_LOCK_KEY;
  }

  /** Tri-state: never mistake "Redis down" for "unlocked". */
  async getState(): Promise<ReconciliationState> {
    let value: string | null;
    try {
      value = await this.redis.get(this.key);
    } catch {
      return 'unavailable';
    }
    if (value != null) return 'locked';
    // No key: distinguish "genuinely unlocked" from "Redis unreachable".
    // RedisService.get swallows errors to null, so probe liveness explicitly.
    try {
      return (await this.redis.ping()) ? 'unlocked' : 'unavailable';
    } catch {
      return 'unavailable';
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
      // Shared Redis unavailable: FAIL CLOSED, never a degraded no-op lock.
      throw new RedisUnavailableError();
    }
    if (!res) return null;
    const heartbeat = setInterval(() => {
      void (async () => {
        try {
          const renewed = await this.redis.compareAndExpire(this.key, token, ttlMs);
          if (renewed === false) {
            // Key is gone or owned by someone else: stop renewing. The running
            // sync observes this via isOwned()/assertOwned() and aborts before
            // markMissing; the consumer resumes after the TTL lapses.
            // (null = Redis blip: keep the heartbeat, guards fail closed meanwhile.)
            this.logger.error('LK reconciliation lock ownership lost; heartbeat stopped');
            clearInterval(heartbeat);
          }
        } catch {
          // Redis blip: next tick retries; ownership checks fail closed meanwhile.
        }
      })();
    }, Math.max(1000, Math.floor(ttlMs / 3)));
    // Don't keep scripts/tests alive just for the heartbeat.
    const t = heartbeat as unknown as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
    let released = false;
    const isOwned = async (): Promise<boolean> => {
      let current: string | null;
      try {
        current = await this.redis.get(this.key);
      } catch {
        throw new RedisUnavailableError();
      }
      if (current == null) {
        // No key visible: confirm Redis is actually reachable before
        // concluding "not owned" (a down Redis must fail closed, not lie).
        let alive = false;
        try {
          alive = await this.redis.ping();
        } catch {
          alive = false;
        }
        if (!alive) throw new RedisUnavailableError();
        return false;
      }
      return current === token;
    };
    return {
      token,
      isOwned,
      assertOwned: async () => {
        if (!(await isOwned())) throw new LockOwnershipLostError();
      },
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
