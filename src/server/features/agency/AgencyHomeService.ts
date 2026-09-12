/**
 * Session-scoped agency home data: recent Sam loop runs across an org's
 * projects, plus a portfolio row per project. Never invents zeros — null /
 * "not measured" when a source is missing or errored.
 */
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  gscConnections,
  projects,
  rankTrackingConfigs,
  rankTrackingKeywords,
  samLoopRuns,
  samLoops,
} from "@/db/schema";
import { GscService } from "@/server/features/gsc/services/GscService";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";

export type AgencyHomeMission = {
  id: string;
  loopId: string;
  loopName: string;
  projectId: string;
  projectName: string;
  projectDomain: string | null;
  status: "completed" | "failed" | "running";
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  costNote: string | null;
};

export type AgencyHomePortfolioRow = {
  projectId: string;
  projectName: string;
  domain: string | null;
  gscConnected: boolean;
  /** Null when unconnected, empty, or GSC errored — never a fake 0. */
  gscClicks28d: number | null;
  gscImpressions28d: number | null;
  /** Null when the project has no tracked keywords. */
  trackedKeywords: number | null;
  /** Best (lowest) current position across tracked keywords; null if none measured. */
  bestPosition: number | null;
  /** Null when the project has no Sam loops at all. */
  loopsActive: number | null;
  setup: {
    gsc: boolean;
    loops: boolean;
  };
};

const MISSION_STATUSES = ["completed", "failed", "running"] as const;
const DEFAULT_MISSION_LIMIT = 12;

function clampMissionLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_MISSION_LIMIT;
  return Math.min(50, Math.max(1, Math.floor(limit)));
}

/**
 * Recent Sam loop runs for every active project in the org.
 * Includes running runs; excludes pending. Ordered by most recent activity.
 */
export async function getAgencyHomeMissions(
  organizationId: string,
  limit?: number,
): Promise<AgencyHomeMission[]> {
  const capped = clampMissionLimit(limit);
  const rows = await db
    .select({
      id: samLoopRuns.id,
      loopId: samLoopRuns.loopId,
      loopName: samLoops.name,
      projectId: samLoopRuns.projectId,
      projectName: projects.name,
      projectDomain: projects.domain,
      status: samLoopRuns.status,
      startedAt: samLoopRuns.startedAt,
      finishedAt: samLoopRuns.finishedAt,
      createdAt: samLoopRuns.createdAt,
      costNote: samLoopRuns.costNote,
    })
    .from(samLoopRuns)
    .innerJoin(samLoops, eq(samLoopRuns.loopId, samLoops.id))
    .innerJoin(projects, eq(samLoopRuns.projectId, projects.id))
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
        inArray(samLoopRuns.status, [...MISSION_STATUSES]),
      ),
    )
    .orderBy(
      desc(
        sql`coalesce(${samLoopRuns.finishedAt}, ${samLoopRuns.startedAt}, ${samLoopRuns.createdAt})`,
      ),
      desc(samLoopRuns.id),
    )
    .limit(capped);

  return rows.map((row) => ({
    ...row,
    // Filter guarantees the three statuses; drizzle still types the full enum.
    status: row.status as AgencyHomeMission["status"],
  }));
}

async function loadGscTotals(
  projectId: string,
): Promise<{ clicks: number; impressions: number } | null> {
  try {
    const result = await GscService.getPerformance({
      projectId,
      dateRange: "last_28_days",
      dimensions: ["date"],
    });
    if (result.rows.length === 0) return null;
    let clicks = 0;
    let impressions = 0;
    for (const row of result.rows) {
      if (Number.isFinite(row.clicks)) clicks += row.clicks;
      if (Number.isFinite(row.impressions)) impressions += row.impressions;
    }
    return { clicks, impressions };
  } catch {
    return null;
  }
}

/**
 * One portfolio row per active project in the org. Sort is applied client-side
 * after GSC totals resolve (most clicks first, unconnected last).
 */
export async function getAgencyHomePortfolio(
  organizationId: string,
): Promise<AgencyHomePortfolioRow[]> {
  const projectRows = await db
    .select({
      id: projects.id,
      name: projects.name,
      domain: projects.domain,
    })
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    )
    .orderBy(desc(projects.createdAt));

  if (projectRows.length === 0) return [];

  const projectIds = projectRows.map((p) => p.id);

  const [gscRows, keywordCounts, loopCounts, enabledLoopCounts, configs] =
    await Promise.all([
      db
        .select({ projectId: gscConnections.projectId })
        .from(gscConnections)
        .where(inArray(gscConnections.projectId, projectIds)),
      db
        .select({
          projectId: rankTrackingConfigs.projectId,
          keywordCount: count(rankTrackingKeywords.id),
        })
        .from(rankTrackingConfigs)
        .innerJoin(
          rankTrackingKeywords,
          eq(rankTrackingKeywords.configId, rankTrackingConfigs.id),
        )
        .where(
          and(
            inArray(rankTrackingConfigs.projectId, projectIds),
            eq(rankTrackingConfigs.isActive, true),
          ),
        )
        .groupBy(rankTrackingConfigs.projectId),
      db
        .select({
          projectId: samLoops.projectId,
          loopCount: count(samLoops.id),
        })
        .from(samLoops)
        .where(inArray(samLoops.projectId, projectIds))
        .groupBy(samLoops.projectId),
      db
        .select({
          projectId: samLoops.projectId,
          enabledCount: count(samLoops.id),
        })
        .from(samLoops)
        .where(
          and(
            inArray(samLoops.projectId, projectIds),
            eq(samLoops.isEnabled, true),
          ),
        )
        .groupBy(samLoops.projectId),
      db
        .select({
          id: rankTrackingConfigs.id,
          projectId: rankTrackingConfigs.projectId,
        })
        .from(rankTrackingConfigs)
        .where(
          and(
            inArray(rankTrackingConfigs.projectId, projectIds),
            eq(rankTrackingConfigs.isActive, true),
          ),
        ),
    ]);

  // Latest snapshots only — historical mins would lie about "current" best.
  const bestByProject = new Map<string, number>();
  await Promise.all(
    configs.map(async (config) => {
      const snaps =
        await RankTrackingRepository.getLatestSnapshotsForKeywords(config.id);
      for (const snap of snaps) {
        if (snap.position == null || !Number.isFinite(snap.position)) continue;
        const prev = bestByProject.get(config.projectId);
        if (prev === undefined || snap.position < prev) {
          bestByProject.set(config.projectId, snap.position);
        }
      }
    }),
  );

  const gscConnected = new Set(gscRows.map((r) => r.projectId));
  const keywordsByProject = new Map(
    keywordCounts.map((r) => [r.projectId, Number(r.keywordCount)]),
  );
  const loopsTotalByProject = new Map(
    loopCounts.map((r) => [r.projectId, Number(r.loopCount)]),
  );
  const loopsEnabledByProject = new Map(
    enabledLoopCounts.map((r) => [r.projectId, Number(r.enabledCount)]),
  );

  const rows: AgencyHomePortfolioRow[] = await Promise.all(
    projectRows.map(async (project) => {
      const connected = gscConnected.has(project.id);
      const gscTotals = connected ? await loadGscTotals(project.id) : null;
      const keywordCount = keywordsByProject.get(project.id) ?? null;
      const loopTotal = loopsTotalByProject.get(project.id) ?? null;
      const loopsActive =
        loopTotal == null || loopTotal === 0
          ? null
          : (loopsEnabledByProject.get(project.id) ?? 0);

      return {
        projectId: project.id,
        projectName: project.name,
        domain: project.domain,
        gscConnected: connected,
        gscClicks28d: gscTotals?.clicks ?? null,
        gscImpressions28d: gscTotals?.impressions ?? null,
        trackedKeywords:
          keywordCount != null && keywordCount > 0 ? keywordCount : null,
        bestPosition:
          keywordCount != null && keywordCount > 0
            ? (bestByProject.get(project.id) ?? null)
            : null,
        loopsActive,
        setup: {
          gsc: connected,
          loops: (loopsEnabledByProject.get(project.id) ?? 0) > 0,
        },
      };
    }),
  );

  return rows.sort((a, b) => {
    // Unconnected last.
    if (a.gscConnected !== b.gscConnected) {
      return a.gscConnected ? -1 : 1;
    }
    // Connected: most clicks first; not-measured (null) after measured.
    const aClicks = a.gscClicks28d;
    const bClicks = b.gscClicks28d;
    if (aClicks == null && bClicks == null) {
      return a.projectName.localeCompare(b.projectName);
    }
    if (aClicks == null) return 1;
    if (bClicks == null) return -1;
    if (bClicks !== aClicks) return bClicks - aClicks;
    return a.projectName.localeCompare(b.projectName);
  });
}

export const AgencyHomeService = {
  getAgencyHomeMissions,
  getAgencyHomePortfolio,
};
