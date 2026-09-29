import { test, expect } from './fixture';
import { gotoAuthed } from './fixture';

// Requires API on :3001 (seeded, JWT_SECRET = EDO_E2E_JWT_SECRET) + web dev
// server on :5173 with VITE_ALLOW_INSECURE_DEV_AUTH=true.
// Auth: real HS256 JWT via window.__EDO_DEV_TOKEN (dev-only hook).
// Run: EDO_E2E_JWT_SECRET=... pnpm --filter @edo/web test:e2e
test('dashboard renders Pencil blocks from generated hooks', async ({ page }) => {
  await gotoAuthed(page, '/');
  await expect(page.getByRole('heading', { name: 'Дашборд' })).toBeVisible();
  await expect(page.getByText('Очередь проверки')).toBeVisible();
  await expect(page.getByText('Оформлено за неделю')).toBeVisible();
  await expect(page.getByText('Работники по этапам')).toBeVisible();
  await expect(page.getByText('Последние действия')).toBeVisible();
});

test('employees list loads via generated hook', async ({ page }) => {
  await gotoAuthed(page, '/employees');
  await expect(page.getByRole('heading', { name: 'Работники' })).toBeVisible();
  await expect(page.getByText('Каримов Азиз Шарифович')).toBeVisible();
});

test('employee deep link renders via router', async ({ page }) => {
  await gotoAuthed(page, '/employees/emp-karimov');
  await expect(page.getByRole('heading', { name: 'Каримов Азиз Шарифович' })).toBeVisible();
});

test('sidebar expands and collapses', async ({ page }) => {
  await gotoAuthed(page, '/');
  await page.getByRole('button', { name: 'Развернуть меню' }).click();
  await expect(page.getByText('Оформление сотрудников', { exact: true })).toBeVisible();
  await expect(page.getByText('Проверка документов')).toBeVisible();
  await page.getByRole('button', { name: 'Свернуть меню' }).click();
  await expect(page.getByText('Проверка документов')).toBeHidden();
});
