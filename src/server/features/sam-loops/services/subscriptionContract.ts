import { z } from "zod";
import { SAM_LOOP_STEP_CAP } from "@/shared/sam-loops";
import { monthlyContentSchema } from "./monthlyContentResult";
import { stripDraftEvidence } from "./monthlyContentResult";
import { countProposalsQueued } from "./countProposalsQueued";
import type { HeadlessSamLoopResult } from "./runHeadlessSamLoop";
import { validateSamLoopOutput } from "./samLoopResult";

export const subscriptionFinalSchema = z
  .object({
    kind: z.literal("final"),
    status: z.enum(["completed", "failed"]),
    report: z.string().max(100_000),
    error: z.string().max(1000).nullable(),
    article: monthlyContentSchema.nullable(),
  })
  .strict();

export const subscriptionTurnSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tool"),
      tool: z.string().min(1).max(120),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
  subscriptionFinalSchema,
]);

const identity = { projectId: z.string().uuid(), loopId: z.string().uuid() };
export const subscriptionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("claim"),
      ...identity,
      scheduledFor: z.iso.datetime(),
      model: z.enum(["grok-4.7", "grok-4.7-build-fast"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("tool"),
      ...identity,
      runId: z.string().uuid(),
      receipt: z.string().max(1_000_000),
      step: z.number().int().min(1).max(SAM_LOOP_STEP_CAP),
      tool: z.string().min(1).max(120),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      action: z.literal("complete"),
      ...identity,
      runId: z.string().uuid(),
      receipt: z.string().max(1_000_000),
      result: subscriptionFinalSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("fail"),
      ...identity,
      runId: z.string().uuid(),
      reason: z.enum([
        "timeout",
        "invalid_output",
        "generation_failed",
        "tool_outcome_unknown",
        "step_cap",
        "runner_failed",
      ]),
    })
    .strict(),
]);

export type SubscriptionRequest = z.infer<typeof subscriptionRequestSchema>;
export type SubscriptionSteps = Array<{
  toolCalls?: Array<{ toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; output: unknown }>;
}>;

export async function validateSubscriptionFinal(
  value: unknown,
  monthly: boolean,
  steps: SubscriptionSteps,
  domain: string,
): Promise<HeadlessSamLoopResult> {
  const parsed = subscriptionFinalSchema.safeParse(value);
  let report = "Not measured — generation did not finish.";
  let error: string | null =
    "Generation did not return a complete valid result: invalid report contract.";
  if (parsed.success) {
    const result = parsed.data;
    if (result.status === "failed" && !result.error?.trim()) {
      error =
        "Generation did not return a complete valid result: missing failure reason.";
    } else if (result.status === "completed" && result.error !== null) {
      error =
        "Generation did not return a complete valid result: completed report contains an error.";
    } else if (result.status === "failed") {
      report = monthly
        ? "No verified monthly article draft — subscription generation reported failure."
        : stripDraftEvidence(result.report).trim() || report;
      error = result.error;
    } else {
      const checked = await validateSamLoopOutput(
        {
          text: result.report,
          finishReason: "stop",
          output: result.article,
          steps,
        },
        monthly,
        domain,
      );
      report = checked.report;
      error = checked.error
        ? `Generation did not return a complete valid result: ${checked.error}`
        : null;
    }
  }
  return {
    status: error ? "failed" : "completed",
    error,
    report,
    stepsUsed: steps.length,
    proposalsQueued: countProposalsQueued(steps),
    costNote: "subscription; model API cost $0",
  };
}
