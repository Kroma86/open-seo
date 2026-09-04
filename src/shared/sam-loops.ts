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
      "Run only for niceseo.ai, twa.studio, or niceapp.ai. Other domains: stop and say this loop is house-domains-only.\n\nThe scheduler only has weekly, not every-two-weeks. Treat this as every two weeks: call get_sam_loop_runs for this project. If this loop already has a completed run with a report in the last 12 days, write \"too soon — skip\" and stop. Do not queue.\n\nQueue-only on-page pass (seo-audit intent + homegrown-otto). Never live-apply. Never start a new crawl. Never buy paid research.\n1. get_niceseo_ops_status.\n2. Read the latest audit with get_audit_status, get_audit_issues, get_audit_pages.\n3. Read get_agency_otto_page_inputs for current title, meta, and H1.\n4. Pick up to 5 priority pages: homepage, plus Search Console landing pages with impressions when get_search_console_performance is available, else pages with the most audit issues. If a source is missing, say not measured.\n5. For each page, if title/meta/H1 is missing, empty, or too long for the page's main query, write a concrete replacement (no placeholders). Call propose_homegrown_otto_fixes with before_* copied from the audit. Pending only.\n6. Call list_homegrown_otto_proposals and list the new ids.\n\nReport: pages checked, proposals queued, pages skipped and why. Never claim a fix is live.",
    cadence: "weekly" as const,
    skillName: null as string | null,
  },
  {
    name: "Keyword portfolio",
    sourceType: "custom" as const,
    customPrompt:
      "Run only for niceseo.ai, twa.studio, or niceapp.ai. Other domains: stop and say this loop is house-domains-only.\n\nAnalyze keyword portfolio health from data we already have. Do not buy keyword research. Do not save keywords. Do not call research_keywords, get_keyword_metrics, or save_keywords.\n1. get_niceseo_ops_status.\n2. list_saved_keywords.\n3. get_rank_tracker (free read).\n4. get_search_console_performance when Search Console is connected (high rowLimit). Filter client-side. Do not invent numbers.\n\nSay, with proof or \"not measured\":\n- How many saved or tracked terms exist.\n- Wasted or declining terms (rank drop or Search Console clicks down).\n- Near-page-one terms (positions 5–20) worth a push.\n- Concentration risk if most clicks sit on one or two queries.\n\nEnd with one do-this-month action an agent can take: site, page, do, do-not, proof. Never claim live changes.",
    cadence: "monthly" as const,
    skillName: null as string | null,
  },
  {
    name: "Review watch",
    sourceType: "custom" as const,
    customPrompt:
      "You run weekly for every client. Read-only: never queue fixes, never post anything anywhere, never buy paid research beyond the single review collection described here.\n1. get_niceseo_ops_status for context.\n2. get_business_reviews for this project's business. If a collection is already running, wait for the taskId to finish instead of starting a second one. If reviews cannot be fetched, say \"not measured\" and stop.\n3. List reviews from the last 7 days: author, star rating, date, whether the owner replied.\n4. Flag any review at 3 stars or lower without an owner reply as NEEDS A REPLY, with a one-sentence suggested reply the owner can edit (never post it).\n5. If there are no new reviews, say so plainly and stop — a quiet week is a good report, keep it to two sentences.\nReport: new reviews count, average rating this week, the NEEDS A REPLY list, and one praise-worthy quote when one exists. Plain English the owner can read in Slack.",
    cadence: "weekly" as const,
    skillName: null as string | null,
  },
  {
    name: "GBP drift",
    sourceType: "custom" as const,
    customPrompt:
      "You run monthly for every client. Read-only: never queue fixes, never post anywhere.\n1. get_business_profile for this project's business. If it cannot be fetched, say \"not measured\" and stop.\n2. Compare against the values from your last completed run (call get_sam_loop_runs for this project and read your previous report). First run: record the current values and say \"baseline recorded\".\n3. Report only CHANGES: business hours, phone number, categories, description, website link. For each change: old value → new value, and whether it looks intentional (e.g. holiday hours) or suspicious (e.g. phone number changed with no other edit).\n4. If nothing changed, one line: \"Profile unchanged since <date>.\"\nNever invent a previous value. When unsure, say not measured.",
    cadence: "monthly" as const,
    skillName: null as string | null,
  },
  {
    name: "CTR opportunities",
    sourceType: "custom" as const,
    customPrompt:
      "You run monthly for every client. You may only propose title and description fixes (pending only, never published). Never propose H1, schema, og tags, canonicals, or content. Never buy paid research.\n1. get_search_console_performance for this project (query+page rows, high rowLimit). If Search Console is not connected, say \"not measured\" and stop.\n2. From the last 28 days, find up to 3 queries with: position 5–20, impressions ≥ 30, and CTR ≤ 1%. Rank them by impressions.\n3. For each: identify the ranking page, read its current title and description (get_agency_otto_page_inputs), and draft a replacement title (≤60 chars) and description (≤155 chars) that matches the query's intent using only facts from the page. No invented claims, no clickbait.\n4. Call propose_homegrown_otto_fixes with status pending for title and description only, copying before_* from the page inputs. List the proposal ids.\n5. If nothing qualifies, say so in one sentence — that is a good report.\nReport: the query, its position/impressions/CTR, the page, and the proposed new title/description. Never claim a fix is live.",
    cadence: "monthly" as const,
    skillName: null as string | null,
  },
] as const;

/** Soak trigger may fire at most this many loops per POST (matches default set). */
export const DOGFOOD_SAM_LOOP_TRIGGER_CAP = DEFAULT_SAM_LOOP_TEMPLATES.length;

/** The only domains Sam loops may run for until Jon names the next cutover. */
export const SAM_LOOP_ALLOWED_DOMAINS = [
  "niceseo.ai",
  "twa.studio",
  "niceapp.ai",
] as const;

/** Default ceiling on Sam loop runs created per UTC day (scheduled + manual). */
export const SAM_LOOP_DAILY_RUN_CAP_DEFAULT = 40;

/** Client-safe alias; server code should call getSamLoopDailyRunCap(env). */
export const SAM_LOOP_DAILY_RUN_CAP = SAM_LOOP_DAILY_RUN_CAP_DEFAULT;

export function isSamLoopDomainAllowed(
  domain: string | null | undefined,
): boolean {
  if (domain == null) return false;
  let host = domain.trim().toLowerCase();
  if (host.startsWith("https://")) host = host.slice("https://".length);
  else if (host.startsWith("http://")) host = host.slice("http://".length);
  const slash = host.indexOf("/");
  if (slash !== -1) host = host.slice(0, slash);
  if (host.startsWith("www.")) host = host.slice(4);
  if (!host) return false;
  return (SAM_LOOP_ALLOWED_DOMAINS as readonly string[]).includes(host);
}

export function isSamLoopProjectAllowed(project: {
  domain: string | null | undefined;
  loopsEnabled?: boolean | null;
}): boolean {
  if (project.domain == null || project.domain.trim() === "") return false;
  return isSamLoopDomainAllowed(project.domain) || project.loopsEnabled === true;
}

/** UTC calendar date `YYYY-MM-DD` (a date prefix, not a full ISO timestamp). */
export function startOfUtcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

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

/** FNV-1a 32-bit hash of `seed` (UTF-8) — deterministic across engines. */
function fnv1a32(seed: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(seed)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash;
}

/**
 * Deterministic per-loop schedule spread: stable day offset for a seed
 * (conventionally `${projectId}:${loopName}`) so loops of a cadence do not
 * all land on the same day. 0–6 for weekly, 0–27 for monthly.
 */
export function samLoopSpreadOffsetDays(
  seed: string,
  cadence: "weekly" | "monthly",
): number {
  return fnv1a32(seed) % (cadence === "weekly" ? 7 : 28);
}

/**
 * Reuse rank-tracking schedule math (daily / weekly / end-of-month).
 * If the computed next time is still in the past (stale anchor / clock skew),
 * re-anchor one full interval from now so downtime cannot stampede catch-up.
 *
 * `spreadSeed` (conventionally `${projectId}:${loopName}`) spreads loops of a
 * cadence across days with ONE rule shared with the D1 stagger migration
 * (scripts/sam-loop-stagger-20260903.py), so the app advance and the
 * migration never fight over a loop's date:
 * - monthly (seed AND advance): the assigned month-day 1 + hash%28 of the
 *   current month at the computeNextCheckAt result's time-of-day, rolling
 *   to the following month when that moment has passed. Offset 0 lands on
 *   day 1 — never a bare end-of-month cliff.
 * - weekly (seed AND advance): the next occurrence of the assigned weekday
 *   (hash%7, 0 = Monday) from today at the computeNextCheckAt result's
 *   time-of-day, adding one interval when that moment has passed. For an
 *   anchor already carrying the assigned weekday this equals the plain
 *   +7-day advance — a fixed point, so the weekday never walks. For a
 *   stale or pre-spread anchor (missed cycles, cliff loops) it re-spreads
 *   the loop onto its assigned weekday.
 * - daily always ignores the seed (the scheduler already spaces dailies).
 */
export function computeNextSamLoopRunAt(
  cadence: SamLoopCadence,
  previousNextRunAt?: string | null,
  spreadSeed?: string,
): string {
  const next = computeNextCheckAt(cadence, previousNextRunAt);
  const resolved =
    new Date(next).getTime() > Date.now() ? next : computeNextCheckAt(cadence);
  if (spreadSeed == null || cadence === "daily") return resolved;

  const now = new Date();
  const time = new Date(resolved);
  const timeParts = [
    time.getUTCHours(),
    time.getUTCMinutes(),
    time.getUTCSeconds(),
    time.getUTCMilliseconds(),
  ] as const;

  if (cadence === "monthly") {
    const assignedDay = 1 + samLoopSpreadOffsetDays(spreadSeed, "monthly");
    let candidate = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        assignedDay,
        ...timeParts,
      ),
    );
    if (candidate.getTime() <= now.getTime()) {
      candidate = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth() + 1,
          assignedDay,
          ...timeParts,
        ),
      );
    }
    return candidate.toISOString();
  }

  // weekly — assigned weekday (0 = Monday) next occurring from today.
  const assigned = samLoopSpreadOffsetDays(spreadSeed, "weekly");
  const nowDow = (now.getUTCDay() + 6) % 7; // JS Sun=0..Sat=6 → Mon=0..Sun=6
  const daysAhead = (assigned - nowDow + 7) % 7;
  let candidate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + daysAhead,
      ...timeParts,
    ),
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate = new Date(candidate.getTime() + 7 * 86_400_000);
  }
  return candidate.toISOString();
}
