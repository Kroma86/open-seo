import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { withPgClient } from "@/db";
import { SamLoopRepository } from "@/server/features/sam-loops/repositories/SamLoopRepository";
import { failSamLoopRunIfActive } from "@/server/features/sam-loops/services/samLoopRunGuards";
import { runHeadlessSamLoop } from "@/server/features/sam-loops/services/runHeadlessSamLoop";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { pgStep } from "@/server/workflows/pgStep";
import type { ToolAuthContext } from "@/server/mcp/context";
import { MCP_SCOPE } from "@/lib/oauth-resource";

const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "10 minutes" as const,
};

interface SamLoopParams {
  runId: string;
  loopId: string;
  projectId: string;
  organizationId: string;
  trigger: "manual" | "scheduled";
}

export class SamLoopWorkflow extends WorkflowEntrypoint<Env, SamLoopParams> {
  async run(event: WorkflowEvent<SamLoopParams>, step: WorkflowStep) {
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<SamLoopParams>,
    step: WorkflowStep,
  ) {
    const { runId, loopId, projectId, organizationId, trigger } = event.payload;

    try {
      const prepared = await pgStep(
        step,
        "prepare",
        { retries: { limit: 0, delay: "1 second" } },
        async () => {
          const run = await SamLoopRepository.getRunById(runId);
          if (!run || run.status === "failed" || run.status === "completed") {
            throw new NonRetryableError(
              `Run ${runId} is no longer active (status=${run?.status ?? "missing"})`,
            );
          }

          const loop = await SamLoopRepository.getLoopById(loopId, projectId);
          if (!loop || !loop.isEnabled) {
            throw new NonRetryableError(
              loop ? "Loop is disabled" : "Loop not found",
            );
          }

          const project = await ProjectRepository.getProjectById(projectId);
          if (!project) {
            throw new NonRetryableError("Project not found");
          }

          const nowIso = new Date().toISOString();
          await SamLoopRepository.updateRun(runId, {
            status: "running",
            startedAt: nowIso,
          });

          return {
            loop: {
              name: loop.name,
              sourceType: loop.sourceType,
              skillName: loop.skillName,
              customPrompt: loop.customPrompt,
            },
            project: {
              id: project.id,
              name: project.name,
              domain: project.domain,
              locationCode: project.locationCode,
              languageCode: project.languageCode,
            },
          };
        },
      );

      const execution = await pgStep(
        step,
        "run-sam",
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () => {
          const authContext: ToolAuthContext = {
            userId: "system",
            userEmail: "system@openseo.so",
            organizationId,
            clientId: null,
            baseUrl: "https://app.openseo.so",
            scopes: [MCP_SCOPE],
          };

          return runHeadlessSamLoop({
            project: prepared.project,
            authContext,
            sourceType: prepared.loop.sourceType,
            skillName: prepared.loop.skillName,
            customPrompt: prepared.loop.customPrompt,
            loopName: prepared.loop.name,
          });
        },
      );

      await pgStep(step, "finalize", SINGLE_ATTEMPT_STEP_CONFIG, async () => {
        const run = await SamLoopRepository.getRunById(runId);
        if (!run || run.status === "failed" || run.status === "completed") {
          console.warn(
            `[sam-loop] ${runId} no longer active (status=${run?.status ?? "missing"}), skipping finalization`,
          );
          return;
        }

        const nowIso = new Date().toISOString();
        await SamLoopRepository.updateRun(runId, {
          status: "completed",
          finishedAt: nowIso,
          report: execution.report,
          proposalsQueued: execution.proposalsQueued,
          stepsUsed: execution.stepsUsed,
          costNote: execution.costNote,
        });
        await SamLoopRepository.updateLoop(loopId, projectId, {
          lastRunAt: nowIso,
        });

        console.log(
          `[sam-loop] ${runId} completed loop=${loopId} project=${projectId} trigger=${trigger} proposals=${execution.proposalsQueued} steps=${execution.stepsUsed}`,
        );
      });
    } catch (error) {
      console.error(`[sam-loop] ${runId} failed:`, error);
      await pgStep(step, "mark-failed", SINGLE_ATTEMPT_STEP_CONFIG, async () => {
        const message =
          error instanceof Error ? error.message : "Unknown error";
        await failSamLoopRunIfActive(runId, message);
      });
      throw error;
    }
  }
}
