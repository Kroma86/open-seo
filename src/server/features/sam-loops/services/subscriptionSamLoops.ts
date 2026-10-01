import { asSchema } from "ai";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { MCP_SCOPE } from "@/lib/oauth-resource";
import { SamLoopRepository } from "../repositories/SamLoopRepository";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  computeNextSamLoopRunAt,
  isSamLoopProjectAllowed,
  SAM_LOOP_STEP_CAP,
  startOfUtcDay,
} from "@/shared/sam-loops";
import { getSamLoopDailyRunCap } from "./samLoopRunGuards";
import { prepareSamLoop, type PreparedSamLoop } from "./runHeadlessSamLoop";
import {
  subscriptionTurnSchema,
  validateSubscriptionFinal,
  type SubscriptionRequest,
  type SubscriptionSteps,
} from "./subscriptionContract";
import { countProposalsQueued } from "./countProposalsQueued";

const FREE_TOOLS = new Set([
  "map_links",
  "read_pages",
  "whoami",
  "get_product_info",
  "list_saved_keywords",
  "get_niceseo_ops_status",
  "get_agency_score_inputs",
  "get_agency_otto_page_inputs",
  "list_homegrown_otto_proposals",
  "get_audit_status",
  "get_audit_issues",
  "get_audit_pages",
  "get_rank_tracker",
  "estimate_rank_tracker_cost",
  "get_search_console_performance",
  "inspect_urls",
  "get_google_analytics_organic_landing_pages",
  "get_google_analytics_page_performance",
  "get_google_analytics_key_events",
  "get_search_opportunities",
  "get_google_analytics_organic_overview",
  "get_google_analytics_traffic_acquisition",
  "get_google_analytics_measurement_health",
  "get_google_analytics_ecommerce_performance",
  "get_google_analytics_site_search",
  "get_google_analytics_audience_breakdown",
  "list_sam_loops",
  "get_sam_loop_runs",
  "get_ai_visibility_trend",
  "propose_homegrown_otto_fixes",
]);
const DEADLINE_MS = 15 * 60_000;
const RECEIPT_MAX_BYTES = 700_000;

export class SubscriptionLoopError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

type Receipt = {
  runId: string;
  loopId: string;
  projectId: string;
  model: string;
  startedAt: string;
  scheduledFor: string;
  steps: SubscriptionSteps;
};
const receiptSchema = z
  .object({
    runId: z.string().uuid(),
    loopId: z.string().uuid(),
    projectId: z.string().uuid(),
    model: z.enum(["grok-4.7", "grok-4.7-build-fast"]),
    startedAt: z.iso.datetime(),
    scheduledFor: z.iso.datetime(),
    steps: z
      .array(
        z
          .object({
            toolCalls: z
              .array(
                z
                  .object({
                    toolName: z.string(),
                    input: z.record(z.string(), z.unknown()),
                  })
                  .strict(),
              )
              .length(1),
            toolResults: z
              .array(
                z
                  .object({ toolName: z.string(), output: z.unknown() })
                  .strict(),
              )
              .length(1),
          })
          .strict(),
      )
      .max(SAM_LOOP_STEP_CAP),
  })
  .strict();

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
async function signingKey() {
  const secret = (env as { AGENCY_SCORE_EXPORT_TOKEN?: string })
    .AGENCY_SCORE_EXPORT_TOKEN;
  if (!secret) throw new SubscriptionLoopError("subscription_disabled", 503);
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
async function signReceipt(receipt: Receipt): Promise<string> {
  const serialized = wireJson(receipt);
  receiptSchema.parse(JSON.parse(serialized));
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.length > RECEIPT_MAX_BYTES)
    throw new SubscriptionLoopError("evidence_limit");
  const signature = await crypto.subtle.sign("HMAC", await signingKey(), bytes);
  return `${encode(bytes)}.${encode(new Uint8Array(signature))}`;
}
async function readReceipt(token: string): Promise<Receipt> {
  const key = await signingKey();
  try {
    const parts = token.split(".");
    if (parts.length !== 2) throw new Error();
    const bytes = decode(parts[0]!);
    if (
      bytes.length > RECEIPT_MAX_BYTES ||
      !(await crypto.subtle.verify(
        "HMAC",
        key,
        new Uint8Array(decode(parts[1]!)).buffer,
        new Uint8Array(bytes).buffer,
      ))
    )
      throw new Error();
    return receiptSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new SubscriptionLoopError("invalid_receipt", 400);
  }
}
function wireJson(value: unknown): string {
  const ancestors = new Set<object>();
  const check = (item: unknown, depth: number): void => {
    if (depth > 64) throw new SubscriptionLoopError("invalid_tool_evidence");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || ancestors.has(item))
      throw new SubscriptionLoopError("invalid_tool_evidence");
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (
        Object.getPrototypeOf(item) !== Array.prototype ||
        Object.getOwnPropertySymbols(item).length
      )
        throw new SubscriptionLoopError("invalid_tool_evidence");
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.keys(descriptors).length !== item.length + 1)
        throw new SubscriptionLoopError("invalid_tool_evidence");
      for (let index = 0; index < item.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || descriptor.get || descriptor.set)
          throw new SubscriptionLoopError("invalid_tool_evidence");
        check(descriptor.value, depth + 1);
      }
    } else {
      if (
        ![Object.prototype, null].includes(Object.getPrototypeOf(item)) ||
        Object.getOwnPropertySymbols(item).length
      )
        throw new SubscriptionLoopError("invalid_tool_evidence");
      for (const descriptor of Object.values(
        Object.getOwnPropertyDescriptors(item),
      )) {
        if (!descriptor.enumerable || descriptor.get || descriptor.set)
          throw new SubscriptionLoopError("invalid_tool_evidence");
        check(descriptor.value, depth + 1);
      }
    }
    ancestors.delete(item);
  };
  check(value, 0);
  return JSON.stringify(value);
}
async function receiptState(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return `subscription:${encode(new Uint8Array(digest))}`;
}

async function prepare(projectId: string, loopId: string, baseUrl: string) {
  const project = await ProjectRepository.getProjectById(projectId);
  const loop = await SamLoopRepository.getLoopById(loopId, projectId);
  if (
    !project ||
    project.archivedAt ||
    !loop?.isEnabled ||
    !isSamLoopProjectAllowed(project)
  )
    throw new SubscriptionLoopError("loop_not_permitted", 403);
  const prepared = await prepareSamLoop({
    project,
    sourceType: loop.sourceType,
    skillName: loop.skillName,
    customPrompt: loop.customPrompt,
    loopName: loop.name,
    authContext: {
      userId: "system",
      userEmail: "system@openseo.so",
      organizationId: project.organizationId,
      clientId: null,
      scopes: [MCP_SCOPE],
      baseUrl,
    },
  });
  if (!("tools" in prepared))
    throw new SubscriptionLoopError("loop_not_ready", 409);
  prepared.tools = Object.fromEntries(
    Object.entries(prepared.tools).filter(([name]) => FREE_TOOLS.has(name)),
  );
  return { project, loop, prepared };
}

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
    const { prepared, loop } = await prepare(projectId!, loopId!, url.origin);
    return {
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
  if (input.action === "fail") {
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
    const updated = await SamLoopRepository.compareAndSwapSubscriptionRun(
      run.id,
      run.costNote,
      {
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: `Generation did not return a complete valid result: ${input.reason}. Consumed steps are not retried.${mutationUnknown ? " Proposal outcome unknown; future runs held for operator inspection." : ""}`,
        report: "Not measured — subscription runner did not finish.",
        costNote: mutationUnknown
          ? "subscription:hold:proposal_outcome_unknown; model API cost $0"
          : "subscription; model API cost $0",
      },
    );
    if (!updated) throw new SubscriptionLoopError("state_changed");
    return { runId: run.id, status: "failed" };
  }
  const baseUrl = "https://seo.niceseo.ai";
  const { project, loop, prepared } = await prepare(
    input.projectId,
    input.loopId,
    baseUrl,
  );
  if (input.action === "claim") {
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
      !(await SamLoopRepository.compareAndSwapSubscriptionRun(
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
  const scopedInput = JSON.parse(wireJson(validated.value)) as Record<
    string,
    unknown
  >;
  const pending = `subscription:pending:${input.tool}:${crypto.randomUUID()}`;
  if (
    !(await SamLoopRepository.compareAndSwapSubscriptionRun(
      run.id,
      run.costNote,
      { costNote: pending, stepsUsed: input.step },
    ))
  )
    throw new SubscriptionLoopError("state_changed");
  const output = await tool.execute(structuredClone(scopedInput), {
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
    const settled = await SamLoopRepository.compareAndSwapSubscriptionRun(
      run.id,
      pending,
      {
        status: "failed",
        finishedAt: new Date().toISOString(),
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
    );
    if (!settled) throw new SubscriptionLoopError("tool_outcome_unknown");
    throw new SubscriptionLoopError("tool_outcome_unknown");
  }
  if (
    !(await SamLoopRepository.compareAndSwapSubscriptionRun(run.id, pending, {
      costNote: await receiptState(nextReceipt),
      proposalsQueued,
    }))
  )
    throw new SubscriptionLoopError("tool_outcome_unknown");
  return { runId: run.id, receipt: nextReceipt, output, step: input.step };
}
