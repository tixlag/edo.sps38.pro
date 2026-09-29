import { test, expect } from '@playwright/test';

// Requires API on :3001 (seeded) + web dev server on :5173.
// Run: pnpm --filter @edo/web test:e2e
test('dashboard renders Pencil blocks from generated hooks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Дашборд' })).toBeVisible();
  await expect(page.getByText('Очередь проверки')).toBeVisible();
  await expect(page.getByText('Оформлено за неделю')).toBeVisible();
  await expect(page.getByText('Работники по этапам')).toBeVisible();
  await expect(page.getByText('Последние действия')).toBeVisible();
});

test('employees list loads via generated hook', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Работники' }).first().click();
  await expect(page.getByRole('heading', { name: 'Работники' })).toBeVisible();
  await expect(page.getByText('Каримов Азиз Шарифович')).toBeVisible();
});

test('sidebar expands and collapses', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Развернуть меню' }).click();
  await expect(page.getByText('Оформление сотрудников', { exact: true })).toBeVisible();
  await expect(page.getByText('Проверка документов')).toBeVisible();
  await page.getByRole('button', { name: 'Свернуть меню' }).click();
  await expect(page.getByText('Проверка документов')).toBeHidden();
});
