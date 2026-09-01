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
vi.mock("@/server/features/sam-loops/services/samLoopRunGuards", () => ({
  beginSamLoopRun: mocks.beginSamLoopRun,
}));

const testEnv = { SAM_LOOP_WORKFLOW: {} } as unknown as Env;

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

async function runTick() {
  const { runScheduledSamLoops } = await import("./scheduledSamLoops");
  await runScheduledSamLoops(testEnv);
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
});
