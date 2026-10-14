import { describe, expect, it } from "vitest";
import {
  FULL_SWEEP_EVERY_WEEKS,
  FULL_SWEEP_MAX_AGE_DAYS,
  decideSweep,
  findReusableLookup,
  fullSweepSlot,
  isFullSweepWeek,
} from "./aiVisibilitySweep";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function weekOn(configId: string, full: boolean): Date {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < FULL_SWEEP_EVERY_WEEKS * 2; i++) {
    const candidate = new Date(start + i * WEEK_MS);
    if (isFullSweepWeek(configId, candidate) === full) return candidate;
  }
  throw new Error(`no ${full ? "full" : "pulse"} week for ${configId}`);
}

const freshLookup = {
  fetchedAt: "2026-01-01T00:00:00.000Z",
  totalMentions: 4,
  partialMentions: false,
  shareOfVoicePct: 10,
  perPlatform: [],
  topCitedSources: [],
};

describe("fullSweepSlot", () => {
  it("is stable for the same id and stays inside 0..3", () => {
    expect(fullSweepSlot("config-a")).toBe(fullSweepSlot("config-a"));
    // FNV-1a 32-bit of "a" is 0xe40c292c.
    expect(fullSweepSlot("a")).toBe(0xe40c292c % FULL_SWEEP_EVERY_WEEKS);
    for (const id of ["a", "b", "config-1"]) {
      const slot = fullSweepSlot(id);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(FULL_SWEEP_EVERY_WEEKS);
    }
  });

  it("spreads a handful of ids across every week slot", () => {
    const slots = new Set<number>();
    for (let i = 0; i < 40; i++) slots.add(fullSweepSlot(`config-${i}`));
    expect(slots).toEqual(new Set([0, 1, 2, 3]));
  });
});

describe("isFullSweepWeek", () => {
  it("matches FNV-1a reference values and epoch week numbers", () => {
    // FNV-1a 32 of "a" is 0xe40c292c; of "config-a" is 0xe5a0892d (slot 1).
    expect(fullSweepSlot("a")).toBe(0xe40c292c % 4);
    expect(fullSweepSlot("config-a")).toBe(1);
    // Epoch weeks 2930..2934; 2933 % 4 === 1 is the only full week.
    expect(
      [
        "2026-03-01",
        "2026-03-08",
        "2026-03-15",
        "2026-03-22",
        "2026-03-29",
      ].map((day) =>
        isFullSweepWeek("config-a", new Date(`${day}T12:00:00.000Z`)),
      ),
    ).toEqual([false, false, false, true, false]);
  });
});

describe("decideSweep", () => {
  const configId = "config-a";

  function scheduled(overrides: {
    now?: Date;
    scheduleInterval?: string;
    lastFreshLookupAt?: string | null;
    trigger?: "manual" | "scheduled";
  }) {
    const now = overrides.now ?? weekOn(configId, false);
    return decideSweep({
      trigger: overrides.trigger ?? "scheduled",
      scheduleInterval: overrides.scheduleInterval ?? "weekly",
      configId,
      now,
      lastFreshLookupAt:
        overrides.lastFreshLookupAt === undefined
          ? new Date(now.getTime() - 2 * DAY_MS).toISOString()
          : overrides.lastFreshLookupAt,
    });
  }

  it("returns full for a manual trigger even on a pulse week with a fresh lookup", () => {
    expect(scheduled({ trigger: "manual" })).toBe("full");
  });

  it("returns full when the schedule is not weekly", () => {
    expect(scheduled({ scheduleInterval: "monthly" })).toBe("full");
    expect(scheduled({ scheduleInterval: "manual" })).toBe("full");
  });

  it("returns full when there is no fresh lookup or the date cannot be parsed", () => {
    expect(scheduled({ lastFreshLookupAt: null })).toBe("full");
    expect(scheduled({ lastFreshLookupAt: "not-a-date" })).toBe("full");
  });

  it("treats exactly 35 days as still fresh and one millisecond older as full", () => {
    const now = weekOn(configId, false);
    const ageMs = FULL_SWEEP_MAX_AGE_DAYS * DAY_MS;
    expect(
      scheduled({
        now,
        lastFreshLookupAt: new Date(now.getTime() - ageMs).toISOString(),
      }),
    ).toBe("pulse");
    expect(
      scheduled({
        now,
        lastFreshLookupAt: new Date(now.getTime() - ageMs - 1).toISOString(),
      }),
    ).toBe("full");
  });

  it("returns full on the config's slot week and pulse on the other weeks", () => {
    expect(scheduled({ now: weekOn(configId, true) })).toBe("full");
    expect(scheduled({ now: weekOn(configId, false) })).toBe("pulse");
  });
});

describe("findReusableLookup", () => {
  it("returns the newest fresh lookup and skips reused, invalid, and legacy-bad rows", () => {
    const fresh = { ...freshLookup, fetchedAt: "2026-02-01T00:00:00.000Z" };
    const found = findReusableLookup([
      {
        id: "reused",
        detail: JSON.stringify({
          brandLookup: { ...fresh, reusedFromRunId: "older", reused: true },
        }),
      },
      { id: "bad-json", detail: "{not json" },
      { id: "null-detail", detail: null },
      { id: "no-lookup", detail: JSON.stringify({ prompts: [] }) },
      {
        id: "bad-fetched",
        detail: JSON.stringify({ brandLookup: { fetchedAt: 1 } }),
      },
      {
        id: "array-lookup",
        detail: JSON.stringify({ brandLookup: [fresh] }),
      },
      { id: "fresh", detail: JSON.stringify({ brandLookup: fresh }) },
      {
        id: "older",
        detail: JSON.stringify({
          brandLookup: {
            ...freshLookup,
            fetchedAt: "2025-01-01T00:00:00.000Z",
          },
        }),
      },
    ]);

    expect(found).toEqual({
      runId: "fresh",
      fetchedAt: fresh.fetchedAt,
      brandLookup: fresh,
    });
  });

  it("accepts a legacy fresh lookup that has no reuse fields", () => {
    const found = findReusableLookup([
      { id: "legacy", detail: JSON.stringify({ brandLookup: freshLookup }) },
    ]);
    expect(found?.runId).toBe("legacy");
    expect(found?.brandLookup.reusedFromRunId).toBeUndefined();
  });

  it("skips a lookup that is missing fields a full sweep always writes", () => {
    const { perPlatform: _dropped, ...withoutPlatforms } = freshLookup;
    expect(
      findReusableLookup([
        {
          id: "broken",
          detail: JSON.stringify({ brandLookup: withoutPlatforms }),
        },
        {
          id: "bad_mentions",
          detail: JSON.stringify({
            brandLookup: { ...freshLookup, totalMentions: "4" },
          }),
        },
        { id: "good", detail: JSON.stringify({ brandLookup: freshLookup }) },
      ]),
    ).toMatchObject({ runId: "good" });
  });

  it("returns null when every row is reused or unreadable", () => {
    expect(
      findReusableLookup([
        {
          id: "reused",
          detail: JSON.stringify({
            brandLookup: { ...freshLookup, reusedFromRunId: "old" },
          }),
        },
        { id: "empty", detail: null },
      ]),
    ).toBeNull();
    expect(findReusableLookup([])).toBeNull();
  });
});
