import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLoopById: vi.fn(),
  claimDueLoop: vi.fn(),
  updateLoop: vi.fn(),
  beginSamLoopRun: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { SAM_LOOP_WORKFLOW: {} },
}));
vi.mock(
  "@/server/features/sam-loops/repositories/SamLoopRepository",
  () => ({
    SamLoopRepository: {
      getLoopById: mocks.getLoopById,
      claimDueLoop: mocks.claimDueLoop,
      updateLoop: mocks.updateLoop,
    },
  }),
);
vi.mock("@/server/features/sam-loops/services/samLoopRunGuards", () => ({
  beginSamLoopRun: mocks.beginSamLoopRun,
}));

import { triggerSamLoop } from "./SamLoopService";

describe("triggerSamLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not_found when the loop is missing", async () => {
    mocks.getLoopById.mockResolvedValue(null);
    await expect(
      triggerSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        organizationId: "org_1",
      }),
    ).resolves.toEqual({ ok: false, reason: "not_found" });
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("returns disabled and never starts a workflow", async () => {
    mocks.getLoopById.mockResolvedValue({
      id: "loop_1",
      projectId: "project_1",
      isEnabled: false,
      cadence: "weekly",
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      triggerSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        organizationId: "org_1",
      }),
    ).resolves.toEqual({ ok: false, reason: "disabled" });
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
  });

  it("advances nextRunAt and starts the workflow for an enabled loop", async () => {
    mocks.getLoopById.mockResolvedValue({
      id: "loop_1",
      projectId: "project_1",
      isEnabled: true,
      cadence: "weekly",
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    mocks.claimDueLoop.mockResolvedValue(true);
    mocks.beginSamLoopRun.mockResolvedValue({ ok: true, runId: "run_1" });

    await expect(
      triggerSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        organizationId: "org_1",
      }),
    ).resolves.toEqual({ ok: true, runId: "run_1" });

    expect(mocks.claimDueLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop_1",
        observedNextRunAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(mocks.beginSamLoopRun).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop_1",
        trigger: "manual",
      }),
    );
  });

  it("logs when the manual claim CAS loses (best-effort) and still starts", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.getLoopById.mockResolvedValue({
      id: "loop_1",
      projectId: "project_1",
      isEnabled: true,
      cadence: "weekly",
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    mocks.claimDueLoop.mockResolvedValue(false);
    mocks.beginSamLoopRun.mockResolvedValue({ ok: true, runId: "run_1" });

    await expect(
      triggerSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        organizationId: "org_1",
      }),
    ).resolves.toEqual({ ok: true, runId: "run_1" });

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("manual trigger claim lost (best-effort)"),
    );
    log.mockRestore();
  });
});
