import type { SearchSelectOption } from "../components/SearchSelect";

export const STATUS_GROUPS = [
  { key: "screening", label: "Подбор и скрининг" },
  { key: "verification", label: "Согласование и проверки" },
  { key: "arrival", label: "Заезд и оформление" },
  { key: "other", label: "Остальные статусы" },
] as const;

export type StatusGroupKey = (typeof STATUS_GROUPS)[number]["key"];
export type StatusGroupLabel = (typeof STATUS_GROUPS)[number]["label"];

/**
 * Classifies an ERP candidate status into one of 4 business groups:
 * - "Подбор и скрининг"
 * - "Согласование и проверки"
 * - "Заезд и оформление"
 * - "Остальные статусы"
 */
export function classifyStatus(status: {
  id: string;
  name?: string | null;
}): StatusGroupLabel {
  const text = `${status.id} ${status.name ?? ""}`.toLowerCase();

  // Заезд и оформление (План на заезд, Заезд/выход, Заезд подтвержден, Оформление, Принят и схожие)
  if (
    /заезд|arrival|прием|приём|приказ|оформлен|принят|стажировк|employment|onboarding/i.test(
      text,
    )
  ) {
    return "Заезд и оформление";
  }

  // Согласование и проверки (СБ, МО, УЦ, Согласование и схожие)
  if (
    /медосмотр|удостоверен|согласован|рассмотрен|пропуск|проверк|безопасн|security|medical|approval/i.test(
      text,
    ) ||
    /(?:^|[^\p{L}\p{N}])(?:мо|уц|сб|фсб|епт|воз|sb|mo|uc)(?:[^\p{L}\p{N}]|$)/iu.test(
      text,
    )
  ) {
    return "Согласование и проверки";
  }

  // Подбор и скрининг (Подбор, Потенциальный, В работе и схожие)
  if (
    /подбор|recruiting|потенциальн|potential|в\s*работе|вработе|in[_\s-]?progress|не\s*дозвон|недозвон|сбор\s*документов|сбордокументов|резерв|reserve|скрининг|screening/iu.test(
      text,
    )
  ) {
    return "Подбор и скрининг";
  }

  return "Остальные статусы";
}

export interface GroupedStatuses<T extends { id: string; name?: string | null }> {
  key: StatusGroupKey;
  label: StatusGroupLabel;
  items: T[];
}

/**
 * Groups a collection of candidate statuses into defined categories,
 * preserving group ordering and omitting empty groups.
 */
export function groupCandidateStatuses<
  T extends { id: string; name?: string | null },
>(items: T[]): GroupedStatuses<T>[] {
  return STATUS_GROUPS.map((group) => ({
    ...group,
    items: items.filter((status) => classifyStatus(status) === group.label),
  })).filter((group) => group.items.length > 0);
}

/**
 * Flattens candidate status items into grouped SearchSelectOption items
 * with `group` property set to the group label.
 */
export function buildGroupedCandidateStatusOptions<
  T extends { id: string; name?: string | null },
>(items: T[]): SearchSelectOption[] {
  const grouped = groupCandidateStatuses(items);
  const options: SearchSelectOption[] = [];
  for (const group of grouped) {
    for (const item of group.items) {
      options.push({
        value: item.id,
        label: item.name || item.id,
        group: group.label,
      });
    }
  }
  return options;
}
