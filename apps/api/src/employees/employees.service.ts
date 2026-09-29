import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmployeeStatus } from './employee-status.enum';
import type { EmployeeDto } from './dto/employee.dto';

/** Deterministic demo data (Pencil names) used when MariaDB is unreachable. */
const SEED: EmployeeDto[] = [
  {
    id: 'emp-toktogulov',
    fullName: 'Токтогулов Айбек Русланович',
    country: 'Кыргызстан',
    position: 'Арматурщик',
    status: EmployeeStatus.BLOCKED,
    stage: 'Проверка патента',
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-29T09:00:00.000Z',
  },
  {
    id: 'emp-osmonov',
    fullName: 'Осмонов Санжар Талантович',
    country: 'Кыргызстан',
    position: 'Монолитчик',
    status: EmployeeStatus.BLOCKED,
    stage: 'Дактилоскопия',
    createdAt: '2026-09-21T09:00:00.000Z',
    updatedAt: '2026-09-29T09:00:00.000Z',
  },
  {
    id: 'emp-karimov',
    fullName: 'Каримов Азиз Шарифович',
    country: 'Таджикистан',
    position: 'Каменщик',
    status: EmployeeStatus.IN_REVIEW,
    stage: 'Проверка документов',
    createdAt: '2026-09-22T09:00:00.000Z',
    updatedAt: '2026-09-29T09:00:00.000Z',
  },
  {
    id: 'emp-kholov',
    fullName: 'Холов Джамшед Фирузович',
    country: 'Таджикистан',
    position: 'Подсобный рабочий',
    status: EmployeeStatus.ONBOARDING,
    stage: 'Проходит путь',
    createdAt: '2026-09-23T09:00:00.000Z',
    updatedAt: '2026-09-29T09:00:00.000Z',
  },
  {
    id: 'emp-nazarov',
    fullName: 'Назаров Фаррух',
    country: 'Узбекистан',
    position: 'Сварщик',
    status: EmployeeStatus.SIGNING,
    stage: 'Подписание',
    createdAt: '2026-09-24T09:00:00.000Z',
    updatedAt: '2026-09-29T09:00:00.000Z',
  },
];

@Injectable()
export class EmployeesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<{ items: EmployeeDto[]; total: number; source: 'db' | 'seed' }> {
    try {
      const rows = await this.prisma.employee.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
      if (rows.length > 0) {
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
          source: 'db',
        };
      }
    } catch {
      // fall through to seed
    }
    return { items: SEED, total: SEED.length, source: 'seed' };
  }

  async getById(id: string): Promise<EmployeeDto | null> {
    try {
      const r = await this.prisma.employee.findUnique({ where: { id } });
      if (r) {
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
    } catch {
      // fall through to seed
    }
    return SEED.find((e) => e.id === id) ?? null;
  }
}
