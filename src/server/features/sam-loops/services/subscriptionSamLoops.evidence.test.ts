import { describe, expect, it } from "vitest";
import { tool } from "ai";
import { z } from "zod";
import {
  getMocks,
  projectId,
  loopId,
  claim,
  currentRun,
  sparseOutput,
} from "./subscriptionSamLoops.fixture";
import { postSubscriptionLoopRequest } from "./subscriptionSamLoops";
const mocks = getMocks();
const stringMatcher: unknown = expect.any(String);

describe("subscription evidence and settlement", () => {
  it("holds unknown proposal outcomes even after recording a failure", async () => {
    const claimed = await claim();
    mocks.execute.mockRejectedValue(new Error("fixture tool failed"));
    await expect(
      postSubscriptionLoopRequest({
        action: "tool",
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        step: 1,
        tool: "propose_homegrown_otto_fixes",
        arguments: { title: "fixture" },
      }),
    ).rejects.toThrow();
    await postSubscriptionLoopRequest({
      action: "fail",
      projectId,
      loopId,
      runId: claimed.runId,
      reason: "tool_outcome_unknown",
    });
    expect(currentRun()?.costNote).toContain("subscription:hold:");
    mocks.recent.mockResolvedValue([currentRun()]);
    await expect(claim()).rejects.toThrow("proposal_outcome_unknown_hold");
  });
  it("keeps successful proposal accounting when later generation fails", async () => {
    const claimed = await claim();
    await postSubscriptionLoopRequest({
      action: "tool",
      projectId,
      loopId,
      runId: claimed.runId,
      receipt: claimed.receipt,
      step: 1,
      tool: "propose_homegrown_otto_fixes",
      arguments: { title: "fixture" },
    });
    await postSubscriptionLoopRequest({
      action: "fail",
      projectId,
      loopId,
      runId: claimed.runId,
      reason: "invalid_output",
    });
    expect(currentRun()?.proposalsQueued).toBe(1);
    expect(currentRun()?.stepsUsed).toBe(1);
  });
  it("records proposals even when the evidence size limit prevents a reply", async () => {
    const claimed = await claim();
    mocks.execute.mockResolvedValue({
      data: { id: "fixture-proposal" },
      detail: "x".repeat(710_000),
    });
    await expect(
      postSubscriptionLoopRequest({
        action: "tool",
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        step: 1,
        tool: "propose_homegrown_otto_fixes",
        arguments: { title: "fixture" },
      }),
    ).rejects.toThrow("tool_outcome_unknown");
    expect(currentRun()).toMatchObject({
      status: "failed",
      proposalsQueued: 1,
      stepsUsed: 1,
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(currentRun()?.costNote).toContain("subscription:hold:");
    mocks.recent.mockResolvedValue([currentRun()]);
    await expect(claim()).rejects.toThrow("proposal_outcome_unknown_hold");
  });
  it.each([
    undefined,
    { detail: undefined },
    { detail: NaN },
    { detail: Infinity },
    { toJSON: () => undefined },
    Object.assign([], { toJSON: () => undefined }),
    sparseOutput,
  ])(
    "holds proposal outcomes when output cannot be represented faithfully as JSON: %j",
    async (output) => {
      const claimed = await claim();
      mocks.execute.mockResolvedValue(output);
      await expect(
        postSubscriptionLoopRequest({
          action: "tool",
          projectId,
          loopId,
          runId: claimed.runId,
          receipt: claimed.receipt,
          step: 1,
          tool: "propose_homegrown_otto_fixes",
          arguments: { title: "fixture" },
        }),
      ).rejects.toThrow("tool_outcome_unknown");
      expect(currentRun()?.costNote).toContain("subscription:hold:");
      expect(mocks.execute).toHaveBeenCalledTimes(1);
      mocks.recent.mockResolvedValue([currentRun()]);
      await expect(claim()).rejects.toThrow("proposal_outcome_unknown_hold");
    },
  );
  it("records the validated scoped input, not raw arguments before defaults and stripping", async () => {
    mocks.prepare.mockImplementation(async () => ({
      system: "Sam",
      prompt: "fixture",
      monthly: false,
      domain: "niceseo.ai",
      tools: {
        propose_homegrown_otto_fixes: tool({
          inputSchema: z.object({
            title: z.string().default("defaulted"),
            count: z.coerce.number(),
          }),
          execute: mocks.execute,
        }),
      },
    }));
    const claimed = await claim();
    const step = z.object({ receipt: z.string() }).parse(
      await postSubscriptionLoopRequest({
        action: "tool",
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        step: 1,
        tool: "propose_homegrown_otto_fixes",
        arguments: { count: "3", ignored: true },
      }),
    );
    const payload = z
      .object({
        steps: z.array(
          z.object({
            toolCalls: z.array(
              z.object({ input: z.record(z.string(), z.unknown()) }),
            ),
          }),
        ),
      })
      .parse(JSON.parse(atob(step.receipt.split(".")[0])));
    expect(payload.steps[0].toolCalls[0].input).toEqual({
      title: "defaulted",
      count: 3,
    });
    expect(mocks.execute.mock.calls[0][0]).toEqual({
      title: "defaulted",
      count: 3,
    });
  });
  it("keeps missing signing credentials distinct from invalid receipt data", async () => {
    const claimed = await claim();
    mocks.env.AGENCY_SCORE_EXPORT_TOKEN = "";
    await expect(
      postSubscriptionLoopRequest({
        action: "tool",
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        step: 1,
        tool: "propose_homegrown_otto_fixes",
        arguments: { title: "fixture" },
      }),
    ).rejects.toMatchObject({ message: "subscription_disabled", status: 503 });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("includes the loop timestamp in the terminal atomic write", async () => {
    const claimed = await claim();
    await postSubscriptionLoopRequest({
      action: "complete",
      projectId,
      loopId,
      runId: claimed.runId,
      receipt: claimed.receipt,
      result: {
        kind: "final",
        status: "completed",
        report: "Only fixture evidence.",
        error: null,
        article: null,
      },
    });
    expect(mocks.cas).toHaveBeenLastCalledWith(
      claimed.runId,
      expect.any(String),
      expect.objectContaining({
        status: "completed",
        finishedAt: stringMatcher,
      }),
      { loopId, projectId, finishedAt: currentRun()?.finishedAt },
    );
  });
  it("includes the loop timestamp when the runner reports a failure", async () => {
    const claimed = await claim();
    await postSubscriptionLoopRequest({
      action: "fail",
      projectId,
      loopId,
      runId: claimed.runId,
      reason: "runner_failed",
    });
    expect(mocks.cas).toHaveBeenLastCalledWith(
      claimed.runId,
      expect.any(String),
      expect.objectContaining({ status: "failed" }),
      { loopId, projectId, finishedAt: currentRun()?.finishedAt },
    );
  });
});
