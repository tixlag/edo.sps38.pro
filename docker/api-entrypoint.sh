#!/bin/sh
# Entrypoint API ЭДО (по образцу surveys в ЛК): миграции при старте контейнера,
# затем запуск приложения. MIGRATE_ON_START=false — запустить без миграций (аварийно).
set -e
cd /app

if [ "${MIGRATE_ON_START:-true}" = "true" ]; then
  echo "==> Проверка: миграции применяются только к базе edo"
  node scripts/assert-edo-database.js
  echo "==> Применение миграций (prisma migrate deploy)"
  pnpm --filter @edo/api exec prisma migrate deploy --schema ../../prisma/schema.prisma
else
  echo "==> MIGRATE_ON_START=${MIGRATE_ON_START} — миграции пропущены"
fi

echo "==> Запуск: $*"
exec "$@"
