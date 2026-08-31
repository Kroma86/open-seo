import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginSamLoopRun } from "./samLoopRunGuards";

const mocks = vi.hoisted(() => ({
  tryCreateRun: vi.fn(),
  getActiveRunForLoop: vi.fn(),
  getRunById: vi.fn(),
  updateRun: vi.fn(),
  getWorkflow: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    SAM_LOOP_WORKFLOW: { get: mocks.getWorkflow },
  },
}));
vi.mock(
  "@/server/features/sam-loops/repositories/SamLoopRepository",
  () => ({ SamLoopRepository: mocks }),
);

const input = {
  loopId: "loop_1",
  projectId: "project_1",
  organizationId: "org_1",
  trigger: "manual" as const,
  workflowStartErrorMessage: "failed",
};

describe("beginSamLoopRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("clears a stale blocker and retries once", async () => {
    mocks.tryCreateRun
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
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
});
