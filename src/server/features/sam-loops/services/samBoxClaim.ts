import { z } from "zod";
import { SamLoopRepository } from "../repositories/SamLoopRepository";
import {
  computeNextSamLoopRunAt,
  isSamLoopProjectAllowed,
  startOfUtcDay,
} from "@/shared/sam-loops";
import { generationErrorDetail } from "./runHeadlessSamLoop";
import {
  advanceSamBoxLoop,
  finishSamBoxRun,
  type SamBoxFinishData,
} from "./samBoxFinalize";
import { samBoxKindForLoop } from "./samBoxKinds";
import { leaseExpiresAt, leaseIdFor } from "./samBoxMode";
import { prepareSamBoxClaim } from "./samBoxPrepare";
import { sweepExpiredBoxRuns } from "./samBoxSweep";
import { getSamLoopDailyRunCap } from "./samLoopRunGuards";
import {
  SAM_BOX_COST_PREFIX,
  SAM_BOX_KINDS,
  SAM_BOX_KIND_LIMITS,
  SAM_BOX_LEASE_SECONDS,
  SAM_BOX_MAX_OUTPUT_BYTES,
  SAM_BOX_MAX_PROMPT_BYTES,
  SAM_BOX_MAX_REPORT_CHARS,
  type SamBoxHttpResult,
  type SamBoxPrepared,
} from "./samBoxTypes";

const claimBodySchema = z
  .object({
    contract: z.literal(1),
    runner_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.-]+$/),
    kinds: z.array(z.string()).min(1),
    max_prompt_bytes: z.number().int().min(4000).max(32000),
  })
  .strict();

const CLAIM_DEADLINE_MS = 80_000;
const CLAIM_SCAN_LIMIT = 10;
type ClaimedRun = { id: string; loopId: string; projectId: string };

function emptyClaim(
  reason: "nothing_due" | "daily_cap" | "no_supported_kind",
  finalizedWithoutModel = 0,
): SamBoxHttpResult {
  return {
    status: 200,
    body: {
      contract: 1,
      claim: null,
      reason,
      ...(finalizedWithoutModel > 0
        ? { finalized_without_model: finalizedWithoutModel }
        : {}),
    },
  };
}

function finishWithoutModel(
  run: ClaimedRun,
  data: Pick<SamBoxFinishData, "status" | "error" | "report">,
  finishedAt: string,
): Promise<boolean> {
  return finishSamBoxRun({
    run,
    data: {
      ...data,
      finishedAt,
      proposalsQueued: 0,
      stepsUsed: 0,
      costNote: "no model call",
    },
    touchLastRun: true,
    advance: true,
  });
}

export async function handleSamBoxClaim(input: {
  env: Env;
  body: unknown;
  now?: Date;
}): Promise<SamBoxHttpResult> {
  // Anchor injected timestamps to the same elapsed clock as the request budget.
  const requestStartedMs = Date.now();
  const nowMs = input.now?.getTime() ?? requestStartedMs;
  const currentTime = () => nowMs + (Date.now() - requestStartedMs);
  const deadline = nowMs + CLAIM_DEADLINE_MS;
  const parsed = claimBodySchema.safeParse(input.body);
  if (!parsed.success) {
    return { status: 400, body: { error: "invalid_body" } };
  }
  const requestedKinds = new Set(
    SAM_BOX_KINDS.filter((kind) => parsed.data.kinds.includes(kind)),
  );
  if (requestedKinds.size === 0) return emptyClaim("no_supported_kind");

  try {
    await sweepExpiredBoxRuns();
  } catch {
    console.error({ event: "sam_box_sweep_failed" });
  }

  let activeRun: ClaimedRun | null = null;
  let runStarted = false;
  let finalizedWithoutModel = 0;
  try {
    const cap = getSamLoopDailyRunCap(input.env);
    const sinceDate = startOfUtcDay(new Date(currentTime()));
    const runsToday = await SamLoopRepository.countRunsCreatedSince(sinceDate);
    if (runsToday >= cap) return emptyClaim("daily_cap");
    const due = await SamLoopRepository.getDueLoopsWithOrganization(
      new Date(currentTime()).toISOString(),
    );
    const candidates = due.flatMap((loop) => {
      const kind = samBoxKindForLoop(loop);
      return kind !== null && requestedKinds.has(kind) ? [{ loop, kind }] : [];
    });

    for (const { loop, kind } of candidates.slice(0, CLAIM_SCAN_LIMIT)) {
      if (currentTime() >= deadline) break;
      if (!loop.nextRunAt) continue;
      if (
        !isSamLoopProjectAllowed({
          domain: loop.domain,
          loopsEnabled: loop.loopsEnabled,
        })
      ) {
        await SamLoopRepository.claimDueLoop({
          loopId: loop.id,
          projectId: loop.projectId,
          observedNextRunAt: loop.nextRunAt,
          nextRunAt: computeNextSamLoopRunAt(
            loop.cadence,
            loop.nextRunAt,
            `${loop.projectId}:${loop.name}`,
          ),
        });
        continue;
      }

      const run = {
        id: crypto.randomUUID(),
        loopId: loop.id,
        projectId: loop.projectId,
      };
      const created = await SamLoopRepository.tryCreateRun(run, {
        sinceDate: startOfUtcDay(new Date(currentTime())),
        cap,
      });
      if (!created) {
        if (await SamLoopRepository.getActiveRunForLoop(loop.id)) continue;
        return emptyClaim("daily_cap", finalizedWithoutModel);
      }
      activeRun = run;
      runStarted = false;
      const startedAt = new Date(currentTime()).toISOString();
      await SamLoopRepository.updateRun(run.id, {
        status: "running",
        startedAt,
        costNote: `${SAM_BOX_COST_PREFIX} leased`,
      });
      runStarted = true;
      if (currentTime() >= deadline) {
        throw new Error("Box claim exceeded the request deadline.");
      }

      let prepared: SamBoxPrepared;
      try {
        prepared = await prepareSamBoxClaim({
          env: input.env,
          loop,
          kind,
          runId: run.id,
          maxPromptBytes: Math.min(
            parsed.data.max_prompt_bytes,
            SAM_BOX_MAX_PROMPT_BYTES,
          ),
        });
      } catch (error) {
        const detail = `Box claim could not prepare inputs: ${generationErrorDetail(error)}`;
        prepared = {
          kind: "final",
          status: "failed",
          error: detail,
          report: `Not measured — ${detail}`,
        };
      }
      if (prepared.kind === "final") {
        const won = await finishWithoutModel(
          run,
          {
            status: prepared.status,
            error: prepared.error,
            report: prepared.report,
          },
          new Date(currentTime()).toISOString(),
        );
        if (won) finalizedWithoutModel++;
        activeRun = null;
        continue;
      }

      if (prepared.staleNotice) {
        await SamLoopRepository.updateRun(run.id, {
          report: prepared.staleNotice,
        });
      }
      if (currentTime() >= deadline) {
        throw new Error("Box claim exceeded the request deadline.");
      }
      const limits = SAM_BOX_KIND_LIMITS[kind];
      return {
        status: 200,
        body: {
          contract: 1,
          claim: {
            lease_id: leaseIdFor(run.id, startedAt),
            run_id: run.id,
            loop_id: loop.id,
            project_id: loop.projectId,
            kind,
            loop_name: loop.name,
            cadence: loop.cadence,
            claimed_at: startedAt,
            lease_expires_at: leaseExpiresAt(startedAt),
            prompt: prepared.prompt,
            prompt_bytes: prepared.promptBytes,
            tool_results: prepared.toolResults,
            output: {
              format: "json_object",
              schema_id: "sam-box-result-v1",
              max_output_bytes: SAM_BOX_MAX_OUTPUT_BYTES,
              max_report_chars: SAM_BOX_MAX_REPORT_CHARS,
              max_proposals: limits.maxProposals,
              allowed_fields: [...limits.allowedFields],
            },
            limits: { call_seconds: 180, lease_seconds: SAM_BOX_LEASE_SECONDS },
          },
        },
      };
    }
    return emptyClaim("nothing_due", finalizedWithoutModel);
  } catch (error) {
    console.error({
      event: "sam_box_claim_failed",
      runId: activeRun?.id ?? null,
    });
    if (activeRun) {
      try {
        const detail = runStarted
          ? `Box claim failed: ${generationErrorDetail(error)}`
          : "Box claim could not start the run.";
        const finishedAt = new Date(currentTime()).toISOString();
        const data: SamBoxFinishData = {
          status: "failed",
          error: detail,
          report: runStarted
            ? `Not measured — ${detail}`
            : `Not measured — ${detail} No model was called.`,
          finishedAt,
          proposalsQueued: 0,
          stepsUsed: 0,
          costNote: "no model call",
        };
        // The running update may have committed before throwing: try its CAS first.
        const won = await finishSamBoxRun({
          run: activeRun,
          data,
          touchLastRun: true,
          advance: true,
        });
        if (!won && !runStarted) {
          const current = await SamLoopRepository.getRunById(activeRun.id);
          if (current?.status === "pending") {
            await SamLoopRepository.updateRun(activeRun.id, data);
            await SamLoopRepository.updateLoop(
              activeRun.loopId,
              activeRun.projectId,
              { lastRunAt: finishedAt },
            );
            await advanceSamBoxLoop(activeRun.loopId, activeRun.projectId);
          }
        }
      } catch {
        console.error({
          event: "sam_box_claim_cleanup_failed",
          runId: activeRun.id,
        });
      }
    }
    return { status: 500, body: { error: "claim_failed" } };
  }
}
