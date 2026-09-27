/**
 * Real mentions: cited sources a decision model says are actually about
 * this business. `p` is the model's probability of "yes" (0 to 1).
 * A source counts only when p is at least 0.5. Missing or unfinished
 * scores stay "not measured" (null), never a fake zero.
 */

export const REAL_MENTION_MIN_P = 0.5;

/** Hard ceiling for one weekly pass, shared across every brand in that pass. */
export const JEV_RUN_CAP_USD = 0.01;

export type JevSpendBudget = {
  capUsd: number;
  spentUsd: number;
  /** What the previous answered call actually cost, used to hold the next one. */
  lastCostUsd: number;
};

export function newJevSpendBudget(capUsd = JEV_RUN_CAP_USD): JevSpendBudget {
  return { capUsd, spentUsd: 0, lastCostUsd: 0 };
}

/**
 * Question sent with each cited source. The words business, cited_source,
 * search_queries, and business.website name fields on the decision state.
 */
export const JEV_ABOUT_THIS_BUSINESS_QUESTION =
  "A brand-tracking tool says this cited_source and these search_queries are mentions of business. Are they actually about this specific business (the company at business.website)? Answer no when they are about a different company, a generic topic, or a common word that merely appears in the business name.";

export function isRealMentionP(p: number | null | undefined): boolean {
  return (
    typeof p === "number" &&
    Number.isFinite(p) &&
    p >= REAL_MENTION_MIN_P &&
    p <= 1
  );
}

/**
 * Count of sources that are about this business.
 * Empty input is a measured zero. Any missing score makes the whole
 * count not measured, so a stopped or failed grade cannot look finished.
 */
export function countRealMentions(
  scores: Array<number | null | undefined>,
): number | null {
  if (scores.length === 0) return 0;
  const unscored = scores.some(
    (p) =>
      p == null ||
      typeof p !== "number" ||
      !Number.isFinite(p) ||
      p < 0 ||
      p > 1,
  );
  if (unscored) return null;
  return scores.filter((p) => isRealMentionP(p)).length;
}

/** Sum per-run counts. One missing run makes the estate total not measured. */
export function sumRealMentions(counts: Array<number | null>): number | null {
  if (counts.some((count) => count == null)) return null;
  return counts.reduce((sum, count) => sum + count, 0);
}

export function formatRealMentions(value: number | null | undefined): string {
  return value == null ? "not measured" : String(value);
}

/** Read the stored count. Accepts the ticket name and the camelCase field. */
export function parseStoredRealMentions(
  detail: string | null | undefined,
): number | null {
  if (!detail) return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (!parsed || typeof parsed !== "object") return null;
    const brandLookup = (
      parsed as {
        brandLookup?: { realMentions?: unknown; real_mentions?: unknown };
      }
    ).brandLookup;
    const value = brandLookup?.realMentions ?? brandLookup?.real_mentions;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}
