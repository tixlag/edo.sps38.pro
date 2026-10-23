# check=skip=SecretsUsedInArgOrEnv
# (ложное срабатывание на VITE_AUTH_* — это публичные адреса и флаг, не секреты)
# ЭДО: образы api и web из монорепо (pnpm + turbo).
# Контекст сборки — корень репозитория:
#   docker build -f docker/Dockerfile --target api -t edo-api .
#   docker build -f docker/Dockerfile --target web -t edo-web \
#     --build-arg VITE_API_BASE_URL=https://edo.sps38.pro \
#     --build-arg VITE_AUTH_REFRESH_URL=... .

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_HOME=/corepack \
    CI=true
# pnpm кладётся в общий COREPACK_HOME, чтобы им мог пользоваться и USER node
# (entrypoint с миграциями, docker exec … pnpm lk:sync) без загрузки при старте
RUN corepack enable && corepack prepare pnpm@9.15.3 --activate \
 && chmod -R a+rX /corepack
WORKDIR /app

# Зависимости по lock-файлу: слой и кэш pnpm store переживают сборки,
# пока не меняется pnpm-lock.yaml
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=edo-pnpm,target=/pnpm/store pnpm fetch --frozen-lockfile

FROM fetch AS source
COPY . .
RUN --mount=type=cache,id=edo-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prefer-offline

# ---------------------------------------------------------------------------
# API. Как surveys в ЛК: в образе все зависимости (prisma CLI, ts-node), чтобы
# миграции шли из entrypoint, а ops-команды runbook (lk:topology, lk:sync,
# lk:recover, infra:check) работали через docker exec без изменений.
# ---------------------------------------------------------------------------
FROM source AS api-build
# Native HEVC decoder; sharp prebuilt binaries decode AVIF, not HEIC/HEVC.
RUN apk add --no-cache libheif-tools
RUN pnpm --filter @edo/api prisma:generate \
 && pnpm turbo build --filter=@edo/api...

FROM api-build AS api
ENV NODE_ENV=production \
    API_PORT=3001
COPY docker/api-entrypoint.sh /usr/local/bin/edo-entrypoint
RUN chmod +x /usr/local/bin/edo-entrypoint \
 && mkdir -p /app/.cache/document-uploads \
 && chown -R node:node /app/.cache \
 && chmod 700 /app/.cache /app/.cache/document-uploads
USER node
EXPOSE 3001
# live — процесс жив; ready (MariaDB + RabbitMQ) проверяет деплой, а не docker:
# кратковременная недоступность брокера не должна помечать API нездоровым
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3001/api/health/live || exit 1
ENTRYPOINT ["edo-entrypoint"]
CMD ["node", "apps/api/dist/main.js"]

# ---------------------------------------------------------------------------
# WEB. VITE_* вшиваются при сборке — передаются build-arg'ами из CI.
# ---------------------------------------------------------------------------
FROM source AS web-build
ARG VITE_API_BASE_URL
ARG VITE_AUTH_REFRESH_URL
ARG VITE_ALLOW_INSECURE_DEV_AUTH=false
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_AUTH_REFRESH_URL=$VITE_AUTH_REFRESH_URL \
    VITE_ALLOW_INSECURE_DEV_AUTH=$VITE_ALLOW_INSECURE_DEV_AUTH
RUN pnpm turbo build --filter=@edo/web...

FROM nginx:1.27-alpine AS web
COPY docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
