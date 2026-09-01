/** Runs still in-flight after this long get reclaimed (worker kill, deploy reset). */
export const STALE_AI_VISIBILITY_RUN_MS = 15 * 60 * 1000;

export const STALE_AI_VISIBILITY_RUN_ERROR = "stale run reclaimed";

type InFlightRun = {
  startedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  status: string;
};

export function isStaleInFlightRun(
  run: InFlightRun,
  nowMs = Date.now(),
): boolean {
  if (run.status !== "pending" && run.status !== "running") return false;
  if (run.finishedAt) return false;
  const anchor = run.startedAt ?? run.createdAt;
  const parsed = Date.parse(
    anchor.includes("T") ? anchor : `${anchor.replace(" ", "T")}Z`,
  );
  if (Number.isNaN(parsed)) return true;
  return parsed < nowMs - STALE_AI_VISIBILITY_RUN_MS;
}
