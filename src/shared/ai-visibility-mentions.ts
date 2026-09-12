import type { BrandLookupResult } from "@/types/schemas/ai-search";

export type MentionsSum = {
  total: number | null;
  partialMentions: boolean;
};

/** Sum platform mentions; never zero-fill nulls — flag partial when any selected platform is unknown. */
export function sumMentionsForPlatforms(
  brandLookup: BrandLookupResult,
  platforms: Array<"chat_gpt" | "google">,
): MentionsSum {
  const rows = brandLookup.perPlatform.filter((row) =>
    platforms.includes(row.platform),
  );
  if (rows.length === 0) {
    return { total: null, partialMentions: false };
  }
  if (rows.every((row) => row.mentions == null)) {
    return { total: null, partialMentions: false };
  }
  const partialMentions = rows.some((row) => row.mentions == null);
  const total = rows.reduce((sum, row) => sum + (row.mentions ?? 0), 0);
  return { total, partialMentions };
}

export function formatMentionsDisplay(
  total: number | null,
  partialMentions: boolean,
): string {
  if (total == null) return "not measured";
  if (partialMentions) return `≥ ${total} (partial)`;
  return String(total);
}
