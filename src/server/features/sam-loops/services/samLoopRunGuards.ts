import { env } from "cloudflare:workers";
import { SamLoopRepository } from "@/server/features/sam-loops/repositories/SamLoopRepository";
import {
  SAM_LOOP_DAILY_RUN_CAP_DEFAULT,
  startOfUtcDay,
} from "@/shared/sam-loops";

const warnedInvalidSamLoopDailyRunCaps = new Set<string>();

export function getSamLoopDailyRunCap(env: {
  SAM_LOOP_DAILY_RUN_CAP?: string;
}): number {
  const raw = env.SAM_LOOP_DAILY_RUN_CAP?.trim();
  if (!raw) return SAM_LOOP_DAILY_RUN_CAP_DEFAULT;

  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < 1 ||
    parsed > 1000 ||
    String(parsed) !== raw
  ) {
    if (!warnedInvalidSamLoopDailyRunCaps.has(raw)) {
      warnedInvalidSamLoopDailyRunCaps.add(raw);
      console.error(
        `Invalid SAM_LOOP_DAILY_RUN_CAP "${raw}" — falling back to ${SAM_LOOP_DAILY_RUN_CAP_DEFAULT}. Valid range: 1..1000.`,
      );
    }
    return SAM_LOOP_DAILY_RUN_CAP_DEFAULT;
  }
  return parsed;
}
import type { SamLoopTriggerResult } from "@/types/schemas/sam-loops";

type RunRow = Awaited<ReturnType<typeof SamLoopRepository.getRunById>>;

type SamLoopWorkflowStatus = {
  status:
    | "queued"
    | "running"
    | "paused"
    | "errored"
    | "terminated"
    | "complete"
    | "waiting"
    | "waitingForPause"
    | "unknown";
  error?: { message: string };
};

const ACTIVE_WORKFLOW_STATUSES = new Set<SamLoopWorkflowStatus["status"]>([
  "queued",
  "running",
  "waiting",
  "waitingForPause",
  "paused",
]);

const STARTUP_GRACE_MS = 60 * 1000;

async function getWorkflowStatus(
  runId: string,
): Promise<SamLoopWorkflowStatus | null> {
  try {
    const instance = await env.SAM_LOOP_WORKFLOW.get(runId);
    return (await instance.status()) as SamLoopWorkflowStatus;
  } catch {
    return null;
  }
}

function getStaleReason(
  workflowStatus: SamLoopWorkflowStatus | null,
  run: RunRow,
): string {
  if (run?.status === "completed" || run?.status === "failed") {
    return `Run already ${run.status}`;
  }
  if (!workflowStatus) {
    return "Workflow instance was not found";
  }
  if (
    workflowStatus.status === "errored" ||
    workflowStatus.status === "terminated"
  ) {
    return workflowStatus.error?.message ?? `Workflow ${workflowStatus.status}`;
  }
  if (workflowStatus.status === "complete") {
    return "Workflow completed without finalizing the run";
  }
  return `Workflow is no longer active (${workflowStatus.status})`;
}

async function getStaleRunReason(input: {
  run: RunRow;
  runId: string;
  ageMs: number;
}) {
  const workflowStatus = await getWorkflowStatus(input.runId);

  if (workflowStatus && ACTIVE_WORKFLOW_STATUSES.has(workflowStatus.status)) {
    return null;
  }

  const startedAt = input.run?.startedAt ?? input.run?.createdAt;
  const ageMs = startedAt
    ? Date.now() - new Date(startedAt).getTime()
    : input.ageMs;

  const startupWindow =
    ageMs < STARTUP_GRACE_MS &&
    (!input.run ||
      input.run.status === "pending" ||
      input.run.status === "running") &&
    (!workflowStatus || workflowStatus.status === "unknown");

  if (startupWindow) {
    return null;
  }

  return getStaleReason(workflowStatus, input.run);
}

export async function failSamLoopRunIfActive(
  runId: string,
  reason: string,
  run?: RunRow,
) {
  const current = run ?? (await SamLoopRepository.getRunById(runId));
  if (
    !current ||
    current.status === "completed" ||
    current.status === "failed"
  ) {
    return;
  }
  await SamLoopRepository.updateRun(runId, {
    status: "failed",
    error: reason,
    finishedAt: new Date().toISOString(),
  });
}

export async function beginSamLoopRun(input: {
  workflow: Env["SAM_LOOP_WORKFLOW"];
  loopId: string;
  projectId: string;
  organizationId: string;
  trigger: "manual" | "scheduled";
  workflowStartErrorMessage: string;
}): Promise<SamLoopTriggerResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const runId = crypto.randomUUID();
    // count-then-insert is not atomic; this narrows the race to the insert itself. Accepted residual: an overshoot bounded by the number of concurrent starters, each one loop run.
    const runsToday = await SamLoopRepository.countRunsCreatedSince(
      startOfUtcDay(),
    );
    if (runsToday >= getSamLoopDailyRunCap(env)) {
      return { ok: false, reason: "daily_cap" };
    }
    const created = await SamLoopRepository.tryCreateRun({
      id: runId,
      loopId: input.loopId,
      projectId: input.projectId,
    });

    if (created) {
      try {
        await input.workflow.create({
          id: runId,
          params: {
            runId,
            loopId: input.loopId,
            projectId: input.projectId,
            organizationId: input.organizationId,
            trigger: input.trigger,
          },
        });
      } catch (error) {
        await failSamLoopRunIfActive(runId, input.workflowStartErrorMessage);
        try {
          const instance = await input.workflow.get(runId);
          await instance.terminate();
        } catch {
          // Workflow may not have been created.
        }
        throw error;
      }
      return { ok: true, runId };
    }

    const blocker = await SamLoopRepository.getActiveRunForLoop(input.loopId);
    if (!blocker) continue;

    if (attempt === 0) {
      const ageMs = Date.now() - new Date(blocker.createdAt).getTime();
      const staleReason = await getStaleRunReason({
        run: blocker,
        runId: blocker.id,
        ageMs,
      });
      if (staleReason) {
        await failSamLoopRunIfActive(blocker.id, staleReason, blocker);
        continue;
      }
    }

    return {
      ok: false,
      reason: "already_running",
      blockingRunId: blocker.id,
    };
  }

  const final = await SamLoopRepository.getActiveRunForLoop(input.loopId);
  return {
    ok: false,
    reason: "already_running",
    blockingRunId: final?.id ?? null,
  };
}
