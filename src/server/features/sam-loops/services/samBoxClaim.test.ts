import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SamLoopRepository } from "../repositories/SamLoopRepository";
import type { SamBoxFinishData } from "./samBoxFinalize";
import type {
  SamBoxLoop,
  SamBoxPrepared,
  SamBoxPrepareInput,
} from "./samBoxTypes";
import {
  DEFAULT_SAM_LOOP_TEMPLATES,
  computeNextSamLoopRunAt,
} from "@/shared/sam-loops";
import { handleSamBoxClaim } from "./samBoxClaim";

const mocks = vi.hoisted(() => ({
  getDueLoopsWithOrganization:
    vi.fn<(nowIso: string) => Promise<SamBoxLoop[]>>(),
  countRunsCreatedSince: vi.fn<(sinceDate: string) => Promise<number>>(),
  claimDueLoop: vi.fn<typeof SamLoopRepository.claimDueLoop>(),
  tryCreateRun: vi.fn<typeof SamLoopRepository.tryCreateRun>(),
  updateRun: vi.fn<typeof SamLoopRepository.updateRun>(),
  getActiveRunForLoop:
    vi.fn<(loopId: string) => Promise<{ id: string } | null>>(),
  finishRunIfRunning:
    vi.fn<(runId: string, data: SamBoxFinishData) => Promise<boolean>>(),
  updateLoop:
    vi.fn<
      (
        loopId: string,
        projectId: string,
        data: { lastRunAt: string },
      ) => Promise<void>
    >(),
  getLoopById: vi.fn<
    (
      loopId: string,
      projectId: string,
    ) => Promise<{
      name: string;
      cadence: "daily" | "weekly" | "monthly";
      nextRunAt: string | null;
    } | null>
  >(),
  prepare: vi.fn<(input: SamBoxPrepareInput) => Promise<SamBoxPrepared>>(),
  sweep: vi.fn<() => Promise<{ expired: number }>>(),
  errorDetail: vi.fn<(error: unknown) => string>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("../repositories/SamLoopRepository", () => ({
  SamLoopRepository: mocks,
}));
vi.mock("./samBoxPrepare", () => ({ prepareSamBoxClaim: mocks.prepare }));
vi.mock("./samBoxSweep", () => ({ sweepExpiredBoxRuns: mocks.sweep }));
vi.mock("./runHeadlessSamLoop", () => ({
  generationErrorDetail: mocks.errorDetail,
}));

const NOW = "2026-10-07T13:20:00.123Z";
const DUE = "2026-10-01T13:00:00.000Z";
const env = { SAM_LOOP_DAILY_RUN_CAP: "20" } as unknown as Env;
const body = {
  contract: 1,
  runner_id: "hermes-vm-sam-runner",
  kinds: ["on_page_priorities", "ctr_opportunities"],
  max_prompt_bytes: 28000,
};

function dueLoop(overrides: Partial<SamBoxLoop> = {}): SamBoxLoop {
  return {
    id: "loop-1",
    projectId: "project-1",
    name: "On-page priorities",
    sourceType: "custom",
    skillName: null,
    customPrompt:
      DEFAULT_SAM_LOOP_TEMPLATES.find(
        (template) => template.name === "On-page priorities",
      )?.customPrompt ?? null,
    cadence: "monthly",
    nextRunAt: DUE,
    organizationId: "org-1",
    domain: "site.example",
    loopsEnabled: true,
    ...overrides,
  };
}

function modelPrepared(): Extract<SamBoxPrepared, { kind: "model" }> {
  return {
    kind: "model",
    prompt: "Prepared inputs",
    promptBytes: 15,
    staleNotice: "",
    toolResults: [
      {
        name: "get_audit_status",
        args: {},
        ok: true,
        derived: null,
        truncated: false,
        bytes: 2,
      },
    ],
  };
}

async function claim(inputBody: unknown = body, inputEnv: Env = env) {
  return handleSamBoxClaim({
    env: inputEnv,
    body: inputBody,
    now: new Date(NOW),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mocks.getDueLoopsWithOrganization.mockResolvedValue([dueLoop()]);
  mocks.countRunsCreatedSince.mockResolvedValue(0);
  mocks.claimDueLoop.mockResolvedValue(true);
  mocks.tryCreateRun.mockResolvedValue(true);
  mocks.updateRun.mockResolvedValue(undefined);
  mocks.getActiveRunForLoop.mockResolvedValue(null);
  mocks.finishRunIfRunning.mockResolvedValue(true);
  mocks.updateLoop.mockResolvedValue(undefined);
  mocks.getLoopById.mockResolvedValue({
    name: "On-page priorities",
    cadence: "monthly",
    nextRunAt: DUE,
  });
  mocks.prepare.mockResolvedValue(modelPrepared());
  mocks.sweep.mockResolvedValue({ expired: 0 });
  mocks.errorDetail.mockReturnValue("Error: inputs unavailable [redacted]");
});
afterEach(() => vi.useRealTimers());

describe("handleSamBoxClaim", () => {
  it("claims the oldest requested box loop in repository order with the exact lease envelope", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop({ id: "non-box", customPrompt: "edited template" }),
      dueLoop({
        id: "oldest",
        name: "Renamed loop",
        nextRunAt: "2026-09-01T13:00:00.000Z",
      }),
      dueLoop({ id: "newer" }),
    ]);
    const result = await claim();
    const runId = mocks.tryCreateRun.mock.calls[0]?.[0].id;
    expect(runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result).toEqual({
      status: 200,
      body: {
        contract: 1,
        claim: {
          lease_id: `${runId}.${Date.parse(NOW)}`,
          run_id: runId,
          loop_id: "oldest",
          project_id: "project-1",
          kind: "on_page_priorities",
          loop_name: "Renamed loop",
          cadence: "monthly",
          claimed_at: NOW,
          lease_expires_at: "2026-10-07T13:35:00.123Z",
          prompt: "Prepared inputs",
          prompt_bytes: 15,
          tool_results: modelPrepared().toolResults,
          output: {
            format: "json_object",
            schema_id: "sam-box-result-v1",
            max_output_bytes: 24576,
            max_report_chars: 6000,
            max_proposals: 5,
            allowed_fields: ["title", "description", "h1"],
          },
          limits: { call_seconds: 180, lease_seconds: 900 },
        },
      },
    });
    expect(mocks.tryCreateRun).toHaveBeenCalledExactlyOnceWith(
      { id: runId, loopId: "oldest", projectId: "project-1" },
      { sinceDate: "2026-10-07", cap: 20 },
    );
    expect(mocks.updateRun).toHaveBeenCalledExactlyOnceWith(runId, {
      status: "running",
      startedAt: NOW,
      costNote: "box:grok-sub leased",
    });
    expect(mocks.getDueLoopsWithOrganization).toHaveBeenCalledWith(NOW);
    expect(mocks.finishRunIfRunning).not.toHaveBeenCalled();
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });

  it("ignores non-box loops and box kinds the runner did not request", async () => {
    const ctr = dueLoop({
      id: "ctr",
      customPrompt:
        DEFAULT_SAM_LOOP_TEMPLATES.find(
          (template) => template.name === "CTR opportunities",
        )?.customPrompt ?? null,
    });
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop(),
      dueLoop({ sourceType: "skill" }),
      ctr,
    ]);
    const result = await claim({
      ...body,
      kinds: ["unknown", "ctr_opportunities"],
    });
    expect(result.body.claim).toMatchObject({
      loop_id: "ctr",
      kind: "ctr_opportunities",
      output: {
        max_proposals: 3,
        allowed_fields: ["title", "description"],
      },
    });
    expect(mocks.tryCreateRun).toHaveBeenCalledTimes(1);
  });

  it("CAS-advances a disallowed project and tries the next candidate", async () => {
    const blocked = dueLoop({ id: "blocked", loopsEnabled: false });
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      blocked,
      dueLoop({ id: "next" }),
    ]);
    const result = await claim();
    expect(result.body.claim).toMatchObject({ loop_id: "next" });
    expect(mocks.claimDueLoop).toHaveBeenCalledExactlyOnceWith({
      loopId: "blocked",
      projectId: blocked.projectId,
      observedNextRunAt: DUE,
      nextRunAt: computeNextSamLoopRunAt(
        blocked.cadence,
        DUE,
        `${blocked.projectId}:${blocked.name}`,
      ),
    });
    expect(mocks.tryCreateRun).toHaveBeenCalledTimes(1);
  });

  it("continues after a disallowed project's advance loses the CAS", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop({ loopsEnabled: false }),
      dueLoop({ id: "next" }),
    ]);
    mocks.claimDueLoop.mockResolvedValue(false);
    expect((await claim()).body.claim).toMatchObject({ loop_id: "next" });
  });

  it("sweeps before checking the UTC daily cap and stops when the cap is reached", async () => {
    mocks.countRunsCreatedSince.mockResolvedValue(20);
    expect(await claim()).toEqual({
      status: 200,
      body: { contract: 1, claim: null, reason: "daily_cap" },
    });
    expect(mocks.countRunsCreatedSince).toHaveBeenCalledWith("2026-10-07");
    expect(mocks.sweep.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.countRunsCreatedSince.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.getDueLoopsWithOrganization).not.toHaveBeenCalled();
    expect(mocks.tryCreateRun).not.toHaveBeenCalled();
  });

  it("logs sweep failures and still claims without logging exception text", async () => {
    const error = new Error("Bearer private-token");
    mocks.sweep.mockRejectedValue(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await claim()).body.claim).toMatchObject({ loop_id: "loop-1" });
    expect(log).toHaveBeenCalledWith({ event: "sam_box_sweep_failed" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(error.message);
  });

  it("skips active runs without changing their loop or run, then tries the next candidate", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop({ id: "active" }),
      dueLoop({ id: "next" }),
    ]);
    mocks.tryCreateRun.mockResolvedValueOnce(false);
    mocks.getActiveRunForLoop.mockResolvedValue({ id: "active-run" });
    expect((await claim()).body.claim).toMatchObject({ loop_id: "next" });
    expect(mocks.getActiveRunForLoop).toHaveBeenCalledWith("active");
    expect(mocks.updateRun).toHaveBeenCalledTimes(1);
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });

  it("returns daily_cap after atomic admission loses the cap race without an active run", async () => {
    mocks.tryCreateRun.mockResolvedValue(false);
    expect(await claim()).toEqual({
      status: 200,
      body: { contract: 1, claim: null, reason: "daily_cap" },
    });
    expect(mocks.updateRun).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it.each(["disallowed", "active"])(
    "scans at most ten %s candidates",
    async (reason) => {
      mocks.getDueLoopsWithOrganization.mockResolvedValue(
        Array.from({ length: 11 }, (_, index) =>
          dueLoop({
            id: `loop-${index}`,
            loopsEnabled: reason !== "disallowed" || index === 10,
          }),
        ),
      );
      if (reason === "active") {
        mocks.tryCreateRun.mockResolvedValue(false);
        mocks.getActiveRunForLoop.mockResolvedValue({ id: "active-run" });
      }
      expect(await claim()).toEqual({
        status: 200,
        body: { contract: 1, claim: null, reason: "nothing_due" },
      });
      expect(
        reason === "disallowed" ? mocks.claimDueLoop : mocks.tryCreateRun,
      ).toHaveBeenCalledTimes(10);
      expect(mocks.prepare).not.toHaveBeenCalled();
    },
  );

  it("stops scanning at the request deadline without real waiting", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop({ id: "active" }),
      dueLoop({ id: "next" }),
    ]);
    mocks.tryCreateRun.mockResolvedValue(false);
    mocks.getActiveRunForLoop.mockImplementation(async () => {
      vi.advanceTimersByTime(100_000);
      return { id: "active-run" };
    });
    expect((await claim()).body).toEqual({
      contract: 1,
      claim: null,
      reason: "nothing_due",
    });
    expect(mocks.tryCreateRun).toHaveBeenCalledTimes(1);
  });

  it("uses the injected time with elapsed request time for UTC admission and lease timestamps", async () => {
    const injected = "2026-12-31T23:59:00.456Z";
    mocks.getDueLoopsWithOrganization.mockImplementation(async () => {
      vi.advanceTimersByTime(1234);
      return [dueLoop()];
    });
    const result = await handleSamBoxClaim({
      env,
      body,
      now: new Date(injected),
    });
    expect(mocks.countRunsCreatedSince).toHaveBeenCalledWith("2026-12-31");
    expect(mocks.getDueLoopsWithOrganization).toHaveBeenCalledWith(injected);
    expect(result.body.claim).toMatchObject({
      claimed_at: "2026-12-31T23:59:01.690Z",
      lease_expires_at: "2027-01-01T00:14:01.690Z",
    });
  });

  it("refreshes atomic admission's UTC day when the request crosses UTC midnight", async () => {
    mocks.getDueLoopsWithOrganization.mockImplementation(async () => {
      vi.advanceTimersByTime(1234);
      return [dueLoop()];
    });
    await handleSamBoxClaim({
      env,
      body,
      now: new Date("2026-12-31T23:59:59.456Z"),
    });
    expect(mocks.countRunsCreatedSince).toHaveBeenCalledWith("2026-12-31");
    expect(mocks.tryCreateRun).toHaveBeenCalledWith(expect.any(Object), {
      sinceDate: "2027-01-01",
      cap: 20,
    });
  });

  it.each(["completed", "failed"] as const)(
    "finalizes a %s no-model result and advances before trying the next candidate",
    async (status) => {
      mocks.getDueLoopsWithOrganization.mockResolvedValue([
        dueLoop(),
        dueLoop({ id: "next" }),
      ]);
      const error = status === "failed" ? "Audit not ready." : null;
      mocks.prepare.mockResolvedValueOnce({
        kind: "final",
        status,
        error,
        report: "No model call was made.",
      });
      expect((await claim()).body.claim).toMatchObject({ loop_id: "next" });
      const runId = mocks.tryCreateRun.mock.calls[0]?.[0].id;
      expect(mocks.finishRunIfRunning).toHaveBeenCalledExactlyOnceWith(runId, {
        status,
        error,
        report: "No model call was made.",
        finishedAt: NOW,
        proposalsQueued: 0,
        stepsUsed: 0,
        costNote: "no model call",
      });
      expect(mocks.updateLoop).toHaveBeenCalledWith("loop-1", "project-1", {
        lastRunAt: NOW,
      });
      expect(mocks.claimDueLoop).toHaveBeenCalledWith({
        loopId: "loop-1",
        projectId: "project-1",
        observedNextRunAt: DUE,
        nextRunAt: computeNextSamLoopRunAt(
          "monthly",
          DUE,
          "project-1:On-page priorities",
        ),
      });
      expect(mocks.claimDueLoop.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.tryCreateRun.mock.invocationCallOrder[1] ?? 0,
      );
    },
  );

  it("counts only no-model finalizations and includes the count on a null claim", async () => {
    mocks.prepare.mockResolvedValue({
      kind: "final",
      status: "completed",
      error: null,
      report: "No candidates.",
    });
    expect(await claim()).toEqual({
      status: 200,
      body: {
        contract: 1,
        claim: null,
        reason: "nothing_due",
        finalized_without_model: 1,
      },
    });
  });

  it("includes prior no-model finalizations when the cap race stops the scan", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop(),
      dueLoop({ id: "next" }),
    ]);
    mocks.prepare.mockResolvedValue({
      kind: "final",
      status: "completed",
      error: null,
      report: "No candidates.",
    });
    mocks.tryCreateRun.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await claim()).body).toEqual({
      contract: 1,
      claim: null,
      reason: "daily_cap",
      finalized_without_model: 1,
    });
  });

  it("does not count a lost terminal CAS or advance that loop", async () => {
    mocks.prepare.mockResolvedValue({
      kind: "final",
      status: "completed",
      error: null,
      report: "No candidates.",
    });
    mocks.finishRunIfRunning.mockResolvedValue(false);
    expect((await claim()).body).toEqual({
      contract: 1,
      claim: null,
      reason: "nothing_due",
    });
    expect(mocks.updateLoop).not.toHaveBeenCalled();
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });

  it("redacts prepare exceptions, fails without a model, advances, and tries the next candidate", async () => {
    const error = new Error("Bearer private-token");
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop(),
      dueLoop({ id: "next" }),
    ]);
    mocks.prepare.mockRejectedValueOnce(error);
    expect((await claim()).body.claim).toMatchObject({ loop_id: "next" });
    expect(mocks.errorDetail).toHaveBeenCalledWith(error);
    const storedError =
      "Box claim could not prepare inputs: Error: inputs unavailable [redacted]";
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(expect.any(String), {
      status: "failed",
      error: storedError,
      report: `Not measured — ${storedError}`,
      finishedAt: NOW,
      proposalsQueued: 0,
      stepsUsed: 0,
      costNote: "no model call",
    });
    expect(mocks.updateLoop).toHaveBeenCalledWith("loop-1", "project-1", {
      lastRunAt: NOW,
    });
    expect(mocks.claimDueLoop).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.finishRunIfRunning.mock.calls)).not.toContain(
      error.message,
    );
  });

  it("stores a non-empty stale audit notice before returning the model claim", async () => {
    const staleNotice =
      "STALE AUDIT — Crawl is older than the normal freshness window.\n\n";
    mocks.prepare.mockResolvedValue({ ...modelPrepared(), staleNotice });
    expect((await claim()).body.claim).toMatchObject({ loop_id: "loop-1" });
    expect(mocks.updateRun).toHaveBeenLastCalledWith(expect.any(String), {
      report: staleNotice,
    });
    expect(mocks.updateRun).toHaveBeenCalledTimes(2);
  });

  it("fails closed and attempts to fail the leased run when the stale notice cannot be stored", async () => {
    mocks.prepare.mockResolvedValue({
      ...modelPrepared(),
      staleNotice: "STALE AUDIT — Old crawl.\n\n",
    });
    mocks.updateRun
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("storage unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await claim()).toEqual({
      status: 500,
      body: { error: "claim_failed" },
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: "failed",
        error: "Box claim failed: Error: inputs unavailable [redacted]",
        stepsUsed: 0,
        proposalsQueued: 0,
        costNote: "no model call",
      }),
    );
    expect(mocks.claimDueLoop).toHaveBeenCalledOnce();
  });

  it("returns claim_failed when cleanup also fails, without leaking exception text", async () => {
    const error = new Error("Bearer private-token");
    mocks.updateRun.mockRejectedValue(error);
    mocks.finishRunIfRunning.mockRejectedValue(error);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await claim()).toEqual({
      status: 500,
      body: { error: "claim_failed" },
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledOnce();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain(error.message);
  });

  it("returns claim_failed for unexpected admission errors without creating or finishing another run", async () => {
    mocks.tryCreateRun.mockRejectedValue(new Error("database unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await claim()).toEqual({
      status: 500,
      body: { error: "claim_failed" },
    });
    expect(mocks.finishRunIfRunning).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("does not issue a model claim if preparation consumes the request deadline", async () => {
    mocks.prepare.mockImplementation(async () => {
      vi.advanceTimersByTime(100_000);
      return modelPrepared();
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await claim()).toEqual({
      status: 500,
      body: { error: "claim_failed" },
    });
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed", stepsUsed: 0 }),
    );
  });

  it("does not begin preparation if admission consumes the request deadline", async () => {
    mocks.tryCreateRun.mockImplementation(async () => {
      vi.advanceTimersByTime(100_000);
      return true;
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await claim()).toEqual({
      status: 500,
      body: { error: "claim_failed" },
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.finishRunIfRunning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "failed", stepsUsed: 0 }),
    );
  });

  it.each([4000, 32000])(
    "forwards the effective prompt limit for requested %s bytes",
    async (requested) => {
      await claim({ ...body, max_prompt_bytes: requested });
      expect(mocks.prepare).toHaveBeenCalledWith({
        env,
        loop: dueLoop(),
        kind: "on_page_priorities",
        runId: expect.any(String),
        maxPromptBytes: Math.min(requested, 28000),
      });
    },
  );

  it("returns no_supported_kind without run or schedule mutations", async () => {
    expect(await claim({ ...body, kinds: ["unknown"] })).toEqual({
      status: 200,
      body: { contract: 1, claim: null, reason: "no_supported_kind" },
    });
    expect(mocks.countRunsCreatedSince).not.toHaveBeenCalled();
    expect(mocks.tryCreateRun).not.toHaveBeenCalled();
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });

  it("returns nothing_due without a zero finalized count", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([]);
    expect(await claim()).toEqual({
      status: 200,
      body: { contract: 1, claim: null, reason: "nothing_due" },
    });
  });

  it.each([
    null,
    [],
    "body",
    { ...body, extra: true },
    { ...body, contract: 2 },
    { contract: 1, kinds: body.kinds, max_prompt_bytes: 28000 },
    { ...body, runner_id: "" },
    { ...body, runner_id: "a".repeat(65) },
    { ...body, runner_id: "runner id" },
    { ...body, runner_id: 1 },
    { ...body, kinds: [] },
    { ...body, kinds: [1] },
    { ...body, kinds: "ctr_opportunities" },
    { ...body, max_prompt_bytes: 3999 },
    { ...body, max_prompt_bytes: 32001 },
    { ...body, max_prompt_bytes: 4000.5 },
    { ...body, max_prompt_bytes: "28000" },
  ])("rejects invalid body %j before side effects", async (invalid) => {
    expect(await claim(invalid)).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
    expect(mocks.sweep).not.toHaveBeenCalled();
    expect(mocks.countRunsCreatedSince).not.toHaveBeenCalled();
    expect(mocks.tryCreateRun).not.toHaveBeenCalled();
  });
});
