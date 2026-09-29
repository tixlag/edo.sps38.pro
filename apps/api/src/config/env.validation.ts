import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  API_PORT: z.coerce.number().default(3001),
  API_PREFIX: z.string().default('/api'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Unified JWT (HS256, shared secret with lk-auth-service).
  JWT_SECRET: z.string().min(1, 'JWT_SECRET is required'),
  JWT_ALG: z.string().default('HS256').refine((v) => v === 'HS256', 'Only HS256 is supported'),
  JWT_ISSUER: z.string().default('lk-auth-service'),
  ALLOW_INSECURE_DEV_AUTH: z
    .string()
    .optional()
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  // Legacy deprecated (kept optional for compat, not used for HS256 verification).
  AUTH_JWKS_URL: z.string().optional(),
  AUTH_AUDIENCE: z.string().optional(),
  // LK compact S2S integration (backend only).
  LK_BASE_URL: z.string().default('http://localhost:8080'),
  LK_EDO_OPENAPI_URL: z.string().optional(),
  LK_EDO_INTERNAL_TOKEN: z.string().optional(),
  // Messaging / cache (shared infra in production).
  RABBITMQ_URL: z.string().default('amqp://guest:guest@localhost:5672'),
  LK_EVENTS_EXCHANGE: z.string().default('lk.events'),
  EDO_LK_QUEUE: z.string().default('edo.lk-reference-sync'),
  REDIS_URL: z.string().default('redis://localhost:6380'),
  S3_ENDPOINT: z.string().default('http://localhost:9000'),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('edo-documents'),
  S3_ACCESS_KEY: z.string().default('minioadmin'),
  S3_SECRET_KEY: z.string().default('minioadmin'),
});

export type AppEnv = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): AppEnv {
  const parsed = envSchema.parse(config);
  const nodeEnv = String(config['NODE_ENV'] ?? parsed.NODE_ENV ?? 'development');
  // Fail closed: production must have a real JWT secret and no dev bypass.
  if (nodeEnv === 'production') {
    const secret = String(config['JWT_SECRET'] ?? '');
    if (!secret || secret === 'dev-only-insecure-secret-change-me') {
      throw new Error('JWT_SECRET must be set to a real value in production');
    }
    const bypass = String(config['ALLOW_INSECURE_DEV_AUTH'] ?? 'false');
    if (bypass === 'true') {
      throw new Error('ALLOW_INSECURE_DEV_AUTH must be false in production');
    }
    if (!String(config['LK_EDO_INTERNAL_TOKEN'] ?? '')) {
      // S2S token missing -> sync fails closed at request time; warn here via throw?
      // Do not crash boot (consumer still serves cached projection), but validation
      // documents the requirement. Callers check and throw 500 with clear message.
    }
  }
  return parsed;
}
