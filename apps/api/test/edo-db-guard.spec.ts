import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', '..', '..', 'scripts', 'assert-edo-database.js');

function run(url: string | undefined): { exit: number; output: string } {
  try {
    const out = execFileSync('node', [script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(url === undefined ? { DATABASE_URL: undefined } : { DATABASE_URL: url }),
      },
    });
    return { exit: 0, output: String(out) };
  } catch (err) {
    const e = err as { status?: number; stderr?: unknown; stdout?: unknown };
    return { exit: e.status ?? 1, output: String(e.stderr ?? e.stdout ?? '') };
  }
}

describe('assert-edo-database guard (shared server, isolated database)', () => {
  it('passes for the isolated edo database (with and without query params)', () => {
    expect(run('mysql://edo:x@127.0.0.1:12002/edo').exit).toBe(0);
    expect(run('mysql://edo:x@127.0.0.1:12002/edo?connectTimeout=5').exit).toBe(0);
  });

  it('refuses LK databases without printing credentials', () => {
    for (const db of ['sps_next', 'sps_db', 'sps_market', 'mysql']) {
      const r = run(`mysql://edo:supersecret@127.0.0.1:12002/${db}`);
      expect(r.exit).toBe(1);
      expect(r.output).toContain(`'${db}'`);
      expect(r.output).not.toContain('supersecret');
    }
  });

  it('refuses unparseable DATABASE_URL', () => {
    // NOTE: the "missing DATABASE_URL" branch is intentionally not asserted
    // here: the script falls back to root .env for local-dev ergonomics, so a
    // missing env still passes locally when .env points at `edo`. In CI (no
    // .env file) a missing DATABASE_URL exits 1 via the same guard.
    expect(run('not-a-url').exit).toBe(1);
  });
});
