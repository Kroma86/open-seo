import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";
import { LOOP_ALLOWED_TOOLS, filterLoopTools } from "./loopToolFilter";

describe("filterLoopTools", () => {
  const stub = { execute: async () => null };

  it("keeps allowlisted readers and propose_homegrown_otto_fixes", () => {
    const tools = {
      propose_homegrown_otto_fixes: stub,
      list_homegrown_otto_proposals: stub,
      get_audit_issues: stub,
      get_rank_tracker: stub,
      get_search_console_performance: stub,
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
});
