import { SamLoopRepository } from "../repositories/SamLoopRepository";
import { computeNextSamLoopRunAt } from "@/shared/sam-loops";

export type SamBoxFinishData = {
  status: "completed" | "failed";
  error: string | null;
  report: string;
  proposalsQueued: number;
  stepsUsed: number | null;
  costNote: string;
  finishedAt?: string;
};

export async function advanceSamBoxLoop(
  loopId: string,
  projectId: string,
): Promise<void> {
  const loop = await SamLoopRepository.getLoopById(loopId, projectId);
  if (!loop || loop.nextRunAt === null) return;
  const nextRunMs = Date.parse(loop.nextRunAt);
  if (!Number.isFinite(nextRunMs)) {
    throw new Error("Box loop has an invalid next run timestamp.");
  }
  if (nextRunMs > Date.now()) return;
  await SamLoopRepository.claimDueLoop({
    loopId,
    projectId,
    observedNextRunAt: loop.nextRunAt,
    nextRunAt: computeNextSamLoopRunAt(
      loop.cadence,
      loop.nextRunAt,
      `${projectId}:${loop.name}`,
    ),
  });
}

export async function finishSamBoxRun(input: {
  run: { id: string; loopId: string; projectId: string };
  data: SamBoxFinishData;
  touchLastRun: boolean;
  advance: boolean;
}): Promise<boolean> {
  const { run, data, touchLastRun, advance } = input;
  const finishedAt = data.finishedAt ?? new Date().toISOString();
  const won = await SamLoopRepository.finishRunIfRunning(run.id, {
    ...data,
    finishedAt,
  });
  if (!won) return false;
  if (touchLastRun) {
    await SamLoopRepository.updateLoop(run.loopId, run.projectId, {
      lastRunAt: finishedAt,
    });
  }
  if (advance) await advanceSamBoxLoop(run.loopId, run.projectId);
  return true;
}
