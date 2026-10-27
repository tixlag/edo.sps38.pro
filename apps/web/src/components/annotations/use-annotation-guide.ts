import { useEffect, type RefObject } from "react";
import { driver } from "driver.js";
import "driver.js/dist/driver.css";
import "./annotation-guide.css";

export function useAnnotationGuide(
  root: RefObject<HTMLElement>,
  request: number,
  active: boolean,
  pageId: string,
) {
  useEffect(() => {
    if (!active || request === 0 || !root.current) return;
    const element = root.current;
    let tour: ReturnType<typeof driver> | undefined;
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const start = () => {
      if (tour || !element.querySelector("[data-annotation-canvas]")) return;
      const selectors = [
        "[data-annotation-fields]",
        "[data-annotation-canvas]",
        "[data-annotation-transcript]",
        "[data-annotation-submit]",
      ];
      const texts = [
        [
          "Выберите поле",
          "Выберите поле и укажите, есть ли оно на оригинале. Нечитаемый текст и отсутствующее поле отмечаются отдельно.",
        ],
        [
          "Обведите одну строку",
          "Нажмите «Новая строка» и протяните рамку по одной видимой строке. Рамку можно переместить, изменить её размер и повернуть.",
        ],
        [
          "Перепишите точно",
          "Введите текст внутри рамки как на оригинале, сохраняя буквы, цифры и знаки. Каждая следующая видимая строка получает отдельную рамку и порядковый номер.",
        ],
        [
          "Сохраните и отправьте",
          "Сохранение оставляет работу черновиком. После заполнения всех полей отправьте её на проверку. Работа с разметкой доступна и после одобрения документа.",
        ],
      ];
      tour = driver({
        showProgress: true,
        nextBtnText: "Далее",
        prevBtnText: "Назад",
        doneBtnText: "Понятно",
        onDestroyed: () => {
          geometryObserver.disconnect();
          if (previousFocus?.isConnected)
            previousFocus.focus({ preventScroll: true });
        },
        steps: selectors.map((selector, index) => ({
          element: element.querySelector(selector) ?? element,
          popover: { title: texts[index][0], description: texts[index][1] },
        })),
      });
      tour.drive();
      observer.disconnect();
      geometryObserver.observe(element, {
        attributes: true,
        attributeFilter: ["style"],
        subtree: true,
      });
    };
    const geometryObserver = new MutationObserver(() => tour?.refresh());
    const observer = new MutationObserver(start);
    observer.observe(element, { childList: true, subtree: true });
    start();
    return () => {
      observer.disconnect();
      geometryObserver.disconnect();
      tour?.destroy();
    };
  }, [root, request, active, pageId]);
}
