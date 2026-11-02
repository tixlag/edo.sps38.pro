import { useState } from "react";
import {
  useListCatalogManagers,
  useListCandidateProjects,
  useListCatalogMentors,
  useListPositions,
} from "@edo/api-client";
import { SearchSelect } from "./SearchSelect";

export type CandidateListFilterKey =
  | "positionCode"
  | "projectCode"
  | "managerId"
  | "mentorCode1c";
export type CandidateListFilterValues = Partial<
  Record<CandidateListFilterKey, string>
>;

export function CandidateListFilters({
  values,
  onChange,
}: {
  values: CandidateListFilterValues;
  onChange: (key: CandidateListFilterKey, value: string | undefined) => void;
}) {
  const [queries, setQueries] = useState<
    Partial<Record<CandidateListFilterKey, string>>
  >({});
  const positions = useListPositions({
    q: queries.positionCode || undefined,
    limit: 100,
  });
  const projects = useListCandidateProjects();
  const managers = useListCatalogManagers();
  const mentors = useListCatalogMentors();
  const options = {
    positionCode: (positions.data?.items ?? []).map((item) => ({
      value: item.code,
      label: item.name,
    })),
    projectCode: (projects.data?.items ?? []).map((item) => ({
      value: item.code ?? item.id,
      label: item.name,
    })),
    managerId: (managers.data?.items ?? []).map((item) => ({
      value: item.id,
      label: item.name,
    })),
    mentorCode1c: (mentors.data?.items ?? []).map((item) => ({
      value: item.code1c,
      label: item.name,
    })),
  };
  const entries = [
    { key: "positionCode", label: "Должность", source: positions },
    { key: "projectCode", label: "Объект", source: projects },
    { key: "managerId", label: "Менеджер", source: managers },
    { key: "mentorCode1c", label: "Наставник", source: mentors },
  ] as const;
  return (
    <div
      className="grid grid-cols-2 gap-x-2 gap-y-2"
      aria-label="Фильтры кандидатов"
    >
      {entries.map(({ key, label, source }) => {
        const query = (queries[key] ?? "").trim().toLocaleLowerCase("ru");
        const all = options[key];
        return (
          <div key={key} className="min-w-0">
            <span className="mb-1 block text-xs font-medium text-[var(--muted-foreground)]">
              {label}
            </span>
            <SearchSelect
              label={label}
              placeholder="Все"
              value={values[key]}
              selectedLabel={
                all.find((option) => option.value === values[key])?.label
              }
              options={
                key === "positionCode"
                  ? all
                  : all.filter((option) =>
                      option.label.toLocaleLowerCase("ru").includes(query),
                    )
              }
              onSearchChange={(text) =>
                setQueries((previous) => ({ ...previous, [key]: text }))
              }
              onChange={(value) => onChange(key, value)}
              isLoading={source.isLoading}
              isError={source.isError}
              onRetry={() => void source.refetch()}
            />
          </div>
        );
      })}
    </div>
  );
}
