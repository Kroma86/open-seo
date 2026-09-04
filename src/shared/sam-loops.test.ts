import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SAM_LOOP_TEMPLATES,
  DOGFOOD_SAM_LOOP_TRIGGER_CAP,
  SAM_LOOP_ALLOWED_DOMAINS,
  SAM_LOOP_DAILY_RUN_CAP,
  SAM_LOOP_STEP_CAP,
  computeNextSamLoopRunAt,
  isSamLoopDomainAllowed,
  isSamLoopProjectAllowed,
  samLoopSpreadOffsetDays,
  startOfUtcDay,
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

  it("exposes the thirteen default templates and a 24-step cap", () => {
    expect(SAM_LOOP_STEP_CAP).toBe(24);
    expect(DEFAULT_SAM_LOOP_TEMPLATES).toHaveLength(13);
    expect(DOGFOOD_SAM_LOOP_TRIGGER_CAP).toBe(13);
    expect(DOGFOOD_SAM_LOOP_TRIGGER_CAP).toBe(DEFAULT_SAM_LOOP_TEMPLATES.length);
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
    const monthlyContent = DEFAULT_SAM_LOOP_TEMPLATES[7];
    expect(monthlyContent.name).toBe("Monthly content");
    expect(monthlyContent.sourceType).toBe("custom");
    expect(monthlyContent.cadence).toBe("monthly");
    expect(monthlyContent.customPrompt).toContain("content-topical-map");
    expect(monthlyContent.customPrompt).toContain("content-brief");
    expect(monthlyContent.customPrompt).toContain("content-draft");
    expect(monthlyContent.customPrompt).toContain("DRAFT");
    expect(monthlyContent.customPrompt).toContain("human review");

    const onPage = DEFAULT_SAM_LOOP_TEMPLATES[8];
    expect(onPage.name).toBe("On-page priorities");
    expect(onPage.sourceType).toBe("custom");
    expect(onPage.cadence).toBe("weekly");
    expect(onPage.customPrompt).toContain("niceseo.ai");
    expect(onPage.customPrompt).toContain("twa.studio");
    expect(onPage.customPrompt).toContain("too soon — skip");
    expect(onPage.customPrompt).toContain("propose_homegrown_otto_fixes");
    expect(onPage.customPrompt).toContain("Pending only");
    expect(onPage.customPrompt).not.toContain("run_site_audit");

    const keywords = DEFAULT_SAM_LOOP_TEMPLATES[9];
    expect(keywords.name).toBe("Keyword portfolio");
    expect(keywords.sourceType).toBe("custom");
    expect(keywords.cadence).toBe("monthly");
    expect(keywords.customPrompt).toContain("niceseo.ai");
    expect(keywords.customPrompt).toContain("twa.studio");
    expect(keywords.customPrompt).toContain("Do not buy keyword research");
    expect(keywords.customPrompt).toContain("research_keywords");
    expect(keywords.customPrompt).toContain("save_keywords");

    const reviewWatch = DEFAULT_SAM_LOOP_TEMPLATES[10];
    expect(reviewWatch.name).toBe("Review watch");
    expect(reviewWatch.sourceType).toBe("custom");
    expect(reviewWatch.skillName).toBeNull();
    expect(reviewWatch.cadence).toBe("weekly");
    expect(reviewWatch.customPrompt).toContain("get_business_reviews");
    expect(reviewWatch.customPrompt).toContain("NEEDS A REPLY");
    expect(reviewWatch.customPrompt).toContain("Read-only");
    expect(reviewWatch.customPrompt).toContain("never queue fixes");
    expect(reviewWatch.customPrompt).toContain("never post anything");

    const gbpDrift = DEFAULT_SAM_LOOP_TEMPLATES[11];
    expect(gbpDrift.name).toBe("GBP drift");
    expect(gbpDrift.sourceType).toBe("custom");
    expect(gbpDrift.skillName).toBeNull();
    expect(gbpDrift.cadence).toBe("monthly");
    expect(gbpDrift.customPrompt).toContain("get_business_profile");
    expect(gbpDrift.customPrompt).toContain("baseline recorded");
    expect(gbpDrift.customPrompt).toContain("get_sam_loop_runs");
    expect(gbpDrift.customPrompt).toContain("Read-only");
    expect(gbpDrift.customPrompt).toContain("never queue fixes");
    expect(gbpDrift.customPrompt).toContain("never post anywhere");

    const ctr = DEFAULT_SAM_LOOP_TEMPLATES[12];
    expect(ctr.name).toBe("CTR opportunities");
    expect(ctr.sourceType).toBe("custom");
    expect(ctr.skillName).toBeNull();
    expect(ctr.cadence).toBe("monthly");
    expect(ctr.customPrompt).toContain("get_search_console_performance");
    expect(ctr.customPrompt).toContain("propose_homegrown_otto_fixes");
    expect(ctr.customPrompt).toContain("status pending");
    expect(ctr.customPrompt).toContain("pending only, never published");
    expect(ctr.customPrompt).toContain(
      "Never propose H1, schema, og tags, canonicals, or content",
    );
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

  it("gates house domains and exposes the daily run cap", () => {
    expect(SAM_LOOP_ALLOWED_DOMAINS).toEqual([
      "niceseo.ai",
      "twa.studio",
      "niceapp.ai",
    ]);
    expect(isSamLoopDomainAllowed("WWW.TWA.STUDIO ")).toBe(true);
    expect(isSamLoopDomainAllowed("https://twa.studio/page")).toBe(true);
    expect(isSamLoopDomainAllowed("example.com")).toBe(false);
    expect(isSamLoopDomainAllowed(null)).toBe(false);
    expect(startOfUtcDay(new Date("2026-09-01T23:59:59Z"))).toBe("2026-09-01");
    expect(SAM_LOOP_DAILY_RUN_CAP).toBe(40);
  });

  it("ORs the compiled house list with an explicit per-project loopsEnabled flag", () => {
    expect(
      isSamLoopProjectAllowed({ domain: "niceseo.ai", loopsEnabled: false }),
    ).toBe(true);
    expect(
      isSamLoopProjectAllowed({ domain: "example.com", loopsEnabled: true }),
    ).toBe(true);
    expect(
      isSamLoopProjectAllowed({ domain: "example.com", loopsEnabled: false }),
    ).toBe(false);
    expect(isSamLoopProjectAllowed({ domain: "example.com" })).toBe(false);
    expect(
      isSamLoopProjectAllowed({ domain: null, loopsEnabled: true }),
    ).toBe(false);
    expect(
      isSamLoopProjectAllowed({ domain: null, loopsEnabled: false }),
    ).toBe(false);
    expect(
      isSamLoopProjectAllowed({ domain: undefined, loopsEnabled: true }),
    ).toBe(false);
    expect(
      isSamLoopProjectAllowed({ domain: "", loopsEnabled: true }),
    ).toBe(false);
    expect(
      isSamLoopProjectAllowed({ domain: "   ", loopsEnabled: true }),
    ).toBe(false);
  });

  it("samLoopSpreadOffsetDays is deterministic and bounded per cadence", () => {
    const seed = "project_1:Site health";
    const weekly = samLoopSpreadOffsetDays(seed, "weekly");
    const monthly = samLoopSpreadOffsetDays(seed, "monthly");

    // Same seed → same offset.
    expect(samLoopSpreadOffsetDays(seed, "weekly")).toBe(weekly);
    expect(samLoopSpreadOffsetDays(seed, "monthly")).toBe(monthly);

    // Bounds: 0–6 weekly, 0–27 monthly, integer, across many seeds.
    for (let i = 0; i < 200; i += 1) {
      const s = `project_${i}:Loop ${i}`;
      const w = samLoopSpreadOffsetDays(s, "weekly");
      const m = samLoopSpreadOffsetDays(s, "monthly");
      expect(Number.isInteger(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(6);
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(27);
    }
  });

  it("samLoopSpreadOffsetDays varies across loop names for one project", () => {
    const offsets = new Set(
      DEFAULT_SAM_LOOP_TEMPLATES.filter((t) => t.cadence !== "daily").map(
        (t) => samLoopSpreadOffsetDays(`project_1:${t.name}`, t.cadence),
      ),
    );
    // Not a strict spread proof — just that one project's loops don't all
    // pile onto a single day.
    expect(offsets.size).toBeGreaterThan(1);
  });

  it("computeNextSamLoopRunAt seeds weekly onto the assigned weekday", () => {
    // computeNextCheckAt without an anchor uses a random hour, so stub it to
    // make the base time-of-day deterministic; the spread math is under test.
    vi.spyOn(rankTracking, "computeNextCheckAt").mockReturnValue(
      "2026-03-20T05:00:00.000Z",
    );
    // Fake now is Sunday 2026-03-15T12:00Z. Seed assigns weekday 4 = Friday,
    // next occurring Friday 2026-03-20 at the base's 05:00.
    const seed = "project_1:Site health";
    expect(samLoopSpreadOffsetDays(seed, "weekly")).toBe(4);

    const seeded = computeNextSamLoopRunAt("weekly", undefined, seed);
    expect(seeded).toBe("2026-03-20T05:00:00.000Z");
    expect(new Date(seeded).getUTCDay()).toBe(5); // Friday
    expect(new Date(seeded).getTime()).toBeGreaterThan(Date.now());
  });

  it("computeNextSamLoopRunAt seeds monthly onto the assigned month-day", () => {
    vi.spyOn(rankTracking, "computeNextCheckAt").mockReturnValue(
      "2026-03-20T05:00:00.000Z",
    );
    // Seed assigns month-day 1 + 11 = 12; March 12 at 05:00 has passed
    // relative to fake now (March 15 12:00), so it rolls to April 12.
    const seed = "project_1:Site health";
    const seeded = computeNextSamLoopRunAt("monthly", undefined, seed);
    expect(seeded).toBe("2026-04-12T05:00:00.000Z");
    expect(new Date(seeded).getUTCDate()).toBe(
      1 + samLoopSpreadOffsetDays(seed, "monthly"),
    );

    // Offset 0 lands on day 1, never a bare end-of-month.
    let zeroSeed = "";
    for (let i = 0; i < 500; i += 1) {
      if (samLoopSpreadOffsetDays(`zero_${i}`, "monthly") === 0) {
        zeroSeed = `zero_${i}`;
        break;
      }
    }
    expect(zeroSeed).not.toBe("");
    const zero = new Date(
      computeNextSamLoopRunAt("monthly", undefined, zeroSeed),
    );
    expect(zero.getUTCDate()).toBe(1);
  });

  it("computeNextSamLoopRunAt does not walk a weekly advance on the assigned weekday", () => {
    // Anchor already carries the assigned weekday (Friday, hash%7 = 4): the
    // seeded advance must equal the plain +7d advance — a fixed point.
    const anchor = "2026-03-13T05:30:00.000Z"; // Friday, 2d before fake now
    const seed = "project_1:Site health";
    expect(samLoopSpreadOffsetDays(seed, "weekly")).toBe(4); // Friday
    expect(new Date(anchor).getUTCDay()).toBe(5); // anchor IS a Friday
    expect(computeNextSamLoopRunAt("weekly", anchor, seed)).toBe(
      computeNextSamLoopRunAt("weekly", anchor),
    );
    expect(computeNextSamLoopRunAt("weekly", anchor, seed)).toBe(
      "2026-03-20T05:30:00.000Z",
    );
    const next = new Date(computeNextSamLoopRunAt("weekly", anchor, seed));
    expect(next.getUTCDay()).toBe(new Date(anchor).getUTCDay());
  });

  it("computeNextSamLoopRunAt re-spreads a stale weekly anchor", () => {
    // Anchor 42 days in the past (missed cycles, e.g. a pre-spread cliff
    // loop): re-anchor onto the assigned weekday instead of perpetuating
    // the anchor's weekday.
    const anchor = "2026-02-01T05:30:00.000Z"; // Sunday
    const seed = "project_1:Site health";
    const assigned = samLoopSpreadOffsetDays(seed, "weekly"); // 4 = Friday
    const next = new Date(computeNextSamLoopRunAt("weekly", anchor, seed));
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getUTCDay()).toBe((assigned + 1) % 7); // Mon=0 → JS Sun=0
    expect(next.getUTCDay()).not.toBe(new Date(anchor).getUTCDay());
    expect(next.toISOString()).toBe("2026-03-20T05:30:00.000Z");
  });

  it("computeNextSamLoopRunAt lands monthly on the assigned month-day", () => {
    const anchor = "2026-02-28T05:30:00.000Z";
    const seed = "project_1:Site health";
    const assignedDay = 1 + samLoopSpreadOffsetDays(seed, "monthly"); // 12

    // Unseeded keeps the old end-of-month behavior.
    const bareEndOfMonth = computeNextSamLoopRunAt("monthly", anchor);
    expect(bareEndOfMonth).toBe("2026-03-31T05:30:00.000Z");

    // Seeded: day 12 of the current month at the base's 05:30 — already
    // past at fake now (March 15 12:00), so it rolls to April 12. This is
    // the same rule on seed and on every advance.
    const spread = computeNextSamLoopRunAt("monthly", anchor, seed);
    expect(spread).not.toBe(bareEndOfMonth);
    expect(spread).toBe("2026-04-12T05:30:00.000Z");
    expect(new Date(spread).getUTCDate()).toBe(assignedDay);
    expect(new Date(spread).getTime()).toBeGreaterThan(Date.now());
  });

  it("computeNextSamLoopRunAt rolls a routine monthly advance exactly once past the anchor", () => {
    // Anchor is last cycle's scheduled run (the 12th at 05:30); fake now is
    // just past it. The advance must roll exactly one month and land on the
    // same assigned day — no skipped cycles, no re-spread.
    const anchor = "2026-03-12T05:30:00.000Z";
    const seed = "project_1:Site health"; // assigned month-day 12
    const next = computeNextSamLoopRunAt("monthly", anchor, seed);
    expect(next).toBe("2026-04-12T05:30:00.000Z");
    expect(new Date(next).getTime()).toBeGreaterThan(
      new Date(anchor).getTime(),
    );
  });

  it("computeNextSamLoopRunAt ignores the seed for daily cadence", () => {
    const anchor = "2026-03-14T05:30:00.000Z";
    expect(
      computeNextSamLoopRunAt("daily", anchor, "project_1:Rank slippage"),
    ).toBe(computeNextSamLoopRunAt("daily", anchor));
  });

  it("computeNextSamLoopRunAt throws when a monthly anchor is beyond the 36-roll guard", () => {
    // Anchor ~30 years out (corrupt state): the guard can never roll past it
    // — fail loud, never double-fire. The huge margin makes the guard
    // exercise independent of computeNextCheckAt's future-anchor behavior
    // (the initial candidate starts from now's date either way).
    const anchor = new Date(Date.now() + 11000 * 86_400_000).toISOString();
    const seed = "project_1:Site health";
    expect(() => computeNextSamLoopRunAt("monthly", anchor, seed)).toThrow(
      /cannot advance past anchor/,
    );
  });

  it("computeNextSamLoopRunAt throws when a weekly anchor is beyond the 520-roll guard", () => {
    // Anchor ~30 years out: 520 weekly rolls (~10 years) cannot reach it —
    // the same loud failure as the monthly branch, never an unbounded loop.
    const anchor = new Date(Date.now() + 11000 * 86_400_000).toISOString();
    const seed = "project_1:Site health";
    expect(() => computeNextSamLoopRunAt("weekly", anchor, seed)).toThrow(
      /cannot advance past anchor/,
    );
  });

  it("computeNextSamLoopRunAt throws on an unparseable anchor instead of treating it as none", () => {
    const seed = "project_1:Site health";
    expect(() =>
      computeNextSamLoopRunAt("weekly", "not-a-date", seed),
    ).toThrow(/unparseable anchor/);
    expect(() =>
      computeNextSamLoopRunAt("monthly", "not-a-date", seed),
    ).toThrow(/unparseable anchor/);
  });
});
