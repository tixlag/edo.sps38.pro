import { test, expect, gotoAuthed, type Page } from "./fixture";
import type { CandidateProfileDto, DocumentDto } from "@edo/api-client";

function profile(
  id: string,
  rest: Partial<CandidateProfileDto>,
): CandidateProfileDto {
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
    approvedDocuments: 0,
    requiredDocuments: null,
    ...rest,
  };
}

const IVANOV = profile("cand-ivanov", {
  fullName: "Иванов Иван Иванович",
  birthDate: "1990-05-17",
  citizenship: "ru",
  positionCode: "POS1",
  positionName: "Продавец",
  projectCode: "PRJ1",
  projectName: "ТЦ Север",
  managerName: "Петров Пётр",
  managerCode1c: "M001",
  mentorName: "Сидоров Сидор",
  mentorPosition: "Наставник",
  mentorCode1c: "N001",
  isReemployment: true,
  approvedDocuments: 3,
  requiredDocuments: 5,
});

const DOCS: DocumentDto[] = [
  {
    id: "doc-pass-ivanov",
    title: "Паспорт",
    documentTypeCode: "PASSPORT",
    documentUid: "uid-1",
    status: "IN_REVIEW",
    currentVersion: 2,
    revision: 0,
    candidateId: "cand-ivanov",
    chatUuid: "chat-ivanov",
    code1c: null,
    deliveryStatus: null,
    pendingDeliveryVersions: [],
    // One candidate row on the backend: every document of Ivanov carries
    // the same profile snapshot, so candidate filters hit all of them.
    candidate: IVANOV,
  },
  {
    id: "doc-snils-ivanov",
    title: "СНИЛС",
    documentTypeCode: "SNILS",
    documentUid: "uid-2",
    status: "IN_REVIEW",
    currentVersion: 1,
    revision: 0,
    candidateId: "cand-ivanov",
    chatUuid: "chat-ivanov",
    code1c: null,
    deliveryStatus: null,
    pendingDeliveryVersions: [],
    candidate: IVANOV,
  },
  {
    id: "doc-pass-anna",
    title: "Паспорт",
    documentTypeCode: "PASSPORT",
    documentUid: "uid-3",
    status: "IN_REVIEW",
    currentVersion: 1,
    revision: 0,
    candidateId: "cand-anna",
    chatUuid: "chat-anna",
    code1c: null,
    deliveryStatus: null,
    pendingDeliveryVersions: [],
    candidate: profile("cand-anna", {
      fullName: "Аннова Анна",
      birthDate: "1995-11-02",
      citizenship: "kz",
      managerName: "Без кода",
      mentorName: null,
      approvedDocuments: 1,
      requiredDocuments: null,
    }),
  },
];

const ALL_IVANOV_DOCS: DocumentDto[] = [
  ...DOCS.filter((doc) => doc.candidateId === IVANOV.id),
  {
    ...DOCS[0],
    id: "doc-approved",
    title: "ИНН",
    status: "APPROVED",
    currentVersion: 3,
  },
];

function candidateGroup(
  candidate: CandidateProfileDto,
  documents: DocumentDto[],
) {
  return {
    candidate,
    documents: documents.map(
      ({
        candidate: _candidate,
        candidateId: _id,
        chatUuid: _chat,
        code1c: _code,
        ...document
      }) => document,
    ),
  };
}

async function mockQueue(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let response: unknown = {};
    if (path === "/api/v1/me")
      response = {
        uuid: "operator",
        code1c: "001",
        fullName: "Проверяющий",
        permissions: { "20000": [], "20002": [], "20009": [] },
        locationScope: { all: true, locationIds: [] },
      };
    else if (path === "/api/v1/document-types") {
      expect(url.searchParams.get("catalogOnly")).toBe("true");
      response = {
        items: [
          { code: "PASSPORT", title: "Паспорт" },
          { code: "SNILS", title: "СНИЛС" },
        ],
      };
    } else if (path === "/api/v1/positions") {
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      response = {
        items: [
          { code: "POS1", name: "Продавец" },
          { code: "POS2", name: "Водитель" },
        ].filter((p) => p.name.toLowerCase().includes(q)),
      };
    } else if (path === "/api/v1/review-documents/facets") {
      response = {
        managers: [{ code1c: "M001", name: "Петров Пётр" }],
        mentors: [{ code1c: "N001", name: "Сидоров Сидор" }],
        projects: [{ code: "PRJ1", name: "ТЦ Север" }],
        citizenships: ["KZ", "RU"],
      };
    } else if (path === "/api/v1/review-candidates") {
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      response = {
        items: [IVANOV, DOCS[2].candidate!]
          .filter((c) => c.fullName?.toLowerCase().includes(q))
          .map(({ id, fullName }) => ({ id, fullName })),
      };
    } else if (path === "/api/v1/candidate-review-queue") {
      const items = DOCS.filter((d) => {
        const c = d.candidate!;
        for (const field of ["candidateId", "documentTypeCode"] as const) {
          const filter = url.searchParams.get(field);
          if (filter && d[field] !== filter) return false;
        }
        for (const field of [
          "managerCode1c",
          "mentorCode1c",
          "positionCode",
          "projectCode",
        ] as const) {
          const filter = url.searchParams.get(field);
          if (filter && c[field] !== filter) return false;
        }
        const citizenship = url.searchParams.get("citizenship");
        if (citizenship && c.citizenship?.toUpperCase() !== citizenship)
          return false;
        const hasMentor = url.searchParams.get("hasMentor");
        if (hasMentor === "true" && !c.mentorName) return false;
        if (hasMentor === "false" && c.mentorName) return false;
        return true;
      });
      response = {
        items: [DOCS[2].candidate!, IVANOV]
          .map((candidate) =>
            candidateGroup(
              candidate,
              items.filter((d) => d.candidateId === candidate.id),
            ),
          )
          .filter((group) => group.documents.length > 0),
        nextCursor: null,
      };
    } else if (path === "/api/v1/candidates/cand-ivanov") {
      response = candidateGroup(IVANOV, ALL_IVANOV_DOCS);
    } else if (path === "/api/v1/candidates/cand-anna") {
      response = candidateGroup(DOCS[2].candidate!, [DOCS[2]]);
    } else if (/\/documents\/[^/]+\/versions\//.test(path)) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: "{}",
      });
    } else if (path.startsWith("/api/v1/documents/")) {
      response = ALL_IVANOV_DOCS.find((d) => path.endsWith(d.id)) ?? DOCS[0];
    } else if (path.endsWith("document-status-events"))
      return route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": heartbeat\n\n",
      });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
}

const ivanovRow = (page: Page) =>
  page.getByRole("region", { name: IVANOV.fullName as string });
const openIvanov = (page: Page) =>
  ivanovRow(page)
    .getByRole("button", { name: /Открыть документы/ })
    .click();

async function selectOption(
  page: Page,
  label: string,
  query: string,
  option: string,
) {
  const input = page.getByRole("combobox", { name: label, exact: true });
  await input.fill(query);
  await page.getByRole("option", { name: option, exact: true }).click();
}

test("queue shows candidate profiles and separate LK links without inline documents", async ({
  page,
}) => {
  await mockQueue(page);
  await gotoAuthed(page, "/review");
  const groups = page.locator("section[aria-label]");
  await expect(groups).toHaveCount(2);
  await expect(groups.first()).toContainText("Аннова Анна");
  const ivanov = ivanovRow(page);
  await expect(ivanov).toContainText("17.05.1990");
  await expect(ivanov).toContainText("Продавец");
  await expect(ivanov).not.toContainText("POS1");
  await expect(ivanov).toContainText("Объект: ТЦ Север (PRJ1)");
  await expect(ivanov).toContainText("Подтверждено 3 из 5");
  await expect(ivanov.getByText("Повторный найм")).toBeVisible();
  await expect(ivanov.getByRole("progressbar")).toHaveAttribute(
    "aria-valuenow",
    "60",
  );
  await expect(ivanov.getByText("Паспорт", { exact: true })).toHaveCount(0);
  await expect(ivanov.locator("button a")).toHaveCount(0);
  const manager = ivanov.getByRole("link", { name: "Петров Пётр" });
  await expect(manager).toHaveAttribute(
    "href",
    "https://lk.sps38.pro/public/employee/M001?size_width=WIDE_1200",
  );
  await expect(manager).toHaveAttribute("target", "_blank");
  await expect(
    ivanov.getByRole("link", { name: /Сидоров Сидор/ }),
  ).toHaveAttribute(
    "href",
    "https://lk.sps38.pro/public/employee/N001?size_width=WIDE_1200",
  );
  await expect(groups.first()).toContainText("Без кода");
  await expect(groups.first()).toContainText("Наставник: —");
  await expect(groups.first()).toContainText(
    "Подтверждено 1 · всего ожидается: неизвестно (нет должности)",
  );
  await expect(groups.first().getByRole("progressbar")).toHaveCount(0);
});

test("candidate selector searches remotely and commits only the exact id to the URL", async ({
  page,
}) => {
  await mockQueue(page);
  await gotoAuthed(page, "/review");
  const input = page.getByRole("combobox", { name: "ФИО кандидата" });
  const search = page.waitForRequest(
    (req) =>
      new URL(req.url()).pathname === "/api/v1/review-candidates" &&
      new URL(req.url()).searchParams.get("q") === "иван",
  );
  await input.fill("иван");
  await expect.poll(() => page.url()).not.toContain("candidateId=");
  await expect(page.locator("section[aria-label]")).toHaveCount(2);
  await search;
  await page.getByRole("option", { name: IVANOV.fullName as string }).click();
  await expect(page).toHaveURL(/candidateId=cand-ivanov/);
  await expect(page.locator("section[aria-label]")).toHaveCount(1);
  await expect(input).toHaveValue(IVANOV.fullName as string);
  await page.reload();
  await expect(input).toHaveValue(IVANOV.fullName as string);
  await expect(page.locator("section[aria-label]")).toHaveCount(1);
  await page.getByRole("button", { name: "Очистить: ФИО кандидата" }).click();
  await expect(page.locator("section[aria-label]")).toHaveCount(2);
});

test("all searchable selectors send exact filters and can be reset", async ({
  page,
}) => {
  await mockQueue(page);
  await gotoAuthed(page, "/review?cursor=old");
  for (const [label, query, option, field, code] of [
    ["Должность", "Продав", "Продавец", "positionCode", "POS1"],
    ["Менеджер", "Петров", "Петров Пётр", "managerCode1c", "M001"],
    ["Наставник", "Сидоров", "Сидоров Сидор", "mentorCode1c", "N001"],
    ["Объект", "Север", "ТЦ Север", "projectCode", "PRJ1"],
    ["Гражданство", "RU", "RU", "citizenship", "RU"],
    ["Тип документа", "СНИЛС", "СНИЛС", "documentTypeCode", "SNILS"],
  ]) {
    await selectOption(page, label, query, option);
    await expect
      .poll(() => new URL(page.url()).searchParams.get(field))
      .toBe(code);
    expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
    await expect(
      page.getByRole("combobox", { name: label, exact: true }),
    ).toHaveValue(option);
  }
  await expect(page.locator("section[aria-label]")).toHaveCount(1);
  await page.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(page.locator("section[aria-label]")).toHaveCount(2);
  expect(new URL(page.url()).search).toBe("");
  await page.getByLabel("Наличие наставника").selectOption("false");
  await expect(page.locator("section[aria-label]")).toHaveCount(1);
  await expect(page.getByRole("region", { name: "Аннова Анна" })).toBeVisible();
});

test("drawer shows all documents, traps focus, closes with Escape and restores focus", async ({
  page,
}) => {
  await mockQueue(page);
  await gotoAuthed(page, "/review?positionCode=POS1");
  await openIvanov(page);
  const drawer = page.getByRole("dialog", { name: IVANOV.fullName as string });
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/candidate=cand-ivanov/);
  await expect(
    drawer.getByText("Документы (3)", { exact: true }),
  ).toBeVisible();
  await expect(drawer.getByText("ИНН", { exact: true })).toBeVisible();
  await expect(
    drawer.getByText("Документ принят", { exact: true }),
  ).toBeVisible();
  await expect(
    drawer.getByRole("button", { name: "Закрыть профиль кандидата" }),
  ).toBeFocused();
  for (let i = 0; i < 10; i++) await page.keyboard.press("Tab");
  expect(
    await drawer.evaluate((el) => el.contains(document.activeElement)),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(
    ivanovRow(page).getByRole("button", { name: /Открыть документы/ }),
  ).toBeFocused();
  expect(new URL(page.url()).searchParams.get("positionCode")).toBe("POS1");
});

test("drawer URL supports reload, back/forward and navigation to a document version", async ({
  page,
}) => {
  await mockQueue(page);
  await gotoAuthed(page, "/review");
  await openIvanov(page);
  await page.goBack();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: IVANOV.fullName as string }),
  ).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Паспорт, версия 2" })
    .click();
  await expect(page).toHaveURL(/\/review\/doc-pass-ivanov\?version=2/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("direct drawer link resolves profile outside the current queue and closes on backdrop", async ({
  page,
}) => {
  await mockQueue(page);
  await gotoAuthed(page, "/review?hasMentor=false&candidate=cand-ivanov");
  await expect(page.getByRole("region", { name: "Аннова Анна" })).toBeVisible();
  const drawer = page.getByRole("dialog", { name: IVANOV.fullName as string });
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("Подтверждено 3 из 5");
  await page.mouse.click(20, 150);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("hasMentor")).toBe("false");
});

test("drawer handles document errors with retry and an empty document list", async ({
  page,
}) => {
  await mockQueue(page);
  let failed = true;
  await page.route("**/api/v1/candidates/cand-ivanov", (route) =>
    route.fulfill({
      status: failed ? 403 : 200,
      contentType: "application/json",
      body: JSON.stringify(failed ? {} : candidateGroup(IVANOV, [])),
    }),
  );
  await gotoAuthed(page, "/review?candidate=cand-ivanov");
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("alert")).toContainText(
    "Не удалось загрузить документы.",
  );
  failed = false;
  await drawer.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(drawer).toContainText("У кандидата нет документов.");
});

test("mobile drawer fills the screen without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockQueue(page);
  await gotoAuthed(page, "/review?candidate=cand-ivanov");
  const drawer = page.getByRole("dialog", { name: IVANOV.fullName as string });
  await expect(drawer).toBeVisible();
  const box = await drawer.locator(".candidate-drawer-panel").boundingBox();
  expect(box?.width).toBeCloseTo(390, 1);
  expect(box?.height).toBeCloseTo(844, 1);
  await expect
    .poll(() => drawer.evaluate((el) => el.scrollWidth <= el.clientWidth))
    .toBe(true);
  await drawer
    .getByRole("button", { name: "Закрыть профиль кандидата" })
    .click();
  await expect(drawer).toHaveCount(0);
});

test("candidate pagination keeps all matching documents together and supports browser history", async ({
  page,
}) => {
  await mockQueue(page);
  const anna = DOCS[2].candidate!;
  const documents = Array.from({ length: 61 }, (_, index) => ({
    ...DOCS[2],
    id: `anna-document-${index}`,
  }));
  await page.route("**/api/v1/candidate-review-queue?*", async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    await route.fulfill({
      json: cursor
        ? { items: [candidateGroup(IVANOV, ALL_IVANOV_DOCS)], nextCursor: null }
        : { items: [candidateGroup(anna, documents)], nextCursor: anna.id },
    });
  });
  await gotoAuthed(page, "/review");
  await expect(page.getByRole("region", { name: "Аннова Анна" })).toContainText(
    "документов: 61",
  );
  await expect(page.locator("section[aria-label]")).toHaveCount(1);
  await page.getByRole("button", { name: "Следующая страница" }).click();
  await expect(page).toHaveURL(/cursor=cand-anna/);
  await expect(ivanovRow(page)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Следующая страница" }),
  ).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole("region", { name: "Аннова Анна" })).toContainText(
    "документов: 61",
  );
  await page.goForward();
  await expect(ivanovRow(page)).toBeVisible();
  await page.getByRole("button", { name: "В начало списка" }).click();
  await expect(page.getByRole("region", { name: "Аннова Анна" })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
});
