import { test, expect, gotoAuthed, type Page } from './fixture';
import type { DocumentDto } from '@edo/api-client';

function profile(id: string, rest: Record<string, unknown>) {
  return {
    id,
    chatUuid: `chat-${id}`,
    code1c: null,
    fullName: null,
    birthDate: null,
    citizenship: null,
    positionCode: null,
    positionName: null,
    projectCode: null,
    projectName: null,
    managerName: null,
    managerCode1c: null,
    mentorName: null,
    mentorPosition: null,
    mentorCode1c: null,
    isReemployment: false,
    profileSyncedAt: null,
    ...rest,
  };
}

const IVANOV = profile('cand-ivanov', {
  fullName: 'Иванов Иван Иванович',
  birthDate: '1990-05-17',
  citizenship: 'ru',
  positionCode: 'POS1',
  positionName: 'Продавец',
  projectCode: 'PRJ1',
  projectName: 'ТЦ Север',
  managerName: 'Петров Пётр',
  managerCode1c: 'M001',
  mentorName: 'Сидоров Сидор',
  mentorPosition: 'Наставник',
  mentorCode1c: 'N001',
});

const DOCS: DocumentDto[] = [
  {
    id: 'doc-pass-ivanov',
    title: 'Паспорт',
    documentTypeCode: 'PASSPORT',
    documentUid: 'uid-1',
    status: 'IN_REVIEW',
    currentVersion: 2,
    revision: 0,
    candidateId: 'cand-ivanov',
    chatUuid: 'chat-ivanov',
    code1c: null,
    deliveryStatus: null,
    pendingDeliveryVersions: [],
    // One candidate row on the backend: every document of Ivanov carries
    // the same profile snapshot, so candidate filters hit all of them.
    candidate: IVANOV,
  },
  {
    id: 'doc-snils-ivanov',
    title: 'СНИЛС',
    documentTypeCode: 'SNILS',
    documentUid: 'uid-2',
    status: 'IN_REVIEW',
    currentVersion: 1,
    revision: 0,
    candidateId: 'cand-ivanov',
    chatUuid: 'chat-ivanov',
    code1c: null,
    deliveryStatus: null,
    pendingDeliveryVersions: [],
    candidate: IVANOV,
  },
  {
    id: 'doc-pass-anna',
    title: 'Паспорт',
    documentTypeCode: 'PASSPORT',
    documentUid: 'uid-3',
    status: 'IN_REVIEW',
    currentVersion: 1,
    revision: 0,
    candidateId: 'cand-anna',
    chatUuid: 'chat-anna',
    code1c: null,
    deliveryStatus: null,
    pendingDeliveryVersions: [],
    candidate: profile('cand-anna', {
      fullName: 'Аннова Анна',
      birthDate: '1995-11-02',
      citizenship: 'kz',
      managerName: 'Без кода',
      mentorName: null,
    }),
  },
];

async function mockQueue(page: Page) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let response: unknown = {};
    if (path === '/api/v1/me')
      response = {
        uuid: 'operator',
        code1c: '001',
        fullName: 'Проверяющий',
        permissions: { '20000': [], '20002': [], '20009': [] },
        locationScope: { all: true, locationIds: [] },
      };
    else if (path === '/api/v1/document-types')
      response = {
        items: [
          { code: 'PASSPORT', title: 'Паспорт' },
          { code: 'SNILS', title: 'СНИЛС' },
        ],
      };
    else if (path === '/api/v1/review-documents') {
      // Emulate server-side AND filtering like the backend does.
      const q = url.searchParams.get('q')?.toLowerCase();
      const documentTypeCode = url.searchParams.get('documentTypeCode');
      const hasMentor = url.searchParams.get('hasMentor');
      const items = DOCS.filter((d) => {
        const c = d.candidate;
        if (q && !(c?.fullName ?? '').toLowerCase().includes(q)) return false;
        if (documentTypeCode && d.documentTypeCode !== documentTypeCode) return false;
        if (hasMentor === 'true' && !c?.mentorName) return false;
        if (hasMentor === 'false' && c?.mentorName) return false;
        return true;
      });
      response = { items, nextCursor: null };
    } else if (path.endsWith('document-status-events'))
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: ': heartbeat\n\n',
      });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
}

test('review queue groups documents by candidate with LK links', async ({ page }) => {
  await mockQueue(page);
  await gotoAuthed(page, '/review');
  // Groups sorted by fullName (ru): Аннова before Иванов.
  const groups = page.locator('section[aria-label]');
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toContainText('Аннова Анна');
  await expect(groups.nth(1)).toContainText('Иванов Иван Иванович');
  // Ivanov group: two documents, RU badge, birth date, position, project.
  const ivanov = groups.nth(1);
  await expect(ivanov.getByRole('link', { name: 'Открыть →' })).toHaveCount(2);
  await expect(ivanov).toContainText('17.05.1990');
  await expect(ivanov).toContainText('Продавец (POS1)');
  await expect(ivanov).toContainText('ТЦ Север (PRJ1)');
  // Manager/mentor with a 1C code link to the LK profile; Anna's plain
  // manager name stays text, missing mentor renders as em dash.
  const managerLink = ivanov.getByRole('link', { name: 'Петров Пётр' });
  await expect(managerLink).toHaveAttribute(
    'href',
    'https://lk.sps38.pro/public/employee/M001?size_width=WIDE_1200',
  );
  await expect(managerLink).toHaveAttribute('target', '_blank');
  await expect(ivanov.getByRole('link', { name: /Сидоров Сидор/ })).toHaveAttribute(
    'href',
    'https://lk.sps38.pro/public/employee/N001?size_width=WIDE_1200',
  );
  await expect(groups.first()).toContainText('Без кода');
  await expect(groups.first()).toContainText('Наставник: —');
  // Document rows open the versioned review page.
  await ivanov.getByRole('link', { name: 'Открыть →' }).first().click();
  await expect(page).toHaveURL(/\/review\/doc-pass-ivanov\?version=2/);
});

test('review queue filters live in the URL and reset cleanly', async ({ page }) => {
  await mockQueue(page);
  await gotoAuthed(page, '/review');
  await expect(page.locator('section[aria-label]')).toHaveCount(2);
  // ФИО search narrows to one group and lands in the URL (deep-linkable).
  await page.getByLabel('Поиск по ФИО').fill('иванов');
  await expect(page.locator('section[aria-label]')).toHaveCount(1);
  await expect(page.url()).toContain('q=%D0%B8%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2');
  // Back/forward keeps the filter: reload the deep link directly.
  await page.reload();
  await expect(page.locator('section[aria-label]')).toHaveCount(1);
  await expect(page.getByLabel('Поиск по ФИО')).toHaveValue('иванов');
  // Tri-state mentor filter to "without mentor": empty state + reset.
  await page.getByLabel('Поиск по ФИО').fill('');
  await expect(page.locator('section[aria-label]')).toHaveCount(2);
  await page.getByLabel('Наличие наставника').selectOption('false');
  await expect(page.locator('section[aria-label]')).toHaveCount(1);
  await expect(page.getByText('Аннова Анна')).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await expect(page.locator('section[aria-label]')).toHaveCount(2);
  expect(page.url()).not.toContain('hasMentor');
  // Type select filters server-side too.
  await page.getByLabel('Тип документа').selectOption('SNILS');
  await expect(page.locator('section[aria-label]')).toHaveCount(1);
  await expect(page.getByText('Иванов Иван Иванович')).toBeVisible();
});

test('review queue accordion collapses locally without losing filters', async ({
  page,
}) => {
  await mockQueue(page);
  await gotoAuthed(page, '/review?q=%D0%B8%D0%B2%D0%B0%D0%BD%D0%BE%D0%B2');
  const group = page.locator('section[aria-label]').first();
  await expect(group.getByRole('link', { name: 'Открыть →' })).toHaveCount(2);
  await group.getByRole('button', { expanded: true }).click();
  await expect(group.getByRole('link', { name: 'Открыть →' })).toHaveCount(0);
  // Collapsing is local UI state: the URL filter is untouched.
  expect(page.url()).toContain('q=');
  await group.getByRole('button', { expanded: false }).click();
  await expect(group.getByRole('link', { name: 'Открыть →' })).toHaveCount(2);
});
