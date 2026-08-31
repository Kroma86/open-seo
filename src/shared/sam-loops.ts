import type { InferSelectModel } from "drizzle-orm";
import type { samLoops } from "@/db/app.schema";
import { computeNextCheckAt } from "@/shared/rank-tracking";

export type SamLoopCadence = InferSelectModel<typeof samLoops>["cadence"];

/** Default skill-backed loops seeded for every project (dogfood + clients). */
export const DEFAULT_SAM_LOOP_TEMPLATES = [
  {
    name: "Site health",
    skillName: "site-health",
    cadence: "weekly" as const,
  },
  {
    name: "Rank slippage",
    skillName: "rank-slippage",
    cadence: "daily" as const,
  },
  {
    name: "NiceSEO pillars",
    skillName: "niceseo-pillars",
    cadence: "weekly" as const,
  },
  {
    name: "Page growth",
    skillName: "page-growth",
    cadence: "monthly" as const,
  },
  {
    name: "Authority plan",
    skillName: "authority-plan",
    cadence: "monthly" as const,
  },
  {
    name: "AI visibility",
    skillName: "ai-visibility",
    cadence: "weekly" as const,
  },
  {
    name: "Striking distance",
    skillName: "striking-distance",
    cadence: "monthly" as const,
  },
] as const;

export const SAM_LOOP_STEP_CAP = 24;

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
