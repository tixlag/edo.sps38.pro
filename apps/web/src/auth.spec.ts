import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('auth-token (in-memory only)', () => {
  it('round-trips token in module memory', async () => {
    const mod = await import('./lib/auth-token');
    mod.setAccessToken('abc');
    expect(mod.getAccessToken()).toBe('abc');
    mod.setAccessToken(null);
    expect(mod.getAccessToken()).toBeNull();
  });

  it('never references persistent browser storage', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ['lib/auth-token.ts', 'lib/auth-context.tsx']) {
      const src = readFileSync(join(here, f), 'utf8');
      expect(src).not.toMatch(/localStorage/);
      expect(src).not.toMatch(/sessionStorage/);
      expect(src).not.toMatch(/indexedDB/);
    }
  });
});
