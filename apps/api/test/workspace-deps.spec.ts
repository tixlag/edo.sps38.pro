import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');

describe('workspace package resolution (clean checkout)', () => {
  it('turbo test depends on workspace builds so clean checkout works without stale dist', () => {
    const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8'));
    // pnpm test on a clean checkout must first build workspace deps
    // (@edo/lk-client dist) instead of relying on a leftover dist/.
    expect(turbo.tasks.test?.dependsOn).toContain('^build');
  });

  it('turbo dev builds workspace deps before starting API (no stale dist)', () => {
    const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8'));
    expect(turbo.tasks.dev?.dependsOn).toContain('^build');
  });

  it('@edo/lk-client exposes a correct production entry (dist + types)', () => {
    const pkg = JSON.parse(
      readFileSync(join(root, 'packages', 'lk-client', 'package.json'), 'utf8'),
    );
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    const exp = pkg.exports?.['.'];
    expect(exp.default ?? exp).toBe('./dist/index.js');
    expect(exp.types ?? pkg.types).toBe('./dist/index.d.ts');
  });

  it('@edo/api depends on @edo/lk-client via workspace (turbo graph can order build->test)', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'apps', 'api', 'package.json'), 'utf8'));
    expect(pkg.dependencies?.['@edo/lk-client']).toMatch(/workspace/);
  });
});
