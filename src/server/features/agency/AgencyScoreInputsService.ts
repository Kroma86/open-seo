/**
 * DB-only agency score inputs for NiceSEO board.
 * Never calls DataForSEO — reads stored rank / backlink / audit rows only.
 *
 * Domain match risk: if multiple active projects share a normalized domain,
 * the first match wins (exact domain, then name).
 */
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { BacklinkSnapshotRepository } from "@/server/features/dashboard/repositories/BacklinkSnapshotRepository";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { GscService } from "@/server/features/gsc/services/GscService";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import { getAgencyExportBlock } from "@/server/features/ai-visibility/services/aiVisibilityResults";
import type { RankTrackingRow } from "@/types/schemas/rank-tracking";

export type GscConnectionStatus = {
  connected: boolean;
  siteUrl: string | null;
  connectedAt: string | null;
};

export type Ga4ConnectionStatus = {
  connected: boolean;
  propertyId: string | null;
  propertyDisplayName: string | null;
  connectedAt: string | null;
};

/** Native GBP OAuth is not in OpenSEO yet. Never pretend Google is connected. */
export type GbpStatus = {
  status: "not_connected_native" | "dfs_local";
  source: "dataforseo" | null;
  capturedAt: string | null;
};

export type AgencyScoreInputs = {
  domain: string;
  projectId: string | null;
  projectName: string | null;
  connections: {
    gsc: GscConnectionStatus;
    ga4: Ga4ConnectionStatus;
  };
  /** GSC last-28-day site totals — one live searchAnalytics read when a
   *  property is mapped; null when unmapped, empty, or errored. Never invent 0. */
  gsc: {
    clicks: number | null;
    impressions: number | null;
    ctr: number | null;
    position: number | null;
    windowStart: string | null;
    windowEnd: string | null;
    capturedAt: string | null;
    source: "google_search_console";
  } | null;
  /** Top GSC queries (last 28 days, by clicks then impressions, max 25) —
   *  the real long tail the tracker's 3 keywords miss. Null when unmapped,
   *  empty, or errored. */
  gscTopQueries: Array<{
    query: string;
    clicks: number;
    impressions: number;
    position: number | null;
  }> | null;
  gbp: GbpStatus;
  ranks: {
    capturedAt: string | null;
    keywords: Array<{
      keyword: string;
      position: number | null;
      device: string;
      url: string | null;
    }>;
    source: "openseo_rank_tracker";
  } | null;
  rankSummary: {
    trackedKeywords: number | null;
    top3: number | null;
    top10: number | null;
    capturedAt: string | null;
    source: "openseo_rank_tracker";
  } | null;
  backlinks: {
    capturedAt: string | null;
    referringDomains: number | null;
    backlinks: number | null;
    rank: number | null;
    source: "openseo_backlink_snapshot";
  } | null;
  audit: {
    capturedAt: string | null;
    status: string | null;
    pagesCrawled: number | null;
    issueCount: number | null;
    lighthouseSeoAvg: number | null;
    source: "openseo_audit";
  } | null;
  aiVisibility: {
    capturedAt: string | null;
    totalMentions: number | null;
    partialMentions: boolean;
    shareOfVoicePct: number | null;
    promptsWithBrand: number | null;
    promptsChecked: number | null;
    promptSetVersion: number | null;
    source: "dataforseo_llm_mentions";
  } | null;
};

const DISCONNECTED_GSC: GscConnectionStatus = {
  connected: false,
  siteUrl: null,
  connectedAt: null,
};

const DISCONNECTED_GA4: Ga4ConnectionStatus = {
  connected: false,
  propertyId: null,
  propertyDisplayName: null,
  connectedAt: null,
};

const GBP_NATIVE_GAP: GbpStatus = {
  status: "not_connected_native",
  source: null,
  capturedAt: null,
};

function emptyInputs(domain: string): AgencyScoreInputs {
  return {
    domain,
    projectId: null,
    projectName: null,
    connections: { gsc: DISCONNECTED_GSC, ga4: DISCONNECTED_GA4 },
    gsc: null,
    gscTopQueries: null,
    gbp: GBP_NATIVE_GAP,
    ranks: null,
    rankSummary: null,
    backlinks: null,
    audit: null,
    aiVisibility: null,
  };
}

export async function loadGscTotals(
  projectId: string,
  connected: boolean,
): Promise<AgencyScoreInputs["gsc"]> {
  if (!connected) return null;
  try {
    // Per-day rows, then sum — the default GSC dimension is ["query"], whose
    // first row is the top query, not site totals.
    const result = await GscService.getPerformance({
      projectId,
      dateRange: "last_28_days",
      dimensions: ["date"],
    });
    if (result.rows.length === 0) return null;
    let clicks = 0;
    let impressions = 0;
    // Position is a per-row average; weight it by impressions so days with
    // no visibility don't drag the mean.
    let positionWeight = 0;
    let positionSum = 0;
    for (const row of result.rows) {
      if (Number.isFinite(row.clicks)) clicks += row.clicks;
      if (Number.isFinite(row.impressions)) {
        impressions += row.impressions;
        if (Number.isFinite(row.position)) {
          positionSum += row.position * row.impressions;
          positionWeight += row.impressions;
        }
      }
    }
    const position = positionWeight > 0 ? positionSum / positionWeight : null;
    return {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : null,
      position,
      windowStart: result.request.startDate ?? null,
      windowEnd: result.request.endDate ?? null,
      capturedAt: result.request.endDate ?? null,
      source: "google_search_console",
    };
  } catch {
    // Expired grant / API error → Not measured, never a fake zero.
    return null;
  }
}

async function loadGscTopQueries(
  projectId: string,
  connected: boolean,
): Promise<AgencyScoreInputs["gscTopQueries"]> {
  if (!connected) return null;
  try {
    const result = await GscService.getPerformance({
      projectId,
      dateRange: "last_28_days",
      dimensions: ["query"],
    });
    if (result.rows.length === 0) return null;
    const rows = result.rows
      .filter((row) => typeof row.keys?.[0] === "string")
      .map((row) => ({
        query: row.keys?.[0] ?? "",
        clicks: Number.isFinite(row.clicks) ? row.clicks : 0,
        impressions: Number.isFinite(row.impressions) ? row.impressions : 0,
        position: Number.isFinite(row.position) ? row.position : null,
      }))
      .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
      .slice(0, 25);
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

async function loadConnections(projectId: string): Promise<{
  gsc: GscConnectionStatus;
  ga4: Ga4ConnectionStatus;
}> {
  const [gscRow, ga4Row] = await Promise.all([
    GscConnectionRepository.getByProjectId(projectId),
    Ga4ConnectionRepository.getByProjectId(projectId),
  ]);
  return {
    gsc: gscRow
      ? {
          connected: true,
          siteUrl: gscRow.siteUrl,
          connectedAt: gscRow.createdAt ?? null,
        }
      : DISCONNECTED_GSC,
    ga4: ga4Row
      ? {
          connected: true,
          propertyId: ga4Row.propertyId,
          propertyDisplayName: ga4Row.propertyDisplayName,
          connectedAt: ga4Row.createdAt ?? null,
        }
      : DISCONNECTED_GA4,
  };
}

function normalizeDomain(raw: string): string {
  let h = raw.trim().toLowerCase();
  for (const prefix of ["https://", "http://"]) {
    if (h.startsWith(prefix)) h = h.slice(prefix.length);
  }
  if (h.startsWith("www.")) h = h.slice(4);
  return h.split("/")[0] ?? h;
}

function domainsMatch(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  return normalizeDomain(a) === normalizeDomain(b);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

async function findProject(
  organizationId: string | null,
  domain: string,
): Promise<typeof projects.$inferSelect | null> {
  const needle = normalizeDomain(domain);
  const rows = organizationId
    ? await db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.organizationId, organizationId),
            isNull(projects.archivedAt),
          ),
        )
    : await db.select().from(projects).where(isNull(projects.archivedAt));

  const exact = rows.find((p) => domainsMatch(p.domain, needle));
  if (exact) return exact;
  return rows.find((p) => domainsMatch(p.name, needle)) ?? null;
}

function rowHasSnapshotData(row: RankTrackingRow): boolean {
  return (
    row.desktop?.position != null ||
    row.mobile?.position != null ||
    row.desktop?.rankingUrl != null ||
    row.mobile?.rankingUrl != null
  );
}

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

async function loadRankData(
  projectId: string,
): Promise<{
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
      if (
        index < 3 &&
        (!ranksCapturedAt || checkedAt > ranksCapturedAt)
      ) {
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

async function loadBacklinks(
  projectId: string,
): Promise<AgencyScoreInputs["backlinks"]> {
  const snapshot =
    await BacklinkSnapshotRepository.getLatestForProject(projectId);
  if (!snapshot) return null;
  return {
    capturedAt: snapshot.capturedAt,
    referringDomains: snapshot.referringDomains,
    backlinks: snapshot.backlinks,
    rank: snapshot.rank,
    source: "openseo_backlink_snapshot",
  };
}

async function loadAudit(
  projectId: string,
): Promise<AgencyScoreInputs["audit"]> {
  const audit = await AuditRepository.getLatestAuditForProject(projectId);
  if (!audit) return null;

  const results = await AuditRepository.getAuditResultsForProject(
    audit.id,
    projectId,
  );
  const issueCount = results.issues.length;
  const seoScores = results.lighthouse
    .map((r) => r.seoScore)
    .filter((s): s is number => s != null && Number.isFinite(s));
  const lighthouseSeoAvg =
    seoScores.length === 0
      ? null
      : (() => {
          const avg = seoScores.reduce((a, b) => a + b, 0) / seoScores.length;
          // Lighthouse SEO is usually 0–100 integers; guard 0–1 fractions.
          return round1(avg <= 1 ? avg * 100 : avg);
        })();

  return {
    capturedAt: audit.completedAt ?? audit.startedAt ?? null,
    status: audit.status,
    pagesCrawled: audit.pagesCrawled ?? results.pages.length,
    issueCount,
    lighthouseSeoAvg,
    source: "openseo_audit",
  };
}

export async function getAgencyScoreInputs(input: {
  domain: string;
  organizationId?: string | null;
}): Promise<AgencyScoreInputs> {
  const domain = normalizeDomain(input.domain);
  const project = await findProject(input.organizationId ?? null, domain);

  if (!project) {
    return emptyInputs(domain);
  }

  const [rankData, backlinks, audit, aiVisibility, connections] =
    await Promise.all([
      loadRankData(project.id),
      loadBacklinks(project.id),
      loadAudit(project.id),
      getAgencyExportBlock(project.id),
      loadConnections(project.id),
    ]);

  return {
    domain,
    projectId: project.id,
    projectName: project.name,
    connections,
    gsc: await loadGscTotals(project.id, connections.gsc.connected),
    gscTopQueries: await loadGscTopQueries(
      project.id,
      connections.gsc.connected,
    ),
    gbp: GBP_NATIVE_GAP,
    ranks: rankData.ranks,
    rankSummary: rankData.rankSummary,
    backlinks,
    audit,
    aiVisibility,
  };
}

/** Machine export: scan all orgs (Hermes bearer path). */
export async function getAgencyScoreInputsGlobal(domain: string) {
  return getAgencyScoreInputs({ domain, organizationId: null });
}
