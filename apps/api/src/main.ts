import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import fastifyMultipart from '@fastify/multipart';
import fastifyCors from '@fastify/cors';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { AppModule } from './app.module';
import { HttpErrorFilter } from './common/http-error.filter';

// Explicit root .env loading (do not rely on cwd): apps/api runs from apps/api/.
dotenvConfig({ path: join(__dirname, '..', '..', '..', '.env') });

export async function createApp(): Promise<{ app: NestFastifyApplication; document: OpenAPIObject }> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
  );

  await app.register(fastifyMultipart, { limits: { files: 10, fileSize: 10 * 1024 * 1024, fields: 2, parts: 12 } });

  const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
  await app.register(fastifyCors, {
    origin: corsOrigin,
    credentials: true,
  });

  const prefix = process.env.API_PREFIX ?? '/api';
  app.setGlobalPrefix(prefix, { exclude: ['/api-json', '/api/docs', '/api/docs-json'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpErrorFilter());

  // Correlation id must be set before guards/filters run (interceptors are too late),
  // so it lives on the raw Fastify request via onRequest hook.
  const fastify = app.getHttpAdapter().getInstance() as {
    addHook: (name: 'onRequest', hook: (req: unknown, reply: unknown, done: () => void) => void) => void;
  };
  fastify.addHook('onRequest', (rawReq, _reply, done) => {
    const req = rawReq as { headers: Record<string, string | undefined>; correlationId?: string };
    const incoming = req.headers['x-correlation-id'] ?? req.headers['x-request-id'];
    req.correlationId = incoming ?? randomUUID();
    done();
  });

  const config = new DocumentBuilder()
    .setTitle('EDO SPS38 API')
    .setDescription('Internal employee onboarding service: employees, documents, tasks, dashboard, audit.')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-jwt')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Server-to-server credential: EDO_LK_INTERNAL_TOKEN' }, 'lk-service-token')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  // Raw JSON for Orval codegen (also exported to apps/api/openapi.json by script).
  const httpAdapter = app.getHttpAdapter();
  httpAdapter.get('/api-json', (req: unknown, reply: { send: (d: unknown) => void }) => {
    (reply as { send: (d: unknown) => void }).send(document);
  });

  return { app, document };
}

async function bootstrap() {
  const { app } = await createApp();
  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`API listening on :${port}`);
}

// Only auto-listen when executed directly (not when imported by export-openapi script/tests).
if (require.main === module) {
  void bootstrap();
}
