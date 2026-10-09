import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SamLoopRunGuards from "@/server/features/sam-loops/services/samLoopRunGuards";
import {
  firstUpdatedNextRunAt,
  mockEnv,
  mocks,
  requireString,
} from "./SamLoopService.fixture";

vi.mock("cloudflare:workers", async () => ({
  env: (await import("./SamLoopService.fixture")).mockEnv,
}));
vi.mock(
  "@/server/features/sam-loops/repositories/SamLoopRepository",
  async () =>
    (await import("./SamLoopService.fixture")).samLoopRepositoryModule,
);
vi.mock(
  "@/server/features/sam-loops/services/samLoopRunGuards",
  async (importOriginal) => ({
    ...(await importOriginal<typeof SamLoopRunGuards>()),
    beginSamLoopRun: (await import("./SamLoopService.fixture")).mocks
      .beginSamLoopRun,
  }),
);
vi.mock(
  "@/server/features/projects/repositories/ProjectRepository",
  async () =>
    (await import("./SamLoopService.fixture")).projectRepositoryModule,
);
vi.mock(
  "@/server/features/agency/AgencyScoreInputsService",
  async () =>
    (await import("./SamLoopService.fixture")).agencyScoreInputsModule,
);

import { triggerSamLoop } from "./SamLoopService";

const anyString: unknown = expect.any(String);

describe("triggerSamLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete mockEnv.SAM_LOOP_DAILY_RUN_CAP;
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
    const advanced = requireString(
      mocks.claimDueLoop.mock.calls[0]?.[0].nextRunAt,
      "claimed nextRunAt",
    );
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
        nextRunAt: anyString,
      }),
    );
    const scheduled = firstUpdatedNextRunAt();
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
        nextRunAt: anyString,
      }),
    );
    const scheduled = firstUpdatedNextRunAt();
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
