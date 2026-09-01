import type { InferSelectModel } from "drizzle-orm";
import type { samLoops } from "@/db/app.schema";
import { computeNextCheckAt } from "@/shared/rank-tracking";

export type SamLoopCadence = InferSelectModel<typeof samLoops>["cadence"];

/** Default loops seeded for every project (dogfood + clients). */
export const DEFAULT_SAM_LOOP_TEMPLATES = [
  {
    name: "Site health",
    sourceType: "skill" as const,
    skillName: "site-health",
    cadence: "weekly" as const,
  },
  {
    name: "Rank slippage",
    sourceType: "skill" as const,
    skillName: "rank-slippage",
    cadence: "daily" as const,
  },
  {
    name: "NiceSEO pillars",
    sourceType: "skill" as const,
    skillName: "niceseo-pillars",
    cadence: "weekly" as const,
  },
  {
    name: "Page growth",
    sourceType: "skill" as const,
    skillName: "page-growth",
    cadence: "monthly" as const,
  },
  {
    name: "Authority plan",
    sourceType: "skill" as const,
    skillName: "authority-plan",
    cadence: "monthly" as const,
  },
  {
    name: "AI visibility",
    sourceType: "skill" as const,
    skillName: "ai-visibility",
    cadence: "weekly" as const,
  },
  {
    name: "Striking distance",
    sourceType: "skill" as const,
    skillName: "striking-distance",
    cadence: "monthly" as const,
  },
  {
    name: "Monthly content",
    sourceType: "custom" as const,
    customPrompt:
      "Each month, run the content-topical-map skill and refresh this project's topical map. Reuse the saved map when it is under 60 days old. From that map, pick the single highest-priority uncovered row. This loop's configuration names that row as the target, so content-brief can run. Run content-brief on it. Then run content-draft on the brief. Put the article in this loop report as a DRAFT for human review. Nothing is ever published by this loop. The draft always waits for a human. If the SERP fetch fails, report that and stop. Do not invent coverage gaps.",
    cadence: "monthly" as const,
    skillName: null as string | null,
  },
] as const;

export const SAM_LOOP_STEP_CAP = 24;

/** Skills whose loops count toward content velocity (plus "Monthly content" by name). */
export const CONTENT_LOOP_SKILL_NAMES = [
  "content-topical-map",
  "content-brief",
  "content-draft",
] as const;

export function isSamContentLoop(loop: {
  name: string;
  skillName: string | null;
}): boolean {
  return (
    loop.name === "Monthly content" ||
    (loop.skillName !== null &&
      (CONTENT_LOOP_SKILL_NAMES as readonly string[]).includes(loop.skillName))
  );
}

/** Approximate drafts per month implied by cadence (labeled approximations in UI). */
export function expectedSamLoopDraftsPerMonth(
  cadence: SamLoopCadence,
): number {
  switch (cadence) {
    case "monthly":
      return 1;
    case "weekly":
      return 4;
    case "daily":
      return 30;
    default:
      return 1;
  }
}

/**
 * Reuse rank-tracking schedule math (daily / weekly / end-of-month).
 * If the computed next time is still in the past (stale anchor / clock skew),
 * re-anchor one full interval from now so downtime cannot stampede catch-up.
 */
export function computeNextSamLoopRunAt(
  cadence: SamLoopCadence,
  previousNextRunAt?: string | null,
): string {
  const next = computeNextCheckAt(cadence, previousNextRunAt);
  if (new Date(next).getTime() > Date.now()) return next;
  return computeNextCheckAt(cadence);
}
