import { describe, expect, it, vi } from "vitest";
import {
  ERP_REFERENCE_LIMIT,
  searchReferences,
  type References,
} from "../src/documents/erp-workspace.client";

const row = (name: string, code?: string): References["items"][number] => ({
  id: name,
  name,
  ...(code ? { code } : {}),
});
const answered = (byWord: Record<string, References["items"][]>) =>
  vi.fn(async (term: string) => ({
    items: byWord[term.toLocaleLowerCase("ru")] ?? [],
  }));

describe("ERP reference search", () => {
  it("passes an unfiltered or single-word query to ERP untouched", async () => {
    const all = [row("Инженер ПТО")];
    const request = vi.fn(async () => ({ items: all }));
    await expect(searchReferences(request, "")).resolves.toEqual({
      items: all,
    });
    await expect(searchReferences(request, "Инженер")).resolves.toEqual({
      items: all,
    });
    expect(request).toHaveBeenNthCalledWith(1, "");
    expect(request).toHaveBeenNthCalledWith(2, "Инженер");
  });
  it("searches every word of a phrase and keeps rows mentioning all of them", async () => {
    const request = answered({
      инженер: [
        row("Инженер ПТО"),
        row("Ведущий инженер по комплектации "),
        row("Инженер по комплектации "),
      ],
      по: [
        row("Руководитель по найму"),
        row("Ведущий инженер по комплектации "),
        row("Инженер по комплектации "),
      ],
      комплектации: [
        row("Ведущий инженер по комплектации "),
        row("Инженер по комплектации "),
        row("Специалист отдела комплектации и логистики"),
      ],
    });
    const result = await searchReferences(request, "  Инженер   по   комплектации ");
    expect(result.items.map((item) => item.name)).toEqual([
      "Ведущий инженер по комплектации ",
      "Инженер по комплектации ",
    ]);
    expect(request.mock.calls.map(([term]) => term)).toEqual([
      "инженер",
      "по",
      "комплектации",
    ]);
  });
  it("merges by the narrowest uncapped word so rows hidden behind ERP's cap survive", async () => {
    const capped = Array.from({ length: ERP_REFERENCE_LIMIT }, (_, i) =>
      row(`Инженер ${i}`),
    );
    const request = answered({
      инженер: capped,
      бульдозера: [row("Инженер бульдозера"), row("Машинист бульдозера")],
    });
    const result = await searchReferences(request, "Инженер бульдозера");
    expect(result.items.map((item) => item.name)).toEqual([
      "Инженер бульдозера",
    ]);
  });
  it("matches a word against the row code as well", async () => {
    const position = row("Инженер по комплектации ", "000000097");
    const request = answered({
      "000000097": [position],
      инженер: [row("Инженер ПТО", "000000004"), position],
    });
    const result = await searchReferences(request, "000000097 Инженер");
    expect(result.items).toEqual([position]);
  });
  it("returns nothing as soon as one word of the phrase is unknown", async () => {
    const request = answered({
      инженер: [row("Инженер ПТО")],
      проектировщик: [],
    });
    await expect(
      searchReferences(request, "Инженер проектировщик"),
    ).resolves.toEqual({ items: [] });
  });
});
