import { readFileSync } from "node:fs";
import { test, expect, gotoAuthed, type Page } from "./fixture";
import type {
  DocumentDto,
  DocumentFieldDto,
  DocumentVersionDto,
} from "@edo/api-client";

// Render real image/PDF assets; API fixtures keep smoke checks away from shared data.
function twoPagePdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 560] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 560 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...["Document page 1", "Document page 2"].map((text) => {
      const content = `BT /F1 20 Tf 40 300 Td (${text}) Tj ET`;
      return `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    }),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function field(
  name: string,
  required = true,
  fileId = "photo-1",
  pageNumber = 1,
): DocumentFieldDto {
  return {
    name,
    label: name === "number" ? "Номер" : `Поле ${name}`,
    kind: "text",
    required,
    value: "4501 123456",
    originalValue: "4501 123456",
    submittedValue: "4501 999999",
    editedBy: null,
    mismatch: true,
    regions: [
      {
        id: `region-${name}`,
        fileId,
        fileOrdinal: fileId === "photo-2" ? 1 : 0,
        pageNumber,
        x: 0.3,
        y: 0.35,
        width: 0.3,
        height: 0.06,
        text: "4501 123456",
      },
    ],
  };
}

async function reviewFixture(
  page: Page,
  mode: "photos" | "pdf" | "few" = "photos",
) {
  const doc: DocumentDto = {
    id: "compact-review",
    title: "Паспорт гражданина РФ",
    documentTypeCode: "PASSPORT",
    documentUid: "passport-uid",
    status: "IN_REVIEW",
    currentVersion: 1,
    revision: 0,
    candidateId: "candidate",
    chatUuid: "candidate-chat",
    code1c: null,
    deliveryStatus: null,
    pendingDeliveryVersions: [],
  };
  const pdf = mode === "pdf";
  let version: DocumentVersionDto = {
    documentId: doc.id,
    version: 1,
    revision: 0,
    status: "IN_REVIEW",
    ocrSource: "EXTERNAL",
    raw: null,
    issues: [],
    job: null,
    approvedAt: null,
    approvedBy: null,
    rejectionReason: null,
    delivery: null,
    files: pdf
      ? [
          {
            id: "pdf",
            ordinal: 0,
            filename: "passport.pdf",
            mimeType: "application/pdf",
            sizeBytes: 1000,
            pageCount: 2,
            deleted: false,
          },
        ]
      : [1, 2].map((n) => ({
          id: `photo-${n}`,
          ordinal: n - 1,
          filename: `passport-${n}.png`,
          mimeType: "image/png",
          sizeBytes: 1000,
          pageCount: 1,
          deleted: false,
        })),
    fields: [
      field("number", true, pdf ? "pdf" : "photo-1"),
      field("issuer", true, pdf ? "pdf" : "photo-2", pdf ? 2 : 1),
      ...(mode === "few"
        ? []
        : Array.from({ length: 22 }, (_, i) => ({
            ...field(`required${i}`, true, pdf ? "pdf" : "photo-1"),
            regions: [],
            submittedValue: "4501 123456",
            mismatch: false,
          }))),
      field("internalOptional", false, pdf ? "pdf" : "photo-1"),
    ],
  };
  const mutations: { action: string; body: Record<string, unknown> }[] = [];
  const image = readFileSync(
    new URL("../../../docs/examples/passport-main.svg", import.meta.url),
  );
  await page.route("**/review-smoke-assets/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: pdf ? "application/pdf" : "image/svg+xml",
      body: pdf ? twoPagePdf() : image,
    }),
  );
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let response: unknown = {};
    if (path === "/api/v1/me")
      response = {
        uuid: "operator",
        code1c: "001",
        fullName: "Проверяющий",
        permissions: { "20000": [], "20002": [], "20009": [] },
        locationScope: { all: true, locationIds: [] },
      };
    else if (path.endsWith("document-status-events"))
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": heartbeat\n\n",
      });
    else if (path.endsWith("/download"))
      response = {
        url: `${new URL(request.url()).origin}/review-smoke-assets/${pdf ? "pages.pdf" : "photo.svg"}`,
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
    else if (path.endsWith("/fields")) {
      const body = request.postDataJSON();
      mutations.push({ action: "save", body });
      version = {
        ...version,
        revision: version.revision + 1,
        fields: version.fields.map((f) =>
          Object.hasOwn(body.fields, f.name)
            ? { ...f, value: body.fields[f.name], editedBy: "operator" }
            : f,
        ),
      };
      response = version;
    } else if (path.endsWith("/approve") || path.endsWith("/reject")) {
      const action = path.endsWith("/approve") ? "approve" : "reject";
      const body = request.postDataJSON();
      mutations.push({ action, body });
      version = {
        ...version,
        revision: version.revision + 1,
        status: action === "approve" ? "APPROVED" : "RETURNED",
        rejectionReason: action === "reject" ? body.reason : null,
      };
      doc.status = version.status;
      response = version;
    } else if (path.endsWith("/versions/1")) response = version;
    else if (path === "/api/v1/documents/compact-review") response = doc;
    else if (path === "/api/v1/review-documents")
      response = { items: [doc], nextCursor: null };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
  await gotoAuthed(page, "/review/compact-review?version=1");
  await expect(page.locator('[data-field-row="number"]')).toBeVisible();
  return mutations;
}

test("dense passport: required fields, two photos, transformed OCR, sticky save and approve", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const mutations = await reviewFixture(page);
  await expect(page.locator("[data-field-row]")).toHaveCount(24);
  await expect(page.locator('[data-field-row="internalOptional"]')).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /internalOptional\. OCR:/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("img", { name: /Загруженная страница/ }),
  ).toBeVisible();
  const zoom = page.getByRole("combobox", { name: /Масштаб/ });
  for (const percentage of ["0.5", "0.75"]) {
    await zoom.selectOption(percentage);
    await expect(zoom).toHaveValue(percentage);
  }
  await page.getByRole("button", { name: /Повернуть вправо/ }).click();
  await page.getByRole("button", { name: /^number\. OCR:/ }).click();
  await expect(page.locator('textarea[id$="-number"]')).toBeFocused();
  await page.getByRole("checkbox", { name: "Области OCR" }).uncheck();
  await expect(
    page.getByRole("button", { name: /^number\. OCR:/ }),
  ).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Области OCR" }).check();
  await page.getByRole("button", { name: /Повернуть влево/ }).click();
  await page.getByRole("button", { name: /Файл 2/ }).click();
  await expect(page.getByText("passport-2.png", { exact: true })).toBeVisible();
  const fields = page.locator('[data-field-row="required21"]');
  await fields.scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Сохранить исправления" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Подтвердить документ" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Отклонить документ", exact: true }),
  ).toBeInViewport();
  await page.locator('textarea[id$="-number"]').fill("4501 654321");
  await expect(
    page.getByRole("button", { name: "Подтвердить документ" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Сохранить исправления" }).click();
  await expect(page.getByText(/Исправления сохранены/)).toBeVisible();
  expect(mutations[0]).toEqual({
    action: "save",
    body: { revision: 0, fields: { number: "4501 654321" } },
  });
  await page.screenshot({
    path: "../../.cache/review-ui/desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Подтвердить документ" }).click();
  await expect(page.getByText("Документ подтверждён вами.")).toBeVisible();
  expect(mutations.at(-1)?.action).toBe("approve");
});

test("two-page PDF keeps OCR selectable after zoom and rotation on either page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await reviewFixture(page, "pdf");
  await expect(page.getByRole("img", { name: "Страница 1 PDF" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^number\. OCR:/ }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: /Масштаб/ }).selectOption("0.5");
  await page.getByRole("button", { name: /Повернуть влево/ }).click();
  await page.getByRole("button", { name: /^number\. OCR:/ }).click();
  await expect(page.locator('textarea[id$="-number"]')).toBeFocused();
  await page.getByRole("button", { name: /Далее|Следующая страница/ }).click();
  await expect(page.getByRole("img", { name: "Страница 2 PDF" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^issuer\. OCR:/ }),
  ).toBeVisible();
  await page.getByRole("combobox", { name: /Масштаб/ }).selectOption("0.75");
  await page.getByRole("button", { name: /Повернуть вправо/ }).click();
  await page.getByRole("button", { name: /^issuer\. OCR:/ }).click();
  await expect(page.locator('textarea[id$="-issuer"]')).toBeFocused();
  await page.screenshot({
    path: "../../.cache/review-ui/pdf.png",
    fullPage: true,
  });
});

test("few required fields on mobile: compact form and rejection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const mutations = await reviewFixture(page, "few");
  await expect(page.locator("[data-field-row]")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Отклонить документ", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: /Причина/ })
    .fill("Документ обрезан, приложите полное фото");
  await page.screenshot({
    path: "../../.cache/review-ui/mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /Вернуть кандидату/ }).click();
  await expect(page.getByText("Документ возвращён кандидату.")).toBeVisible();
  expect(mutations.at(-1)?.action).toBe("reject");
});
