import { SamLoopRepository } from "@/server/features/sam-loops/repositories/SamLoopRepository";
import {
  beginSamLoopRun,
  getSamLoopDailyRunCap,
} from "@/server/features/sam-loops/services/samLoopRunGuards";
import {
  computeNextSamLoopRunAt,
  isSamLoopProjectAllowed,
  startOfUtcDay,
} from "@/shared/sam-loops";

const TICK_DEADLINE_MS = 3 * 60_000;
const ALREADY_RUNNING_IDS_CAP = 20;

/** Cron body: claim due enabled loops and start SamLoopWorkflow for each. */
export async function runScheduledSamLoops(env: Env) {
  const dailyRunCap = getSamLoopDailyRunCap(env);
  const runsToday = await SamLoopRepository.countRunsCreatedSince(
    startOfUtcDay(),
  );
  if (runsToday >= dailyRunCap) {
    console.error({
      event: "sam_loops_daily_cap_hit",
      cap: dailyRunCap,
      runsToday,
    });
    return;
  }
  let budget = dailyRunCap - runsToday;

  const nowIso = new Date().toISOString();
  const dueLoops =
    await SamLoopRepository.getDueLoopsWithOrganization(nowIso);

  const deadline = Date.now() + TICK_DEADLINE_MS;
  let started = 0;
  let stoppedByDeadline = false;
  let stoppedByCap = false;
  let concurrentChangeSkips = 0;
  let alreadyRunning = 0;
  const alreadyRunningLoopIds: string[] = [];
  let workflowStartErrors = 0;
  let loopErrors = 0;
  let domainSkips = 0;

  for (const loop of dueLoops) {
    if (Date.now() >= deadline) {
      stoppedByDeadline = true;
      break;
    }

    try {
      if (!loop.nextRunAt) continue;

      const observedNextRunAt = loop.nextRunAt;
      const nextRunAt = computeNextSamLoopRunAt(
        loop.cadence,
        observedNextRunAt,
        `${loop.projectId}:${loop.name}`,
      );

      if (
        !isSamLoopProjectAllowed({
          domain: loop.domain,
          loopsEnabled: loop.loopsEnabled,
        })
      ) {
        const deferred = await SamLoopRepository.claimDueLoop({
          loopId: loop.id,
          projectId: loop.projectId,
          observedNextRunAt,
          nextRunAt,
        });
        if (!deferred) {
          concurrentChangeSkips++;
          continue;
        }
        domainSkips++;
        continue;
      }

      if (started >= budget) {
        stoppedByCap = true;
        break;
      }

      const claimed = await SamLoopRepository.claimDueLoop({
        loopId: loop.id,
        projectId: loop.projectId,
        observedNextRunAt,
        nextRunAt,
      });
      if (!claimed) {
        concurrentChangeSkips++;
        continue;
      }
      const restoreSchedule = async () => {
        const restored = await SamLoopRepository.claimDueLoop({
          loopId: loop.id,
          projectId: loop.projectId,
          observedNextRunAt: nextRunAt,
          nextRunAt: observedNextRunAt,
        });
        if (!restored) {
          console.log(
            `[cron] Could not restore schedule for Sam loop ${loop.id} — changed concurrently`,
          );
        }
      };

      let result;
      try {
        result = await beginSamLoopRun({
          workflow: env.SAM_LOOP_WORKFLOW,
          loopId: loop.id,
          projectId: loop.projectId,
          organizationId: loop.organizationId,
          trigger: "scheduled",
          workflowStartErrorMessage: "Failed to start scheduled Sam loop",
        });
      } catch (err) {
        workflowStartErrors++;
        console.error(
          `[cron] Failed to start Sam loop ${loop.id} (${loop.name}):`,
          err,
        );
        await restoreSchedule();
        continue;
      }

      if (result.ok) {
        started++;
        continue;
      }

      // Keep the original due date when admission refuses the run.
      if (result.reason === "daily_cap") stoppedByCap = true;
      await restoreSchedule();
      if (stoppedByCap) break;
      alreadyRunning++;
      if (alreadyRunningLoopIds.length < ALREADY_RUNNING_IDS_CAP) {
        alreadyRunningLoopIds.push(loop.id);
      }
    } catch (err) {
      loopErrors++;
      console.error(`[cron] Error processing Sam loop ${loop.id}:`, err);
      if (stoppedByCap) break;
    }
  }

  const oldestDue = dueLoops[0]?.nextRunAt;
  const logSummary =
    workflowStartErrors + loopErrors > 0 ? console.error : console.log;
  logSummary({
    event: "sam_loops_scheduler_summary",
    candidates: dueLoops.length,
    started,
    stoppedByDeadline,
    stoppedByCap,
    runsToday,
    concurrentChangeSkips,
    alreadyRunning,
    alreadyRunningLoopIds,
    workflowStartErrors,
    loopErrors,
    domainSkips,
    oldestDueAgeMs: oldestDue
      ? Date.now() - new Date(oldestDue).getTime()
      : null,
  });
}
