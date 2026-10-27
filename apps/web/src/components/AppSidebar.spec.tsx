import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeResponseDto } from "@edo/api-client";
import { AppSidebar } from "./AppSidebar";

describe("review navigation permissions", () => {
  it.each([false, true])(
    "shows only the allowed review queue (collapsed=%s)",
    (collapsed) => {
      const render = (permissions: Record<string, unknown>) =>
        renderToStaticMarkup(
          <AppSidebar
            collapsed={collapsed}
            active="/review-ig"
            onToggle={() => {}}
            onNavigate={() => {}}
            profile={{ permissions } as unknown as MeResponseDto}
          />,
        );
      const ru = render({ "20002": [] });
      expect(ru).toContain("Проверка документов РУ");
      expect(ru).not.toContain("Проверка документов ИГ");
      const ig = render({ "20011": [] });
      expect(ig).toContain("Проверка документов ИГ");
      expect(ig).not.toContain("Проверка документов РУ");
      const all = render({ "20009": [] });
      expect(all).toContain("Проверка документов РУ");
      expect(all).toContain("Проверка документов ИГ");
      const neither = render({ "20000": [] });
      expect(neither).not.toContain("Проверка документов РУ");
      expect(neither).not.toContain("Проверка документов ИГ");
    },
  );
});

it.each([false, true])(
  "hides inaccessible and unfinished sections from reviewers (collapsed=%s)",
  (collapsed) => {
    const html = renderToStaticMarkup(
      <AppSidebar
        collapsed={collapsed}
        active="/"
        onToggle={() => {}}
        onNavigate={() => {}}
        profile={
          {
            permissions: { "20000": [], "20002": [] },
          } as unknown as MeResponseDto
        }
      />,
    );
    expect(html).toContain("Дашборд");
    expect(html).toContain("История");
    for (const title of [
      "Мои задачи",
      "Работники",
      "Оформление",
      "Подписание",
      "Участники",
      "Настройки",
    ])
      expect(html).not.toContain(collapsed ? `title="${title}"` : `>${title}<`);
  },
);
