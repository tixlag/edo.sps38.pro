import { describe, expect, it } from "vitest";
import { findCurrentUserAsManager } from "./manager-default";

describe("findCurrentUserAsManager", () => {
  const managers = [
    { id: "mgr-1", name: "Главинская Алёна Александровна" },
    { id: "mgr-2", name: "Воронухин Никита Александрович" },
  ];

  it("matches manager by full name case-insensitively and with extra whitespace", () => {
    const me = { fullName: "  главинская   Алёна Александровна  " };
    expect(findCurrentUserAsManager(managers, me)).toEqual(managers[0]);
  });

  it("matches manager by uuid if name does not match", () => {
    const me = { fullName: "Другое Имя", uuid: "mgr-2" };
    expect(findCurrentUserAsManager(managers, me)).toEqual(managers[1]);
  });

  it("returns undefined if no match or me is missing", () => {
    expect(findCurrentUserAsManager(managers, { fullName: "Неизвестный" })).toBeUndefined();
    expect(findCurrentUserAsManager(managers, undefined)).toBeUndefined();
    expect(findCurrentUserAsManager(undefined, { fullName: "Главинская Алёна Александровна" })).toBeUndefined();
  });
});
