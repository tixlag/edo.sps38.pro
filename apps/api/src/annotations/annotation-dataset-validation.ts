import { BadRequestException } from "@nestjs/common";
import type {
  AnnotationCatalogSectionDto,
  AnnotationRegionDto,
  AnnotationSectionInstanceDto,
} from "./annotation.dto";
import type {
  CatalogField,
  FieldAnswer,
  PageFrame,
} from "./annotation-validation";
const fail = (message: string): never => {
  throw new BadRequestException(message);
};
const keyPattern = /^[-a-zA-Z0-9_]{1,64}$/;
export function annotationKey(label: string, used: Set<string>): string {
  const alphabet: Record<string, string> = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "yo",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "kh",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "shch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya",
  };
  const base =
    Array.from(label.toLowerCase())
      .map((c) => alphabet[c] ?? c)
      .join("")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 54) || "field";
  let key = base,
    index = 2;
  while (used.has(key)) key = `${base}_${index++}`;
  used.add(key);
  return key;
}
export function validateSections(
  sections: AnnotationCatalogSectionDto[],
): AnnotationCatalogSectionDto[] {
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > 50)
    fail("Нужно от 1 до 50 разделов");
  const keys = new Set<string>();
  const orders = new Set<number>();
  return sections.map((s) => {
    if (
      !s ||
      !keyPattern.test(s.key) ||
      keys.has(s.key) ||
      typeof s.label !== "string" ||
      !s.label.trim() ||
      s.label.length > 255 ||
      !Number.isInteger(s.ordinal) ||
      s.ordinal < 0 ||
      orders.has(s.ordinal) ||
      typeof s.repeatable !== "boolean"
    )
      fail("Некорректный раздел документа");
    keys.add(s.key);
    orders.add(s.ordinal);
    return { ...s, label: s.label.trim() };
  });
}
export function validateRegion(
  region: AnnotationRegionDto,
  pages: PageFrame[],
) {
  if (
    !region ||
    !keyPattern.test(region.id) ||
    !pages.some((p) => p.id === region.pageId) ||
    !["RECTANGLE", "POLYGON"].includes(region.shape) ||
    !Number.isFinite(region.orientationDeg) ||
    region.orientationDeg < 0 ||
    region.orientationDeg >= 360
  )
    fail("Некорректная область или направление чтения");
  const q = region.polygon;
  if (
    !Array.isArray(q) ||
    q.length % 2 ||
    q.length < 6 ||
    q.length > 128 ||
    q.some((n) => !Number.isFinite(n) || n < 0 || n > 1) ||
    (region.shape === "RECTANGLE" && q.length !== 8)
  )
    fail("Некорректный контур области");
  const p = Array.from({ length: q.length / 2 }, (_, i) => [
    q[i * 2],
    q[i * 2 + 1],
  ]);
  const cross = (a: number[], b: number[], c: number[]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let area = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i],
      b = p[(i + 1) % p.length];
    area += a[0] * b[1] - b[0] * a[1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-7)
      fail("Совпадающие вершины контура");
    for (let j = i + 2; j < p.length; j++) {
      if (i === 0 && j === p.length - 1) continue;
      const c = p[j],
        d = p[(j + 1) % p.length];
      if (
        cross(a, b, c) * cross(a, b, d) <= 0 &&
        cross(c, d, a) * cross(c, d, b) <= 0 &&
        Math.max(Math.min(a[0], b[0]), Math.min(c[0], d[0])) <=
          Math.min(Math.max(a[0], b[0]), Math.max(c[0], d[0])) &&
        Math.max(Math.min(a[1], b[1]), Math.min(c[1], d[1])) <=
          Math.min(Math.max(a[1], b[1]), Math.max(c[1], d[1]))
      )
        fail("Контур пересекает сам себя");
    }
  }
  if (area <= 1e-8) fail("Вершины контура должны идти по часовой стрелке");
  if (region.shape === "RECTANGLE") {
    const page = pages.find((x) => x.id === region.pageId)!;
    const v = p.map((a, i) => [
      (p[(i + 1) % 4][0] - a[0]) * page.width,
      (p[(i + 1) % 4][1] - a[1]) * page.height,
    ]);
    for (let i = 0; i < 4; i++)
      if (
        Math.abs(v[i][0] * v[(i + 1) % 4][0] + v[i][1] * v[(i + 1) % 4][1]) >
        Math.hypot(...v[i]) * Math.hypot(...v[(i + 1) % 4]) * 0.01
      )
        fail("Рамка должна быть прямоугольной");
  }
}
export function validateDataset(
  fields: FieldAnswer[],
  definitions: CatalogField[],
  sections: AnnotationCatalogSectionDto[],
  instances: AnnotationSectionInstanceDto[],
  pages: PageFrame[],
  complete: boolean,
) {
  if (!Array.isArray(instances) || instances.length > 200)
    fail("Некорректные экземпляры разделов");
  const ids = new Set<string>();
  for (const instance of instances) {
    const section = sections.find((s) => s.key === instance.sectionKey);
    if (
      !section ||
      !keyPattern.test(instance.id) ||
      ids.has(instance.id) ||
      !["PRESENT", "NOT_UPLOADED", "NOT_PRESENT"].includes(
        instance.availability,
      ) ||
      !Array.isArray(instance.pageIds) ||
      new Set(instance.pageIds).size !== instance.pageIds.length ||
      instance.pageIds.some((id) => !pages.some((p) => p.id === id)) ||
      instance.pageIds.length > 100
    )
      fail("Некорректный раздел или страница оригинала");
    ids.add(instance.id);
    if (instance.availability !== "PRESENT" && instance.pageIds.length)
      fail("У отсутствующего раздела не должно быть страниц");
    if (
      complete &&
      instance.availability === "PRESENT" &&
      !instance!.pageIds.length
    )
      fail("Укажите страницы раздела");
    if (
      !section!.repeatable &&
      instances.filter((s) => s.sectionKey === section!.key).length > 1
    )
      fail("Раздел не допускает повторов");
  }
  if (complete && !instances.some((i) => i.availability === "PRESENT"))
    fail("Назначьте хотя бы один раздел загруженным страницам");
  if (
    complete &&
    sections.some((s) => !instances.some((i) => i.sectionKey === s.key))
  )
    fail("Укажите состояние каждого раздела документа");
  const geometryIds = new Set(fields.flatMap((f) => f.lines.map((l) => l.id)));
  let regionCount = 0;
  for (const answer of fields) {
    const def = definitions.find((f) => f.key === answer.key)!;
    const instance = instances.find(
      (i) => i.id === (answer.instanceId ?? "main"),
    );
    if (
      !instance ||
      instance.sectionKey !== (def.sectionKey ?? "main") ||
      instance.availability !== "PRESENT"
    )
      fail("Поле не относится к выбранному разделу");
    const regions = answer.regions ?? [];
    if (regions.length > 100) fail("Слишком много областей");
    for (const region of regions) {
      if (++regionCount > 1000) fail("Слишком много областей в работе");
      validateRegion(region, pages);
      if (
        geometryIds.has(region.id) ||
        !instance!.pageIds.includes(region.pageId)
      )
        fail("Некорректная страница или повтор области");
      geometryIds.add(region.id);
    }
    if (answer.lines.some((l) => !instance!.pageIds.includes(l.pageId)))
      fail("Строка находится вне раздела");
    if (
      answer.disposition === "NOT_PRESENT" &&
      (regions.length || answer.lines.length)
    )
      fail("Отсутствующее поле не может содержать области");
    if (def.kind !== "TEXT" && def.kind && answer.lines.length)
      fail("Нетекстовая область не требует транскрипции");
    if (complete && answer.disposition !== "NOT_PRESENT" && !regions.length)
      fail("Обведите область поля");
  }
  if (complete)
    for (const instance of instances.filter(
      (i) => i.availability === "PRESENT",
    ))
      for (const def of definitions.filter(
        (f) => (f.sectionKey ?? "main") === instance.sectionKey,
      ))
        if (
          !fields.some(
            (f) =>
              f.key === def.key && (f.instanceId ?? "main") === instance.id,
          )
        )
          fail("Завершите все поля выбранного раздела");
}
