import { describe, expect, it } from "vitest";
import {
  classifyStatus,
  groupCandidateStatuses,
  buildGroupedCandidateStatusOptions,
} from "./candidate-status-groups";

describe("candidate-status-groups", () => {
  it("classifies statuses accurately into the 4 groups", () => {
    // Screening
    expect(classifyStatus({ id: "Подбор", name: "Подбор" })).toBe(
      "Подбор и скрининг",
    );
    expect(classifyStatus({ id: "НеДозвон", name: "Не дозвон" })).toBe(
      "Подбор и скрининг",
    );
    expect(classifyStatus({ id: "ВРаботе", name: "В работе" })).toBe(
      "Подбор и скрининг",
    );
    expect(classifyStatus({ id: "Резерв", name: "Резерв" })).toBe(
      "Подбор и скрининг",
    );
    expect(classifyStatus({ id: "СборДокументов", name: "Сбор документов" })).toBe(
      "Подбор и скрининг",
    );

    // Verification
    expect(classifyStatus({ id: "Проверка", name: "Проверка СБ" })).toBe(
      "Согласование и проверки",
    );
    expect(classifyStatus({ id: "Медосмотр", name: "МО" })).toBe(
      "Согласование и проверки",
    );
    expect(classifyStatus({ id: "ПолучениеУдостоверенийСЛТ", name: "УЦ" })).toBe(
      "Согласование и проверки",
    );
    expect(classifyStatus({ id: "НаРассмотрение", name: "Согласован" })).toBe(
      "Согласование и проверки",
    );
    expect(classifyStatus({ id: "ФСБ", name: "ФСБ" })).toBe(
      "Согласование и проверки",
    );

    // Arrival & onboarding
    expect(classifyStatus({ id: "Заезд", name: "Заезд/выход" })).toBe(
      "Заезд и оформление",
    );
    expect(classifyStatus({ id: "ЗаездПодтвержден", name: "Заезд подтвержден" })).toBe(
      "Заезд и оформление",
    );
    expect(classifyStatus({ id: "ПланНаЗаезд", name: "План на заезд" })).toBe(
      "Заезд и оформление",
    );
    expect(classifyStatus({ id: "Прием", name: "Приказ проведен" })).toBe(
      "Заезд и оформление",
    );
    expect(classifyStatus({ id: "Стажировка", name: "Стажировка" })).toBe(
      "Заезд и оформление",
    );

    // Other
    expect(classifyStatus({ id: "Отказ", name: "Отказ" })).toBe(
      "Остальные статусы",
    );
    expect(classifyStatus({ id: "custom_status", name: "Неизвестный статус" })).toBe(
      "Остальные статусы",
    );
  });

  it("groups candidate statuses into ordered categories without empty groups", () => {
    const raw = [
      { id: "Отказ", name: "Отказ" },
      { id: "Подбор", name: "Подбор" },
      { id: "ЗаездПодтвержден", name: "Заезд подтвержден" },
    ];
    const grouped = groupCandidateStatuses(raw);
    expect(grouped.map((g) => g.label)).toEqual([
      "Подбор и скрининг",
      "Заезд и оформление",
      "Остальные статусы",
    ]);
    expect(grouped[0].items[0].id).toBe("Подбор");
    expect(grouped[1].items[0].id).toBe("ЗаездПодтвержден");
    expect(grouped[2].items[0].id).toBe("Отказ");
  });

  it("builds SearchSelectOption items with matching group properties", () => {
    const raw = [
      { id: "Подбор", name: "Подбор" },
      { id: "Проверка", name: "Проверка СБ" },
      { id: "Заезд", name: "Заезд/выход" },
      { id: "ЗаездПодтвержден", name: "Заезд подтвержден" },
      { id: "Отказ", name: "Отказ" },
    ];
    const options = buildGroupedCandidateStatusOptions(raw);
    expect(options).toEqual([
      { value: "Подбор", label: "Подбор", group: "Подбор и скрининг" },
      { value: "Проверка", label: "Проверка СБ", group: "Согласование и проверки" },
      { value: "Заезд", label: "Заезд/выход", group: "Заезд и оформление" },
      { value: "ЗаездПодтвержден", label: "Заезд подтвержден", group: "Заезд и оформление" },
      { value: "Отказ", label: "Отказ", group: "Остальные статусы" },
    ]);
  });
});
