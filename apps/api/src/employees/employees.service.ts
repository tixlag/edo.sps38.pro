import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeeStatus } from './employee-status.enum';
import type { EmployeeDto } from './dto/employee.dto';

/**
 * EDO domain employees (NOT LK master data).
 * No seed fallback at runtime: DB errors propagate as 5xx, empty DB returns [].
 * Demo content exists only via `db:seed`.
 */
@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<{ items: EmployeeDto[]; total: number }> {
    const rows = await this.prisma.employee.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return {
      items: rows.map((r) => ({
        id: r.id,
        fullName: r.fullName,
        country: r.country,
        position: r.position,
        status: r.status as EmployeeDto['status'],
        stage: r.stage,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      total: rows.length,
    };
  }

  async getById(id: string): Promise<EmployeeDto | null> {
    const r = await this.prisma.employee.findUnique({ where: { id } });
    if (!r) return null;
    return {
      id: r.id,
      fullName: r.fullName,
      country: r.country,
      position: r.position,
      status: r.status as EmployeeDto['status'],
      stage: r.stage,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}

export { EmployeeStatus };
