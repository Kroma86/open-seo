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
  {
    name: "On-page priorities",
    sourceType: "custom" as const,
    customPrompt:
      "Run only for niceseo.ai. Other domains: stop and say this loop is dogfood-only.\n\nThe scheduler only has weekly, not every-two-weeks. Treat this as every two weeks: call get_sam_loop_runs for this project. If this loop already has a completed run with a report in the last 12 days, write \"too soon — skip\" and stop. Do not queue.\n\nQueue-only on-page pass (seo-audit intent + homegrown-otto). Never live-apply. Never start a new crawl. Never buy paid research.\n1. get_niceseo_ops_status.\n2. Read the latest audit with get_audit_status, get_audit_issues, get_audit_pages.\n3. Read get_agency_otto_page_inputs for current title, meta, and H1.\n4. Pick up to 5 priority pages: homepage, plus Search Console landing pages with impressions when get_search_console_performance is available, else pages with the most audit issues. If a source is missing, say not measured.\n5. For each page, if title/meta/H1 is missing, empty, or too long for the page's main query, write a concrete replacement (no placeholders). Call propose_homegrown_otto_fixes with before_* copied from the audit. Pending only.\n6. Call list_homegrown_otto_proposals and list the new ids.\n\nReport: pages checked, proposals queued, pages skipped and why. Never claim a fix is live.",
    cadence: "weekly" as const,
    skillName: null as string | null,
  },
  {
    name: "Keyword portfolio",
    sourceType: "custom" as const,
    customPrompt:
      "Run only for niceseo.ai. Other domains: stop and say this loop is dogfood-only.\n\nAnalyze keyword portfolio health from data we already have. Do not buy keyword research. Do not save keywords. Do not call research_keywords, get_keyword_metrics, or save_keywords.\n1. get_niceseo_ops_status.\n2. list_saved_keywords.\n3. get_rank_tracker (free read).\n4. get_search_console_performance when Search Console is connected (high rowLimit). Filter client-side. Do not invent numbers.\n\nSay, with proof or \"not measured\":\n- How many saved or tracked terms exist.\n- Wasted or declining terms (rank drop or Search Console clicks down).\n- Near-page-one terms (positions 5–20) worth a push.\n- Concentration risk if most clicks sit on one or two queries.\n\nEnd with one do-this-month action an agent can take: site, page, do, do-not, proof. Never claim live changes.",
    cadence: "monthly" as const,
    skillName: null as string | null,
  },
] as const;

/** Soak trigger may fire at most this many loops per POST (matches default set). */
export const DOGFOOD_SAM_LOOP_TRIGGER_CAP = DEFAULT_SAM_LOOP_TEMPLATES.length;

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
