import { describe, expect, it, vi } from 'vitest';
import { computeReconnectDelay, RabbitmqService } from '../src/rabbitmq/rabbitmq.module';

function service() {
  const config = { get: () => undefined } as never;
  return new RabbitmqService(config);
}

describe('RabbitMQ reconnect scheduling', () => {
  it('uses bounded exponential backoff 1s/2s/5s/10s/30s max', () => {
    expect(computeReconnectDelay(0)).toBe(1000);
    expect(computeReconnectDelay(1)).toBe(2000);
    expect(computeReconnectDelay(2)).toBe(5000);
    expect(computeReconnectDelay(3)).toBe(10000);
    expect(computeReconnectDelay(4)).toBe(30000);
    expect(computeReconnectDelay(5)).toBe(30000);
    expect(computeReconnectDelay(99)).toBe(30000);
  });

  it('adds jitter without breaking the cap logic', () => {
    expect(computeReconnectDelay(0, 499)).toBe(1499);
    expect(computeReconnectDelay(4, 499)).toBe(30499);
  });

  it('does not start multiple reconnect loops', () => {
    const svc = service();
    vi.useFakeTimers();
    try {
      // Force failures so ensureConnected always rejects quickly.
      vi.spyOn(svc, 'ensureConnected').mockRejectedValue(new Error('broker down'));
      svc.scheduleReconnect();
      const first = svc.getReconnectState();
      svc.scheduleReconnect();
      const second = svc.getReconnectState();
      expect(first.scheduled).toBe(true);
      expect(second.scheduled).toBe(true);
      expect(first.attempt).toBe(second.attempt);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops reconnect on shutdown', async () => {
    const svc = service();
    svc.scheduleReconnect();
    expect(svc.getReconnectState().scheduled).toBe(true);
    await svc.onModuleDestroy();
    expect(svc.getReconnectState().scheduled).toBe(false);
  });

  it('exposes DLQ/DLX topology names', () => {
    const svc = service();
    expect(svc.queue).toBe('edo.lk-reference-sync');
    expect(svc.dlq).toBe('edo.lk-reference-sync.dlq');
    expect(svc.dlx).toBe('edo.lk-reference-sync.dlx');
  });
});
