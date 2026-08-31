/**
 * Read-only SAM loop run export for Hermes / NiceSEO board.
 * Completed and failed runs only — never pending or running.
 */
import { and, asc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { projects, samLoopRuns, samLoops } from "@/db/schema";

export type AgencyLoopReport = {
  id: string;
  loopId: string;
  loopName: string;
  cadence: "daily" | "weekly" | "monthly";
  projectId: string;
  projectName: string;
  projectDomain: string | null;
  status: "completed" | "failed";
  startedAt: string | null;
  finishedAt: string | null;
  report: string | null;
  proposalsQueued: number;
  costNote: string | null;
  error: string | null;
};

export type AgencyLoopReportsResult = {
  runs: AgencyLoopReport[];
  count: number;
};

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.min(200, Math.max(1, Math.floor(limit)));
}

export async function getAgencyLoopReports(
  since: string,
  limit = 50,
): Promise<AgencyLoopReportsResult> {
  const capped = clampLimit(limit);
  // Inclusive finishedAt cursor: caller dedupes by run id, so an inclusive
  // cursor can re-read but never skip a row that finished exactly at `since`.
  const rows = await db
    .select({
      id: samLoopRuns.id,
      loopId: samLoopRuns.loopId,
      loopName: samLoops.name,
      cadence: samLoops.cadence,
      projectId: samLoopRuns.projectId,
      projectName: projects.name,
      projectDomain: projects.domain,
      status: samLoopRuns.status,
      startedAt: samLoopRuns.startedAt,
      finishedAt: samLoopRuns.finishedAt,
      report: samLoopRuns.report,
      proposalsQueued: samLoopRuns.proposalsQueued,
      costNote: samLoopRuns.costNote,
      error: samLoopRuns.error,
    })
    .from(samLoopRuns)
    .innerJoin(samLoops, eq(samLoopRuns.loopId, samLoops.id))
    .innerJoin(projects, eq(samLoopRuns.projectId, projects.id))
    .where(
      and(
        inArray(samLoopRuns.status, ["completed", "failed"]),
        isNotNull(samLoopRuns.finishedAt),
        gte(samLoopRuns.finishedAt, since),
      ),
    )
    .orderBy(asc(samLoopRuns.finishedAt), asc(samLoopRuns.id))
    .limit(capped);

  return {
    // Filter guarantees completed|failed; drizzle still types the full enum.
    runs: rows as AgencyLoopReport[],
    count: rows.length,
  };
}
