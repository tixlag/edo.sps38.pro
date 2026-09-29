import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const specPath =
  process.env.LK_EDO_OPENAPI_URL && !process.env.LK_EDO_OPENAPI_URL.startsWith('http')
    ? join(root, process.env.LK_EDO_OPENAPI_URL)
    : join(root, 'packages', 'lk-client', 'openapi', 'edo.json');

async function main() {
  let raw;
  if (process.env.LK_EDO_OPENAPI_URL?.startsWith('http')) {
    const res = await fetch(process.env.LK_EDO_OPENAPI_URL);
    if (!res.ok) throw new Error(`Failed to fetch LK EDO spec: ${res.status}`);
    raw = await res.text();
    writeFileSync(join(root, 'packages', 'lk-client', 'openapi', 'edo.json'), raw);
  } else {
    raw = readFileSync(specPath, 'utf8');
  }
  const spec = JSON.parse(raw);
  const paths = Object.keys(spec.paths ?? {});
  const allowed = [
    '/api/internal/edo/v1/employees',
    '/api/internal/edo/v1/locations',
    '/api/internal/edo/v1/positions',
    '/api/internal/edo/v1/departments',
  ];
  for (const p of paths) {
    if (!allowed.includes(p)) {
      throw new Error(`LK EDO spec contains unexpected path ${p}; refusing to generate broad client`);
    }
  }
  mkdirSync(join(root, 'packages', 'lk-client', 'src', 'generated'), { recursive: true });
  console.log(`LK EDO spec OK: ${paths.length} narrow paths verified. Types are hand-pinned in src/generated/types.ts.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
