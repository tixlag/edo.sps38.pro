import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { HealthModule } from './health/health.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { EmployeesModule } from './employees/employees.module';
import { OcrModule } from './ocr/ocr.module';
import { StorageModule } from './storage/storage.module';
import { RedisModule } from './redis/redis.module';
import { RabbitmqModule } from './rabbitmq/rabbitmq.module';
import { LkSyncModule } from './lk-sync/lk-sync.module';
import { LkEventsModule } from './lk-events/lk-events.module';
import { MeModule } from './me/me.module';

// Root .env is loaded explicitly: do not rely on process cwd.
// apps/api runs from apps/api/, repo root is ../../.env.
const ROOT_ENV = join(__dirname, '..', '..', '..', '.env');

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: [ROOT_ENV, '.env'],
    }),
    PrismaModule,
    RedisModule,
    RabbitmqModule,
    AuthModule,
    AuditModule,
    HealthModule,
    DashboardModule,
    EmployeesModule,
    OcrModule,
    StorageModule,
    LkSyncModule,
    LkEventsModule,
    MeModule,
  ],
})
export class AppModule {}
