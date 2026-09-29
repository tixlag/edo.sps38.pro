import { writeFileSync } from 'fs';
import { join } from 'path';
import { createApp } from '../src/main';

async function main() {
  // Minimal env so ConfigModule validation passes during export.
  process.env.DATABASE_URL ??= 'mysql://edo:edo@localhost:3307/edo';
  const { document } = await createApp();
  const out = join(__dirname, '..', 'openapi.json');
  writeFileSync(out, JSON.stringify(document, null, 2));
  // eslint-disable-next-line no-console
  console.log(`OpenAPI written to ${out}`);
  // Exit without graceful close: BullMQ/Redis may be absent in docs/CI builds.
  process.exit(0);
}

void main();
