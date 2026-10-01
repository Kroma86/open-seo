import { describe, expect, it } from "vitest";
import {
  getMocks,
  projectId,
  loopId,
  scheduledFor,
  claim,
  currentRun,
} from "./subscriptionSamLoops.fixture";
import {
  getSubscriptionLoopRequest,
  postSubscriptionLoopRequest,
} from "./subscriptionSamLoops";
const mocks = getMocks();
const stringMatcher: unknown = expect.any(String);

describe("subscription admission and signed tool evidence", () => {
  it("exposes identical scoped readers but never paid GBP tools", async () => {
    const claimed = await claim();
    expect(claimed.tools.map((entry) => entry.name)).toEqual([
      "propose_homegrown_otto_fixes",
    ]);
    expect(currentRun()?.costNote).toMatch(/^subscription:/);
    expect(mocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledFor }),
      { sinceDate: stringMatcher, cap: 20 },
    );
  });
  it("does not claim when mode is off", async () => {
    mocks.env.SAM_LOOP_EXECUTOR = "legacy";
    await expect(claim()).rejects.toThrow("subscription_mode_required");
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("rechecks project permission before any mutation", async () => {
    mocks.project.mockResolvedValue({
      id: projectId,
      domain: "example.test",
      loopsEnabled: false,
    });
    await expect(claim()).rejects.toThrow("loop_not_permitted");
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("rejects changed schedules and a full daily cap without admission", async () => {
    await expect(
      postSubscriptionLoopRequest({
        action: "claim",
        projectId,
        loopId,
        scheduledFor: "2026-09-30T00:00:00.000Z",
        model: "grok-4.7",
      }),
    ).rejects.toThrow("schedule_changed");
    mocks.count.mockResolvedValue(20);
    await expect(claim()).rejects.toThrow("daily_cap");
    expect(mocks.claim).not.toHaveBeenCalled();
  });
  it("executes a concurrent mutating request only once", async () => {
    const claimed = await claim();
    const input = {
      action: "tool" as const,
      projectId,
      loopId,
      runId: claimed.runId,
      receipt: claimed.receipt,
      step: 1,
      tool: "propose_homegrown_otto_fixes",
      arguments: { title: "fixture" },
    };
    const replies = await Promise.allSettled([
      postSubscriptionLoopRequest(input),
      postSubscriptionLoopRequest(input),
    ]);
    expect(
      replies.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    await expect(postSubscriptionLoopRequest(input)).rejects.toThrow(
      "state_changed",
    );
  });
  it("cannot finalize while a consumed tool has an unknown outcome", async () => {
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
    ).rejects.toThrow("fixture tool failed");
    await expect(
      postSubscriptionLoopRequest({
        action: "complete",
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        result: {
          kind: "final",
          status: "completed",
          report: "fixture",
          error: null,
          article: null,
        },
      }),
    ).rejects.toThrow("state_changed");
    expect(currentRun()?.costNote).toMatch(/^subscription:pending:/);
  });
  it("rejects tampered evidence and invalid tool arguments before execution", async () => {
    const claimed = await claim();
    const input = {
      action: "tool" as const,
      projectId,
      loopId,
      runId: claimed.runId,
      receipt: claimed.receipt,
      step: 1,
      tool: "propose_homegrown_otto_fixes",
      arguments: {},
    };
    await expect(postSubscriptionLoopRequest(input)).rejects.toThrow(
      "invalid_tool_arguments",
    );
    await expect(
      postSubscriptionLoopRequest({
        ...input,
        receipt: claimed.receipt.slice(1),
      }),
    ).rejects.toThrow("invalid_receipt");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("requires consecutive server-verified steps", async () => {
    const claimed = await claim();
    await expect(
      postSubscriptionLoopRequest({
        action: "tool",
        projectId,
        loopId,
        runId: claimed.runId,
        receipt: claimed.receipt,
        step: 2,
        tool: "propose_homegrown_otto_fixes",
        arguments: { title: "fixture" },
      }),
    ).rejects.toThrow("step_limit_or_order");
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("stores a validated terminal result once, with subscription provenance", async () => {
    const claimed = await claim();
    const input = {
      action: "complete" as const,
      projectId,
      loopId,
      runId: claimed.runId,
      receipt: claimed.receipt,
      result: {
        kind: "final" as const,
        status: "completed" as const,
        report: "Only supplied evidence was checked. No live changes.",
        error: null,
        article: null,
      },
    };
    expect(await postSubscriptionLoopRequest(input)).toMatchObject({
      status: "completed",
      proposalsQueued: 0,
      stepsUsed: 0,
    });
    expect(currentRun()?.costNote).toBe(
      "subscription; grok-4.7; model API cost $0",
    );
    await expect(postSubscriptionLoopRequest(input)).rejects.toThrow(
      "run_not_active",
    );
  });
  it("records failure safely even if project permission was revoked", async () => {
    const claimed = await claim();
    mocks.project.mockResolvedValue(null);
    expect(
      await postSubscriptionLoopRequest({
        action: "fail",
        projectId,
        loopId,
        runId: claimed.runId,
        reason: "runner_failed",
      }),
    ).toMatchObject({ status: "failed" });
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("does not expose unfinished evidence in previews", async () => {
    await claim();
    const preview = await getSubscriptionLoopRequest(
      new URL(`https://example.test/?projectId=${projectId}&loopId=${loopId}`),
    );
    expect(preview).not.toHaveProperty("receipt");
    expect(preview).not.toHaveProperty("runId");
  });
});
