import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SAM_LOOP_TEMPLATES,
  DOGFOOD_SAM_LOOP_TRIGGER_CAP,
  SAM_LOOP_STEP_CAP,
  computeNextSamLoopRunAt,
} from "@/shared/sam-loops";
import * as rankTracking from "@/shared/rank-tracking";

describe("sam-loops shared helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("exposes the ten default templates and a 24-step cap", () => {
    expect(SAM_LOOP_STEP_CAP).toBe(24);
    expect(DEFAULT_SAM_LOOP_TEMPLATES).toHaveLength(10);
    expect(DOGFOOD_SAM_LOOP_TRIGGER_CAP).toBe(10);
    expect(
      DEFAULT_SAM_LOOP_TEMPLATES.filter(
        (t) => t.sourceType === "skill",
      ).map((t) => t.skillName),
    ).toEqual([
      "site-health",
      "rank-slippage",
      "niceseo-pillars",
      "page-growth",
      "authority-plan",
      "ai-visibility",
      "striking-distance",
    ]);
    const byName = Object.fromEntries(
      DEFAULT_SAM_LOOP_TEMPLATES.map((t) => [t.name, t]),
    );
    const monthlyContent = byName["Monthly content"];
    expect(monthlyContent?.sourceType).toBe("custom");
    expect(monthlyContent?.cadence).toBe("monthly");
    expect(monthlyContent?.customPrompt).toContain("content-topical-map");
    expect(monthlyContent?.customPrompt).toContain("content-brief");
    expect(monthlyContent?.customPrompt).toContain("content-draft");
    expect(monthlyContent?.customPrompt).toContain("DRAFT");
    expect(monthlyContent?.customPrompt).toContain("human review");

    const onPage = byName["On-page priorities"];
    expect(onPage?.sourceType).toBe("custom");
    expect(onPage?.cadence).toBe("weekly");
    expect(onPage?.customPrompt).toContain("niceseo.ai");
    expect(onPage?.customPrompt).toContain("too soon — skip");
    expect(onPage?.customPrompt).toContain("propose_homegrown_otto_fixes");
    expect(onPage?.customPrompt).toContain("Pending only");
    expect(onPage?.customPrompt).not.toContain("run_site_audit");

    const keywords = byName["Keyword portfolio"];
    expect(keywords?.sourceType).toBe("custom");
    expect(keywords?.cadence).toBe("monthly");
    expect(keywords?.customPrompt).toContain("niceseo.ai");
    expect(keywords?.customPrompt).toContain("Do not buy keyword research");
    expect(keywords?.customPrompt).toContain("research_keywords");
    expect(keywords?.customPrompt).toContain("save_keywords");
  });

  it("advances daily/weekly from the previous anchor without drift", () => {
    expect(
      computeNextSamLoopRunAt("daily", "2026-03-14T05:30:00.000Z"),
    ).toBe("2026-03-16T05:30:00.000Z");
    expect(
      computeNextSamLoopRunAt("weekly", "2026-03-08T05:30:00.000Z"),
    ).toBe("2026-03-22T05:30:00.000Z");
  });

  it("advances monthly to a later end-of-month after the anchor", () => {
    expect(
      computeNextSamLoopRunAt("monthly", "2026-02-28T05:30:00.000Z"),
    ).toBe("2026-03-31T05:30:00.000Z");
  });

  it("clamps to now+interval when the computed next time is in the past", () => {
    const fromNow = "2026-03-16T08:00:00.000Z";
    vi.spyOn(rankTracking, "computeNextCheckAt")
      .mockReturnValueOnce("2020-01-01T00:00:00.000Z")
      .mockReturnValueOnce(fromNow);

    expect(
      computeNextSamLoopRunAt("daily", "2019-12-31T00:00:00.000Z"),
    ).toBe(fromNow);

    expect(rankTracking.computeNextCheckAt).toHaveBeenCalledTimes(2);
    expect(rankTracking.computeNextCheckAt).toHaveBeenNthCalledWith(
      1,
      "daily",
      "2019-12-31T00:00:00.000Z",
    );
    expect(rankTracking.computeNextCheckAt).toHaveBeenNthCalledWith(2, "daily");
  });
});
