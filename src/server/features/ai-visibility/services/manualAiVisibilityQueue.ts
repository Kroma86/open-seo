import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { AiVisibilityManagementService } from "./AiVisibilityManagementService";
import { reclaimStaleRunsForConfig } from "./aiVisibilityReconciler";
import { isStaleInFlightRun } from "./aiVisibilityStaleRun";
import { executeAiVisibilityRun } from "./runAiVisibilityCheck";
import type { NameBudget } from "./brandNameDecision";
import {
  aiVisibilityRequestFingerprint,
  manualAiQueueEnvelope,
  manualAiQueueEnvelopeSchema,
} from "./manualAiVisibilityQueueContract";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { pausedScheduledSeoProjects } from "@/server/features/projects/services/scheduledSeoPauses";
import { AppError } from "@/server/lib/errors";

export async function enqueueManualAiVisibilityCheck(input: {
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
}) {
  await AiVisibilityManagementService.requireAiVisibilityAccess(
    input.billingCustomer.organizationId,
  );
  const config = await AiVisibilityManagementService.getValidatedConfig(
    input.configId,
    input.projectId,
  );
  const project = await ProjectRepository.getProjectForOrganization(
    input.projectId,
    input.billingCustomer.organizationId,
  );
  if (!project) throw new AppError("NOT_FOUND", "Project not found");
  if (
    !config.isActive ||
    pausedScheduledSeoProjects(new Date().toISOString()).includes(
      input.projectId,
    )
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "AI visibility checks are paused for this project or config",
    );
  }
  const prompts = await AiVisibilityRepository.getActivePromptsForConfig(
    config.id,
  );
  if (!prompts.length)
    throw new AppError(
      "VALIDATION_ERROR",
      "Add an active prompt before starting a check",
    );
  const fingerprint = await aiVisibilityRequestFingerprint({
    config,
    project,
    prompts,
  });
  const detail = manualAiQueueEnvelope(
    input.billingCustomer,
    input.projectId,
    fingerprint,
  );
  await reclaimStaleRunsForConfig(config.id);
  const runId = crypto.randomUUID();
  const inserted = await AiVisibilityRepository.tryCreateRun({
    id: runId,
    configId: config.id,
    projectId: input.projectId,
    promptSetVersion: config.promptSetVersion,
    detail,
  });
  if (!inserted) {
    const blocker = await AiVisibilityRepository.getActiveRunForConfig(
      config.id,
    );
    return {
      ok: false as const,
      reason: "already_running" as const,
      blockingRunId: blocker?.id ?? null,
    };
  }
  // Only durable acceptance happens here. The cron worker owns execution.
  return { ok: true as const, runId, outcome: "queued" as const };
}

export async function runQueuedManualAiVisibilityChecks(
  nameBudget: NameBudget,
) {
  const queued = await AiVisibilityRepository.getQueuedManualRuns();
  for (const run of queued) {
    try {
      if (run.status !== "pending" || run.startedAt || run.finishedAt) continue;
      if (isStaleInFlightRun(run) || Date.parse(run.createdAt) > Date.now()) {
        throw new Error(
          "Queued AI visibility request expired or has an invalid timestamp",
        );
      }
      const envelope = manualAiQueueEnvelopeSchema.parse(
        JSON.parse(run.detail ?? "null"),
      );
      if (envelope.billingCustomer.projectId !== run.projectId)
        throw new Error("Queued project scope mismatch");
      await AiVisibilityManagementService.requireAiVisibilityAccess(
        envelope.billingCustomer.organizationId,
      );
      await executeAiVisibilityRun({
        runId: run.id,
        configId: run.configId,
        projectId: run.projectId,
        billingCustomer: envelope.billingCustomer,
        trigger: "manual",
        nameBudget,
        expectedFingerprint: envelope.fingerprint,
        expectedPromptSetVersion: run.promptSetVersion,
      });
    } catch {
      // Never fail a row another worker already claimed. The engine owns its
      // post-claim failure handling. No automatic replay of uncertain work.
      await AiVisibilityRepository.failPendingRun(
        run.id,
        "Queued AI visibility request could not safely run; start a new check after resolving the hold",
      );
    }
  }
}
