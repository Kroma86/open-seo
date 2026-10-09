/**
 * Rank-tracker inputs for the agency score export: the first three configs'
 * keywords plus a top-3 / top-10 summary across every active config.
 */
import type { AgencyScoreInputs } from "@/server/features/agency/AgencyScoreInputsService";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import type { RankTrackingRow } from "@/types/schemas/rank-tracking";

function pushRankKeyword(
  keywords: NonNullable<AgencyScoreInputs["ranks"]>["keywords"],
  row: RankTrackingRow,
): void {
  if (row.desktop?.position != null || row.desktop?.rankingUrl) {
    keywords.push({
      keyword: row.keyword,
      position: row.desktop.position ?? null,
      device: "desktop",
      url: row.desktop.rankingUrl ?? null,
    });
  } else if (row.mobile?.position != null || row.mobile?.rankingUrl) {
    keywords.push({
      keyword: row.keyword,
      position: row.mobile.position ?? null,
      device: "mobile",
      url: row.mobile.rankingUrl ?? null,
    });
  } else {
    keywords.push({
      keyword: row.keyword,
      position: null,
      device: "desktop",
      url: null,
    });
  }
}

export async function loadRankData(projectId: string): Promise<{
  ranks: AgencyScoreInputs["ranks"];
  rankSummary: AgencyScoreInputs["rankSummary"];
}> {
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  if (configs.length === 0) return { ranks: null, rankSummary: null };

  const keywords: NonNullable<AgencyScoreInputs["ranks"]>["keywords"] = [];
  const keywordBest = new Map<string, number | null>();
  let ranksCapturedAt: string | null = null;
  let summaryCapturedAt: string | null = null;
  let hasPositionSnapshots = false;

  for (const [index, config] of configs.entries()) {
    const { rows, run } = await getLatestResults(config.id, projectId, "7d");
    const checkedAt = run?.lastCheckedAt ?? null;
    if (checkedAt) {
      if (index < 3 && (!ranksCapturedAt || checkedAt > ranksCapturedAt)) {
        ranksCapturedAt = checkedAt;
      }
      if (!summaryCapturedAt || checkedAt > summaryCapturedAt) {
        summaryCapturedAt = checkedAt;
      }
    }

    for (const row of rows) {
      if (row.desktop?.position != null || row.mobile?.position != null) {
        hasPositionSnapshots = true;
      }

      if (index < 3) {
        pushRankKeyword(keywords, row);
      }

      const positions = [
        row.desktop?.position ?? null,
        row.mobile?.position ?? null,
      ];
      const nonNull = positions.filter((p): p is number => p != null);
      const bestNew = nonNull.length > 0 ? Math.min(...nonNull) : null;
      keywordBest.set(
        row.keyword,
        mergeBestPosition(keywordBest.get(row.keyword), bestNew),
      );
    }
  }

  const ranks =
    keywords.length === 0 && !ranksCapturedAt
      ? null
      : {
          capturedAt: ranksCapturedAt,
          keywords,
          source: "openseo_rank_tracker" as const,
        };

  const trackedKeywords = keywordBest.size;
  let top3: number | null = null;
  let top10: number | null = null;
  if (hasPositionSnapshots) {
    top3 = 0;
    top10 = 0;
    for (const position of keywordBest.values()) {
      if (position != null) {
        if (position <= 3) top3 += 1;
        if (position <= 10) top10 += 1;
      }
    }
  }

  return {
    ranks,
    rankSummary: {
      trackedKeywords,
      top3,
      top10,
      capturedAt: summaryCapturedAt,
      source: "openseo_rank_tracker",
    },
  };
}

function mergeBestPosition(
  existing: number | null | undefined,
  candidate: number | null,
): number | null {
  if (candidate == null) return existing ?? null;
  if (existing == null) return candidate;
  return Math.min(existing, candidate);
}
