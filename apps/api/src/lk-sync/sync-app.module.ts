import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { validateEnv } from '../config/env.validation';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { RabbitmqModule } from '../rabbitmq/rabbitmq.module';
import { LkSyncModule } from './lk-sync.module';

const ROOT_ENV = join(__dirname, '..', '..', '..', '..', '.env');

/**
 * Lightweight sync context for `lk:sync` / `lk:topology`.
 * Intentionally does NOT import the live events module, so a full
 * snapshot can never start the live consumer in the same process.
 * Bootstrap order: lk:topology (queue buffers) -> lk:sync (snapshot) -> app boot (live).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: [ROOT_ENV, '.env'],
    }),
    PrismaModule,
    RabbitmqModule,
    AuditModule,
    LkSyncModule,
  ],
})
export class SyncAppModule {}
