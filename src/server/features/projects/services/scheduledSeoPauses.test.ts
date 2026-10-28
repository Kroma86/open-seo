import { describe, expect, it } from "vitest";
import { pausedScheduledSeoProjects } from "./scheduledSeoPauses";

const PROJECT = "d6d3c442-bedf-4c4c-b65b-17d0fcf4ec4d";
describe("scheduled SEO pause window", () => {
  it.each([
    ["2026-10-01T05:49:59.999Z", []],
    ["2026-10-01T05:50:00.000Z", [PROJECT]],
    ["2026-10-15T08:00:00.000Z", [PROJECT]],
    ["2026-12-01T06:59:59.999Z", [PROJECT]],
    ["2026-12-01T07:00:00.000Z", []],
    ["2026-12-02T07:00:00.000Z", []],
  ])("applies only the half-open window at %s", (now, expected) => {
    expect(pausedScheduledSeoProjects(now)).toEqual(expected);
  });
  it.each([
    "",
    "invalid",
    "2026-10-15",
    "2026-10-15T08:00:00",
    "2026-10-15T08:00:00-07:00",
    "2026-02-30T08:00:00.000Z",
  ])("refuses an invalid or ambiguous clock: %s", (now) => {
    expect(() => pausedScheduledSeoProjects(now)).toThrow();
  });
});
