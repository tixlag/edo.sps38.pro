import { join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Load root .env explicitly when present (local dev); CI provides env directly.
// Missing file is fine — dotenvConfig simply loads nothing.
dotenvConfig({ path: join(__dirname, '..', '..', '..', '.env') });

const prisma = new PrismaClient();

async function main() {
  // Deterministic demo seed mirroring Pencil dashboard names.
  // locationId is the explicit access object (20007 scope); NULL means "no
  // object set" and is invisible to scoped users (see EmployeesService).
  const employees = [
    { id: 'emp-toktogulov', fullName: 'Токтогулов Айбек Русланович', country: 'Кыргызстан', position: 'Арматурщик', status: 'BLOCKED' as const, stage: 'Проверка патента', locationId: 98 },
    { id: 'emp-osmonov', fullName: 'Осмонов Санжар Талантович', country: 'Кыргызстан', position: 'Монолитчик', status: 'BLOCKED' as const, stage: 'Дактилоскопия', locationId: 999 },
    { id: 'emp-karimov', fullName: 'Каримов Азиз Шарифович', country: 'Таджикистан', position: 'Каменщик', status: 'IN_REVIEW' as const, stage: 'Проверка документов', locationId: 98 },
    { id: 'emp-kholov', fullName: 'Холов Джамшед Фирузович', country: 'Таджикистан', position: 'Подсобный рабочий', status: 'ONBOARDING' as const, stage: 'Проходит путь', locationId: 999 },
    { id: 'emp-nazarov', fullName: 'Назаров Фаррух', country: 'Узбекистан', position: 'Сварщик', status: 'SIGNING' as const, stage: 'Подписание', locationId: null },
  ];
  for (const e of employees) {
    await prisma.employee.upsert({ where: { id: e.id }, update: e, create: e });
  }

  const types = [
    { code: 'PASSPORT', title: 'Паспорт' },
    { code: 'PATENT', title: 'Патент' },
    { code: 'SNILS', title: 'СНИЛС' },
    { code: 'DMS', title: 'Полис ДМС' },
  ];
  for (const t of types) {
    await prisma.documentType.upsert({ where: { code: t.code }, update: {}, create: t });
  }

  await prisma.task.upsert({
    where: { id: 'task-1' },
    update: {},
    create: { id: 'task-1', title: 'Проверить страховой полис ДМС — Назаров Фаррух', status: 'TODO' },
  });

  // eslint-disable-next-line no-console
  console.log(`Seeded ${employees.length} employees, ${types.length} document types.`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
