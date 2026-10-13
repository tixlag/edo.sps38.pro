import { createHmac } from 'node:crypto';
import type { Page } from '@playwright/test';

export { test, expect } from '@playwright/test';

const EDO_RULE_IDS = [20000, 20001, 20002, 20003, 20004, 20005, 20006, 20007, 20008, 20009];

/**
 * E2E auth fixture: signs a REAL HS256 JWT (full EDO rules) with
 * EDO_E2E_JWT_SECRET (must equal the API JWT_SECRET) and injects it via the
 * dev-only `window.__EDO_DEV_TOKEN` hook. Never used in production.
 */
export function signE2EJwt(): string {
  return signE2EJwtWithRules(Object.fromEntries(EDO_RULE_IDS.map((id) => [String(id), []])));
}

/** Sign a real HS256 JWT with an explicit accessRules map (scoped-access e2e). */
export function signE2EJwtWithRules(accessRules: Record<string, string[]>): string {
  const secret = process.env.EDO_E2E_JWT_SECRET;
  if (!secret) throw new Error('EDO_E2E_JWT_SECRET is required for e2e (must equal API JWT_SECRET)');
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    uuid: 'e2e-operator',
    code_1c: 'E2E001',
    iss: 'lk-auth-service',
    exp: Math.floor(Date.now() / 1000) + 600,
    accessRules,
  };
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const h = b64(header);
  const p = b64(payload);
  const sig = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

/** Open a URL with a real JWT already in the in-memory auth store. */
export async function gotoAuthed(page: Page, url: string): Promise<void> {
  await gotoAuthedWith(page, url, signE2EJwt());
}

/** Open a URL with an explicitly signed JWT (scoped-access e2e). */
export async function gotoAuthedWith(page: Page, url: string, token: string): Promise<void> {
  await page.addInitScript((t) => {
    (window as unknown as { __EDO_DEV_TOKEN?: string }).__EDO_DEV_TOKEN = t;
  }, token);
  await page.goto(url);
}
