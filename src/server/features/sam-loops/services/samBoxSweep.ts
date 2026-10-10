import { SamLoopRepository } from "../repositories/SamLoopRepository";
import { finishSamBoxRun, type SamBoxFinishData } from "./samBoxFinalize";
import { SAM_BOX_COST_PREFIX, SAM_BOX_LEASE_SECONDS } from "./samBoxTypes";

export function samBoxExpiredFinish(now = new Date()): SamBoxFinishData {
  return {
    status: "failed",
    error: "Box lease expired before a result was posted.",
    report: "Not measured — Box lease expired before a result was posted.",
    finishedAt: now.toISOString(),
    costNote: `${SAM_BOX_COST_PREFIX} (lease expired)`,
    stepsUsed: null,
    proposalsQueued: 0,
  };
}

export async function sweepExpiredBoxRuns(
  now = new Date(),
): Promise<{ expired: number }> {
  let expired = 0;
  try {
    const nowIso = now.toISOString();
    const runs = await SamLoopRepository.getExpiredBoxRuns(
      nowIso,
      SAM_BOX_LEASE_SECONDS,
    );
    for (const run of runs) {
      try {
        const won = await finishSamBoxRun({
          run,
          data: samBoxExpiredFinish(now),
          touchLastRun: true,
          advance: true,
        });
        if (won) expired++;
      } catch {
        console.error({ event: "sam_box_sweep_run_failed", runId: run.id });
      }
    }
  } catch {
    console.error({ event: "sam_box_sweep_failed" });
  }
  return { expired };
}
