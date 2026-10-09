import { asSchema } from "ai";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { SamLoopRepository } from "../repositories/SamLoopRepository";
import {
  computeNextSamLoopRunAt,
  isSamLoopProjectAllowed,
  SAM_LOOP_STEP_CAP,
  startOfUtcDay,
} from "@/shared/sam-loops";
import { getSamLoopDailyRunCap } from "./samLoopRunGuards";
import type { PreparedSamLoop } from "./runHeadlessSamLoop";
import { prepareSubscriptionLoop as prepare } from "./subscriptionPreparation";
import {
  subscriptionTurnSchema,
  validateSubscriptionFinal,
  type SubscriptionRequest,
} from "./subscriptionContract";
import {
  SubscriptionLoopError,
  signReceipt,
  readReceipt,
  wireJson,
  receiptState,
} from "./subscriptionReceipt";
export { SubscriptionLoopError } from "./subscriptionReceipt";
import { countProposalsQueued } from "./countProposalsQueued";
import type { SubscriptionHouseScope } from "@/db/samLoopSubscriptionWrites";

const DEADLINE_MS = 15 * 60_000;

export async function buildSubscriptionPrompt(prepared: PreparedSamLoop) {
  return {
    system: prepared.system,
    prompt: `${prepared.prompt}\nSubscription execution: paid tools are unavailable. Use only the supplied tools. Return one JSON tool request or a final report matching the contract.`,
    monthly: prepared.monthly,
    domain: prepared.domain,
    tools: await Promise.all(
      Object.entries(prepared.tools).map(async ([name, tool]) => ({
        name,
        description: tool.description ?? "",
        inputSchema: await asSchema(tool.inputSchema).jsonSchema,
      })),
    ),
    outputSchema: z.toJSONSchema(subscriptionTurnSchema),
  };
}

export async function getSubscriptionLoopRequest(url: URL) {
  const projectId = url.searchParams.get("projectId");
  const loopId = url.searchParams.get("loopId");
  if (projectId || loopId) {
    if (
      !z.string().uuid().safeParse(projectId).success ||
      !z.string().uuid().safeParse(loopId).success
    )
      throw new SubscriptionLoopError("invalid_identity", 400);
    const house = url.searchParams.get("houseOnly");
    if (house !== null && house !== "true")
      throw new SubscriptionLoopError("invalid_house_scope", 400);
    const { prepared, loop } = await prepare(
      projectId!,
      loopId!,
      url.origin,
      house === "true",
    );
    return {
      ...(house === "true" ? { houseOnly: true } : {}),
      loop: {
        id: loop.id,
        projectId: loop.projectId,
        name: loop.name,
        scheduledFor: loop.nextRunAt,
      },
      ...(await buildSubscriptionPrompt(prepared)),
    };
  }
  const loops = (
    await SamLoopRepository.getDueLoopsWithOrganization(
      new Date().toISOString(),
    )
  )
    .filter(isSamLoopProjectAllowed)
    .map((loop) => ({
      id: loop.id,
      projectId: loop.projectId,
      name: loop.name,
      scheduledFor: loop.nextRunAt,
    }));
  return { loops };
}

export async function postSubscriptionLoopRequest(input: SubscriptionRequest) {
  if (
    (env as { SAM_LOOP_EXECUTOR?: string }).SAM_LOOP_EXECUTOR !== "subscription"
  )
    throw new SubscriptionLoopError("subscription_mode_required");
  if (input.action === "fail") return failSubscriptionRun(input);
  const baseUrl = "https://seo.niceseo.ai";
  const { project, loop, prepared } = await prepare(
    input.projectId,
    input.loopId,
    baseUrl,
    input.houseOnly === true,
  );
  const houseScope: SubscriptionHouseScope | undefined = input.houseOnly
    ? { projectId: loop.projectId, loopId: loop.id, domain: "niceseo.ai" }
    : undefined;
  const updateScopedRun = (
    ...arguments_: Parameters<
      typeof SamLoopRepository.compareAndSwapSubscriptionRun
    >
  ) => {
    if (houseScope)
      return SamLoopRepository.compareAndSwapSubscriptionRun(
        arguments_[0],
        arguments_[1],
        arguments_[2],
        arguments_[3],
        houseScope,
      );
    return SamLoopRepository.compareAndSwapSubscriptionRun(...arguments_);
  };
  if (input.action === "claim")
    return claimSubscriptionLoop(input, { project, loop, prepared });
  const run = await SamLoopRepository.getRunById(input.runId);
  if (
    !run ||
    run.loopId !== loop.id ||
    run.projectId !== loop.projectId ||
    !["pending", "running"].includes(run.status) ||
    !run.costNote?.startsWith("subscription:")
  )
    throw new SubscriptionLoopError("run_not_active");
  const receipt = await readReceipt(input.receipt);
  if (receipt.houseOnly !== input.houseOnly)
    throw new SubscriptionLoopError("house_scope_changed");
  if (
    receipt.runId !== run.id ||
    receipt.projectId !== loop.projectId ||
    receipt.loopId !== loop.id ||
    (await receiptState(input.receipt)) !== run.costNote
  )
    throw new SubscriptionLoopError("state_changed");
  if (Date.now() - Date.parse(receipt.startedAt) >= DEADLINE_MS)
    throw new SubscriptionLoopError("deadline_expired");
  if (input.action === "complete") {
    const result = await validateSubscriptionFinal(
      input.result,
      prepared.monthly,
      receipt.steps,
      prepared.domain,
    );
    const finishedAt = new Date().toISOString();
    if (
      !(await updateScopedRun(
        run.id,
        run.costNote,
        {
          ...result,
          finishedAt,
          costNote: `subscription; ${receipt.model}; model API cost $0`,
        },
        { loopId: loop.id, projectId: loop.projectId, finishedAt },
      ))
    )
      throw new SubscriptionLoopError("state_changed");
    return { runId: run.id, ...result };
  }
  if (input.step !== receipt.steps.length + 1 || input.step > SAM_LOOP_STEP_CAP)
    throw new SubscriptionLoopError("step_limit_or_order");
  const tool = prepared.tools[input.tool];
  if (!tool?.execute)
    throw new SubscriptionLoopError("tool_not_permitted", 403);
  const schema = asSchema(tool.inputSchema);
  const validated = await schema.validate?.(input.arguments);
  if (!validated?.success)
    throw new SubscriptionLoopError("invalid_tool_arguments", 400);
  const scopedInput = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(wireJson(validated.value)));
  const pending = `subscription:pending:${input.tool}:${crypto.randomUUID()}`;
  if (
    !(await updateScopedRun(run.id, run.costNote, {
      costNote: pending,
      stepsUsed: input.step,
    }))
  )
    throw new SubscriptionLoopError("state_changed");
  const output: unknown = await tool.execute(structuredClone(scopedInput), {
    toolCallId: `${run.id}:${input.step}`,
    messages: [],
    abortSignal: AbortSignal.timeout(
      Math.max(1, DEADLINE_MS - (Date.now() - Date.parse(receipt.startedAt))),
    ),
  });
  receipt.steps.push({
    toolCalls: [{ toolName: input.tool, input: scopedInput }],
    toolResults: [{ toolName: input.tool, output }],
  });
  const proposalsQueued = countProposalsQueued(receipt.steps);
  let nextReceipt: string;
  try {
    if (Date.now() - Date.parse(receipt.startedAt) >= DEADLINE_MS)
      throw new SubscriptionLoopError("deadline_expired");
    nextReceipt = await signReceipt(receipt);
  } catch {
    const finishedAt = new Date().toISOString();
    const settled = await SamLoopRepository.compareAndSwapSubscriptionRun(
      run.id,
      pending,
      {
        status: "failed",
        finishedAt,
        error:
          "Tool output exceeded the deadline or evidence limit; consumed tool is not retried.",
        report:
          "Not measured — subscription tool did not finish within its limits.",
        proposalsQueued,
        costNote:
          input.tool === "propose_homegrown_otto_fixes"
            ? "subscription:hold:proposal_outcome_unknown; model API cost $0"
            : `subscription; ${receipt.model}; model API cost $0`,
      },
      { loopId: run.loopId, projectId: run.projectId, finishedAt },
    );
    if (!settled) throw new SubscriptionLoopError("tool_outcome_unknown");
    throw new SubscriptionLoopError("tool_outcome_unknown");
  }
  if (
    !(await updateScopedRun(run.id, pending, {
      costNote: await receiptState(nextReceipt),
      proposalsQueued,
    }))
  )
    throw new SubscriptionLoopError("tool_outcome_unknown");
  return { runId: run.id, receipt: nextReceipt, output, step: input.step };
}

async function failSubscriptionRun(
  input: Extract<SubscriptionRequest, { action: "fail" }>,
) {
  const run = await SamLoopRepository.getRunById(input.runId);
  if (
    !run ||
    run.loopId !== input.loopId ||
    run.projectId !== input.projectId ||
    !run.costNote?.startsWith("subscription:")
  )
    throw new SubscriptionLoopError("run_not_active");
  const mutationUnknown = run.costNote.startsWith(
    "subscription:pending:propose_homegrown_otto_fixes:",
  );
  const finishedAt = new Date().toISOString();
  const updated = await SamLoopRepository.compareAndSwapSubscriptionRun(
    run.id,
    run.costNote,
    {
      status: "failed",
      finishedAt,
      error: `Generation did not return a complete valid result: ${input.reason}. Consumed steps are not retried.${mutationUnknown ? " Proposal outcome unknown; future runs held for operator inspection." : ""}`,
      report: "Not measured — subscription runner did not finish.",
      costNote: mutationUnknown
        ? "subscription:hold:proposal_outcome_unknown; model API cost $0"
        : "subscription; model API cost $0",
    },
    { loopId: run.loopId, projectId: run.projectId, finishedAt },
  );
  if (!updated) throw new SubscriptionLoopError("state_changed");
  return { runId: run.id, status: "failed" };
}

async function claimSubscriptionLoop(
  input: Extract<SubscriptionRequest, { action: "claim" }>,
  context: Awaited<ReturnType<typeof prepare>>,
) {
  const { project, loop, prepared } = context;
  const now = new Date().toISOString();
  const recent = await SamLoopRepository.getRunsForLoop({
    loopId: loop.id,
    projectId: loop.projectId,
    limit: 1,
  });
  if (recent[0]?.costNote?.startsWith("subscription:hold:"))
    throw new SubscriptionLoopError("proposal_outcome_unknown_hold");
  const blocker = await SamLoopRepository.getActiveRunForLoop(loop.id);
  if (
    blocker?.costNote?.startsWith(
      "subscription:pending:propose_homegrown_otto_fixes:",
    )
  )
    throw new SubscriptionLoopError("proposal_outcome_unknown_hold");
  if (
    blocker?.costNote?.startsWith("subscription:") &&
    blocker.startedAt &&
    Date.now() - Date.parse(blocker.startedAt) >= DEADLINE_MS
  ) {
    if (
      !(await SamLoopRepository.compareAndSwapSubscriptionRun(
        blocker.id,
        blocker.costNote,
        {
          status: "failed",
          finishedAt: now,
          error:
            "Subscription runner deadline expired; consumed steps are not retried. Pending proposal outcomes may be unknown.",
          report: "Not measured — runner did not finish.",
          costNote: "subscription; model API cost $0",
        },
        { loopId: loop.id, projectId: loop.projectId, finishedAt: now },
      ))
    )
      throw new SubscriptionLoopError("state_changed");
  } else if (blocker) throw new SubscriptionLoopError("already_running");
  if (
    !loop.nextRunAt ||
    loop.nextRunAt !== input.scheduledFor ||
    Date.parse(loop.nextRunAt) > Date.now()
  )
    throw new SubscriptionLoopError("schedule_changed");
  if (
    (await SamLoopRepository.countRunsCreatedSince(startOfUtcDay())) >=
    getSamLoopDailyRunCap(env)
  )
    throw new SubscriptionLoopError("daily_cap");
  const runId = crypto.randomUUID();
  const receipt = await signReceipt({
    runId,
    loopId: loop.id,
    projectId: loop.projectId,
    model: input.model,
    startedAt: now,
    scheduledFor: input.scheduledFor,
    steps: [],
    ...(input.houseOnly ? { houseOnly: true as const } : {}),
  });
  const wire = await buildSubscriptionPrompt(prepared);
  const admitted = await SamLoopRepository.claimSubscriptionRun(
    {
      id: runId,
      loopId: loop.id,
      projectId: loop.projectId,
      scheduledFor: input.scheduledFor,
      nextRunAt: computeNextSamLoopRunAt(
        loop.cadence,
        input.scheduledFor,
        `${loop.projectId}:${loop.name}`,
      ),
      startedAt: now,
      costNote: await receiptState(receipt),
      domain: project.domain,
      loopsEnabled: project.loopsEnabled,
    },
    { sinceDate: startOfUtcDay(), cap: getSamLoopDailyRunCap(env) },
  );
  if (!admitted) throw new SubscriptionLoopError("admission_refused");
  return {
    ...(input.houseOnly ? { houseOnly: true } : {}),
    runId,
    receipt,
    loop: {
      id: loop.id,
      projectId: loop.projectId,
      scheduledFor: input.scheduledFor,
      name: loop.name,
    },
    ...wire,
  };
}
