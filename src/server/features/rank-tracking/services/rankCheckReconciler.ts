import { and, asc, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { env } from "cloudflare:workers";
import { getDatabaseProvider } from "@/db/provider";
import { toSqliteTimestamp } from "../rankTrackingTimestamps";
import { rankCheckRuns } from "@/db/schema";
import { completeRankCheckRunFromSnapshots } from "@/server/features/rank-tracking/services/rankCheckFinalize";
import { failRunIfActive } from "@/server/features/rank-tracking/services/rankCheckRunGuards";

/**
 * Snapshots for a finished DFS collect are usually present minutes before the
 * finalize step runs. Give the live workflow that window, then complete from
 * DB state so positions stop staying invisible behind status=running.
 */
const SNAPSHOT_FINALIZE_GRACE_MS = 3 * 60 * 1000;

/** In-flight runs older than this with no complete snapshots get failed. */
const STALE_INCOMPLETE_MS = 25 * 60 * 1000;

const WATCHDOG_BATCH_LIMIT = 100;

// D1's CURRENT_TIMESTAMP uses a space separator, while Postgres defaults to
// ISO. Comparing a D1 value with an ISO cutoff makes every same-day run appear
// stale (space sorts before "T"). Match the provider, then verify elapsed age.
function isOlderThan(
  run: { id: string; startedAt: string },
  ageMs: number,
): boolean {
  const { startedAt } = run;
  const timestamp = Date.parse(
    startedAt.includes("T") ? startedAt : `${startedAt.replace(" ", "T")}Z`,
  );
  if (!Number.isFinite(timestamp)) {
    console.warn(`[rank-check] watchdog skipped ${run.id}: invalid startedAt`);
    return false;
  }
  return timestamp < Date.now() - ageMs;
}

/**
 * Cron watchdog: finish (or fail) rank_check_runs stuck in pending/running
 * after their workflow should have finalized.
 */
export async function reconcileStuckRankCheckRuns() {
  if (
    ["ANTHROPIC_API_KEY", "XAI_API_KEY", "OPENAI_API_KEY"].some(
      (name) =>
        (typeof process !== "undefined" && process.env[name] !== undefined) ||
        Reflect.has(env, name),
    )
  ) {
    throw new Error("API-key environment refused; subscriptions only");
  }

  const cutoff = new Date(Date.now() - SNAPSHOT_FINALIZE_GRACE_MS);
  const snapshotGraceCutoff =
    getDatabaseProvider() === "postgres"
      ? cutoff.toISOString()
      : toSqliteTimestamp(cutoff);

  const stuck = await db
    .select()
    .from(rankCheckRuns)
    .where(
      and(
        inArray(rankCheckRuns.status, ["pending", "running"]),
        lt(rankCheckRuns.startedAt, snapshotGraceCutoff),
      ),
    )
    .orderBy(asc(rankCheckRuns.startedAt))
    .limit(WATCHDOG_BATCH_LIMIT);

  for (const run of stuck) {
    if (!isOlderThan(run, SNAPSHOT_FINALIZE_GRACE_MS)) continue;
    try {
      const completed = await completeRankCheckRunFromSnapshots({
        run,
        requireFullCoverage: true,
      });
      if (completed) {
        console.log(
          `[rank-check] watchdog completed run ${run.id} from snapshots (${completed.keywordsChecked}/${completed.keywordsTotal})`,
        );
        continue;
      }

      if (isOlderThan(run, STALE_INCOMPLETE_MS)) {
        await failRunIfActive(
          run.id,
          "Rank check timed out before finalizing",
          run,
        );
        console.log(
          `[rank-check] watchdog failed stale incomplete run ${run.id}`,
        );
      }
    } catch (error) {
      console.error(
        `[rank-check] watchdog failed to reconcile ${run.id}:`,
        error,
      );
    }
  }
}
