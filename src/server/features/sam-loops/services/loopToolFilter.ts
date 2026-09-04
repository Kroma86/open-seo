import type { ToolSet } from "ai";

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
  // GBP collections are async (start + a few polls); refuse beyond that so a
  // looping model can never scale spend with invocations.
  get_business_profile: 5,
  get_business_reviews: 5,
};

/**
 * Enforce LOOP_TOOL_CALL_CAPS: after the cap a tool throws, telling the model
 * to report "not measured" instead of retrying. Prompt text is not a cost
 * control; this wrapper is.
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
