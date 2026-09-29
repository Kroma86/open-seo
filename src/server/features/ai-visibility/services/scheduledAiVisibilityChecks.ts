import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { reconcileStaleAiVisibilityRuns } from "@/server/features/ai-visibility/services/aiVisibilityReconciler";
import { failRunIfActive } from "@/server/features/ai-visibility/services/aiVisibilityRunGuards";
import {
  executeQueuedAiVisibilityRun,
  runAiVisibilityCheck,
} from "@/server/features/ai-visibility/services/runAiVisibilityCheck";
import { customerHasPaidPlan } from "@/server/billing/subscription";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import {
  computeNextRunAt,
  isScheduledAiVisibilityInterval,
} from "@/shared/ai-visibility";

/** Back off failed scheduled runs so the interval is not lost to a hot loop. */
const SCHEDULED_RUN_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

/** Cap so one tick cannot turn a burst of hand starts into an hours-long cron. */
const QUEUED_MANUAL_RUNS_PER_TICK = 5;

const PLAN_REQUIRED_ERROR =
  "Upgrade to the paid plan to run AI visibility checks";

function scheduleRetryAfterFailure(): string {
  return new Date(Date.now() + SCHEDULED_RUN_FAILURE_BACKOFF_MS).toISOString();
}

async function drainQueuedManualRuns(
  isHosted: boolean,
  checkPaidPlan: (organizationId: string) => Promise<boolean>,
) {
  const queued = await AiVisibilityRepository.listQueuedManualRuns(
    QUEUED_MANUAL_RUNS_PER_TICK,
  );
  for (const run of queued) {
    try {
      if (isHosted) {
        let hasPaidPlan = false;
        try {
          hasPaidPlan = await checkPaidPlan(run.organizationId);
        } catch (err) {
          // Leave the row pending. The next tick retries. It is not "running".
          console.error(
            `[cron] AI visibility plan check failed for queued run ${run.id}:`,
            err,
          );
          continue;
        }
        if (!hasPaidPlan) {
          await failRunIfActive(run.id, PLAN_REQUIRED_ERROR);
          continue;
        }
      }

      await executeQueuedAiVisibilityRun({
        runId: run.id,
        configId: run.configId,
        projectId: run.projectId,
        billingCustomer: {
          userId: "system",
          userEmail: "system@openseo.so",
          organizationId: run.organizationId,
          projectId: run.projectId,
        },
      });
    } catch (err) {
      // The run is already marked failed inside executeQueuedAiVisibilityRun.
      // Do not touch nextRunAt: a hand start must not move the weekly schedule.
      console.error(`[cron] Queued AI visibility run ${run.id} failed:`, err);
    }
  }
}

export async function runScheduledAiVisibilityChecks(_env: Env) {
  await reconcileStaleAiVisibilityRuns();

  const nowIso = new Date().toISOString();
  const dueConfigs =
    await AiVisibilityRepository.getDueConfigsWithOrganization(nowIso);

  const isHosted = await isHostedServerAuthMode();
  const paidPlanChecks = new Map<string, Promise<boolean>>();
  const checkPaidPlan = (organizationId: string) => {
    let check = paidPlanChecks.get(organizationId);
    if (!check) {
      check = customerHasPaidPlan(organizationId, { retryDenied: true });
      paidPlanChecks.set(organizationId, check);
    }
    return check;
  };

  let started = 0;
  let skippedFree = 0;
  let skippedNoPrompts = 0;
  let alreadyRunning = 0;
  let planCheckErrors = 0;
  let runErrors = 0;

  for (const config of dueConfigs) {
    try {
      const interval = isScheduledAiVisibilityInterval(config.scheduleInterval)
        ? config.scheduleInterval
        : null;
      if (!interval || !config.nextRunAt) continue;

      const observedNextRunAt = config.nextRunAt;
      const nextRunAt = computeNextRunAt(interval, observedNextRunAt);

      const activePrompts =
        await AiVisibilityRepository.getActivePromptsForConfig(config.id);
      if (activePrompts.length === 0) {
        const claimed = await AiVisibilityRepository.claimDueConfig({
          configId: config.id,
          projectId: config.projectId,
          observedNextRunAt,
          nextRunAt,
        });
        if (claimed) skippedNoPrompts++;
        continue;
      }

      let hasPaidPlan = true;
      if (isHosted) {
        try {
          hasPaidPlan = await checkPaidPlan(config.organizationId);
        } catch (err) {
          console.error(
            `[cron] AI visibility plan check failed for config ${config.id}:`,
            err,
          );
          planCheckErrors++;
          continue;
        }
      }

      if (!hasPaidPlan) {
        const claimed = await AiVisibilityRepository.claimDueConfig({
          configId: config.id,
          projectId: config.projectId,
          observedNextRunAt,
          nextRunAt,
        });
        if (claimed) skippedFree++;
        continue;
      }

      const claimed = await AiVisibilityRepository.claimDueConfig({
        configId: config.id,
        projectId: config.projectId,
        observedNextRunAt,
        nextRunAt,
      });
      if (!claimed) continue;

      let result;
      try {
        result = await runAiVisibilityCheck({
          configId: config.id,
          projectId: config.projectId,
          billingCustomer: {
            userId: "system",
            userEmail: "system@openseo.so",
            organizationId: config.organizationId,
            projectId: config.projectId,
          },
          trigger: "scheduled",
        });
      } catch (err) {
        runErrors++;
        // Retry in one hour instead of waiting a full weekly/monthly interval.
        // CAS on the value we claimed to, like every other scheduler write, so
        // a concurrent schedule change is never clobbered.
        await AiVisibilityRepository.claimDueConfig({
          configId: config.id,
          projectId: config.projectId,
          observedNextRunAt: nextRunAt,
          nextRunAt: scheduleRetryAfterFailure(),
        });
        console.error(
          `[cron] AI visibility check failed for config ${config.id}:`,
          err,
        );
        continue;
      }

      if (result.ok) {
        if (result.outcome === "reclaimed") {
          // Results were discarded — retry soon instead of losing the interval.
          runErrors++;
          await AiVisibilityRepository.claimDueConfig({
            configId: config.id,
            projectId: config.projectId,
            observedNextRunAt: nextRunAt,
            nextRunAt: scheduleRetryAfterFailure(),
          });
          continue;
        }
        started++;
        continue;
      }

      alreadyRunning++;
      await AiVisibilityRepository.claimDueConfig({
        configId: config.id,
        projectId: config.projectId,
        observedNextRunAt: nextRunAt,
        nextRunAt: observedNextRunAt,
      });
    } catch (err) {
      runErrors++;
      console.error(
        `[cron] Error processing AI visibility config ${config.id}:`,
        err,
      );
    }
  }

  if (dueConfigs.length > 0) {
    const logSummary =
      planCheckErrors + runErrors > 0 ? console.error : console.log;
    logSummary({
      event: "ai_visibility_scheduler_summary",
      candidates: dueConfigs.length,
      started,
      skippedFree,
      skippedNoPrompts,
      alreadyRunning,
      planCheckErrors,
      runErrors,
    });
  }

  // After scheduled work, so a hand start cannot delay or replace a due check.
  // A cutoff of the original request cannot reach this code.
  await drainQueuedManualRuns(isHosted, checkPaidPlan);
}
