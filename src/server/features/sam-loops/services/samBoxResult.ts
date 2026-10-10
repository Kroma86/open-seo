import { z } from "zod";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  enqueueHomegrownOttoProposal,
  listHomegrownOttoProposals,
} from "@/server/features/agency/AgencyOttoProposalsService";
import { SamLoopRepository } from "../repositories/SamLoopRepository";
import { generationErrorDetail } from "./runHeadlessSamLoop";
import { finishSamBoxRun, type SamBoxFinishData } from "./samBoxFinalize";
import { samBoxKindForLoop } from "./samBoxKinds";
import { leaseIdFor, leaseExpiresAt } from "./samBoxMode";
import { samBoxExpiredFinish } from "./samBoxSweep";
import {
  validateSamBoxResult,
  type SamBoxProposal,
} from "./samBoxResultValidate";
import {
  SAM_BOX_COST_PREFIX,
  SAM_BOX_KIND_LIMITS,
  SAM_BOX_MAX_OUTPUT_BYTES,
  SAM_BOX_MAX_REPORT_CHARS,
  type SamBoxHttpResult,
  type SamBoxKind,
  type SamBoxOutputLimits,
} from "./samBoxTypes";

export { validateSamBoxResult };

const envelopeFields = {
  contract: z.literal(1),
  lease_id: z.string(),
  run_id: z.string(),
  runner_id: z.string(),
};
const resultEnvelope = z
  .object({
    ...envelopeFields,
    model: z.string(),
    duration_ms: z.number(),
    journal_ticket: z.string(),
    result: z.custom<unknown>((value) => value !== undefined),
  })
  .strict();
const abandonEnvelope = z
  .object({
    ...envelopeFields,
    stage: z.string(),
    code: z.string(),
    detail: z.string().optional(),
  })
  .strict();
const abandonValues = z
  .object({
    stage: z.enum(["before_model", "model_call"]),
    code: z.enum([
      "controller_active",
      "quiet_window",
      "daily_cap",
      "consecutive_failures",
      "journal_hold",
      "runtime_refused",
      "prompt_too_large",
      "prompt_refused",
      "lease_too_short",
      "model_timeout",
      "model_error",
      "invalid_model_output",
      "runner_error",
    ]),
  })
  .strict();
type BoxRun = NonNullable<
  Awaited<ReturnType<typeof SamLoopRepository.getRunById>>
>;

function httpError(status: number, error: string): SamBoxHttpResult {
  return { status, body: { error } };
}

function validIds(input: {
  run_id: string;
  lease_id: string;
  runner_id: string;
}): boolean {
  return (
    input.run_id.length > 0 &&
    input.lease_id.length > 0 &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(input.runner_id)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function checkRun(input: {
  run_id: string;
  lease_id: string;
}): Promise<
  { ok: true; run: BoxRun } | { ok: false; response: SamBoxHttpResult }
> {
  const run = await SamLoopRepository.getRunById(input.run_id);
  if (!run) return { ok: false, response: httpError(404, "unknown_run") };
  const releasedBeforeModel =
    run.status === "failed" &&
    run.error?.startsWith(
      "Box runner released the run before any model call (",
    );
  if (!run.costNote?.startsWith(SAM_BOX_COST_PREFIX) && !releasedBeforeModel) {
    return { ok: false, response: httpError(409, "not_a_box_run") };
  }
  if (
    !run.startedAt ||
    !Number.isFinite(Date.parse(run.startedAt)) ||
    input.lease_id !== leaseIdFor(run.id, run.startedAt)
  ) {
    return { ok: false, response: httpError(409, "lease_mismatch") };
  }
  // Only a leased running attempt or a terminal box attempt is eligible.
  if (run.status === "pending")
    return { ok: false, response: httpError(409, "not_a_box_run") };
  return { ok: true, run };
}

function resultBody(
  run: Pick<BoxRun, "id" | "status" | "error" | "proposalsQueued">,
  replay: boolean,
): SamBoxHttpResult {
  return {
    status: 200,
    body: {
      ok: true,
      run_id: run.id,
      status: run.status,
      error: run.error,
      proposals_queued: run.proposalsQueued,
      replay,
    },
  };
}

async function currentReplay(
  runId: string,
  abandon = false,
): Promise<SamBoxHttpResult> {
  const current = await SamLoopRepository.getRunById(runId);
  if (!current) return httpError(404, "unknown_run");
  return abandon ? abandonBody(current, true) : resultBody(current, true);
}

function outputLimits(kind: SamBoxKind): SamBoxOutputLimits {
  const kindLimits = SAM_BOX_KIND_LIMITS[kind];
  return {
    format: "json_object",
    schema_id: "sam-box-result-v1",
    max_output_bytes: SAM_BOX_MAX_OUTPUT_BYTES,
    max_report_chars: SAM_BOX_MAX_REPORT_CHARS,
    max_proposals: kindLimits.maxProposals,
    allowed_fields: [...kindLimits.allowedFields],
  };
}

function fixesFor(proposal: SamBoxProposal): Record<string, string> {
  const fixes: Record<string, string> = {};
  for (const field of ["title", "description", "h1"] as const) {
    if (proposal[field]) fixes[field] = proposal[field];
  }
  return fixes;
}

function sameFixes(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const fields = Object.keys(left);
  return (
    fields.length === Object.keys(right).length &&
    fields.every((field) => left[field] === right[field])
  );
}

async function queueProposals(
  project: { id: string; domain: string; organizationId: string },
  proposals: SamBoxProposal[],
): Promise<{
  count: number;
  failed: number;
  error: string | null;
}> {
  let count = 0;
  let failed = 0;
  let error: string | null = null;
  if (!proposals.length) return { count, failed, error };
  const domain = project.domain;
  let pending: Awaited<ReturnType<typeof listHomegrownOttoProposals>>;
  try {
    pending = await listHomegrownOttoProposals({
      domain,
      status: "pending",
      limit: 200,
      visibleToOrganizationId: project.organizationId,
    });
  } catch (cause) {
    return {
      count: 0,
      failed: proposals.length,
      error: generationErrorDetail(cause),
    };
  }
  for (const proposal of proposals) {
    const fixes = fixesFor(proposal);
    if (
      pending.some(
        (row) => row.path === proposal.path && sameFixes(row.fixes, fixes),
      )
    ) {
      count++;
      continue;
    }
    try {
      await enqueueHomegrownOttoProposal({
        domain,
        organizationId: project.organizationId,
        projectId: project.id,
        path: proposal.path,
        fixes,
        before: {
          title: proposal.before_title ?? null,
          description: proposal.before_description ?? null,
        },
        humanReview: proposal.human_review ?? [],
        rationale: proposal.rationale ?? null,
        proposedBy: "sam",
      });
      count++;
    } catch (cause) {
      failed++;
      error ??= generationErrorDetail(cause);
    }
  }
  return { count, failed, error };
}

function workerNote(dropped: string[]): string {
  return dropped.length
    ? `\n\nWorker note: ${dropped.length} proposal(s) were not queued (${[...new Set(dropped)].join(", ")}).`
    : "";
}

function logFinal(run: BoxRun, data: SamBoxFinishData): void {
  console.log(
    `[sam-loop] ${run.id} ${data.status} loop=${run.loopId} project=${run.projectId} trigger=box proposals=${data.proposalsQueued} steps=${data.stepsUsed}`,
  );
}

export async function handleSamBoxResult(input: {
  body: unknown;
}): Promise<SamBoxHttpResult> {
  const parsed = resultEnvelope.safeParse(input.body);
  if (!parsed.success) return httpError(400, "invalid_body");
  const body = parsed.data;
  if (body.model !== "grok-4.6" && body.model !== "grok-4.6-build")
    return httpError(422, "invalid_model");
  if (
    !validIds(body) ||
    !Number.isInteger(body.duration_ms) ||
    body.duration_ms < 0 ||
    body.duration_ms > 600000 ||
    !/^[a-f0-9]{32}$/.test(body.journal_ticket) ||
    !isPlainObject(body.result)
  )
    return httpError(422, "invalid_envelope");
  let resultBytes: number;
  try {
    resultBytes = new TextEncoder().encode(
      JSON.stringify(body.result),
    ).byteLength;
  } catch {
    return httpError(422, "invalid_envelope");
  }
  if (resultBytes > SAM_BOX_MAX_OUTPUT_BYTES)
    return httpError(422, "result_too_large");
  const checked = await checkRun(body);
  if (!checked.ok) return checked.response;
  const { run } = checked;
  if (run.status !== "running") return resultBody(run, true);
  if (run.startedAt && Date.now() > Date.parse(leaseExpiresAt(run.startedAt))) {
    const expired = samBoxExpiredFinish();
    const won = await finishSamBoxRun({
      run,
      data: expired,
      touchLastRun: true,
      advance: true,
    });
    if (!won) return currentReplay(run.id);
    logFinal(run, expired);
    return httpError(409, "lease_expired");
  }

  let error: string | null = null;
  let report = "";
  let proposalsQueued = 0;
  const loop = await SamLoopRepository.getLoopById(run.loopId, run.projectId);
  const kind = loop && samBoxKindForLoop(loop);
  if (!kind) {
    error = "Loop is no longer a box loop.";
  } else {
    const validated = validateSamBoxResult(
      body.result,
      kind,
      outputLimits(kind),
    );
    if (!validated.ok) {
      error = validated.error;
    } else {
      report = validated.report;
      const dropped: string[] = [...validated.dropped];
      const project = await ProjectRepository.getProjectById(run.projectId);
      if (!project?.domain?.trim()) {
        error = "Project has no domain for proposal queuing.";
      } else {
        const queued = await queueProposals(
          {
            id: project.id,
            domain: project.domain,
            organizationId: project.organizationId,
          },
          validated.proposals,
        );
        proposalsQueued = queued.count;
        dropped.push(
          ...Array.from({ length: queued.failed }, () => "queue_error"),
        );
        if (queued.error && !queued.count && validated.proposals.length)
          error = `Proposal queue failed: ${queued.error}`;
      }
      report += workerNote(dropped);
    }
  }
  const staleNotice = run.report?.startsWith("STALE AUDIT — ")
    ? run.report
    : "";
  const data: SamBoxFinishData = {
    status: error ? "failed" : "completed",
    error,
    report: staleNotice + (report || `Not measured — ${error}`),
    proposalsQueued,
    stepsUsed: 1,
    costNote: `${SAM_BOX_COST_PREFIX} ${body.model} · subscription, no per-use cost · ${Math.round(body.duration_ms / 1000)}s`,
  };
  const won = await finishSamBoxRun({
    run,
    data,
    touchLastRun: true,
    advance: true,
  });
  if (!won) {
    console.error({
      event: "sam_box_orphan_proposals",
      runId: run.id,
      count: proposalsQueued,
    });
    return currentReplay(run.id);
  }
  logFinal(run, data);
  return resultBody(
    { id: run.id, status: data.status, error: data.error, proposalsQueued },
    false,
  );
}

function abandonBody(
  run: Pick<BoxRun, "id" | "status">,
  replay: boolean,
): SamBoxHttpResult {
  return {
    status: 200,
    body: { ok: true, run_id: run.id, status: run.status, replay },
  };
}

export async function handleSamBoxAbandon(input: {
  body: unknown;
}): Promise<SamBoxHttpResult> {
  const parsed = abandonEnvelope.safeParse(input.body);
  if (!parsed.success) return httpError(400, "invalid_body");
  const body = parsed.data;
  const values = abandonValues.safeParse({
    stage: body.stage,
    code: body.code,
  });
  if (!values.success || !validIds(body))
    return httpError(422, "invalid_envelope");
  const checked = await checkRun(body);
  if (!checked.ok) return checked.response;
  const { run } = checked;
  if (run.status !== "running") return abandonBody(run, true);
  const { stage, code } = values.data;
  const beforeModel = stage === "before_model";
  const asciiDetail = (body.detail ?? "")
    .replace(/[^\x20-\x7E\t\r\n]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const detail = asciiDetail
    ? generationErrorDetail(new Error(asciiDetail))
    : "";
  const error = beforeModel
    ? `Box runner released the run before any model call (${code}).`
    : `Generation did not return a complete valid result. Box runner: ${code}${detail ? `: ${detail}` : ""}`;
  const data: SamBoxFinishData = {
    status: "failed",
    error,
    proposalsQueued: 0,
    stepsUsed: beforeModel ? 0 : 1,
    costNote: beforeModel
      ? "no model call"
      : `${SAM_BOX_COST_PREFIX} (${code})`,
    report: `Not measured — ${error}${beforeModel ? " No model was called." : ""}`,
  };
  const won = await finishSamBoxRun({
    run,
    data,
    touchLastRun: !beforeModel,
    advance: !beforeModel,
  });
  if (!won) return currentReplay(run.id, true);
  logFinal(run, data);
  return abandonBody({ id: run.id, status: data.status }, false);
}
