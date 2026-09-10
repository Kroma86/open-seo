import { describe, expect, it } from "vitest";
import { formatCount } from "@/client/features/ai-search/platformLabels";
import type { BrandLookupResult } from "@/types/schemas/ai-search";
import {
  buildMentionTrendData,
  formatMentionTrendValue,
} from "./brandLookupMentionTrendUtils";

type MonthlyEntry = BrandLookupResult["monthlyVolume"][number];

function entry(
  year: number,
  month: number,
  volume: number | null,
): MonthlyEntry {
  return { year, month, volume };
}

describe("buildMentionTrendData", () => {
  it("returns no measurements for an empty series", () => {
    expect(buildMentionTrendData([])).toEqual({
      chartData: [],
      hasMeasurements: false,
    });
  });

  it("returns no measurements when every volume is null", () => {
    expect(
      buildMentionTrendData([entry(2025, 1, null), entry(2025, 2, null)]),
    ).toEqual({
      chartData: [
        { label: "2025-01", volume: null },
        { label: "2025-02", volume: null },
      ],
      hasMeasurements: false,
    });
  });

  it("treats a measured zero as a real measurement", () => {
    expect(buildMentionTrendData([entry(2025, 3, 0)])).toEqual({
      chartData: [{ label: "2025-03", volume: 0 }],
      hasMeasurements: true,
    });
  });

  it("preserves mixed positive, null, and zero volumes", () => {
    expect(
      buildMentionTrendData([
        entry(2025, 4, 12),
        entry(2025, 5, null),
        entry(2025, 6, 0),
      ]),
    ).toEqual({
      chartData: [
        { label: "2025-04", volume: 12 },
        { label: "2025-05", volume: null },
        { label: "2025-06", volume: 0 },
      ],
      hasMeasurements: true,
    });
  });

  it("keeps input order, zero-pads months, and does not sort across a year boundary", () => {
    expect(
      buildMentionTrendData([
        entry(2026, 1, 2),
        entry(2025, 12, 9),
        entry(2025, 9, 1),
      ]),
    ).toEqual({
      chartData: [
        { label: "2026-01", volume: 2 },
        { label: "2025-12", volume: 9 },
        { label: "2025-09", volume: 1 },
      ],
      hasMeasurements: true,
    });
  });

  it("does not mutate the original entries", () => {
    const entries = [entry(2025, 11, 4), entry(2025, 12, null)];
    const snapshot = entries.map((item) => ({ ...item }));
    buildMentionTrendData(entries);
    expect(entries).toEqual(snapshot);
  });

  it("maps undefined and nonfinite volumes to null", () => {
    const entries = [
      { year: 2025, month: 1, volume: undefined },
      { year: 2025, month: 2, volume: Number.NaN },
      { year: 2025, month: 3, volume: Number.POSITIVE_INFINITY },
    ] as unknown as BrandLookupResult["monthlyVolume"];

    expect(buildMentionTrendData(entries)).toEqual({
      chartData: [
        { label: "2025-01", volume: null },
        { label: "2025-02", volume: null },
        { label: "2025-03", volume: null },
      ],
      hasMeasurements: false,
    });
  });
});

describe("formatMentionTrendValue", () => {
  it("renders unknown tooltip copy for null, undefined, NaN, and Infinity", () => {
    expect(formatMentionTrendValue(null)).toBe("Not measured");
    expect(formatMentionTrendValue(undefined)).toBe("Not measured");
    expect(formatMentionTrendValue(Number.NaN)).toBe("Not measured");
    expect(formatMentionTrendValue(Number.POSITIVE_INFINITY)).toBe(
      "Not measured",
    );
  });

  it("formats finite zero and positive counts with the existing formatCount helper", () => {
    expect(formatMentionTrendValue(0)).toBe(`${formatCount(0)} mentions`);
    expect(formatMentionTrendValue(1234)).toBe(`${formatCount(1234)} mentions`);
  });
});
