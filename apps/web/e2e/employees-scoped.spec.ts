import { test, expect } from './fixture';
import { gotoAuthedWith, signE2EJwtWithRules } from './fixture';

// Requires API on :3001 (seeded incl. locationId, JWT_SECRET = EDO_E2E_JWT_SECRET)
// + web dev server on :5173 with VITE_ALLOW_INSECURE_DEV_AUTH=true.
// Seed objects: 98 -> Токтогулов, Каримов; 999 -> Осмонов, Холов; NULL -> Назаров.
// Backend scope: 20009/20008 -> all, 20007 -> listed ids, else denied;
// NULL-object rows are invisible to scoped users.

const SCOPED_98 = { '20000': [], '20007': ['98'] };
const BASE_ONLY = { '20000': [] };
const FULL = { '20009': [] };

test('scoped list shows only allowed object + scoped total', async ({ page }) => {
  await gotoAuthedWith(page, '/employees', signE2EJwtWithRules(SCOPED_98));
  await expect(page.getByRole('heading', { name: 'Работники' })).toBeVisible();
  await expect(page.getByText('Каримов Азиз Шарифович')).toBeVisible();
  await expect(page.getByText('Токтогулов Айбек Русланович')).toBeVisible();
  await expect(page.getByText('Осмонов Санжар Талантович')).toBeHidden();
  await expect(page.getByText('Холов Джамшед Фирузович')).toBeHidden();
  // NULL-object row is invisible to scoped users.
  await expect(page.getByText('Назаров Фаррух')).toBeHidden();
});

test('scoped card allows own object, denies foreign and NULL-object cards', async ({ page }) => {
  await gotoAuthedWith(page, '/employees/emp-karimov', signE2EJwtWithRules(SCOPED_98));
  await expect(page.getByRole('heading', { name: 'Каримов Азиз Шарифович' })).toBeVisible();

  await gotoAuthedWith(page, '/employees/emp-osmonov', signE2EJwtWithRules(SCOPED_98));
  await expect(page.getByText('Не удалось загрузить.')).toBeVisible();

  await gotoAuthedWith(page, '/employees/emp-nazarov', signE2EJwtWithRules(SCOPED_98));
  await expect(page.getByText('Не удалось загрузить.')).toBeVisible();
});

test('base access without scope sees an empty list (denied, not all)', async ({ page }) => {
  await gotoAuthedWith(page, '/employees', signE2EJwtWithRules(BASE_ONLY));
  await expect(page.getByRole('heading', { name: 'Работники' })).toBeVisible();
  await expect(page.getByText('Нет работников')).toBeVisible();
});

test('full access still sees everything including NULL-object rows', async ({ page }) => {
  await gotoAuthedWith(page, '/employees', signE2EJwtWithRules(FULL));
  await expect(page.getByText('Каримов Азиз Шарифович')).toBeVisible();
  await expect(page.getByText('Назаров Фаррух')).toBeVisible();
});
