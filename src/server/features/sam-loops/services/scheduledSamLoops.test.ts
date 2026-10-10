import { beforeEach, describe, expect, it, vi } from "vitest";

type DueLoopRow = {
  id: string;
  projectId: string;
  name: string;
  sourceType: "skill" | "custom";
  skillName: string | null;
  customPrompt: string | null;
  cadence: "daily" | "weekly" | "monthly";
  nextRunAt: string | null;
  organizationId: string;
  domain: string | null;
  loopsEnabled: boolean;
};

type ClaimInput = {
  loopId: string;
  projectId: string;
  observedNextRunAt: string;
  nextRunAt: string;
};

type BeginResult =
  | { ok: true; runId: string }
  | { ok: false; reason: string; blockingRunId: string | null };

const mocks = vi.hoisted(() => ({
  getDueLoopsWithOrganization:
    vi.fn<(nowIso: string) => Promise<DueLoopRow[]>>(),
  claimDueLoop: vi.fn<(input: ClaimInput) => Promise<boolean>>(),
  countRunsCreatedSince: vi.fn<(sinceDate: string) => Promise<number>>(),
  beginSamLoopRun:
    vi.fn<(input: { loopId: string; trigger: string }) => Promise<BeginResult>>(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock(
  "@/server/features/sam-loops/repositories/SamLoopRepository",
  () => ({
    SamLoopRepository: {
      getDueLoopsWithOrganization: mocks.getDueLoopsWithOrganization,
      claimDueLoop: mocks.claimDueLoop,
      countRunsCreatedSince: mocks.countRunsCreatedSince,
    },
  }),
);
vi.mock("@/server/features/sam-loops/services/samLoopRunGuards", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/server/features/sam-loops/services/samLoopRunGuards")
    >();
  return {
    ...actual,
    beginSamLoopRun: mocks.beginSamLoopRun,
  };
});

const testEnv = { SAM_LOOP_WORKFLOW: {} } as unknown as Env;

function capEnv(value?: string): Env {
  const env = { SAM_LOOP_WORKFLOW: {} } as unknown as Env;
  if (value !== undefined) {
    (env as { SAM_LOOP_DAILY_RUN_CAP?: string }).SAM_LOOP_DAILY_RUN_CAP = value;
  }
  return env;
}

function dueLoop(overrides: Partial<DueLoopRow> = {}): DueLoopRow {
  return {
    id: "loop_1",
    projectId: "project_1",
    name: "Site health",
    sourceType: "skill",
    skillName: "site-health",
    customPrompt: null,
    cadence: "weekly",
    nextRunAt: "2026-01-01T00:00:00.000Z",
    organizationId: "org_1",
    domain: "niceseo.ai",
    loopsEnabled: false,
    ...overrides,
  };
}

async function runTick(env: Env = testEnv) {
  const { runScheduledSamLoops } = await import("./scheduledSamLoops");
  await runScheduledSamLoops(env);
}

describe("runScheduledSamLoops", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.countRunsCreatedSince.mockResolvedValue(0);
  });

  it("claims due loops and starts workflows", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([dueLoop()]);
    mocks.claimDueLoop.mockResolvedValue(true);
    mocks.beginSamLoopRun.mockResolvedValue({ ok: true, runId: "run_1" });

    await runTick();

    expect(mocks.claimDueLoop).toHaveBeenCalledTimes(1);
    expect(mocks.beginSamLoopRun).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop_1",
        trigger: "scheduled",
      }),
    );
  });

  it("restores schedule when already running", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([dueLoop()]);
    mocks.claimDueLoop.mockResolvedValue(true);
    mocks.beginSamLoopRun.mockResolvedValue({
      ok: false,
      reason: "already_running",
      blockingRunId: "blocker",
    });

    await runTick();

    // First claim advances, second restores observed nextRunAt.
    expect(mocks.claimDueLoop).toHaveBeenCalledTimes(2);
    const restore = mocks.claimDueLoop.mock.calls[1]?.[0];
    expect(restore?.nextRunAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("skips when claim loses the CAS race", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([dueLoop()]);
    mocks.claimDueLoop.mockResolvedValue(false);

    await runTick();

    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("restores a failed workflow start and still starts the next due loop", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop(), dueLoop({ id: "loop_2" }),
    ]);
    mocks.claimDueLoop.mockResolvedValue(true);
    mocks.beginSamLoopRun
      .mockRejectedValueOnce(new Error("workflow unavailable"))
      .mockResolvedValue({ ok: true, runId: "run_2" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await runTick();

    const claim = mocks.claimDueLoop.mock.calls[0]?.[0];
    expect(mocks.claimDueLoop.mock.calls[1]?.[0]).toEqual({
      loopId: "loop_1", projectId: "project_1",
      observedNextRunAt: claim?.nextRunAt,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      workflowStartErrors: 1, started: 1,
    }));
  });

  it("does not overwrite a concurrent schedule change while restoring", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([dueLoop()]);
    mocks.claimDueLoop.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.beginSamLoopRun.mockRejectedValue(new Error("workflow unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTick();

    expect(mocks.claimDueLoop).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("changed concurrently"));
  });

  it("continues other loops when schedule restoration fails", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop(), dueLoop({ id: "loop_2" }),
    ]);
    mocks.claimDueLoop.mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("restore unavailable"))
      .mockResolvedValue(true);
    mocks.beginSamLoopRun.mockRejectedValueOnce(new Error("workflow unavailable"))
      .mockResolvedValue({ ok: true, runId: "run_2" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    await runTick();

    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      workflowStartErrors: 1, loopErrors: 1, started: 1,
    }));
  });

  it("restores the schedule and stops when admission reports the daily cap", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop(), dueLoop({ id: "loop_2" }),
    ]);
    mocks.claimDueLoop.mockResolvedValue(true);
    mocks.beginSamLoopRun.mockResolvedValue({
      ok: false, reason: "daily_cap", blockingRunId: null,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTick();

    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(1);
    expect(mocks.claimDueLoop.mock.calls[1]?.[0]?.nextRunAt)
      .toBe("2026-01-01T00:00:00.000Z");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      stoppedByCap: true, alreadyRunning: 0, started: 0,
    }));
  });

  it("does nothing when today's runs already reached the cap", async () => {
    mocks.countRunsCreatedSince.mockResolvedValue(40);

    await runTick();

    expect(mocks.getDueLoopsWithOrganization).not.toHaveBeenCalled();
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });

  it("stops claiming once the remaining budget is used", async () => {
    mocks.countRunsCreatedSince.mockResolvedValue(39);
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop({ id: "loop_1" }),
      dueLoop({ id: "loop_2" }),
    ]);
    mocks.claimDueLoop.mockResolvedValue(true);
    mocks.beginSamLoopRun.mockResolvedValue({ ok: true, runId: "run_1" });

    await runTick();

    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(1);
  });

  it("claims but never starts a due loop whose project domain is outside the allowlist", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop({ domain: "client-example.com" }),
    ]);
    mocks.claimDueLoop.mockResolvedValue(true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTick();

    expect(mocks.claimDueLoop).toHaveBeenCalledTimes(1);
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sam_loops_scheduler_summary",
        domainSkips: 1,
        started: 0,
      }),
    );
  });

  it("reports a refused domain deferral as a concurrent change, not a successful skip", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop({ domain: "client-example.com" }),
    ]);
    mocks.claimDueLoop.mockResolvedValue(false);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await runTick();

    expect(mocks.claimDueLoop).toHaveBeenCalledTimes(1);
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sam_loops_scheduler_summary",
        domainSkips: 0,
        concurrentChangeSkips: 1,
        started: 0,
      }),
    );
  });

  it("starts a due loop when the project is outside the allowlist but loopsEnabled is true", async () => {
    mocks.getDueLoopsWithOrganization.mockResolvedValue([
      dueLoop({ domain: "client-example.com", loopsEnabled: true }),
    ]);
    mocks.claimDueLoop.mockResolvedValue(true);
    mocks.beginSamLoopRun.mockResolvedValue({ ok: true, runId: "run_1" });

    await runTick();

    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(1);
    expect(mocks.beginSamLoopRun).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop_1",
        trigger: "scheduled",
      }),
    );
  });

  describe("SAM_LOOP_DAILY_RUN_CAP", () => {
    it.each([
      { value: undefined, cap: 40, label: "unset" },
      { value: "100", cap: 100, label: "100" },
      { value: "0", cap: 40, label: "0" },
      { value: "abc", cap: 40, label: "abc" },
      { value: "-5", cap: 40, label: "-5" },
      { value: "1001", cap: 40, label: "1001" },
    ])("$label uses cap $cap", async ({ value, cap }) => {
      mocks.countRunsCreatedSince.mockResolvedValue(cap);

      await runTick(capEnv(value));

      expect(mocks.getDueLoopsWithOrganization).not.toHaveBeenCalled();
      expect(mocks.claimDueLoop).not.toHaveBeenCalled();
    });

    it("stops claiming once the remaining budget is used with a raised cap", async () => {
      mocks.countRunsCreatedSince.mockResolvedValue(99);
      mocks.getDueLoopsWithOrganization.mockResolvedValue([
        dueLoop({ id: "loop_1" }),
        dueLoop({ id: "loop_2" }),
      ]);
      mocks.claimDueLoop.mockResolvedValue(true);
      mocks.beginSamLoopRun.mockResolvedValue({ ok: true, runId: "run_1" });

      await runTick(capEnv("100"));

      expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(1);
    });
  });
});
