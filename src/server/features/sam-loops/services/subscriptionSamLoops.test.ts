import { beforeEach, describe, expect, it, vi } from "vitest";
import { tool } from "ai";
import { z } from "zod";

const mocks = vi.hoisted(() => ({
  env: {
    SAM_LOOP_EXECUTOR: "subscription",
    AGENCY_SCORE_EXPORT_TOKEN: "fixture-signing-token",
  },
  project: vi.fn(),
  loop: vi.fn(),
  prepare: vi.fn(),
  active: vi.fn(),
  count: vi.fn(),
  claim: vi.fn(),
  create: vi.fn(),
  getRun: vi.fn(),
  cas: vi.fn(),
  updateLoop: vi.fn(),
  due: vi.fn(),
  execute: vi.fn(),
  admit: vi.fn(),
  recent: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: mocks.env }));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectById: mocks.project },
}));
vi.mock("./runHeadlessSamLoop", () => ({ prepareSamLoop: mocks.prepare }));
vi.mock("./samLoopRunGuards", () => ({ getSamLoopDailyRunCap: () => 20 }));
vi.mock("../repositories/SamLoopRepository", () => ({
  SamLoopRepository: {
    getLoopById: mocks.loop,
    getActiveRunForLoop: mocks.active,
    getRunsForLoop: mocks.recent,
    countRunsCreatedSince: mocks.count,
    claimDueLoop: mocks.claim,
    tryCreateRun: mocks.create,
    claimSubscriptionRun: mocks.admit,
    getRunById: mocks.getRun,
    compareAndSwapSubscriptionRun: mocks.cas,
    updateLoop: mocks.updateLoop,
    getDueLoopsWithOrganization: mocks.due,
  },
}));
import {
  getSubscriptionLoopRequest,
  postSubscriptionLoopRequest,
} from "./subscriptionSamLoops";

const projectId = "22222222-2222-4222-8222-222222222222";
const loopId = "11111111-1111-4111-8111-111111111111";
const scheduledFor = "2026-10-01T00:00:00.000Z";
type Run = {
  id: string;
  projectId: string;
  loopId: string;
  status: string;
  costNote: string | null;
  startedAt?: string;
  stepsUsed?: number;
  proposalsQueued?: number;
  finishedAt?: string;
};
let run: Run | null;

beforeEach(() => {
  vi.resetAllMocks();
  run = null;
  mocks.env.SAM_LOOP_EXECUTOR = "subscription";
  mocks.env.AGENCY_SCORE_EXPORT_TOKEN = "fixture-signing-token";
  mocks.project.mockResolvedValue({
    id: projectId,
    name: "House",
    domain: "niceseo.ai",
    organizationId: "fixture-org",
    archivedAt: null,
    loopsEnabled: false,
  });
  mocks.loop.mockResolvedValue({
    id: loopId,
    projectId,
    name: "On-page priorities",
    isEnabled: true,
    sourceType: "custom",
    skillName: null,
    customPrompt: "fixture",
    nextRunAt: scheduledFor,
    cadence: "weekly",
  });
  mocks.execute.mockResolvedValue({ data: { id: "fixture-proposal" } });
  mocks.prepare.mockImplementation(async () => ({
    system: "Sam",
    prompt: "fixture",
    monthly: false,
    domain: "niceseo.ai",
    tools: {
      propose_homegrown_otto_fixes: tool({
        inputSchema: z.object({ title: z.string() }).strict(),
        execute: mocks.execute,
      }),
      get_business_reviews: tool({
        inputSchema: z.object({}),
        execute: mocks.execute,
      }),
    },
  }));
  mocks.active.mockImplementation(async () =>
    run && ["pending", "running"].includes(run.status) ? run : null,
  );
  mocks.count.mockResolvedValue(0);
  mocks.recent.mockResolvedValue([]);
  mocks.claim.mockResolvedValue(true);
  mocks.create.mockImplementation(async (data) => {
    run = { ...data, status: "pending", costNote: null };
    return true;
  });
  mocks.admit.mockImplementation(async (data) => {
    run = { ...data, status: "running" };
    return true;
  });
  mocks.getRun.mockImplementation(async () => run && { ...run });
  mocks.cas.mockImplementation(async (id, expected, changes) => {
    if (
      !run ||
      run.id !== id ||
      run.costNote !== expected ||
      !["pending", "running"].includes(run.status)
    )
      return false;
    run = { ...run, ...changes };
    return true;
  });
});

async function claim() {
  return (await postSubscriptionLoopRequest({
    action: "claim",
    projectId,
    loopId,
    scheduledFor,
    model: "grok-4.7",
  })) as { runId: string; receipt: string; tools: Array<{ name: string }> };
}

describe("subscription admission and signed tool evidence", () => {
  it("exposes identical scoped readers but never paid GBP tools", async () => {
    const claimed = await claim();
    expect(claimed.tools.map((entry) => entry.name)).toEqual([
      "propose_homegrown_otto_fixes",
    ]);
    expect(run?.costNote).toMatch(/^subscription:/);
    expect(mocks.admit).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledFor }),
      { sinceDate: expect.any(String), cap: 20 },
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
    expect(run?.costNote).toMatch(/^subscription:pending:/);
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
    expect(run?.costNote).toBe("subscription; grok-4.7; model API cost $0");
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
    expect(run?.costNote).toContain("subscription:hold:");
    mocks.recent.mockResolvedValue([run]);
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
    expect(run?.proposalsQueued).toBe(1);
    expect(run?.stepsUsed).toBe(1);
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
    expect(run).toMatchObject({
      status: "failed",
      proposalsQueued: 1,
      stepsUsed: 1,
    });
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    expect(run?.costNote).toContain("subscription:hold:");
    mocks.recent.mockResolvedValue([run]);
    await expect(claim()).rejects.toThrow("proposal_outcome_unknown_hold");
  });
  it.each([
    undefined,
    { detail: undefined },
    { detail: NaN },
    { detail: Infinity },
    { toJSON: () => undefined },
    Object.assign([], { toJSON: () => undefined }),
    new Array(1),
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
      expect(run?.costNote).toContain("subscription:hold:");
      expect(mocks.execute).toHaveBeenCalledTimes(1);
      mocks.recent.mockResolvedValue([run]);
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
    const step = (await postSubscriptionLoopRequest({
      action: "tool",
      projectId,
      loopId,
      runId: claimed.runId,
      receipt: claimed.receipt,
      step: 1,
      tool: "propose_homegrown_otto_fixes",
      arguments: { count: "3", ignored: true },
    })) as { receipt: string };
    const payload = JSON.parse(atob(step.receipt.split(".")[0]!));
    expect(payload.steps[0].toolCalls[0].input).toEqual({
      title: "defaulted",
      count: 3,
    });
    expect(mocks.execute.mock.calls[0]![0]).toEqual({
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
        finishedAt: expect.any(String),
      }),
      { loopId, projectId, finishedAt: run?.finishedAt },
    );
  });
});
