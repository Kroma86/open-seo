import type {
  BrandLookupResult,
  PromptExplorerModel,
} from "@/types/schemas/ai-search";

export type AiVisibilitySweep = "full" | "pulse";

export const FULL_SWEEP_EVERY_WEEKS = 4;
export const FULL_SWEEP_MAX_AGE_DAYS = 35;

export const PULSE_MODELS: PromptExplorerModel[] = ["perplexity"];

export const PULSE_MODEL_NAMES: Partial<Record<PromptExplorerModel, string>> = {
  perplexity: "sonar",
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_AGE_MS = FULL_SWEEP_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

/** FNV-1a 32-bit over UTF-16 code units, then a stable week bucket. */
export function fullSweepSlot(configId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < configId.length; i++) {
    hash ^= configId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % FULL_SWEEP_EVERY_WEEKS;
}

export function isFullSweepWeek(configId: string, now: Date): boolean {
  const weekIndex = Math.floor(now.getTime() / WEEK_MS);
  return weekIndex % FULL_SWEEP_EVERY_WEEKS === fullSweepSlot(configId);
}

function lookupForcesFullSweep(
  lastFreshLookupAt: string | null,
  now: Date,
): boolean {
  if (lastFreshLookupAt == null) return true;
  const parsed = Date.parse(lastFreshLookupAt);
  if (Number.isNaN(parsed)) return true;
  return now.getTime() - parsed > MAX_AGE_MS;
}

export function decideSweep(input: {
  trigger: "manual" | "scheduled";
  scheduleInterval: string;
  configId: string;
  now: Date;
  lastFreshLookupAt: string | null;
}): AiVisibilitySweep {
  if (input.trigger === "manual") return "full";
  if (input.scheduleInterval !== "weekly") return "full";
  if (lookupForcesFullSweep(input.lastFreshLookupAt, input.now)) return "full";
  if (isFullSweepWeek(input.configId, input.now)) return "full";
  return "pulse";
}

/** Brand-lookup block stored on a completed run's detail JSON. */
export type StoredBrandLookup = {
  fetchedAt: string;
  totalMentions: number | null;
  partialMentions: boolean;
  shareOfVoicePct: number | null;
  perPlatform: BrandLookupResult["perPlatform"];
  topCitedSources: BrandLookupResult["topPages"];
  reused?: boolean;
  reusedFromRunId?: string;
};

function numberOrNull(value: unknown): boolean {
  return value === null || typeof value === "number";
}

function freshLookupFromDetail(detail: string | null): StoredBrandLookup | null {
  if (!detail) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const brandLookup = (parsed as { brandLookup?: unknown }).brandLookup;
  if (
    !brandLookup ||
    typeof brandLookup !== "object" ||
    Array.isArray(brandLookup)
  ) {
    return null;
  }
  const record = brandLookup as Record<string, unknown>;
  if (typeof record.fetchedAt !== "string") return null;
  // A pulse copies these into run columns, so require what a full sweep writes.
  if (
    !numberOrNull(record.totalMentions) ||
    !numberOrNull(record.shareOfVoicePct) ||
    typeof record.partialMentions !== "boolean" ||
    !Array.isArray(record.perPlatform) ||
    !Array.isArray(record.topCitedSources)
  ) {
    return null;
  }
  // A reused block points at an older fetch. Only a fresh lookup can be reused.
  if (typeof record.reusedFromRunId === "string") return null;
  return brandLookup as StoredBrandLookup;
}

export function findReusableLookup(
  runs: Array<{ id: string; detail: string | null }>,
): { runId: string; fetchedAt: string; brandLookup: StoredBrandLookup } | null {
  for (const run of runs) {
    const brandLookup = freshLookupFromDetail(run.detail);
    if (!brandLookup) continue;
    return { runId: run.id, fetchedAt: brandLookup.fetchedAt, brandLookup };
  }
  return null;
}
