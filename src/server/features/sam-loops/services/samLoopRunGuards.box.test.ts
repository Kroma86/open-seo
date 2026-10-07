import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SamLoopRepository } from "../repositories/SamLoopRepository";
import { beginSamLoopRun } from "./samLoopRunGuards";

type RunRow = NonNullable<Awaited<ReturnType<typeof SamLoopRepository.getRunById>>>;

const mocks = vi.hoisted(() => ({
  countRunsCreatedSince: vi.fn<typeof SamLoopRepository.countRunsCreatedSince>(),
  tryCreateRun: vi.fn<typeof SamLoopRepository.tryCreateRun>(),
  getActiveRunForLoop: vi.fn<typeof SamLoopRepository.getActiveRunForLoop>(),
  getRunById: vi.fn<typeof SamLoopRepository.getRunById>(),
  updateRun: vi.fn<typeof SamLoopRepository.updateRun>(),
  getWorkflow: vi.fn(),
  createWorkflow: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { SAM_LOOP_WORKFLOW: { get: mocks.getWorkflow } },
}));
vi.mock("@/server/features/sam-loops/repositories/SamLoopRepository", () => ({
  SamLoopRepository: mocks,
}));

const now = new Date("2026-10-07T13:20:00.123Z");
const input = {
  workflow: { create: mocks.createWorkflow } as unknown as Env["SAM_LOOP_WORKFLOW"],
  loopId: "loop-1",
  projectId: "project-1",
  organizationId: "org-1",
  trigger: "manual" as const,
  workflowStartErrorMessage: "Failed to start Sam loop",
};

function boxRun(startedAt: string | null): RunRow {
  return {
    id: "box-run",
    loopId: input.loopId,
    projectId: input.projectId,
    status: "running",
    startedAt,
    createdAt: "2026-10-07T12:00:00.000Z",
    finishedAt: null,
    report: null,
    proposalsQueued: 0,
    stepsUsed: null,
    costNote: "box:grok-sub leased",
    error: null,
  };
}

describe("beginSamLoopRun with a box lease", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.countRunsCreatedSince.mockResolvedValue(0);
    mocks.tryCreateRun.mockResolvedValue(false);
    mocks.getWorkflow.mockRejectedValue(new Error("No Workflow for box run"));
    mocks.updateRun.mockResolvedValue(undefined);
    mocks.createWorkflow.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([0, 899_999, 900_000])(
    "preserves a %i ms box lease without checking for a Workflow",
    async (ageMs) => {
      mocks.getActiveRunForLoop.mockResolvedValue(
        boxRun(new Date(now.getTime() - ageMs).toISOString()),
      );

      expect(await beginSamLoopRun(input)).toEqual({
        ok: false,
        reason: "already_running",
        blockingRunId: "box-run",
      });
      expect(mocks.getWorkflow).not.toHaveBeenCalled();
      expect(mocks.updateRun).not.toHaveBeenCalled();
      expect(mocks.createWorkflow).not.toHaveBeenCalled();
    },
  );

  it("fails an expired lease with the exact reason and retries admission", async () => {
    mocks.getActiveRunForLoop.mockResolvedValue(
      boxRun(new Date(now.getTime() - 900_001).toISOString()),
    );
    mocks.tryCreateRun.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    expect(await beginSamLoopRun(input)).toMatchObject({ ok: true });
    expect(mocks.updateRun).toHaveBeenCalledWith("box-run", {
      status: "failed",
      error: "Box lease expired before a result was posted.",
      finishedAt: now.toISOString(),
    });
    expect(mocks.getWorkflow).not.toHaveBeenCalled();
    expect(mocks.createWorkflow).toHaveBeenCalledTimes(1);
  });

  it.each([null, "", "invalid-date"])(
    "leaves a lease with corrupt startedAt %j blocking without writes",
    async (startedAt) => {
      mocks.getActiveRunForLoop.mockResolvedValue(boxRun(startedAt));
      expect(await beginSamLoopRun(input)).toMatchObject({
        ok: false,
        reason: "already_running",
      });
      expect(mocks.updateRun).not.toHaveBeenCalled();
      expect(mocks.createWorkflow).not.toHaveBeenCalled();
      expect(mocks.getWorkflow).not.toHaveBeenCalled();
    },
  );
});
