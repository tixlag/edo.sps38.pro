import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { SigningPage } from "./SigningPage";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("демонстрация подписания", () => {
  it("проводит сотрудника через экраны и меняет статус только после выбора банка", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const click = (label: string) => {
      const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(label) || item.getAttribute("aria-label") === label);
      expect(button, label).toBeDefined();
      act(() => button!.click());
    };
    act(() => root.render(<SigningPage />));
    click("Сотрудник");
    expect(container.textContent).toContain("Вам поступил трудовой договор");
    click("Мои документы");
    click("Трудовой договор");
    click("Подписать");
    expect(container.textContent).toContain("Подтвердите личность");
    click("Назад");
    expect(container.textContent).toContain("Подписать");
    click("Подписать");
    click("Сбер ID");
    expect(container.textContent).toContain("успешно подписан");
    click("Перейти к документу");
    expect(container.textContent).toContain("Подписан");
    click("Кадровик");
    expect(container.textContent).toContain("Подписан");
    act(() => root.unmount());
    container.remove();
  });
});
