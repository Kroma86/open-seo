import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLoopById: vi.fn(),
  claimDueLoop: vi.fn(),
  updateLoop: vi.fn(),
  beginSamLoopRun: vi.fn(),
  ensureDefaultLoops: vi.fn(),
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
      ensureDefaultLoops: mocks.ensureDefaultLoops,
    },
  }),
);
vi.mock("@/server/features/sam-loops/services/samLoopRunGuards", () => ({
  beginSamLoopRun: mocks.beginSamLoopRun,
}));

import {
  seedDefaultSamLoopsForProject,
  triggerSamLoop,
} from "./SamLoopService";

describe("triggerSamLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T15:00:00.000Z"));
    mocks.beginSamLoopRun.mockResolvedValue({ ok: true, runId: "run_1" });
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("leaves a future nextRunAt untouched on manual trigger", async () => {
    const futureNext = "2026-09-07T00:00:00.000Z";
    mocks.getLoopById.mockResolvedValue({
      id: "loop_1",
      projectId: "project_1",
      isEnabled: true,
      cadence: "weekly",
      nextRunAt: futureNext,
    });

    await expect(
      triggerSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        organizationId: "org_1",
      }),
    ).resolves.toEqual({ ok: true, runId: "run_1" });

    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
    expect(mocks.updateLoop).not.toHaveBeenCalled();
    expect(mocks.beginSamLoopRun).toHaveBeenCalledWith(
      expect.objectContaining({
        loopId: "loop_1",
        trigger: "manual",
      }),
    );
  });

  it("advances a due nextRunAt from now (not the old anchor)", async () => {
    const dueNext = "2026-01-01T00:00:00.000Z";
    mocks.getLoopById.mockResolvedValue({
      id: "loop_1",
      projectId: "project_1",
      isEnabled: true,
      cadence: "weekly",
      nextRunAt: dueNext,
    });
    mocks.claimDueLoop.mockResolvedValue(true);

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
        projectId: "project_1",
        observedNextRunAt: dueNext,
      }),
    );
    const advanced = mocks.claimDueLoop.mock.calls[0]?.[0].nextRunAt as string;
    expect(new Date(advanced).getTime()).toBeGreaterThan(Date.now());
  });

  it("schedules from now when nextRunAt is missing", async () => {
    mocks.getLoopById.mockResolvedValue({
      id: "loop_1",
      projectId: "project_1",
      isEnabled: true,
      cadence: "weekly",
      nextRunAt: null,
    });

    await expect(
      triggerSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        organizationId: "org_1",
      }),
    ).resolves.toEqual({ ok: true, runId: "run_1" });

    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
    expect(mocks.updateLoop).toHaveBeenCalledWith(
      "loop_1",
      "project_1",
      expect.objectContaining({
        nextRunAt: expect.any(String),
      }),
    );
    const scheduled = mocks.updateLoop.mock.calls[0]?.[2].nextRunAt as string;
    expect(new Date(scheduled).getTime()).toBeGreaterThan(Date.now());
  });

  it("re-anchors from now when nextRunAt is unparsable", async () => {
    mocks.getLoopById.mockResolvedValue({
      id: "loop_1",
      projectId: "project_1",
      isEnabled: true,
      cadence: "weekly",
      nextRunAt: "not-a-date",
    });

    await expect(
      triggerSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        organizationId: "org_1",
      }),
    ).resolves.toEqual({ ok: true, runId: "run_1" });

    expect(mocks.claimDueLoop).not.toHaveBeenCalled();
    expect(mocks.updateLoop).toHaveBeenCalledWith(
      "loop_1",
      "project_1",
      expect.objectContaining({
        nextRunAt: expect.any(String),
      }),
    );
    const scheduled = mocks.updateLoop.mock.calls[0]?.[2].nextRunAt as string;
    expect(new Date(scheduled).getTime()).toBeGreaterThan(Date.now());
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

describe("seedDefaultSamLoopsForProject", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates default loops for a project", async () => {
    const created = [
      { id: "loop_a", name: "Site health" },
      { id: "loop_b", name: "Rank slippage" },
    ];
    mocks.ensureDefaultLoops.mockResolvedValue(created);

    await expect(seedDefaultSamLoopsForProject("project_1")).resolves.toEqual(
      created,
    );
    expect(mocks.ensureDefaultLoops).toHaveBeenCalledWith("project_1");
  });

  it("creates no duplicates when defaults already exist", async () => {
    mocks.ensureDefaultLoops.mockResolvedValueOnce([
      { id: "loop_a", name: "Site health" },
    ]);
    mocks.ensureDefaultLoops.mockResolvedValueOnce([]);

    await seedDefaultSamLoopsForProject("project_1");
    await expect(seedDefaultSamLoopsForProject("project_1")).resolves.toEqual(
      [],
    );
    expect(mocks.ensureDefaultLoops).toHaveBeenCalledTimes(2);
  });
});
