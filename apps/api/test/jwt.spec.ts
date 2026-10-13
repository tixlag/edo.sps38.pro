import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { JwtService } from '../src/auth/jwt.service';

const SECRET = 'test-secret-please-ignore';
const ISSUER = 'lk-auth-service';

function configService(env: Record<string, string> = {}) {
  const values: Record<string, string> = {
    JWT_SECRET: SECRET,
    JWT_ISSUER: ISSUER,
    JWT_ALG: 'HS256',
    NODE_ENV: 'test',
    ...env,
  };
  return {
    get: (key: string) => values[key],
  } as never;
}

function sign(payload: Record<string, unknown>, secret = SECRET, extra: jwt.SignOptions = {}) {
  return jwt.sign({ iss: ISSUER, ...payload }, secret, { algorithm: 'HS256', ...extra });
}

function signRaw(payload: Record<string, unknown>): string {
  // Manual HS256 signing to craft structurally valid JWTs with invalid exp/iat
  // types (jsonwebtoken.sign would reject them before verify is reached).
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ iss: ISSUER, ...payload });
  const sig = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

describe('JwtService (HS256, lk-auth-service)', () => {
  let svc: JwtService;
  beforeEach(() => {
    svc = new JwtService(configService());
  });

  it('accepts a valid token and maps uuid/code_1c/sid/accessRules', () => {
    const token = sign({
      uuid: '00000000-0000-0000-0000-000000000001',
      code_1c: 'УП00040092',
      sid: 'abcdef1234567890abcdef1234567890',
      device_id: 'abcdef123456',
      accessRules: { '20000': [], '20007': ['98', '148'] },
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const principal = svc.verify(token);
    expect(principal.uuid).toBe('00000000-0000-0000-0000-000000000001');
    expect(principal.code1c).toBe('УП00040092');
    expect(principal.accessRules['20000']).toEqual([]);
    expect(principal.accessRules['20007']).toEqual(['98', '148']);
  });

  it('rejects a wrong secret', () => {
    const token = sign({ uuid: 'u1', exp: Math.floor(Date.now() / 1000) + 600 }, 'wrong-secret');
    expect(() => svc.verify(token)).toThrow();
  });

  it('rejects a wrong issuer', () => {
    const token = jwt.sign({ uuid: 'u1' }, SECRET, { algorithm: 'HS256', issuer: 'evil-issuer' });
    expect(() => svc.verify(token)).toThrow();
  });

  it('rejects expired tokens', () => {
    const token = sign({ uuid: 'u1', exp: Math.floor(Date.now() / 1000) - 10 });
    expect(() => svc.verify(token)).toThrow();
  });

  it('rejects non-HS256 algorithms (alg is pinned, never trusted from header)', () => {
    // HS384 signed with same secret must be rejected because only HS256 is allowed.
    const token = jwt.sign({ uuid: 'u1', iss: ISSUER }, SECRET, { algorithm: 'HS384' });
    expect(() => svc.verify(token)).toThrow();
  });

  it('rejects tokens without uuid', () => {
    const token = sign({ exp: Math.floor(Date.now() / 1000) + 600 });
    expect(() => svc.verify(token)).toThrow();
  });

  it('rejects tokens without exp (exp is required)', () => {
    const token = sign({ uuid: 'u1' });
    expect(() => svc.verify(token)).toThrow(/exp/i);
  });

  it('rejects tokens with non-numeric exp', () => {
    const token = signRaw({ uuid: 'u1', exp: 'not-a-number' });
    expect(() => svc.verify(token)).toThrow(/exp/i);
  });

  it('rejects tokens with non-numeric iat when present', () => {
    const token = signRaw({
      uuid: 'u1',
      exp: Math.floor(Date.now() / 1000) + 600,
      iat: 'yesterday',
    });
    expect(() => svc.verify(token)).toThrow(/iat/i);
  });

  it('accepts long-lived tokens (no artificial max-age)', () => {
    const token = sign({
      uuid: 'u1',
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365,
    });
    expect(() => svc.verify(token)).not.toThrow();
  });

  it('fails closed when secret is missing', () => {
    const unconfigured = new JwtService(configService({ JWT_SECRET: '' }));
    expect(() => unconfigured.verify('a.b.c')).toThrow();
  });
});
