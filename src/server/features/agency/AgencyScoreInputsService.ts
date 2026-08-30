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
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";

export type AgencyScoreInputs = {
  domain: string;
  projectId: string | null;
  projectName: string | null;
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
};

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

async function loadRanks(
  projectId: string,
): Promise<AgencyScoreInputs["ranks"]> {
  // Already filtered to isActive=true inside the repository.
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  if (configs.length === 0) return null;

  const keywords: NonNullable<AgencyScoreInputs["ranks"]>["keywords"] = [];
  let capturedAt: string | null = null;

  for (const config of configs.slice(0, 3)) {
    const { rows, run } = await getLatestResults(config.id, projectId, "7d");
    if (run?.lastCheckedAt) {
      if (!capturedAt || run.lastCheckedAt > capturedAt) {
        capturedAt = run.lastCheckedAt;
      }
    }
    for (const row of rows) {
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
  }

  if (keywords.length === 0 && !capturedAt) return null;
  return {
    capturedAt,
    keywords,
    source: "openseo_rank_tracker",
  };
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
    return {
      domain,
      projectId: null,
      projectName: null,
      ranks: null,
      backlinks: null,
      audit: null,
    };
  }

  const [ranks, backlinks, audit] = await Promise.all([
    loadRanks(project.id),
    loadBacklinks(project.id),
    loadAudit(project.id),
  ]);

  return {
    domain,
    projectId: project.id,
    projectName: project.name,
    ranks,
    backlinks,
    audit,
  };
}

/** Machine export: scan all orgs (Hermes bearer path). */
export async function getAgencyScoreInputsGlobal(domain: string) {
  return getAgencyScoreInputs({ domain, organizationId: null });
}
