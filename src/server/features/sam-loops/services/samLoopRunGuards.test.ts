import { beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(
  () =>
    ({
      SAM_LOOP_WORKFLOW: {
        get: vi.fn(),
      } as unknown as Env["SAM_LOOP_WORKFLOW"],
    }) as Env,
);

const mocks = vi.hoisted(() => ({
  tryCreateRun: vi.fn(),
  getActiveRunForLoop: vi.fn(),
  getRunById: vi.fn(),
  updateRun: vi.fn(),
  getWorkflow: vi.fn(),
  countRunsCreatedSince: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));
vi.mock("@/server/features/sam-loops/repositories/SamLoopRepository", () => ({
  SamLoopRepository: mocks,
}));

beforeEach(() => {
  mockEnv.SAM_LOOP_WORKFLOW = {
    get: mocks.getWorkflow,
  } as unknown as Env["SAM_LOOP_WORKFLOW"];
  delete mockEnv.SAM_LOOP_DAILY_RUN_CAP;
});

const input = {
  loopId: "loop_1",
  projectId: "project_1",
  organizationId: "org_1",
  trigger: "manual" as const,
  workflowStartErrorMessage: "failed",
};

describe("getSamLoopDailyRunCap", () => {
  beforeEach(() => {
    vi.resetModules();
    delete mockEnv.SAM_LOOP_DAILY_RUN_CAP;
  });

  it.each([
    { value: undefined, expected: 40, label: "unset" },
    { value: "100", expected: 100, label: "100" },
    { value: "0", expected: 40, label: "0" },
    { value: "abc", expected: 40, label: "abc" },
    { value: "-5", expected: 40, label: "-5" },
    { value: "1001", expected: 40, label: "1001" },
  ])("$label → $expected", async ({ value, expected }) => {
    if (value !== undefined) {
      mockEnv.SAM_LOOP_DAILY_RUN_CAP = value;
    }
    const { getSamLoopDailyRunCap } = await import("./samLoopRunGuards");
    expect(getSamLoopDailyRunCap(mockEnv)).toBe(expected);
  });
});

describe("beginSamLoopRun", () => {
  beforeEach(async () => {
    vi.resetModules();
    delete mockEnv.SAM_LOOP_DAILY_RUN_CAP;
    const mod = await import("./samLoopRunGuards");
    beginSamLoopRun = mod.beginSamLoopRun;
  });

  let beginSamLoopRun: typeof import("./samLoopRunGuards").beginSamLoopRun;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.countRunsCreatedSince.mockResolvedValue(0);
  });

  it("creates a run and starts the workflow", async () => {
    mocks.tryCreateRun.mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue(undefined);
    const workflow = { create } as unknown as Env["SAM_LOOP_WORKFLOW"];

    const result = await beginSamLoopRun({ ...input, workflow });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.runId).toEqual(expect.any(String));
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].params.loopId).toBe("loop_1");
  });

  it("returns already_running when an active run blocks insert", async () => {
    mocks.tryCreateRun.mockResolvedValue(false);
    mocks.getActiveRunForLoop.mockResolvedValue({
      id: "blocker",
      loopId: "loop_1",
      projectId: "project_1",
      status: "running",
      startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    mocks.getWorkflow.mockResolvedValue({
      status: async () => ({ status: "running" }),
    });
    const create = vi.fn();
    const workflow = { create } as unknown as Env["SAM_LOOP_WORKFLOW"];

    const result = await beginSamLoopRun({ ...input, workflow });
    expect(result).toEqual({
      ok: false,
      reason: "already_running",
      blockingRunId: "blocker",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("returns daily_cap without launching when another loop takes the last slot after the early check", async () => {
    mocks.countRunsCreatedSince
      .mockResolvedValueOnce(39)
      .mockResolvedValueOnce(40);
    mocks.tryCreateRun.mockResolvedValue(false);
    mocks.getActiveRunForLoop.mockResolvedValue(null);
    const create = vi.fn();
    const workflow = { create } as unknown as Env["SAM_LOOP_WORKFLOW"];

    const result = await beginSamLoopRun({ ...input, workflow });

    expect(result).toEqual({ ok: false, reason: "daily_cap" });
    expect(mocks.tryCreateRun).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    expect(mocks.updateRun).not.toHaveBeenCalled();
  });

  it("passes the configured cap and UTC date prefix into atomic admission", async () => {
    mockEnv.SAM_LOOP_DAILY_RUN_CAP = "100";
    mocks.tryCreateRun.mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue(undefined);
    const workflow = { create } as unknown as Env["SAM_LOOP_WORKFLOW"];
    const date = new Date().toISOString().slice(0, 10);

    const result = await beginSamLoopRun({ ...input, workflow });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an admitted run");
    expect(mocks.tryCreateRun).toHaveBeenCalledWith(
      { id: result.runId, loopId: input.loopId, projectId: input.projectId },
      { sinceDate: date, cap: 100 },
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps already_running when an active blocker caused the rejected insert", async () => {
    mocks.countRunsCreatedSince.mockResolvedValue(39);
    mocks.tryCreateRun.mockResolvedValue(false);
    mocks.getActiveRunForLoop.mockResolvedValue({
      id: "active_blocker",
      loopId: "loop_1",
      projectId: "project_1",
      status: "running",
      startedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });
    mocks.getWorkflow.mockResolvedValue({
      status: async () => ({ status: "running" }),
    });
    const create = vi.fn();
    const workflow = { create } as unknown as Env["SAM_LOOP_WORKFLOW"];

    await expect(beginSamLoopRun({ ...input, workflow })).resolves.toEqual({
      ok: false,
      reason: "already_running",
      blockingRunId: "active_blocker",
    });
    expect(create).not.toHaveBeenCalled();
    expect(mocks.updateRun).not.toHaveBeenCalled();
  });

  it("clears a stale blocker and retries once", async () => {
    mocks.tryCreateRun.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mocks.getActiveRunForLoop.mockResolvedValue({
      id: "stale",
      loopId: "loop_1",
      projectId: "project_1",
      status: "running",
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      createdAt: new Date(Date.now() - 120_000).toISOString(),
    });
    mocks.getWorkflow.mockRejectedValue(new Error("missing"));
    mocks.updateRun.mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue(undefined);
    const workflow = { create } as unknown as Env["SAM_LOOP_WORKFLOW"];

    const result = await beginSamLoopRun({ ...input, workflow });
    expect(result.ok).toBe(true);
    expect(mocks.updateRun).toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("refuses to create a run when today's count is at the cap", async () => {
    mocks.countRunsCreatedSince.mockResolvedValue(40);
    const create = vi.fn();
    const workflow = { create } as unknown as Env["SAM_LOOP_WORKFLOW"];

    const result = await beginSamLoopRun({ ...input, workflow });
    expect(result).toEqual({
      ok: false,
      reason: "daily_cap",
    });
    expect(mocks.tryCreateRun).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("uses SAM_LOOP_DAILY_RUN_CAP from env when set", async () => {
    mockEnv.SAM_LOOP_DAILY_RUN_CAP = "100";
    mocks.countRunsCreatedSince.mockResolvedValue(100);
    const create = vi.fn();
    const workflow = { create } as unknown as Env["SAM_LOOP_WORKFLOW"];

    const result = await beginSamLoopRun({ ...input, workflow });
    expect(result).toEqual({
      ok: false,
      reason: "daily_cap",
    });
    expect(mocks.tryCreateRun).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
