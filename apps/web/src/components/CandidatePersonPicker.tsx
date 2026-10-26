import { useState } from "react";
import {
  useSearchCandidatePersons,
  type CandidateReferenceDto,
} from "@edo/api-client";
import { SearchSelect } from "./SearchSelect";
import { formatBirthDateRu } from "../lib/review-groups";

/** Only an explicitly confirmed signed ERP choice leaves this component. */
export function CandidatePersonPicker({
  disabled,
  onChange,
}: {
  disabled: boolean;
  onChange: (personSelection: string | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<CandidateReferenceDto>();
  const [confirmed, setConfirmed] = useState(false);
  const persons = useSearchCandidatePersons(
    { q: query.trim() || undefined },
    {
      query: {
        enabled: !disabled && query.trim().length >= 3,
        queryKey: ["/api/v1/candidates/references/persons", query.trim()],
        refetchOnWindowFocus: false,
        staleTime: 14 * 60_000,
      },
    },
  );
  return (
    <div className="space-y-3">
      <SearchSelect
        label="Поиск физлица"
        placeholder="Введите не менее 3 символов ФИО"
        value={selected?.id}
        selectedLabel={
          selected
            ? `${selected.name} · ${formatBirthDateRu(selected.birthDate)}`
            : undefined
        }
        options={(query.trim().length >= 3
          ? (persons.data?.items ?? [])
          : []
        ).map((person) => ({
          value: person.id,
          label: `${person.name} · ${formatBirthDateRu(person.birthDate)}`,
        }))}
        onSearchChange={(value) => {
          setQuery(value);
          setSelected(undefined);
          setConfirmed(false);
          onChange(undefined);
        }}
        onChange={(value) => {
          setSelected(
            persons.data?.items.find((person) => person.id === value),
          );
          setConfirmed(false);
          onChange(undefined);
        }}
        disabled={disabled}
        emptyText={
          query.trim().length < 3
            ? "Введите не менее 3 символов ФИО"
            : "Физлица не найдены"
        }
        isLoading={query.trim().length >= 3 && persons.isLoading}
        isError={persons.isError}
        onRetry={() => void persons.refetch()}
      />
      {selected && (
        <div className="space-y-2 rounded-md bg-[var(--muted)] p-3 text-sm">
          <p className="font-medium">{selected.name}</p>
          <p>Дата рождения: {formatBirthDateRu(selected.birthDate)}</p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={confirmed}
              disabled={disabled}
              onChange={(event) => {
                setConfirmed(event.target.checked);
                onChange(event.target.checked ? selected.id : undefined);
              }}
            />
            Подтверждаю, что это нужный человек для текущего оформления
          </label>
        </div>
      )}
    </div>
  );
}
