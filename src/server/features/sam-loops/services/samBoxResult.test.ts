import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SAM_LOOP_TEMPLATES } from "@/shared/sam-loops";
import { handleSamBoxAbandon, handleSamBoxResult } from "./samBoxResult";
import { validateSamBoxResult } from "./samBoxResultValidate";
import { leaseIdFor } from "./samBoxMode";
import {
  SAM_BOX_KIND_LIMITS,
  type SamBoxKind,
  type SamBoxOutputLimits,
} from "./samBoxTypes";
import type { SamBoxFinishData } from "./samBoxFinalize";
import type { SamLoopRepository } from "../repositories/SamLoopRepository";

const mocks = vi.hoisted(() => ({
  getRunById: vi.fn(),
  getLoopById: vi.fn(),
  finishRunIfRunning: vi.fn(),
  updateLoop: vi.fn(),
  claimDueLoop: vi.fn(),
  getProjectById: vi.fn(),
  listProposals: vi.fn(),
  enqueueProposal: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("../repositories/SamLoopRepository", () => ({
  SamLoopRepository: {
    getRunById: mocks.getRunById,
    getLoopById: mocks.getLoopById,
    finishRunIfRunning: mocks.finishRunIfRunning,
    updateLoop: mocks.updateLoop,
    claimDueLoop: mocks.claimDueLoop,
  },
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: { getProjectById: mocks.getProjectById },
}));
vi.mock("@/server/features/agency/AgencyOttoProposalsService", () => ({
  listHomegrownOttoProposals: mocks.listProposals,
  enqueueHomegrownOttoProposal: mocks.enqueueProposal,
}));
// Keep the real error redactor while removing the model/tool import graph.
vi.mock("@/server/lib/openrouter", () => ({ getChatAgentModel: vi.fn() }));
vi.mock("@/server/lib/chatAgent", () => ({ openRouterCostUsd: vi.fn() }));
vi.mock("@/server/features/sam/samChatTools", () => ({
  buildSamMcpTools: vi.fn(),
}));
vi.mock("@/server/features/sam/samSkills", () => ({
  buildSamSkillSource: vi.fn(),
}));
vi.mock("@/server/features/sam/samSystemPrompt", () => ({
  buildSamSystemPrompt: vi.fn(),
}));
vi.mock(
  "@/server/features/project-context/services/ProjectContextService",
  () => ({ ProjectContextService: {} }),
);
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {},
}));

type Run = NonNullable<
  Awaited<ReturnType<typeof SamLoopRepository.getRunById>>
>;
const NOW = "2026-10-07T13:22:00.123Z";
const START = "2026-10-07T13:20:00.123Z";
const REPORT =
  "Measurements: saved audit. Findings: improve pricing. Next action: review.";
const PROPOSAL = {
  path: "/pricing",
  title: "Pricing",
  description: "Compare plans",
  h1: "Our plans",
  before_title: "Old title",
  before_description: "Old description",
  rationale: "Clearer copy",
  human_review: ["Check pricing"],
};

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    loopId: "loop-1",
    projectId: "project-1",
    status: "running",
    startedAt: START,
    finishedAt: null,
    report: null,
    error: null,
    stepsUsed: null,
    costNote: "box:grok-sub leased",
    proposalsQueued: 0,
    createdAt: START,
    ...overrides,
  };
}
function loop(kind: SamBoxKind = "on_page_priorities") {
  const name =
    kind === "on_page_priorities" ? "On-page priorities" : "CTR opportunities";
  const template = DEFAULT_SAM_LOOP_TEMPLATES.find((t) => t.name === name);
  return {
    id: "loop-1",
    projectId: "project-1",
    name,
    sourceType: "custom",
    customPrompt:
      template && "customPrompt" in template ? template.customPrompt : null,
    cadence: "monthly",
    nextRunAt: START,
  };
}
function limits(kind: SamBoxKind = "on_page_priorities"): SamBoxOutputLimits {
  const l = SAM_BOX_KIND_LIMITS[kind];
  return {
    format: "json_object",
    schema_id: "sam-box-result-v1",
    max_output_bytes: 24576,
    max_report_chars: 6000,
    max_proposals: l.maxProposals,
    allowed_fields: [...l.allowedFields],
  };
}
function envelope(overrides: Record<string, unknown> = {}) {
  return {
    contract: 1,
    run_id: "run-1",
    lease_id: leaseIdFor("run-1", START),
    runner_id: "hermes-vm-sam-runner",
    model: "grok-4.6",
    duration_ms: 41234,
    journal_ticket: "a3f1c2d4e5b6478990aabbccddeeff00",
    result: { report: REPORT, proposals: [PROPOSAL] },
    ...overrides,
  };
}
function abandon(overrides: Record<string, unknown> = {}) {
  return {
    contract: 1,
    run_id: "run-1",
    lease_id: leaseIdFor("run-1", START),
    runner_id: "hermes-vm-sam-runner",
    stage: "before_model",
    code: "controller_active",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.getRunById.mockResolvedValue(run());
  mocks.getLoopById.mockResolvedValue(loop());
  mocks.finishRunIfRunning.mockImplementation(
    async (_id: string, data: SamBoxFinishData) => {
      mocks.getRunById.mockResolvedValue(run(data));
      return true;
    },
  );
  mocks.updateLoop.mockResolvedValue(undefined);
  mocks.claimDueLoop.mockResolvedValue(true);
  mocks.getProjectById.mockResolvedValue({
    id: "project-1",
    domain: "project.example",
  });
  mocks.listProposals.mockResolvedValue([]);
  mocks.enqueueProposal.mockResolvedValue({ id: "proposal-1" });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
});

describe("box result", () => {
  it("completes and advances with the tool's proposal mapping and project-bound domain", async () => {
    const result = await handleSamBoxResult({ body: envelope() });
    expect(result).toEqual({
      status: 200,
      body: {
        ok: true,
        run_id: "run-1",
        status: "completed",
        error: null,
        proposals_queued: 1,
        replay: false,
      },
    });
    expect(mocks.listProposals).toHaveBeenCalledWith({
      domain: "project.example",
      status: "pending",
      limit: 200,
    });
    expect(mocks.enqueueProposal).toHaveBeenCalledWith({
      domain: "project.example",
      path: "/pricing",
      fixes: {
        title: "Pricing",
        description: "Compare plans",
        h1: "Our plans",
      },
      before: { title: "Old title", description: "Old description" },
      humanReview: ["Check pricing"],
      rationale: "Clearer copy",
      proposedBy: "sam",
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith("run-1", {
      status: "completed",
      error: null,
      report: REPORT,
      proposalsQueued: 1,
      stepsUsed: 1,
      finishedAt: NOW,
      costNote: "box:grok-sub grok-4.6 · subscription, no per-use cost · 41s",
    });
    expect(mocks.updateLoop).toHaveBeenCalledWith("loop-1", "project-1", {
      lastRunAt: NOW,
    });
    expect(mocks.claimDueLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop-1",
        projectId: "project-1",
        observedNextRunAt: START,
      }),
    );
    expect(mocks.enqueueProposal.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.finishRunIfRunning.mock.invocationCallOrder[0] ?? 0,
    );
    expect(console.log).toHaveBeenCalledWith(
      "[sam-loop] run-1 completed loop=loop-1 project=project-1 trigger=box proposals=1 steps=1",
    );
  });
  it("replays stored columns and never queues a second time", async () => {
    await handleSamBoxResult({ body: envelope() });
    const result = await handleSamBoxResult({ body: envelope() });
    expect(result.body).toEqual({
      ok: true,
      run_id: "run-1",
      status: "completed",
      error: null,
      proposals_queued: 1,
      replay: true,
    });
    expect(mocks.enqueueProposal).toHaveBeenCalledTimes(1);
    expect(mocks.finishRunIfRunning).toHaveBeenCalledTimes(1);
  });
  it.each([
    [null, "unknown_run", 404],
    [run({ costNote: null, startedAt: null }), "not_a_box_run", 409],
    [run({ startedAt: null }), "lease_mismatch", 409],
    [run({ startedAt: "invalid" }), "lease_mismatch", 409],
    [
      run({ status: "completed", startedAt: "2026-10-07T13:19:00.123Z" }),
      "lease_mismatch",
      409,
    ],
  ])(
    "checks run ownership and lease before replay (%s)",
    async (row, error, status) => {
      mocks.getRunById.mockResolvedValue(row);
      expect(await handleSamBoxResult({ body: envelope() })).toEqual({
        status,
        body: { error },
      });
      expect(mocks.finishRunIfRunning).not.toHaveBeenCalled();
      expect(mocks.enqueueProposal).not.toHaveBeenCalled();
    },
  );
  it("fails an expired running lease using the sweep's exact terminal fields", async () => {
    vi.setSystemTime("2026-10-07T13:35:00.124Z");
    expect(await handleSamBoxResult({ body: envelope() })).toEqual({
      status: 409,
      body: { error: "lease_expired" },
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith("run-1", {
      status: "failed",
      error: "Box lease expired before a result was posted.",
      report: "Not measured — Box lease expired before a result was posted.",
      stepsUsed: null,
      costNote: "box:grok-sub (lease expired)",
      proposalsQueued: 0,
      finishedAt: "2026-10-07T13:35:00.124Z",
    });
    expect(mocks.updateLoop).toHaveBeenCalledTimes(1);
    expect(mocks.claimDueLoop).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueProposal).not.toHaveBeenCalled();
  });
  it("accepts a result at the exact lease deadline", async () => {
    vi.setSystemTime("2026-10-07T13:35:00.123Z");
    expect((await handleSamBoxResult({ body: envelope() })).body.status).toBe(
      "completed",
    );
  });
  it("replays a terminal run before checking expiry", async () => {
    vi.setSystemTime("2026-10-07T13:36:00.123Z");
    mocks.getRunById.mockResolvedValue(
      run({ status: "failed", error: "Stored failure", proposalsQueued: 2 }),
    );
    expect((await handleSamBoxResult({ body: envelope() })).body).toEqual({
      ok: true,
      run_id: "run-1",
      status: "failed",
      error: "Stored failure",
      proposals_queued: 2,
      replay: true,
    });
    expect(mocks.finishRunIfRunning).not.toHaveBeenCalled();
  });
  it("returns the current winner if expiry loses its terminal write", async () => {
    vi.setSystemTime("2026-10-07T13:36:00.123Z");
    mocks.finishRunIfRunning.mockImplementation(async () => {
      mocks.getRunById.mockResolvedValue(
        run({ status: "completed", proposalsQueued: 2 }),
      );
      return false;
    });
    expect((await handleSamBoxResult({ body: envelope() })).body).toEqual({
      ok: true,
      run_id: "run-1",
      status: "completed",
      error: null,
      proposals_queued: 2,
      replay: true,
    });
    expect(mocks.updateLoop).not.toHaveBeenCalled();
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });
  it("accepts exactly the output byte limit and rejects one byte more", async () => {
    const overhead = JSON.stringify({ report: "", proposals: [] }).length;
    const result = { report: "x".repeat(24576 - overhead), proposals: [] };
    expect(
      (await handleSamBoxResult({ body: envelope({ result }) })).body.status,
    ).toBe("completed");
    expect(
      await handleSamBoxResult({
        body: envelope({ result: { ...result, report: result.report + "x" } }),
      }),
    ).toEqual({ status: 422, body: { error: "result_too_large" } });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ unknown: true }, 400, "invalid_body"],
    [{ run_id: undefined }, 400, "invalid_body"],
    [{ runner_id: 1 }, 400, "invalid_body"],
    [{ duration_ms: "1" }, 400, "invalid_body"],
    [{ model: 1 }, 400, "invalid_body"],
    [{ result: undefined }, 400, "invalid_body"],
    [{ model: "grok-4.7" }, 422, "invalid_model"],
    [{ duration_ms: -1 }, 422, "invalid_envelope"],
    [{ duration_ms: 600001 }, 422, "invalid_envelope"],
    [{ duration_ms: 1.5 }, 422, "invalid_envelope"],
    [{ runner_id: "bad runner" }, 422, "invalid_envelope"],
    [{ journal_ticket: "ABC" }, 422, "invalid_envelope"],
    [{ result: null }, 422, "invalid_envelope"],
    [{ result: [] }, 422, "invalid_envelope"],
    [{ result: "text" }, 422, "invalid_envelope"],
    [{ result: new Date() }, 422, "invalid_envelope"],
    [
      { result: { report: "é".repeat(12300), proposals: [] } },
      422,
      "result_too_large",
    ],
  ])(
    "leaves the run untouched on invalid envelope %j",
    async (overrides, status, error) => {
      expect(await handleSamBoxResult({ body: envelope(overrides) })).toEqual({
        status,
        body: { error },
      });
      expect(mocks.getRunById).not.toHaveBeenCalled();
      expect(mocks.finishRunIfRunning).not.toHaveBeenCalled();
      expect(mocks.enqueueProposal).not.toHaveBeenCalled();
    },
  );
  it.each([
    {},
    { report: "" },
    { report: 42 },
    { report: " <!-- openseo-monthly-draft-v1:abc --> " },
  ])(
    "finalizes a missing written report as content failure (%j)",
    async (result) => {
      expect(
        (
          await handleSamBoxResult({
            body: envelope({ result: { proposals: [], ...result } }),
          })
        ).body,
      ).toMatchObject({
        status: "failed",
        error: "The run ended without a written report.",
        proposals_queued: 0,
      });
      expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          report: "Not measured — The run ended without a written report.",
          stepsUsed: 1,
        }),
      );
      expect(mocks.claimDueLoop).toHaveBeenCalledTimes(1);
    },
  );
  it("fails unknown result fields instead of treating them as missing prose", async () => {
    const result = await handleSamBoxResult({
      body: envelope({
        result: {
          report: REPORT,
          proposals: [PROPOSAL],
          domain: "other.example",
        },
      }),
    });
    expect(result.body).toMatchObject({
      status: "failed",
      error: "Result had unexpected fields.",
      proposals_queued: 0,
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        report: "Not measured — Result had unexpected fields.",
      }),
    );
    expect(mocks.enqueueProposal).not.toHaveBeenCalled();
  });
  it.each([null, { ...loop(), customPrompt: "edited" }])(
    "fails closed when the loop is gone or is no longer a box kind",
    async (row) => {
      mocks.getLoopById.mockResolvedValue(row);
      expect(
        (await handleSamBoxResult({ body: envelope() })).body,
      ).toMatchObject({
        status: "failed",
        error: "Loop is no longer a box loop.",
        proposals_queued: 0,
      });
      expect(mocks.enqueueProposal).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { id: "project-1", domain: null },
    { id: "project-1", domain: "" },
  ])("fails closed without a project domain", async (row) => {
    mocks.getProjectById.mockResolvedValue(row);
    expect((await handleSamBoxResult({ body: envelope() })).body.status).toBe(
      "failed",
    );
    expect(mocks.enqueueProposal).not.toHaveBeenCalled();
  });
  it("carries the saved stale-audit notice before the stripped report and note", async () => {
    mocks.getRunById.mockResolvedValue(
      run({ report: "STALE AUDIT — Saved evidence is old.\n\n" }),
    );
    await handleSamBoxResult({
      body: envelope({
        result: {
          report: "  Measured <!-- openseo-monthly-draft-v1:abc -->  ",
          proposals: [{ path: "/", domain: "injected", title: "X" }],
        },
      }),
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "completed",
        report:
          "STALE AUDIT — Saved evidence is old.\n\nMeasured\n\nWorker note: 1 proposal(s) were not queued (disallowed_field).",
      }),
    );
  });
  it("counts identical pending fixes as queued regardless of key order", async () => {
    mocks.listProposals.mockResolvedValue([
      {
        path: "/pricing",
        fixes: {
          h1: "Our plans",
          description: "Compare plans",
          title: "Pricing",
        },
      },
    ]);
    expect(
      (await handleSamBoxResult({ body: envelope() })).body.proposals_queued,
    ).toBe(1);
    expect(mocks.enqueueProposal).not.toHaveBeenCalled();
  });
  it.each([
    [{ path: "/pricing", fixes: { title: "Different" } }],
    [
      {
        path: "/other",
        fixes: {
          title: "Pricing",
          description: "Compare plans",
          h1: "Our plans",
        },
      },
    ],
    [
      {
        path: "/pricing",
        fixes: {
          title: "Pricing",
          description: "Compare plans",
          h1: "Our plans",
          og_title: "Extra",
        },
      },
    ],
  ])("queues when path or complete fixes differ (%j)", async (pending) => {
    mocks.listProposals.mockResolvedValue([pending]);
    await handleSamBoxResult({ body: envelope() });
    expect(mocks.enqueueProposal).toHaveBeenCalledTimes(1);
  });
  it("returns the CURRENT winner and logs orphan proposals after a lost finalize race", async () => {
    mocks.finishRunIfRunning.mockImplementation(async () => {
      mocks.getRunById.mockResolvedValue(
        run({ status: "failed", error: "Sweep won", proposalsQueued: 0 }),
      );
      return false;
    });
    const result = await handleSamBoxResult({ body: envelope() });
    expect(result.body).toEqual({
      ok: true,
      run_id: "run-1",
      status: "failed",
      error: "Sweep won",
      proposals_queued: 0,
      replay: true,
    });
    expect(console.error).toHaveBeenCalledWith({
      event: "sam_box_orphan_proposals",
      runId: "run-1",
      count: 1,
    });
    expect(mocks.updateLoop).not.toHaveBeenCalled();
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });
  it("records a redacted queue failure without losing the report", async () => {
    mocks.enqueueProposal.mockRejectedValue(
      new Error("queue unavailable Bearer sk-private"),
    );
    const result = await handleSamBoxResult({ body: envelope() });
    expect(result.body).toMatchObject({
      status: "failed",
      proposals_queued: 0,
      error: expect.stringContaining("Proposal queue failed: Error:"),
    });
    expect(JSON.stringify(result)).not.toContain("sk-private");
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        report:
          REPORT +
          "\n\nWorker note: 1 proposal(s) were not queued (queue_error).",
      }),
    );
  });
  it("keeps partial queuing completed and adds queue_error only once", async () => {
    mocks.enqueueProposal
      .mockResolvedValueOnce({ id: "queued" })
      .mockRejectedValue(new Error("queue unavailable"));
    const proposals = [
      PROPOSAL,
      { path: "/two", title: "Two" },
      { path: "/three", title: "Three" },
    ];
    const result = await handleSamBoxResult({
      body: envelope({ result: { report: REPORT, proposals } }),
    });
    expect(result.body).toMatchObject({
      status: "completed",
      error: null,
      proposals_queued: 1,
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        report:
          REPORT +
          "\n\nWorker note: 2 proposal(s) were not queued (queue_error).",
      }),
    );
  });
  it("counts a deduped proposal even if every new queue write fails", async () => {
    mocks.listProposals.mockResolvedValue([
      {
        path: "/pricing",
        fixes: {
          title: "Pricing",
          description: "Compare plans",
          h1: "Our plans",
        },
      },
    ]);
    mocks.enqueueProposal.mockRejectedValue(new Error("queue unavailable"));
    const result = await handleSamBoxResult({
      body: envelope({
        result: {
          report: REPORT,
          proposals: [PROPOSAL, { path: "/two", title: "Two" }],
        },
      }),
    });
    expect(result.body).toMatchObject({
      status: "completed",
      error: null,
      proposals_queued: 1,
    });
  });
  it("finalizes safely when reading the dedupe list fails", async () => {
    mocks.listProposals.mockRejectedValue(new Error("KV unavailable"));
    expect((await handleSamBoxResult({ body: envelope() })).body).toMatchObject(
      {
        status: "failed",
        proposals_queued: 0,
        error: "Proposal queue failed: Error: KV unavailable",
      },
    );
    expect(mocks.enqueueProposal).not.toHaveBeenCalled();
  });
  it("never reads the proposal store for an empty proposal list", async () => {
    await handleSamBoxResult({
      body: envelope({
        model: "grok-4.6-build",
        duration_ms: 600000,
        result: { report: REPORT, proposals: [] },
      }),
    });
    expect(mocks.listProposals).not.toHaveBeenCalled();
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        costNote:
          "box:grok-sub grok-4.6-build · subscription, no per-use cost · 600s",
      }),
    );
  });
});

describe("pure result validation", () => {
  const cases: [Record<string, unknown> | null, string][] = [
    [{ title: "X" }, "bad_path"],
    [{ path: "https://bad.example/", title: "X" }, "bad_path"],
    [{ path: "/" + "x".repeat(200), title: "X" }, "bad_path"],
    [{ path: "/has space", title: "X" }, "bad_path"],
    [{ path: "/https://bad", title: "X" }, "bad_path"],
    [{ path: "/<bad>", title: "X" }, "bad_path"],
    [{ path: "/", title: 4 }, "bad_field"],
    [{ path: "/", title: " " }, "bad_field"],
    [null, "bad_field"],
    [{ path: "/", title: "x".repeat(71) }, "too_long"],
    [{ path: "/", description: "x".repeat(171) }, "too_long"],
    [{ path: "/", h1: "x".repeat(121) }, "too_long"],
    [{ path: "/", title: "<b>Title</b>" }, "markup"],
    [{ path: "/", description: "Title>" }, "markup"],
    [{ path: "/", h1: "Title\n" }, "markup"],
    [{ path: "/", title: "Title\r" }, "markup"],
    [{ path: "/", title: "X", before_title: "x".repeat(301) }, "too_long"],
    [
      { path: "/", title: "X", before_description: "x".repeat(301) },
      "too_long",
    ],
    [{ path: "/", title: "X", rationale: "x".repeat(301) }, "too_long"],
    [{ path: "/", title: "X", human_review: ["x".repeat(201)] }, "too_long"],
    [{ path: "/", title: "X", human_review: [1] }, "bad_field"],
    [
      { path: "/", title: "X", human_review: ["a", "b", "c", "d", "e", "f"] },
      "too_long",
    ],
    [{ path: "/", title: "X", before_title: null }, "bad_field"],
    [{ path: "/", title: "X", domain: "evil.example" }, "disallowed_field"],
    [{ path: "/", title: "X", og_title: "X" }, "disallowed_field"],
    [{ path: "/", title: "X", og_description: "X" }, "disallowed_field"],
    [{ path: "/", title: "X", unexpected: true }, "disallowed_field"],
    [{ path: "/", rationale: "No fix supplied" }, "no_fix"],
  ];
  it.each(cases)(
    "drops only the offending proposal with %s / %s",
    async (bad, code) => {
      const result = await handleSamBoxResult({
        body: envelope({
          result: { report: REPORT, proposals: [bad, PROPOSAL] },
        }),
      });
      expect(result.body).toMatchObject({
        status: "completed",
        proposals_queued: 1,
      });
      expect(mocks.enqueueProposal).toHaveBeenCalledTimes(1);
      expect(mocks.enqueueProposal).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/pricing" }),
      );
      expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
        "run-1",
        expect.objectContaining({
          report:
            REPORT +
            `\n\nWorker note: 1 proposal(s) were not queued (${code}).`,
        }),
      );
    },
  );
  it("trims fixes and accepts every exact maximum, preserving optional empty metadata", () => {
    const proposal = {
      path: "/" + "a".repeat(199),
      title: " " + "a".repeat(70) + " ",
      description: "a".repeat(170),
      h1: "a".repeat(120),
      before_title: "a".repeat(300),
      before_description: "",
      rationale: "a".repeat(300),
      human_review: Array.from({ length: 5 }, () => "a".repeat(200)),
    };
    expect(
      validateSamBoxResult(
        {
          report: " Read <!-- openseo-monthly-draft-v1:abc --> ",
          proposals: [proposal],
        },
        "on_page_priorities",
        limits(),
      ),
    ).toEqual({
      ok: true,
      report: "Read",
      proposals: [{ ...proposal, title: "a".repeat(70) }],
      dropped: [],
    });
  });
  it("truncates overlong prose with the exact Worker suffix", () => {
    expect(
      validateSamBoxResult(
        { report: "x".repeat(6001), proposals: [] },
        "on_page_priorities",
        limits(),
      ),
    ).toEqual({
      ok: true,
      report: "x".repeat(5980) + "…[truncated by Worker]",
      proposals: [],
      dropped: [],
    });
  });
  it("rejects invalid proposals arrays as content rather than queueing", () => {
    expect(
      validateSamBoxResult(
        { report: REPORT, proposals: {} },
        "on_page_priorities",
        limits(),
      ),
    ).toEqual({ ok: false, error: "Result had invalid fields." });
  });
  it.each([null, [], "text"])(
    "treats non-object content as a missing report in the pure validator (%s)",
    (result) => {
      expect(
        validateSamBoxResult(result, "on_page_priorities", limits()),
      ).toEqual({
        ok: false,
        error: "The run ended without a written report.",
      });
    },
  );
  it.each([
    { path: "/pricing", title: 1 },
    { path: "/pricing", title: "X", domain: "injected.example" },
  ])(
    "reserves the first path even when that proposal is rejected (%j)",
    (bad) => {
      expect(
        validateSamBoxResult(
          { report: REPORT, proposals: [bad, PROPOSAL] },
          "on_page_priorities",
          limits(),
        ),
      ).toMatchObject({
        ok: true,
        proposals: [],
        dropped: [
          "domain" in bad ? "disallowed_field" : "bad_field",
          "duplicate_path",
        ],
      });
    },
  );
  it("drops later duplicate paths and extras in input order with distinct note codes", async () => {
    const proposals = [
      PROPOSAL,
      { path: "/pricing", title: "Duplicate" },
      { path: "/two", title: "Two" },
      { path: "/bad path", title: "Bad" },
      { path: "/bad path 2", title: "Bad" },
      { path: "/six", title: "Six" },
    ];
    await handleSamBoxResult({
      body: envelope({ result: { report: REPORT, proposals } }),
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        proposalsQueued: 2,
        report:
          REPORT +
          "\n\nWorker note: 4 proposal(s) were not queued (duplicate_path, bad_path, over_limit).",
      }),
    );
  });
  it("CTR allows only title/description and applies the tighter lengths and count", async () => {
    mocks.getLoopById.mockResolvedValue(loop("ctr_opportunities"));
    await handleSamBoxResult({
      body: envelope({
        result: {
          report: REPORT,
          proposals: [
            {
              path: "/one",
              title: "a".repeat(60),
              description: "a".repeat(155),
            },
            { path: "/two", h1: "H1" },
            { path: "/three", title: "a".repeat(61) },
            { path: "/four", title: "Four" },
          ],
        },
      }),
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "completed",
        proposalsQueued: 1,
        report:
          REPORT +
          "\n\nWorker note: 3 proposal(s) were not queued (disallowed_field, too_long, over_limit).",
      }),
    );
    expect(
      validateSamBoxResult(
        {
          report: REPORT,
          proposals: [{ path: "/", description: "a".repeat(156) }],
        },
        "ctr_opportunities",
        limits("ctr_opportunities"),
      ),
    ).toMatchObject({ ok: true, dropped: ["too_long"] });
  });
});

describe("box abandon", () => {
  it("releases before the model without consuming cadence or touching lastRunAt", async () => {
    expect(await handleSamBoxAbandon({ body: abandon() })).toEqual({
      status: 200,
      body: { ok: true, run_id: "run-1", status: "failed", replay: false },
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith("run-1", {
      status: "failed",
      error:
        "Box runner released the run before any model call (controller_active).",
      report:
        "Not measured — Box runner released the run before any model call (controller_active). No model was called.",
      proposalsQueued: 0,
      stepsUsed: 0,
      costNote: "no model call",
      finishedAt: NOW,
    });
    expect(mocks.updateLoop).not.toHaveBeenCalled();
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });
  it("fails closed on a repeated before-model release after the contract removes its box marker", async () => {
    await handleSamBoxAbandon({ body: abandon() });
    expect(await handleSamBoxAbandon({ body: abandon() })).toEqual({
      status: 409,
      body: { error: "not_a_box_run" },
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledTimes(1);
    expect(mocks.updateLoop).not.toHaveBeenCalled();
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });
  it("advances after a model call and sanitizes detail through the real redactor", async () => {
    await handleSamBoxAbandon({
      body: abandon({
        stage: "model_call",
        code: "model_timeout",
        detail: "runtime\t  stopped\n safely ☃ Bearer sk-private",
      }),
    });
    const error =
      "Generation did not return a complete valid result. Box runner: model_timeout: Error: runtime stopped [redacted]";
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith("run-1", {
      status: "failed",
      error,
      report: "Not measured — " + error,
      proposalsQueued: 0,
      stepsUsed: 1,
      costNote: "box:grok-sub (model_timeout)",
      finishedAt: NOW,
    });
    expect(mocks.updateLoop).toHaveBeenCalledTimes(1);
    expect(mocks.claimDueLoop).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.finishRunIfRunning.mock.calls)).not.toContain(
      "sk-private",
    );
  });
  it("caps runner detail at 200 printable characters before redaction", async () => {
    await handleSamBoxAbandon({
      body: abandon({
        stage: "model_call",
        code: "runner_error",
        detail: "read failed ".repeat(30),
      }),
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        error:
          "Generation did not return a complete valid result. Box runner: runner_error: Error: " +
          "read failed ".repeat(30).slice(0, 200).trim(),
      }),
    );
  });
  it.each(["completed", "failed"] as const)(
    "replays an already %s run without writes",
    async (status) => {
      mocks.getRunById.mockResolvedValue(run({ status }));
      expect(await handleSamBoxAbandon({ body: abandon() })).toEqual({
        status: 200,
        body: { ok: true, run_id: "run-1", status, replay: true },
      });
      expect(mocks.finishRunIfRunning).not.toHaveBeenCalled();
    },
  );
  it("releases an expired running lease according to its stage", async () => {
    vi.setSystemTime("2026-10-07T13:50:00.123Z");
    expect(
      (
        await handleSamBoxAbandon({
          body: abandon({ stage: "model_call", code: "model_error" }),
        })
      ).body,
    ).toEqual({ ok: true, run_id: "run-1", status: "failed", replay: false });
    expect(mocks.claimDueLoop).toHaveBeenCalledTimes(1);
  });
  it("returns the current winning status on a lost terminal write", async () => {
    mocks.finishRunIfRunning.mockImplementation(async () => {
      mocks.getRunById.mockResolvedValue(run({ status: "completed" }));
      return false;
    });
    expect((await handleSamBoxAbandon({ body: abandon() })).body).toEqual({
      ok: true,
      run_id: "run-1",
      status: "completed",
      replay: true,
    });
    expect(mocks.updateLoop).not.toHaveBeenCalled();
  });
  it.each([
    [{ stage: "unknown" }, 422],
    [{ code: "unknown" }, 422],
    [{ stage: 1 }, 400],
    [{ code: null }, 400],
    [{ detail: 1 }, 400],
    [{ unexpected: true }, 400],
  ])(
    "leaves runs untouched for abandon envelope errors (%j)",
    async (overrides, status) => {
      expect(await handleSamBoxAbandon({ body: abandon(overrides) })).toEqual({
        status,
        body: { error: status === 400 ? "invalid_body" : "invalid_envelope" },
      });
      expect(mocks.getRunById).not.toHaveBeenCalled();
      expect(mocks.finishRunIfRunning).not.toHaveBeenCalled();
    },
  );
  it.each([
    [null, "unknown_run", 404],
    [run({ costNote: "openrouter" }), "not_a_box_run", 409],
    [run({ status: "completed" }), "lease_mismatch", 409],
  ])(
    "checks abandon run and lease gates before any write (%s)",
    async (row, error, status) => {
      mocks.getRunById.mockResolvedValue(row);
      expect(
        await handleSamBoxAbandon({ body: abandon({ lease_id: "wrong" }) }),
      ).toEqual({ status, body: { error } });
      expect(mocks.finishRunIfRunning).not.toHaveBeenCalled();
    },
  );
});
