// Safety guard: destructive DB operations (migrate/seed) and integration tests
// must ONLY ever touch the isolated `edo` database on the shared LK MariaDB
// server. Same container/server != same application database.
//
// Usage: node scripts/assert-edo-database.js
// Exits 0 when DATABASE_URL points at database `edo`, 1 otherwise.
// DATABASE_URL is taken from process env, falling back to root .env (local dev).
// Never prints credentials — only the database NAME on failure.
const fs = require('node:fs');
const path = require('node:path');

function loadDotEnvIfPresent(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?DATABASE_URL=(.*)$/);
      if (m && process.env.DATABASE_URL == null) {
        let v = m[1].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        process.env.DATABASE_URL = v;
      }
    }
  } catch {
    // No .env file (CI provides env directly) — fine.
  }
}

function databaseName(url) {
  // mysql://user:pass@host:port/dbname?params — pathname is /dbname.
  const parsed = new URL(url.replace(/^mysql:\/\//, 'http://'));
  return decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? '');
}

function main() {
  loadDotEnvIfPresent(path.join(__dirname, '..', '.env'));
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('assert-edo-database: DATABASE_URL is not set (refusing to run)');
    process.exit(1);
  }
  let name;
  try {
    name = databaseName(url);
  } catch {
    console.error('assert-edo-database: DATABASE_URL is not parseable (refusing to run)');
    process.exit(1);
  }
  if (name !== 'edo') {
    console.error(
      `assert-edo-database: refusing to run against database '${name}' (expected 'edo'). ` +
        'Same MariaDB server, but EDO must use ONLY its isolated database.',
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { databaseName };
