import { useId, useState } from "react";

type SearchableOption = {
  value: string;
  label: string;
  hint?: string;
  group?: string;
  keywords?: string[];
  disabled?: boolean;
};

export function filterSearchableOptions(
  options: readonly SearchableOption[],
  query: string,
): SearchableOption[] {
  const needle = query.trim().toLowerCase();
  return options.filter((option) =>
    [option.label, option.hint, option.group, ...(option.keywords ?? [])].some(
      (field) => field?.toLowerCase().includes(needle),
    ),
  );
}

function renderOption(option: SearchableOption) {
  return (
    <option key={option.value} value={option.value} disabled={option.disabled}>
      {option.label}
      {option.hint ? ` · ${option.hint}` : ""}
    </option>
  );
}

/** Search filters options; the browser owns selection and keyboard access. */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  searchPlaceholder = "Search",
  emptyLabel = "No matches",
  className = "w-full",
  "aria-label": ariaLabel = "Property",
}: {
  value: string | null;
  onChange: (value: string) => void;
  options: readonly SearchableOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const [query, setQuery] = useState("");
  const id = useId();
  const filtered = filterSearchableOptions(options, query);
  const selected = options.find((option) => option.value === value);
  const groups = new Map<string, SearchableOption[]>();
  for (const option of filtered) {
    const group = option.group ?? "";
    const entries = groups.get(group) ?? [];
    entries.push(option);
    groups.set(group, entries);
  }

  return (
    <div className={`space-y-2 ${className}`}>
      <input
        type="search"
        className="input input-bordered w-full"
        aria-label={`Search ${ariaLabel}`}
        aria-controls={id}
        placeholder={searchPlaceholder}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <select
        id={id}
        className="select select-bordered w-full"
        aria-label={ariaLabel}
        value={selected?.value ?? ""}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {/* Filtering must not silently replace a choice already made. */}
        {selected && !filtered.includes(selected) ? (
          <option value={selected.value} hidden>
            {selected.label}
          </option>
        ) : null}
        {[...groups].map(([group, entries]) =>
          group ? (
            <optgroup key={group} label={group}>
              {entries.map(renderOption)}
            </optgroup>
          ) : (
            entries.map(renderOption)
          ),
        )}
      </select>
      {filtered.length === 0 ? (
        <p role="status" className="text-sm text-base-content/60">
          {emptyLabel}
        </p>
      ) : null}
    </div>
  );
}
