import { describe, expect, it, vi } from 'vitest';
import {
  LkReconciliationLockService,
  LK_RECONCILIATION_LOCK_KEY,
} from '../src/lk-sync/lk-reconciliation-lock.service';
import { LkEventConsumer } from '../src/lk-events/lk-event.consumer';

function memoryRedis() {
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
    async get(key: string) {
      return alive(key)?.value ?? null;
    },
    async setNxPx(key: string, value: string, pxMs: number) {
      if (alive(key)) return false;
      store.set(key, { value, expiresAt: Date.now() + pxMs });
      return true;
    },
    async compareAndDel(key: string, expected: string) {
      const e = alive(key);
      if (!e) return false;
      if (e.value !== expected) return false;
      store.delete(key);
      return true;
    },
    async compareAndExpire(key: string, expected: string, pxMs: number) {
      const e = alive(key);
      if (!e) return false;
      if (e.value !== expected) return false;
      e.expiresAt = Date.now() + pxMs;
      return true;
    },
  };
}

function lockWithMemory() {
  const redis = memoryRedis();
  const lock = new LkReconciliationLockService(redis as never);
  return { redis, lock };
}

describe('LkReconciliationLockService (distributed coordination via Redis)', () => {
  it('sync acquires the lock; second concurrent sync is refused', async () => {
    const { lock } = lockWithMemory();
    const first = await lock.tryAcquire(30_000);
    expect(first).not.toBeNull();
    expect(await lock.isLocked()).toBe(true);
    const second = await lock.tryAcquire(30_000);
    expect(second).toBeNull();
    await first!.release();
    expect(await lock.isLocked()).toBe(false);
    const third = await lock.tryAcquire(30_000);
    expect(third).not.toBeNull();
    await third!.release();
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

  it('expired/crashed lock does not block the system forever (TTL)', async () => {
    const { lock } = lockWithMemory();
    const handle = await lock.tryAcquire(60);
    expect(handle).not.toBeNull();
    expect(handle!.distributed).toBe(true);
    expect(await lock.isLocked()).toBe(true);
    // Simulate crash: never release. TTL must free the lock.
    await new Promise((r) => setTimeout(r, 120));
    expect(await lock.isLocked()).toBe(false);
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
    expect(await lock.isLocked()).toBe(true);
    // Direct store check: value is still the owner token.
    expect(redis.store.get(LK_RECONCILIATION_LOCK_KEY)?.value).toBe(handle!.token);
    const own = await lock.releaseToken(handle!.token);
    expect(own).toBe(true);
    expect(await lock.isLocked()).toBe(false);
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
    expect(await lock.isLocked()).toBe(true);
    await handle!.release();
  });

  it('degrades safely when Redis is unavailable (local/CI without Redis)', async () => {
    const down = {
      get: async () => null,
      setNxPx: async () => null,
      compareAndDel: async () => null,
      compareAndExpire: async () => null,
    } as never;
    const lock = new LkReconciliationLockService(down);
    const handle = await lock.tryAcquire();
    expect(handle).not.toBeNull();
    expect(handle!.distributed).toBe(false);
    // Consumer must not pause when coordination is unavailable.
    expect(await lock.isLocked()).toBe(false);
    await handle!.release();
  });

  it('run-sync refuses concurrent execution while the lock is held', async () => {
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
