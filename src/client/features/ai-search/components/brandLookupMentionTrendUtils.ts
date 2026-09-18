import { formatCount } from "@/client/features/ai-search/platformLabels";
import type { BrandLookupResult } from "@/types/schemas/ai-search";

function finiteVolume(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildMentionTrendData(
  entries: BrandLookupResult["monthlyVolume"],
): {
  chartData: Array<{ label: string; volume: number | null }>;
  hasMeasurements: boolean;
} {
  const chartData = entries.map((entry) => ({
    label: `${entry.year}-${String(entry.month).padStart(2, "0")}`,
    volume: finiteVolume(entry.volume),
  }));

  return {
    chartData,
    hasMeasurements: chartData.some((point) => point.volume !== null),
  };
}

export function formatMentionTrendValue(
  value: number | null | undefined,
): string {
  const volume = finiteVolume(value);
  if (volume === null) return "Not measured";
  return `${formatCount(volume)} mentions`;
}
