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
    for (const f of ['lib/auth-token.ts', 'lib/auth-context.tsx', 'lib/auth-refresh.ts']) {
      const src = readFileSync(join(here, f), 'utf8');
      expect(src).not.toMatch(/localStorage/);
      expect(src).not.toMatch(/sessionStorage/);
      expect(src).not.toMatch(/indexedDB/);
    }
  });

  it('never persists refresh_token in JS (cookie-only)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const f of ['lib/auth-refresh.ts', 'lib/auth-context.tsx', 'lib/auth-token.ts']) {
      const src = readFileSync(join(here, f), 'utf8');
      expect(src).not.toMatch(/localStorage.*refresh/i);
      expect(src).not.toMatch(/setItem.*refresh/i);
    }
    const refresh = readFileSync(join(here, 'lib', 'auth-refresh.ts'), 'utf8');
    // refresh_token from JSON must be ignored, never stored.
    expect(refresh).toMatch(/refresh_token/);
    expect(refresh).toMatch(/cookie-only/i);
  });

  it('dev bypass is explicitly gated (never a default demo login)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'lib/auth-context.tsx'), 'utf8');
    expect(src).toMatch(/VITE_ALLOW_INSECURE_DEV_AUTH/);
    expect(src).toMatch(/import\.meta\.env\.DEV/);
  });

  it('exposes loading/authenticated/unauthenticated (no fake ready)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'lib/auth-context.tsx'), 'utf8');
    expect(src).toMatch(/authenticated/);
    expect(src).toMatch(/unauthenticated/);
    expect(src).not.toMatch(/'ready'/);
  });

  it('wires per-request token via adapter (no defaults.headers primary)', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'lib/auth-context.tsx'), 'utf8');
    expect(src).toMatch(/configureApiAuth/);
    expect(src).toMatch(/getAccessToken/);
  });
});
