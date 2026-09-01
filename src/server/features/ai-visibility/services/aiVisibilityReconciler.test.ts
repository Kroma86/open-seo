import { describe, expect, it } from "vitest";
import {
  isStaleInFlightRun,
  STALE_AI_VISIBILITY_RUN_MS,
} from "./aiVisibilityStaleRun";

describe("isStaleInFlightRun", () => {
  const now = Date.parse("2026-02-01T12:00:00.000Z");

  it("treats old running rows as stale", () => {
    const startedAt = new Date(
      now - STALE_AI_VISIBILITY_RUN_MS - 60_000,
    ).toISOString();
    expect(
      isStaleInFlightRun(
        {
          status: "running",
          startedAt,
          createdAt: startedAt,
          finishedAt: null,
        },
        now,
      ),
    ).toBe(true);
  });

  it("keeps recent running rows blocking", () => {
    const startedAt = new Date(now - 60_000).toISOString();
    expect(
      isStaleInFlightRun(
        {
          status: "running",
          startedAt,
          createdAt: startedAt,
          finishedAt: null,
        },
        now,
      ),
    ).toBe(false);
  });

  it("uses createdAt when startedAt is missing", () => {
    const createdAt = new Date(
      now - STALE_AI_VISIBILITY_RUN_MS - 60_000,
    ).toISOString();
    expect(
      isStaleInFlightRun(
        {
          status: "pending",
          startedAt: null,
          createdAt,
          finishedAt: null,
        },
        now,
      ),
    ).toBe(true);
  });
});
