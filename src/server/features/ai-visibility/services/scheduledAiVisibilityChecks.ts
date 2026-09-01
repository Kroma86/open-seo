import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { reconcileStaleAiVisibilityRuns } from "@/server/features/ai-visibility/services/aiVisibilityReconciler";
import { runAiVisibilityCheck } from "@/server/features/ai-visibility/services/runAiVisibilityCheck";
import { customerHasPaidPlan } from "@/server/billing/subscription";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import {
  computeNextRunAt,
  isScheduledAiVisibilityInterval,
} from "@/shared/ai-visibility";

export async function runScheduledAiVisibilityChecks(_env: Env) {
  await reconcileStaleAiVisibilityRuns();

  const nowIso = new Date().toISOString();
  const dueConfigs =
    await AiVisibilityRepository.getDueConfigsWithOrganization(nowIso);
  if (dueConfigs.length === 0) return;

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
        console.error(
          `[cron] AI visibility check failed for config ${config.id}:`,
          err,
        );
        continue;
      }

      if (result.ok) {
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
