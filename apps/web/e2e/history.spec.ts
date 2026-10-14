import { test, expect, gotoAuthed, type Page } from './fixture';
import type { DocumentDto, DocumentVersionDto } from '@edo/api-client';

interface AuditRow {
  id: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  version?: number | null;
  rejectionReason: string | null;
  createdAt: string;
  linkHint: string | null;
}

interface MockDb {
  me: Record<string, unknown>;
  audits: AuditRow[];
  docs: Record<string, DocumentDto>;
  versions: Record<string, DocumentVersionDto>;
}

const FULL_ME = {
  uuid: 'e2e-operator',
  code1c: 'E2E001',
  fullName: 'Проверяющий',
  permissions: { '20000': [], '20002': [], '20005': [], '20007': ['1'], '20009': [] },
  locationScope: { all: true, locationIds: [] },
};

// Reviewer without the base read right (20000): audit rows stay visible,
// object links must not be clickable (UI-only gating, backend re-checks).
const NO_READ_ME = {
  ...FULL_ME,
  permissions: { '20002': [], '20007': ['1'] },
  locationScope: { all: false, locationIds: [1] },
};

function field(value: string) {
  return {
    name: 'number',
    label: 'Номер',
    kind: 'text',
    required: true,
    value,
    submittedValue: value,
    originalValue: null,
    editedBy: null,
    mismatch: false,
    regions: [],
  };
}

function docInfo(id: string, rest: Partial<DocumentDto>): DocumentDto {
  return {
    id,
    documentTypeCode: 'PASSPORT',
    title: 'Паспорт',
    documentUid: 'passport-uid',
    status: 'IN_REVIEW',
    currentVersion: 1,
    revision: 0,
    candidateId: 'candidate',
    chatUuid: 'candidate-chat',
    code1c: null,
    deliveryStatus: null,
    pendingDeliveryVersions: [],
    ...rest,
  } as DocumentDto;
}

function docVersion(
  documentId: string,
  version: number,
  rest: Partial<DocumentVersionDto>,
): DocumentVersionDto {
  return {
    documentId,
    version,
    status: 'IN_REVIEW',
    revision: 0,
    ocrSource: null,
    raw: null,
    files: [],
    fields: [field(`${documentId}-v${version}`)],
    issues: [],
    job: null,
    approvedAt: null,
    approvedBy: null,
    rejectionReason: null,
    delivery: null,
    ...rest,
  } as DocumentVersionDto;
}

function audit(
  id: string,
  action: string,
  entityId: string,
  rest: Partial<AuditRow> = {},
): AuditRow {
  return {
    id,
    actorId: 'e2e-operator',
    actorName: 'Проверяющий',
    action,
    entityType: 'Document',
    entityId,
    rejectionReason: null,
    createdAt: new Date().toISOString(),
    linkHint: `/documents/${entityId}`,
    ...rest,
  };
}

function buildDb(me: Record<string, unknown> = FULL_ME): MockDb {
  const audits: AuditRow[] = [
    audit('a1', 'DOCUMENT_APPROVED', 'docA-1111', { version: 2 }),
    audit('a2', 'DOCUMENT_RETURNED', 'docA-1111', {
      version: 1,
      rejectionReason: 'Плохое фото',
    }),
    audit('a3', 'DOCUMENT_APPROVED', 'docB-2222'),
    audit('a4', 'DOCUMENT_APPROVED', 'docC-3333', {
      actorId: 'other-op',
      actorName: 'Другой',
      version: 2,
    }),
  ];
  const docs: Record<string, DocumentDto> = {
    'docA-1111': docInfo('docA-1111', { status: 'APPROVED', currentVersion: 2 }),
    'docB-2222': docInfo('docB-2222', { status: 'IN_REVIEW', currentVersion: 1 }),
    'docC-3333': docInfo('docC-3333', { status: 'APPROVED', currentVersion: 2 }),
  };
  const versions: Record<string, DocumentVersionDto> = {
    'docA-1111:1': docVersion('docA-1111', 1, { fields: [field('A1-stale')] }),
    'docA-1111:2': docVersion('docA-1111', 2, {
      status: 'APPROVED',
      revision: 1,
      fields: [field('A2-current')],
      approvedAt: new Date().toISOString(),
      approvedBy: 'e2e-operator',
    }),
    'docB-2222:1': docVersion('docB-2222', 1, { fields: [field('B1-current')] }),
    'docC-3333:1': docVersion('docC-3333', 1, {
      status: 'RETURNED',
      fields: [field('C1-rejected')],
      rejectionReason: 'Плохое фото, нужен пересъём',
    }),
    'docC-3333:2': docVersion('docC-3333', 2, {
      status: 'APPROVED',
      revision: 1,
      fields: [field('C2-current')],
      approvedAt: new Date().toISOString(),
      approvedBy: 'e2e-operator',
    }),
  };
  return { me, audits, docs, versions };
}

async function mockApi(page: Page, db: MockDb, onMutation?: () => void) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (method !== 'GET' && path.includes('/versions/')) {
      onMutation?.();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
      return;
    }
    let status = 200;
    let response: unknown = {};
    if (path === '/api/v1/me') response = db.me;
    else if (path.endsWith('document-status-events')) {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: ': heartbeat\n\n',
      });
      return;
    } else if (path === '/api/v1/audit-logs') {
      const mine = url.searchParams.get('mine') === 'true';
      const action = url.searchParams.get('action');
      const entityId = url.searchParams.get('entityId');
      const filtered = db.audits.filter(
        (row) =>
          (!mine || row.actorId === 'e2e-operator') &&
          (!action || row.action === action) &&
          (!entityId || row.entityId === entityId),
      );
      const PAGE = 2;
      const start = Number(url.searchParams.get('cursor') ?? 0) || 0;
      const slice = filtered.slice(start, start + PAGE);
      response = {
        items: slice,
        nextCursor: start + PAGE < filtered.length ? String(start + PAGE) : null,
      };
    } else if (path === '/api/v1/review-documents') {
      response = { items: [], nextCursor: null };
    } else {
      const versionMatch = path.match(/^\/api\/v1\/documents\/([^/]+)\/versions\/(\d+)$/);
      const infoMatch = path.match(/^\/api\/v1\/documents\/([^/]+)$/);
      if (versionMatch) {
        const found = db.versions[`${versionMatch[1]}:${versionMatch[2]}`];
        if (found) response = found;
        else status = 404;
      } else if (infoMatch) {
        const found = db.docs[infoMatch[1]];
        if (found) response = found;
        else status = 404;
      }
    }
    if (status !== 200) {
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ statusCode: status, message: 'Not found' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}

test('history: mine/all, action filter, pagination resets on filter switch', async ({
  page,
}) => {
  await mockApi(page, buildDb());
  await gotoAuthed(page, '/history');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(rows).toHaveCount(4);
  // Switch to mine: pages of the other filter must not mix in.
  await page.getByRole('button', { name: 'Мои', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  await expect(rows).toHaveCount(3);
  // Action filter resets pagination too.
  await page.getByLabel('Действие').selectOption('DOCUMENT_RETURNED');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Возвращён');
  await expect(rows.first()).toContainText('Плохое фото');
});

test('my-reviews tabs switch approved/returned', async ({ page }) => {
  await mockApi(page, buildDb());
  await gotoAuthed(page, '/my-reviews');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('Подтверждён');
  await page.getByRole('button', { name: 'Отклоненные' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Возвращён');
});

test('history deep link opens the historic version, locked', async ({ page }) => {
  let mutations = 0;
  await mockApi(page, buildDb(), () => {
    mutations += 1;
  });
  await gotoAuthed(page, '/history');
  const rows = page.locator('tbody tr');
  // First page already holds a1 (approved) + a2 (returned).
  const row = rows.filter({ hasText: 'Возвращён' });
  await row.getByRole('link').click();
  await expect(page).toHaveURL(/\/review\/docA-1111\?version=1/);
  await expect(page.getByText('Историческая версия 1')).toBeVisible();
  // Stale IN_REVIEW v1 would be editable by itself: the historic lock
  // (disabled fieldset) forbids edit/approve/reject/send.
  await expect(page.locator('textarea[id$="-number"]')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Подтвердить' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Отклонить' })).toBeDisabled();
  expect(mutations).toBe(0);
  // Back to the current version: the lock is gone.
  await page.getByRole('button', { name: 'Перейти к актуальной версии' }).click();
  await expect(page).toHaveURL(/\/review\/docA-1111\?version=2/);
  await expect(page.getByText('Историческая версия 1')).toBeHidden();
  // Current v2 is APPROVED: read-only by design, values as plain text.
  await expect(page.getByText('A2-current', { exact: true })).toBeVisible();
});

test('rejected v1 after approve v2: reason shown, original honestly missing', async ({
  page,
}) => {
  await mockApi(page, buildDb());
  await gotoAuthed(page, '/review/docC-3333?version=1');
  await expect(page.getByText('Историческая версия 1')).toBeVisible();
  await expect(page.getByText(/причина: Плохое фото/)).toBeVisible();
  // Originals were cleaned after reject: honest notice, never v2's file.
  await expect(page.getByText('Оригиналы недоступны.')).toBeVisible();
  // RETURNED versions are read-only: value as plain text, not an input.
  await expect(page.getByText('C1-rejected', { exact: true })).toBeVisible();
});

test('legacy history row without version falls back to current with notice', async ({
  page,
}) => {
  await mockApi(page, buildDb());
  await gotoAuthed(page, '/history');
  // Object labels truncate the id (first 8 chars + …): 'docB-222'.
  await page.getByRole('button', { name: 'Показать ещё' }).click();
  const row = page.locator('tbody tr').filter({ hasText: 'docB-222' });
  await row.getByRole('link').click();
  await expect(page).toHaveURL(/\/review\/docB-2222$/);
  expect(page.url()).not.toContain('version=');
  await expect(page.getByText('Точная версия неизвестна')).toBeVisible();
  // Current version stays actionable.
  await expect(page.locator('textarea[id$="-number"]')).toHaveValue('B1-current');
  await expect(page.getByRole('button', { name: 'Подтвердить' })).toBeEnabled();
});

test('missing version reports honestly instead of substituting current', async ({
  page,
}) => {
  await mockApi(page, buildDb());
  await gotoAuthed(page, '/review/docB-2222?version=9');
  await expect(page.getByText('Не удалось загрузить документ.')).toBeVisible();
  await expect(page.getByText('Запрошенная версия 9 недоступна')).toBeVisible();
});

test('without the base read right rows stay visible but not clickable', async ({
  page,
}) => {
  await mockApi(page, buildDb(NO_READ_ME));
  await gotoAuthed(page, '/history');
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toContainText('Подтверждён');
  await expect(page.locator('tbody tr a')).toHaveCount(0);
  await expect(page.getByTitle('Нет доступа к содержимому').first()).toBeVisible();
});
