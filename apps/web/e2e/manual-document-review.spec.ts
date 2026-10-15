import { test, expect, gotoAuthed } from './fixture';
import type { DocumentDto, DocumentVersionDto } from '@edo/api-client';

// Browser contract fixtures; server mutations are covered by isolated API tests.
for (const width of [1440, 390]) {
  test(`manual document review and ERP retry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const doc: DocumentDto = { id: 'manual-doc', documentTypeCode: 'PASSPORT', title: 'Паспорт', documentUid: 'passport-uuid', status: 'IN_REVIEW', currentVersion: 1, revision: 0, candidateId: 'candidate', chatUuid: 'candidate-chat', code1c: null, deliveryStatus: null, pendingDeliveryVersions: [], candidate: null };
    let version: DocumentVersionDto = { documentId: doc.id, version: 1, status: 'IN_REVIEW', revision: 0, ocrSource: null, raw: null, files: [], fields: [{ name: 'number', label: 'Номер', kind: 'text', required: true, value: '000123', submittedValue: '000123', originalValue: null, editedBy: null, mismatch: false, regions: [] }, { name: 'isInvalid', label: 'Недействителен', kind: 'boolean', required: false, value: 'false', submittedValue: 'false', originalValue: null, editedBy: null, mismatch: false, regions: [] }], issues: [], job: null, approvedAt: null, approvedBy: null, rejectionReason: null, delivery: null };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let response: unknown;
      if (path === '/api/v1/me') response = { uuid: 'operator', code1c: '001', fullName: 'Проверяющий', permissions: { '20000': [], '20002': [], '20006': [], '20009': [] }, locationScope: { all: true, locationIds: [] } };
      else if (path.endsWith('document-status-events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': heartbeat\n\n' });
      else if (path === '/api/v1/review-documents') response = { items: [doc], nextCursor: null };
      else if (path === '/api/v1/documents/manual-doc') response = doc;
      else if (path.endsWith('/approve')) {
        version = { ...version, status: 'APPROVED', revision: 1, approvedAt: new Date().toISOString(), approvedBy: 'operator', delivery: { status: 'REQUIRES_MANUAL', errorCode: 'ERP_HTTP_503', attempts: [] } };
        doc.status = 'APPROVED'; doc.revision = 1; doc.pendingDeliveryVersions = [1]; response = version;
      } else if (path.endsWith('/send-to-erp')) { version = { ...version, delivery: { status: 'SENT', errorCode: null, attempts: [] } }; response = version; }
      else if (path === '/api/v1/documents/manual-doc/versions/1') response = version;
      else response = {};
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) });
    });
    await gotoAuthed(page, '/review');
    await expect(page.getByText('Ожидает проверки', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Открыть →' }).click();
    await expect(page.locator('textarea[id$="-number"]')).toHaveValue('000123');
    await expect(page.locator('[data-field-row="isInvalid"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Подтвердить документ' })).toBeVisible();
    await page.screenshot({ path: `../../.cache/manual-review-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Подтвердить документ' }).click();
    await expect(page.getByText('Требует отправки в ERP', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Отправить в ERP', exact: true }).click();
    await expect(page.getByText('Документ отправлен в ERP', { exact: true })).toBeVisible();
  });
}
