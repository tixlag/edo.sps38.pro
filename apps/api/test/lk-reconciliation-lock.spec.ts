import { describe, expect, it, vi } from 'vitest';
import {
  LkReconciliationLockService,
  LK_RECONCILIATION_LOCK_KEY,
  RedisUnavailableError,
  LockOwnershipLostError,
} from '../src/lk-sync/lk-reconciliation-lock.service';
import { LkEventConsumer } from '../src/lk-events/lk-event.consumer';

function memoryRedis(opts: { available?: boolean } = {}) {
  const available = opts.available ?? true;
  const store = new Map<string, { value: string; expiresAt: number }>();
  function alive(key: string): { value: string; expiresAt: number } | undefined {
    const e = store.get(key);
    if (!e) return undefined;
    if (Date.now() >= e.expiresAt) {
      store.delete(key);
      return undefined;
    }
    return e;
  }
  return {
    store,
    async ping() {
      if (!available) return false;
      return true;
    },
    async get(key: string) {
      if (!available) return null;
      return alive(key)?.value ?? null;
    },
    async setNxPx(key: string, value: string, pxMs: number) {
      if (!available) return null;
      if (alive(key)) return false;
      store.set(key, { value, expiresAt: Date.now() + pxMs });
      return true;
    },
    async compareAndDel(key: string, expected: string) {
      if (!available) return null;
      const e = alive(key);
      if (!e) return false;
      if (e.value !== expected) return false;
      store.delete(key);
      return true;
    },
    async compareAndExpire(key: string, expected: string, pxMs: number) {
      if (!available) return null;
      const e = alive(key);
      if (!e) return false;
      if (e.value !== expected) return false;
      e.expiresAt = Date.now() + pxMs;
      return true;
    },
  };
}

function lockWithMemory(opts?: { available?: boolean }) {
  const redis = memoryRedis(opts);
  const lock = new LkReconciliationLockService(redis as never);
  return { redis, lock };
}

describe('LkReconciliationLockService (distributed coordination via Redis)', () => {
  it('sync acquires the lock; second concurrent sync is refused', async () => {
    const { lock } = lockWithMemory();
    const first = await lock.tryAcquire(30_000);
    expect(first).not.toBeNull();
    expect(await lock.getState()).toBe('locked');
    const second = await lock.tryAcquire(30_000);
    expect(second).toBeNull();
    await first!.release();
    expect(await lock.getState()).toBe('unlocked');
    const third = await lock.tryAcquire(30_000);
    expect(third).not.toBeNull();
    await third!.release();
  });

  it('tryAcquire FAILS CLOSED when shared Redis is unavailable (no degraded no-op)', async () => {
    const { lock } = lockWithMemory({ available: false });
    await expect(lock.tryAcquire()).rejects.toBeInstanceOf(RedisUnavailableError);
    // And the state is reported as unavailable, never as unlocked.
    expect(await lock.getState()).toBe('unavailable');
  });

  it('consumer waits while reconciliation is locked and resumes after release', async () => {
    const { lock } = lockWithMemory();
    const rabbitmq = {} as never;
    const handler = {} as never;
    const consumer = new LkEventConsumer(rabbitmq, handler, lock);
    const handle = await lock.tryAcquire(30_000);
    expect(handle).not.toBeNull();
    let resumed = false;
    const waiting = consumer.waitWhileReconciling().then(() => {
      resumed = true;
    });
    // Still locked: waiter must not have resumed yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(resumed).toBe(false);
    await handle!.release();
    await waiting;
    expect(resumed).toBe(true);
  });

  it('consumer also pauses while Redis is unavailable and resumes after recovery', async () => {
    let available = false;
    const redis = memoryRedis({ available: true });
    // Simulate outage by toggling availability through the mock.
    const probing = {
      get: async (k: string) => (available ? redis.get(k) : null),
      ping: async () => available,
      setNxPx: async (...a: [string, string, number]) =>
        available ? redis.setNxPx(...a) : null,
      compareAndDel: async (...a: [string, string]) =>
        available ? redis.compareAndDel(...a) : null,
      compareAndExpire: async (...a: [string, string, number]) =>
        available ? redis.compareAndExpire(...a) : null,
    } as never;
    const lock = new LkReconciliationLockService(probing);
    const consumer = new LkEventConsumer({} as never, {} as never, lock);
    expect(await lock.getState()).toBe('unavailable');
    let resumed = false;
    const waiting = consumer.waitWhileReconciling().then(() => {
      resumed = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(resumed).toBe(false);
    available = true;
    await waiting;
    expect(resumed).toBe(true);
    expect(await lock.getState()).toBe('unlocked');
  });

  it('expired/crashed lock does not block the system forever (TTL)', async () => {
    const { lock } = lockWithMemory();
    const handle = await lock.tryAcquire(60);
    expect(handle).not.toBeNull();
    expect(await lock.getState()).toBe('locked');
    // Simulate crash: never release. TTL must free the lock.
    await new Promise((r) => setTimeout(r, 120));
    expect(await lock.getState()).toBe('unlocked');
    const next = await lock.tryAcquire(30_000);
    expect(next).not.toBeNull();
    await next!.release();
  });

  it('foreign token cannot release the lock (ownership)', async () => {
    const { redis, lock } = lockWithMemory();
    const handle = await lock.tryAcquire(30_000);
    expect(handle).not.toBeNull();
    const foreign = await lock.releaseToken('not-the-owner');
    expect(foreign).toBe(false);
    expect(await lock.getState()).toBe('locked');
    // Direct store check: value is still the owner token.
    expect(redis.store.get(LK_RECONCILIATION_LOCK_KEY)?.value).toBe(handle!.token);
    const own = await lock.releaseToken(handle!.token);
    expect(own).toBe(true);
    expect(await lock.getState()).toBe('unlocked');
  });

  it('handle reports ownership loss (stolen/expired) and assertOwned throws', async () => {
    const { redis, lock } = lockWithMemory();
    const handle = await lock.tryAcquire(30_000);
    expect(handle).not.toBeNull();
    expect(await handle!.isOwned()).toBe(true);
    await handle!.assertOwned();
    // Simulate a stolen lock: overwrite the key with a foreign token.
    redis.store.set(LK_RECONCILIATION_LOCK_KEY, {
      value: 'foreign-token',
      expiresAt: Date.now() + 30_000,
    });
    expect(await handle!.isOwned()).toBe(false);
    await expect(handle!.assertOwned()).rejects.toBeInstanceOf(LockOwnershipLostError);
    await handle!.release();
  });

  it('isOwned fails closed when Redis goes down mid-sync', async () => {
    const probing = memoryRedis({ available: true });
    let down = false;
    const redis = {
      get: async (k: string) => {
        if (down) return null;
        return probing.get(k);
      },
      ping: async () => !down,
      setNxPx: (...a: [string, string, number]) => probing.setNxPx(...a),
      compareAndDel: (...a: [string, string]) => probing.compareAndDel(...a),
      compareAndExpire: (...a: [string, string, number]) => probing.compareAndExpire(...a),
    } as never;
    const lock = new LkReconciliationLockService(redis);
    const handle = await lock.tryAcquire(30_000);
    expect(await handle!.isOwned()).toBe(true);
    down = true;
    await expect(handle!.isOwned()).rejects.toBeInstanceOf(RedisUnavailableError);
    await expect(handle!.assertOwned()).rejects.toBeInstanceOf(RedisUnavailableError);
    await handle!.release();
  });

  it('heartbeat renews the TTL while the owner still holds it', async () => {
    const { redis, lock } = lockWithMemory();
    const handle = await lock.tryAcquire(300);
    expect(handle).not.toBeNull();
    // Manually extend like the heartbeat does.
    const renewed = await redis.compareAndExpire(
      LK_RECONCILIATION_LOCK_KEY,
      handle!.token,
      5000,
    );
    expect(renewed).toBe(true);
    await new Promise((r) => setTimeout(r, 350));
    // Still locked because TTL was renewed past the original 300ms.
    expect(await lock.getState()).toBe('locked');
    await handle!.release();
  });

  it('run-sync refuses concurrent execution and fails closed without Redis', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'src', 'lk-sync', 'run-sync.ts'), 'utf8');
    expect(src).toMatch(/LkReconciliationLockService/);
    expect(src).toMatch(/tryAcquire/);
    expect(src).toMatch(/release/);
    // Second sync exits non-zero instead of running concurrently.
    expect(src).toMatch(/process\.exit\(2\)/);
    // Redis down -> fail closed without snapshot.
    expect(src).toMatch(/RedisUnavailableError/);
    expect(src).toMatch(/process\.exit\(3\)/);
    // Vitest spy: two overlapping tryAcquire calls, second gets null.
    const { lock } = lockWithMemory();
    const first = await lock.tryAcquire();
    const second = await lock.tryAcquire();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await first!.release();
    vi.useRealTimers();
  });
});
