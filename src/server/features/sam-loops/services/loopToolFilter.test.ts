import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import {
  LOOP_ALLOWED_TOOLS,
  capLoopToolCalls,
  filterLoopTools,
} from "./loopToolFilter";

describe("filterLoopTools", () => {
  const stub = { execute: async () => null };

  it("keeps allowlisted readers and propose_homegrown_otto_fixes", () => {
    const tools = {
      propose_homegrown_otto_fixes: stub,
      list_homegrown_otto_proposals: stub,
      get_audit_issues: stub,
      get_rank_tracker: stub,
      get_search_console_performance: stub,
      get_ai_visibility_trend: stub,
      update_project_context: stub,
      save_keywords: stub,
      create_rank_tracker: stub,
      add_rank_tracking_keywords: stub,
      remove_rank_tracking_keywords: stub,
      run_rank_tracker: stub,
      run_site_audit: stub,
      research_keywords: stub,
      get_backlinks_overview: stub,
    } as unknown as ToolSet;

    const filtered = filterLoopTools(tools);
    expect(Object.keys(filtered).sort()).toEqual([
      "get_ai_visibility_trend",
      "get_audit_issues",
      "get_rank_tracker",
      "get_search_console_performance",
      "list_homegrown_otto_proposals",
      "propose_homegrown_otto_fixes",
    ]);
  });

  it("blocks an unknown/new tool key by default (fail closed)", () => {
    const tools = {
      propose_homegrown_otto_fixes: stub,
      get_audit_issues: stub,
      brand_new_paid_research_tool: stub,
      future_write_surface: stub,
    } as unknown as ToolSet;

    const filtered = filterLoopTools(tools);
    expect(filtered.brand_new_paid_research_tool).toBeUndefined();
    expect(filtered.future_write_surface).toBeUndefined();
    expect(Object.keys(filtered).sort()).toEqual([
      "get_audit_issues",
      "propose_homegrown_otto_fixes",
    ]);
    expect(LOOP_ALLOWED_TOOLS.has("brand_new_paid_research_tool")).toBe(false);
  });

  it("excludes paid DataForSEO research fan-outs", () => {
    const tools = {
      get_audit_issues: stub,
      research_keywords: stub,
      get_domain_overview: stub,
      get_domain_keyword_suggestions: stub,
      get_backlinks_overview: stub,
      get_backlinks_profile: stub,
      get_serp_results: stub,
      get_ranked_keywords: stub,
      find_serp_competitors: stub,
      get_keyword_metrics: stub,
      get_ai_brand_visibility: stub,
      explore_ai_prompt: stub,
    } as unknown as ToolSet;

    const filtered = filterLoopTools(tools);
    expect(Object.keys(filtered)).toEqual(["get_audit_issues"]);
  });

  it("keeps the bounded GBP readers while other paid tools stay blocked", () => {
    const tools = {
      get_business_profile: stub,
      get_business_reviews: stub,
      get_audit_issues: stub,
      research_keywords: stub,
      get_domain_overview: stub,
    } as unknown as ToolSet;

    const filtered = filterLoopTools(tools);
    expect(Object.keys(filtered).sort()).toEqual([
      "get_audit_issues",
      "get_business_profile",
      "get_business_reviews",
    ]);
  });

  it("capLoopToolCalls enforces the per-run cap and throws past it", async () => {
    let calls = 0;
    const tools = {
      get_business_reviews: {
        execute: async () => {
          calls += 1;
          return { ok: true };
        },
      },
      get_audit_issues: {
        execute: async () => ({ ok: true }),
      },
    } as unknown as ToolSet;

    const capped = capLoopToolCalls(tools);
    const run = capped.get_business_reviews as unknown as {
      execute: (a: unknown, o: unknown) => Promise<unknown>;
    };
    for (let i = 0; i < 5; i += 1) {
      await run.execute({}, {});
    }
    expect(calls).toBe(5);
    await expect(run.execute({}, {})).rejects.toThrow(/call cap reached/);
    expect(calls).toBe(5);

    const uncapped = capped.get_audit_issues as unknown as {
      execute: (a: unknown, o: unknown) => Promise<unknown>;
    };
    for (let i = 0; i < 7; i += 1) {
      await uncapped.execute({}, {});
    }
  });
});
