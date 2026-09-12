import type { ToolSet } from "ai";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";

/**
 * Fail-closed allowlist for headless Sam Loops.
 *
 * Only free/first-party readers the seeded loop skills need, plus the single
 * allowed write (`propose_homegrown_otto_fixes`). Paid DataForSEO research
 * fan-outs, mutating tools, and anything not named here are excluded by
 * default — new tools stay blocked until explicitly added.
 */
export const LOOP_ALLOWED_TOOLS = new Set([
  // Free site scrape (no credits)
  "map_links",
  "read_pages",
  // Account / free DB reads
  "whoami",
  "get_product_info",
  "list_saved_keywords",
  "get_niceseo_ops_status",
  "get_agency_score_inputs",
  "get_agency_otto_page_inputs",
  "list_homegrown_otto_proposals",
  // Audit readers (not run_site_audit)
  "get_audit_status",
  "get_audit_issues",
  "get_audit_pages",
  // Rank readers (not create/add/remove/run)
  "get_rank_tracker",
  "estimate_rank_tracker_cost",
  // GSC readers
  "get_search_console_performance",
  "inspect_urls",
  // GA4 readers (connected property; no DataForSEO)
  "get_google_analytics_organic_landing_pages",
  "get_google_analytics_page_performance",
  "get_google_analytics_key_events",
  "get_search_opportunities",
  "get_google_analytics_organic_overview",
  "get_google_analytics_traffic_acquisition",
  "get_google_analytics_measurement_health",
  "get_google_analytics_ecommerce_performance",
  "get_google_analytics_site_search",
  "get_google_analytics_audience_breakdown",
  // Loop introspection (read-only)
  "list_sam_loops",
  "get_sam_loop_runs",
  // Stored AI-visibility trend (no new paid check)
  "get_ai_visibility_trend",
  // GBP public-data readers (bounded DataForSEO cost ~$0.003–0.008/call;
  // per-run call cap enforced in capLoopToolCalls below)
  "get_business_profile",
  "get_business_reviews",
  // Sole allowed write — queues proposals; never deploys
  "propose_homegrown_otto_fixes",
]);

/** Per-run call caps for tools that cost money per invocation. */
export const LOOP_TOOL_CALL_CAPS: Record<string, number> = {
  // GBP collections are async (start + several polls + transient failures);
  // refuse beyond that so a looping model can never scale spend with calls.
  // Worst case at the cap: 24 calls/run ≈ $0.19 (at ≤$0.008/call). The yearly
  // ceiling scales with the loop's cadence — ≈$2 monthly, ≈$10 weekly, ≈$70 if
  // a user switches a GBP loop to daily. Cadence is user-editable, so this cap
  // (not the seeded cadence) is the actual cost control.
  get_business_profile: 12,
  get_business_reviews: 12,
};

/**
 * The GBP public-data readers. Kept as an explicit set so scoping never
 * couples to "is it capped" — a cap on a non-GBP tool must not gate it.
 */
const LOOP_GBP_TOOLS: ReadonlySet<string> = new Set([
  "get_business_profile",
  "get_business_reviews",
]);

/**
 * Enforce LOOP_TOOL_CALL_CAPS: after the cap a tool throws, telling the model
 * to report "not measured" instead of retrying. Prompt text is not a cost
 * control; this wrapper is. One instance per run — the counter Map lives and
 * dies with the returned tool set, so build exactly one set per run.
 */
export function capLoopToolCalls(tools: ToolSet): ToolSet {
  const counts = new Map<string, number>();
  const out: ToolSet = {};
  for (const [name, toolEntry] of Object.entries(tools)) {
    const cap = LOOP_TOOL_CALL_CAPS[name];
    if (cap == null || toolEntry == null) {
      out[name] = toolEntry;
      continue;
    }
    if (typeof toolEntry.execute !== "function") {
      // Fail closed: a paid tool we cannot wrap would run UNCAPPED. A capped
      // tool without a callable execute is a build-time bug, not a pass-through.
      throw new Error(
        `${name} is call-capped but has no wrappable execute; refusing to expose it uncapped`,
      );
    }
    counts.set(name, 0);
    out[name] = {
      ...toolEntry,
      execute: async (args: unknown, options: unknown) => {
        const n = (counts.get(name) ?? 0) + 1;
        counts.set(name, n);
        if (n > cap) {
          throw new Error(
            `${name} call cap reached for this run (${cap}). Report "not measured" instead of retrying.`,
          );
        }
        return (
          toolEntry as { execute: (a: unknown, o: unknown) => unknown }
        ).execute(args, options);
      },
    } as ToolSet[string];
  }
  return out;
}

/** Keep only allowlisted Sam tools so loops fail closed on unknown keys. */
export function filterLoopTools(tools: ToolSet): ToolSet {
  const filtered: ToolSet = {};
  for (const [name, toolEntry] of Object.entries(tools)) {
    if (!LOOP_ALLOWED_TOOLS.has(name)) continue;
    filtered[name] = toolEntry;
  }
  return filtered;
}

/**
 * Per-loop capability, keyed by the loop's TEMPLATE IDENTITY: the stored
 * customPrompt must byte-match an approved template, and the capability comes
 * from that template's declared capabilities — never from the display name
 * (user-controllable) and never from grepping prompt prose (a "Never call X"
 * sentence would otherwise grant X).
 *
 * The door-closer is this exact-match map itself: scoping is fail-closed, so
 * any stored prompt that does not byte-match an approved template gets ZERO
 * capabilities, whatever the loop is named or its prompt claims. Because the
 * template prompts ship in the client bundle, a user could submit a byte-
 * identical copy — SamLoopService rejects that on create AND on update
 * (reserved-prompt rule). That rule is an anti-spoofing complement at the
 * write path; it is not what gates scoping — an unrecognized prompt is
 * denied here regardless.
 *
 * TRACKED FOLLOW-UP: this map keys capability on mutable, user-editable
 * prompt text — a proxy. The durable fix is a stable templateKey recorded at
 * seed time (a schema change, deliberately out of scope for this diff).
 * Until then the reserved-prompt write-path rules in SamLoopService (create
 * + update, with the template-family carve-out) defend the proxy, and
 * scopeLoopTools warns when a loop named like a template no longer
 * matches it.
 */
function templatePromptFor(name: string): string | null {
  const t = DEFAULT_SAM_LOOP_TEMPLATES.find((x) => x.name === name);
  return t && t.sourceType === "custom" && t.customPrompt
    ? t.customPrompt
    : null;
}

function capabilityEntry(
  name: string,
  caps: { write: boolean; gbp: boolean },
): [string, { write: boolean; gbp: boolean }][] {
  // A renamed/removed template yields NO entry instead of a module-load
  // crash — drift is caught loudly by the cross-check test at CI, which is
  // where it belongs; importing this module must never take loop execution
  // down in a cold start.
  const prompt = templatePromptFor(name);
  return prompt ? [[prompt, caps]] : [];
}

/** Exported for tests: the cross-check iterates it as scoping ground truth. */
export const TEMPLATE_CAPABILITIES = new Map<
  string,
  { write: boolean; gbp: boolean }
>([
  ...capabilityEntry("On-page priorities", { write: true, gbp: false }),
  ...capabilityEntry("CTR opportunities", { write: true, gbp: false }),
  ...capabilityEntry("Review watch", { write: false, gbp: true }),
  ...capabilityEntry("GBP drift", { write: false, gbp: true }),
  // Read-only by design (the draft goes in the report, analysis only) —
  // declared explicitly so a new template left out of this map fails the
  // cross-check test instead of silently inheriting the fail-closed default.
  ...capabilityEntry("Monthly content", { write: false, gbp: false }),
  ...capabilityEntry("Keyword portfolio", { write: false, gbp: false }),
]);

/**
 * Scope the write tool and the paid GBP tools to the loops that own them —
 * LOOP_ALLOWED_TOOLS is global; per-loop scope is the actual contract.
 * Skill loops get ZERO extra capabilities by construction: the capabilities
 * lookup only runs for custom loops, so a skill loop never sees the write or
 * GBP tools no matter what its skill body says.
 */
export function scopeLoopTools(
  tools: ToolSet,
  loop: { sourceType: string; customPrompt: string | null; loopName?: string },
): ToolSet {
  const caps =
    loop.sourceType === "custom" && loop.customPrompt != null
      ? TEMPLATE_CAPABILITIES.get(loop.customPrompt)
      : undefined;
  if (loop.sourceType === "custom" && loop.customPrompt != null && !caps) {
    // A custom loop whose prompt matches no approved template runs with
    // readers only — the NORMAL state for user-authored loops, so stay quiet
    // there (a per-cycle warn would be noise operators learn to ignore). But
    // a loop NAMED like a template whose prompt no longer matches is a seeded
    // loop that was edited away from its template: degraded — warn. (A
    // renamed-then-edited seeded loop escapes this heuristic; the tracked
    // templateKey follow-up is the durable fix.)
    if (
      loop.loopName != null &&
      DEFAULT_SAM_LOOP_TEMPLATES.some((t) => t.name === loop.loopName)
    ) {
      console.warn(
        `scopeLoopTools: loop "${loop.loopName}" is named like an approved template but its prompt no longer matches it — running with readers only (edited template prompt? restore via starter loops)`,
      );
    }
  }
  const { write, gbp } = caps ?? { write: false, gbp: false };
  const out: ToolSet = {};
  for (const [name, toolEntry] of Object.entries(tools)) {
    if (!write && name === "propose_homegrown_otto_fixes") continue;
    if (!gbp && LOOP_GBP_TOOLS.has(name)) continue;
    out[name] = toolEntry;
  }
  return out;
}

/**
 * The intended entry point for assembling a loop's tool set: allowlist →
 * per-loop scope → per-run cost caps. Tests build the stages individually;
 * production should not — the only production caller is runHeadlessSamLoop.
 *
 * INVARIANT — exactly ONE tool set per loop run: the cost-cap counters inside
 * capLoopToolCalls live and die with the returned set. Reusing one set across
 * runs shares counters (caps trip early); building two sets for one run splits
 * them (each set gets its own cap, multiplying spend). This is a documented
 * convention, not an enforced one.
 */
export function buildScopedLoopTools(
  tools: ToolSet,
  loop: { sourceType: string; customPrompt: string | null; loopName?: string },
): ToolSet {
  return capLoopToolCalls(scopeLoopTools(filterLoopTools(tools), loop));
}
