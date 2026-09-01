import { and, asc, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { aiVisibilityRuns } from "@/db/schema";
import { getDatabaseProvider } from "@/db/provider";
import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import {
  isStaleInFlightRun,
  STALE_AI_VISIBILITY_RUN_ERROR,
  STALE_AI_VISIBILITY_RUN_MS,
} from "@/server/features/ai-visibility/services/aiVisibilityStaleRun";

const WATCHDOG_BATCH_LIMIT = 100;

function startedBeforeForProvider(cutoff: Date): string {
  const iso = cutoff.toISOString();
  return getDatabaseProvider() === "postgres"
    ? iso
    : iso.replace("T", " ").slice(0, 19);
}

async function failStaleRun(runId: string) {
  await AiVisibilityRepository.updateRun(runId, {
    status: "failed",
    error: STALE_AI_VISIBILITY_RUN_ERROR,
    finishedAt: new Date().toISOString(),
  });
}

/** Reclaim stale in-flight runs for one config before starting a new run. */
export async function reclaimStaleRunsForConfig(configId: string) {
  const runs = await db
    .select({
      id: aiVisibilityRuns.id,
      configId: aiVisibilityRuns.configId,
      startedAt: aiVisibilityRuns.startedAt,
      createdAt: aiVisibilityRuns.createdAt,
      finishedAt: aiVisibilityRuns.finishedAt,
      status: aiVisibilityRuns.status,
    })
    .from(aiVisibilityRuns)
    .where(
      and(
        eq(aiVisibilityRuns.configId, configId),
        inArray(aiVisibilityRuns.status, ["pending", "running"]),
        isNull(aiVisibilityRuns.finishedAt),
      ),
    );

  for (const run of runs) {
    if (!isStaleInFlightRun(run)) continue;
    await failStaleRun(run.id);
    console.log(
      `AI visibility: reclaimed stale run ${run.id} for config ${configId}`,
    );
  }
}

/** Cron watchdog: sweep globally stale in-flight runs. */
export async function reconcileStaleAiVisibilityRuns() {
  const startedBefore = startedBeforeForProvider(
    new Date(Date.now() - STALE_AI_VISIBILITY_RUN_MS),
  );
  const createdBefore = startedBefore;

  const stale = await db
    .select({
      id: aiVisibilityRuns.id,
      configId: aiVisibilityRuns.configId,
      startedAt: aiVisibilityRuns.startedAt,
      createdAt: aiVisibilityRuns.createdAt,
      finishedAt: aiVisibilityRuns.finishedAt,
      status: aiVisibilityRuns.status,
    })
    .from(aiVisibilityRuns)
    .where(
      and(
        inArray(aiVisibilityRuns.status, ["pending", "running"]),
        isNull(aiVisibilityRuns.finishedAt),
        or(
          and(
            isNull(aiVisibilityRuns.startedAt),
            lt(aiVisibilityRuns.createdAt, createdBefore),
          ),
          and(
            isNotNull(aiVisibilityRuns.startedAt),
            lt(aiVisibilityRuns.startedAt, startedBefore),
          ),
        ),
      ),
    )
    .orderBy(asc(aiVisibilityRuns.startedAt), asc(aiVisibilityRuns.createdAt))
    .limit(WATCHDOG_BATCH_LIMIT);

  for (const run of stale) {
    try {
      if (!isStaleInFlightRun(run)) continue;
      await failStaleRun(run.id);
      console.log(
        `AI visibility watchdog: reclaimed stale run ${run.id} (config ${run.configId})`,
      );
    } catch (error) {
      console.error(
        `AI visibility watchdog: failed to reclaim ${run.id}:`,
        error,
      );
    }
  }
}

export { STALE_AI_VISIBILITY_RUN_MS } from "./aiVisibilityStaleRun";
