import { useMemo } from "react";
import { sortBy } from "remeda";
import { parseTerms } from "@/client/features/keywords/utils";
import type { KeywordResearchRow } from "@/types/keywords";
import {
  parseIntentFilter,
  type KeywordFilterValues,
} from "@/client/features/keywords/keywordResearchTypes";
import type { SortDir, SortField } from "@/client/features/keywords/components";

/** Active when the original string is truthy and Number(string) is not NaN. */
function parseActiveBound(raw: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function passesNumericBounds(
  value: number | null | undefined,
  minRaw: string,
  maxRaw: string,
): boolean {
  const min = parseActiveBound(minRaw);
  const max = parseActiveBound(maxRaw);
  if (min === undefined && max === undefined) return true;
  if (value == null) return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

/** Missing values sort last in both directions; equal present values stay stable. */
function compareNullableNumber(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: SortDir,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir === "asc" ? a - b : b - a;
}

export function applyKeywordFiltersAndSort(params: {
  rows: KeywordResearchRow[];
  filters: KeywordFilterValues;
  sortField: SortField;
  sortDir: SortDir;
}): KeywordResearchRow[] {
  const includeTerms = parseTerms(params.filters.include);
  const excludeTerms = parseTerms(params.filters.exclude);
  const selectedIntents = parseIntentFilter(params.filters.intents);

  const filtered = params.rows.filter((row) => {
    const haystack = row.keyword.toLowerCase();
    if (
      includeTerms.length > 0 &&
      !includeTerms.every((term) => haystack.includes(term))
    ) {
      return false;
    }
    if (excludeTerms.some((term) => haystack.includes(term))) {
      return false;
    }

    if (selectedIntents.length > 0 && !selectedIntents.includes(row.intent)) {
      return false;
    }

    if (
      !passesNumericBounds(
        row.searchVolume,
        params.filters.minVol,
        params.filters.maxVol,
      )
    ) {
      return false;
    }
    if (
      !passesNumericBounds(
        row.cpc,
        params.filters.minCpc,
        params.filters.maxCpc,
      )
    ) {
      return false;
    }
    if (
      !passesNumericBounds(
        row.keywordDifficulty,
        params.filters.minKd,
        params.filters.maxKd,
      )
    ) {
      return false;
    }
    return true;
  });

  if (params.sortField === "keyword") {
    return sortBy(filtered, [(row) => row.keyword, params.sortDir]);
  }

  const field = params.sortField;
  return filtered.toSorted((left, right) =>
    compareNullableNumber(left[field], right[field], params.sortDir),
  );
}

export function useKeywordFiltering(params: {
  rows: KeywordResearchRow[];
  filters: KeywordFilterValues;
  sortField: SortField;
  sortDir: SortDir;
}) {
  const filteredRows = useMemo(
    () =>
      applyKeywordFiltersAndSort({
        rows: params.rows,
        filters: params.filters,
        sortField: params.sortField,
        sortDir: params.sortDir,
      }),
    [params.filters, params.rows, params.sortDir, params.sortField],
  );

  const activeFilterCount = useMemo(
    () =>
      Object.values(params.filters).filter((value) => value.trim() !== "")
        .length,
    [params.filters],
  );

  return {
    filteredRows,
    activeFilterCount,
  };
}
