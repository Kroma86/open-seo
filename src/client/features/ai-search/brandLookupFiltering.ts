import { parseTerms } from "@/client/features/keywords/utils";
import type { BrandLookupResult } from "@/types/schemas/ai-search";
import type {
  QueriesFilterValues,
  TopPagesFilterValues,
} from "./brandLookupFilterTypes";

function passesNumericFilter(
  value: number | null | undefined,
  min: string,
  max: string,
): boolean {
  const minN = Number(min);
  const maxN = Number(max);
  const minActive = Boolean(min) && !Number.isNaN(minN);
  const maxActive = Boolean(max) && !Number.isNaN(maxN);
  if (value == null) return !minActive && !maxActive;
  if (minActive && value < minN) return false;
  if (maxActive && value > maxN) return false;
  return true;
}

function passesTextFilter(
  haystack: string,
  includeTerms: string[],
  excludeTerms: string[],
): boolean {
  const lower = haystack.toLowerCase();
  if (
    includeTerms.length > 0 &&
    !includeTerms.some((term) => lower.includes(term))
  ) {
    return false;
  }
  if (excludeTerms.some((term) => lower.includes(term))) {
    return false;
  }
  return true;
}

export function filterTopPages(
  rows: BrandLookupResult["topPages"],
  filters: TopPagesFilterValues,
): BrandLookupResult["topPages"] {
  const includeTerms = parseTerms(filters.include);
  const excludeTerms = parseTerms(filters.exclude);

  return rows.filter((row) => {
    const textFields = [
      row.url,
      row.domain,
      ...row.keywords.map((keyword) => keyword.question),
    ]
      .filter((v): v is string => Boolean(v))
      .join(" ");

    if (!passesTextFilter(textFields, includeTerms, excludeTerms)) return false;
    if (filters.platform && row.platform !== filters.platform) return false;
    if (
      !passesNumericFilter(
        row.mentions,
        filters.minMentions,
        filters.maxMentions,
      )
    ) {
      return false;
    }
    return true;
  });
}

export function filterQueries(
  rows: BrandLookupResult["topQueries"],
  filters: QueriesFilterValues,
): BrandLookupResult["topQueries"] {
  const includeTerms = parseTerms(filters.include);
  const excludeTerms = parseTerms(filters.exclude);

  return rows.filter((row) => {
    const textFields = [row.question, ...row.brandsMentioned].join(" ");

    if (!passesTextFilter(textFields, includeTerms, excludeTerms)) return false;
    if (filters.platform && row.platform !== filters.platform) return false;
    if (
      !passesNumericFilter(
        row.aiSearchVolume,
        filters.minVolume,
        filters.maxVolume,
      )
    ) {
      return false;
    }
    return true;
  });
}

export function countActiveFilters(values: Record<string, string>): number {
  return Object.values(values).filter((v) => v.trim() !== "").length;
}
