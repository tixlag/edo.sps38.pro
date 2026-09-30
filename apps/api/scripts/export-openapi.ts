import { writeFileSync } from 'fs';
import { join } from 'path';
import { createApp } from '../src/main';

async function main() {
  // Minimal env so ConfigModule validation passes during export.
  // Root .env is authoritative; fallbacks here are export-only and never production.
  process.env.DATABASE_URL ??= 'mysql://edo:edo@127.0.0.1:12002/edo';
  process.env.JWT_SECRET ??= 'export-only-insecure-secret';
  process.env.LK_EVENTS_CONSUME ??= '0';
  const { document } = await createApp();
  const out = join(__dirname, '..', 'openapi.json');
  writeFileSync(out, JSON.stringify(document, null, 2));
  // eslint-disable-next-line no-console
  console.log(`OpenAPI written to ${out}`);
  // Exit without graceful close: Redis/RabbitMQ may be absent in docs/CI builds.
  process.exit(0);
}

void main();
