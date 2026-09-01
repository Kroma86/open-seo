import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { reclaimStaleRunsForConfig } from "@/server/features/ai-visibility/services/aiVisibilityReconciler";
import type {
  AiVisibilityCheckTrigger,
  AiVisibilityCheckTriggerResult,
} from "./AiVisibilityManagementService";

export async function failRunIfActive(
  runId: string,
  reason: string,
  run?: Awaited<ReturnType<typeof AiVisibilityRepository.getRunById>>,
) {
  const current = run ?? (await AiVisibilityRepository.getRunById(runId));
  if (
    !current ||
    current.status === "completed" ||
    current.status === "failed"
  ) {
    return false;
  }
  return AiVisibilityRepository.updateRunIfInFlight(
    runId,
    {
      status: "failed",
      error: reason,
      finishedAt: new Date().toISOString(),
    },
    { requireRunning: false },
  );
}

export async function beginAiVisibilityRun(input: {
  configId: string;
  projectId: string;
  promptSetVersion: number;
}): Promise<AiVisibilityCheckTriggerResult> {
  await reclaimStaleRunsForConfig(input.configId);

  const runId = crypto.randomUUID();
  const created = await AiVisibilityRepository.tryCreateRun({
    id: runId,
    configId: input.configId,
    projectId: input.projectId,
    promptSetVersion: input.promptSetVersion,
  });

  if (created) {
    return { ok: true, runId };
  }

  const blocker = await AiVisibilityRepository.getActiveRunForConfig(
    input.configId,
  );
  return {
    ok: false,
    reason: "already_running",
    blockingRunId: blocker?.id ?? null,
  };
}

export type { AiVisibilityCheckTrigger };
