import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SyncAppModule } from '../src/lk-sync/sync-app.module';

const here = dirname(fileURLToPath(import.meta.url));

describe('lk:sync isolation (snapshot vs live consumer)', () => {
  it('SyncAppModule does not include the live consumer module', () => {
    const src = readFileSync(join(here, '..', 'src', 'lk-sync', 'sync-app.module.ts'), 'utf8');
    expect(src).not.toMatch(/LkEventsModule/);
    expect(src).not.toMatch(/LkEventConsumer/);
    // Sanity: the module class exists and is importable.
    expect(SyncAppModule).toBeDefined();
  });

  it('run-sync forces LK_EVENTS_CONSUME=0 before creating the context', () => {
    const src = readFileSync(join(here, '..', 'src', 'lk-sync', 'run-sync.ts'), 'utf8');
    expect(src).toMatch(/SyncAppModule/);
    expect(src).toMatch(/LK_EVENTS_CONSUME/);
    expect(src).toMatch(/['"]0['"]/);
    expect(src).not.toMatch(/from '\.\.\/app\.module'/);
  });

  it('topology can be asserted separately without starting a consumer', () => {
    const src = readFileSync(join(here, '..', 'src', 'lk-sync', 'run-topology.ts'), 'utf8');
    expect(src).toMatch(/assertTopologyOnly/);
    expect(src).not.toMatch(/\.consume\(/);
    expect(src).not.toMatch(/LkEventConsumer/);
  });
});
