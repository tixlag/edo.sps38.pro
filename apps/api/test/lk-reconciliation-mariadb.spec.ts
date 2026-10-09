import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { LkReferenceSyncService } from '../src/lk-sync/lk-reference-sync.service';
import { noopFencing } from './helpers/noop-fencing';

// Snapshot tests change absence/deletion markers for the entire projection.
// Explicit disposable DB only: never load root .env or fall back to DATABASE_URL.
const testUrl = process.env.EDO_TEST_DATABASE_URL ?? '';
if (testUrl && !/^mysql:\/\/[^@/]+@(127\.0\.0\.1|localhost):(3307|3308)\/edo(\?|$)/.test(testUrl)) {
  throw new Error('Refusing: reconciliation tests require disposable MariaDB :3307/:3308, db edo');
}
const prisma = new PrismaClient({ datasourceUrl: testUrl || 'mysql://unused:unused@127.0.0.1:3308/edo' });
let dbAvailable = false;

function emp(code1c: string, overrides: Record<string, unknown> = {}) {
  return {
    code1c,
    uuid: '00000000-0000-0000-0000-000000000001',
    fullName: `Сотрудник ${code1c}`,
    birthday: null,
    citizenship: null,
    organization: { code: null, name: 'ООО' },
    position: { code1c: null, name: null },
    department: { code1c: null, name: null },
    division: { code1c: null, name: null },
    lastLocation: null,
    hireDate: null,
    fired: false,
    contractor: false,
    updatedAt: null,
    ...overrides,
  };
}

function service() {
  const audit = { log: vi.fn() } as never;
  const config = { get: () => undefined } as never;
  return new LkReferenceSyncService(prisma as never, audit, config, noopFencing() as never);
}

const PREFIX = `T${Date.now().toString(36).toUpperCase()}`;
const OLD_EMP = `${PREFIX}-OLD`;
const OLD_FIRED_EMP = `${PREFIX}-OLD-FIRED`;
const CUR_EMP = `${PREFIX}-CUR`;
const OLD_POS = `${PREFIX}-POS-OLD`;
const CUR_POS = `${PREFIX}-POS-CUR`;
const LOC = `${PREFIX}-LOC`;
const DEP = `${PREFIX}-DEP`;

function snapshotClient(currentEmployees: string[], currentPositions: string[]) {
  return {
    listLocations: async () => [
      {
        id: 900000 + Math.floor(Math.random() * 1000),
        code1c: LOC,
        name: 'Тестовый объект',
        shortName: '',
        generalUnitCode: null,
        deleted: false,
        updatedAt: null,
      },
    ],
    listPositions: async () =>
      currentPositions.map((code1c) => ({ code1c, name: `Должность ${code1c}`, deleted: false, updatedAt: null })),
    listDepartments: async () => [{ code1c: DEP, name: 'Тестовый отдел', deleted: false, updatedAt: null }],
    listEmployeesPage: async () => ({
      items: currentEmployees.map((c) => emp(c)),
      nextCursor: null,
    }),
  } as never;
}

async function currentDatabase(): Promise<string | null> {
  try {
    const rows = (await prisma.$queryRaw`SELECT DATABASE() AS db`) as Array<{ db: string | null }>;
    return rows[0]?.db ?? null;
  } catch {
    return null;
  }
}

async function cleanup() {
  // Safety: same MariaDB server hosts LK databases — never clean outside `edo`.
  const db = await currentDatabase();
  if (db !== 'edo') {
    throw new Error(
      `Refusing integration-test cleanup in database '${db}' (expected 'edo')`,
    );
  }
  await prisma.lkEmployee.deleteMany({ where: { code1c: { startsWith: PREFIX } } }).catch(() => undefined);
  await prisma.lkPosition.deleteMany({ where: { code1c: { startsWith: PREFIX } } }).catch(() => undefined);
  await prisma.lkLocation.deleteMany({ where: { code1c: { startsWith: PREFIX } } }).catch(() => undefined);
  await prisma.lkDepartment.deleteMany({ where: { code1c: { startsWith: PREFIX } } }).catch(() => undefined);
}

beforeAll(async () => {
  if (!testUrl) return;
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
});

afterAll(async () => {
  try {
    if (dbAvailable) await cleanup();
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
});

describe.skipIf(!testUrl)('LK reconciliation against real MariaDB (NULL marking regression)', () => {
  it('marks NULL stale employee sourcePresent=false and NULL reference deleted=true, keeps fired', async () => {
    if (!dbAvailable) {
      console.warn('MariaDB unavailable, skipping real-DB reconciliation test');
      return;
    }
    await cleanup();
    const svc = service();
    // Legacy rows with lastSeenSyncId=NULL (old imports / event-created).
    await prisma.lkEmployee.create({
      data: {
        code1c: OLD_EMP,
        uuid: '00000000-0000-0000-0000-000000000001',
        fullName: 'Старый сотрудник',
        fired: false,
        contractor: false,
        sourcePresent: true,
        lastSeenSyncId: null,
      },
    });
    await prisma.lkEmployee.create({
      data: {
        code1c: OLD_FIRED_EMP,
        uuid: '00000000-0000-0000-0000-000000000002',
        fullName: 'Уволенный старый',
        fired: true,
        contractor: false,
        sourcePresent: true,
        lastSeenSyncId: null,
      },
    });
    await prisma.lkPosition.create({
      data: { code1c: OLD_POS, name: 'Старая должность', deleted: false, lastSeenSyncId: null },
    });

    // Successful snapshot where OLD rows are absent, CURRENT rows present.
    await svc.syncAll(snapshotClient([CUR_EMP], [CUR_POS]), 'run-2', { allowUnguardedForTests: true });

    const oldEmp = await prisma.lkEmployee.findUnique({ where: { code1c: OLD_EMP } });
    expect(oldEmp?.sourcePresent).toBe(false);
    expect(oldEmp?.fired).toBe(false);

    const oldFired = await prisma.lkEmployee.findUnique({ where: { code1c: OLD_FIRED_EMP } });
    expect(oldFired?.sourcePresent).toBe(false);
    // Absence must never change business dismissal status.
    expect(oldFired?.fired).toBe(true);

    const oldPos = await prisma.lkPosition.findUnique({ where: { code1c: OLD_POS } });
    expect(oldPos?.deleted).toBe(true);

    const cur = await prisma.lkEmployee.findUnique({ where: { code1c: CUR_EMP } });
    expect(cur?.sourcePresent).toBe(true);
    expect(cur?.lastSeenSyncId).toBe('run-2');
  });

  it('partial snapshot failure does not mark NULL stale rows', async () => {
    if (!dbAvailable) {
      console.warn('MariaDB unavailable, skipping real-DB reconciliation test');
      return;
    }
    await cleanup();
    const svc = service();
    const STALE = `${PREFIX}-STALE-PARTIAL`;
    await prisma.lkEmployee.create({
      data: {
        code1c: STALE,
        uuid: '00000000-0000-0000-0000-000000000003',
        fullName: 'Stale partial',
        fired: false,
        contractor: false,
        sourcePresent: true,
        lastSeenSyncId: null,
      },
    });
    const failing = {
      listLocations: async () => [
        { id: 910001, code1c: LOC, name: 'Л', shortName: '', generalUnitCode: null, deleted: false, updatedAt: null },
      ],
      listPositions: async () => {
        throw new Error('LK positions outage');
      },
      listDepartments: async () => [{ code1c: DEP, name: 'D', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => ({ items: [emp(CUR_EMP)], nextCursor: null }),
    } as never;
    await expect(svc.syncAll(failing, 'run-partial', { allowUnguardedForTests: true })).rejects.toThrow(/outage/);
    const stale = await prisma.lkEmployee.findUnique({ where: { code1c: STALE } });
    expect(stale?.sourcePresent).toBe(true);
  });

  it('empty employee snapshot does not wipe staff (safety guard)', async () => {
    if (!dbAvailable) {
      console.warn('MariaDB unavailable, skipping real-DB reconciliation test');
      return;
    }
    await cleanup();
    const svc = service();
    await svc.syncAll(snapshotClient([CUR_EMP], [CUR_POS]), 'run-full', { allowUnguardedForTests: true });
    const emptyEmployees = {
      listLocations: async () => [
        { id: 910002, code1c: LOC, name: 'Л', shortName: '', generalUnitCode: null, deleted: false, updatedAt: null },
      ],
      listPositions: async () => [{ code1c: CUR_POS, name: 'P', deleted: false, updatedAt: null }],
      listDepartments: async () => [{ code1c: DEP, name: 'D', deleted: false, updatedAt: null }],
      listEmployeesPage: async () => ({ items: [], nextCursor: null }),
    } as never;
    await svc.syncAll(emptyEmployees, 'run-empty', { allowUnguardedForTests: true });
    const cur = await prisma.lkEmployee.findUnique({ where: { code1c: CUR_EMP } });
    expect(cur?.sourcePresent).toBe(true);
  });
});
