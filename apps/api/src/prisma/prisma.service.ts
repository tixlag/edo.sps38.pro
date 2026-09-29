import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient {
  async onModuleInit() {
    // Connect lazily: DB may not exist in CI/docs builds. Never crash the app boot.
    try {
      await this.$connect();
    } catch {
      // EmployeesService falls back to deterministic seed data when DB is unreachable.
    }
  }

  async onModuleDestroy() {
    try {
      await this.$disconnect();
    } catch {
      // ignore
    }
  }
}
