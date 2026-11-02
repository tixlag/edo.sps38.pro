import { expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DateFilter } from "./DateFilter";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("accepts a typed date and a calendar selection", async () => {
  const onChange = vi.fn();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  await act(async () =>
    root.render(<DateFilter label="Дата рождения с" onChange={onChange} />),
  );
  const input = node.querySelector('input[type="text"]') as HTMLInputElement;
  expect(input.placeholder).toBe("Выберите дату");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(input, "12.05.2000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(onChange).toHaveBeenCalledWith("2000-05-12");
  const date = node.querySelector('input[type="date"]') as HTMLInputElement;
  const showPicker = vi.fn();
  Object.defineProperty(date, "showPicker", { value: showPicker });
  const calendar = node.querySelector(
    'button[aria-label="Дата рождения с: выбрать в календаре"]',
  ) as HTMLButtonElement;
  await act(async () => calendar.click());
  expect(showPicker).toHaveBeenCalledOnce();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!.call(date, "2001-06-14");
    date.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(onChange).toHaveBeenLastCalledWith("2001-06-14");
  await act(async () => root.unmount());
  node.remove();
});
