import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLoopById: vi.fn(),
  getLoopsForProject: vi.fn(),
  claimDueLoop: vi.fn(),
  updateLoop: vi.fn(),
  beginSamLoopRun: vi.fn(),
  ensureDefaultLoops: vi.fn(),
  countRunsCreatedSince: vi.fn(),
  getProjectById: vi.fn(),
  getAgencyScoreInputsGlobal: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: { SAM_LOOP_WORKFLOW: {} },
}));
vi.mock(
  "@/server/features/sam-loops/repositories/SamLoopRepository",
  () => ({
    SamLoopRepository: {
      getLoopById: mocks.getLoopById,
      getLoopsForProject: mocks.getLoopsForProject,
      claimDueLoop: mocks.claimDueLoop,
      updateLoop: mocks.updateLoop,
      ensureDefaultLoops: mocks.ensureDefaultLoops,
      countRunsCreatedSince: mocks.countRunsCreatedSince,
    },
  }),
);
vi.mock("@/server/features/sam-loops/services/samLoopRunGuards", () => ({
  beginSamLoopRun: mocks.beginSamLoopRun,
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectById: mocks.getProjectById,
  },
}));
vi.mock("@/server/features/agency/AgencyScoreInputsService", () => ({
  getAgencyScoreInputsGlobal: mocks.getAgencyScoreInputsGlobal,
}));

import {
  DOGFOOD_SAM_LOOP_TRIGGER_CAP,
  SAM_LOOP_DAILY_RUN_CAP,
} from "@/shared/sam-loops";
import {
  seedDefaultSamLoopsForProject,
  triggerSamLoop,
  triggerSamLoopsForDomain,
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

describe("triggerSamLoopsForDomain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T15:00:00.000Z"));
    mocks.beginSamLoopRun.mockResolvedValue({ ok: true, runId: "run_1" });
    mocks.ensureDefaultLoops.mockResolvedValue([]);
    mocks.countRunsCreatedSince.mockResolvedValue(0);
    mocks.getAgencyScoreInputsGlobal.mockResolvedValue({
      projectId: "project_niceseo",
    });
    mocks.getProjectById.mockResolvedValue({
      id: "project_niceseo",
      name: "Default",
      domain: "niceseo.ai",
      organizationId: "org_1",
    });
    const loopRows = [
      {
        id: "loop_health",
        name: "Site health",
        skillName: "site-health",
        isEnabled: true,
        cadence: "weekly",
        nextRunAt: "2026-09-08T00:00:00.000Z",
        projectId: "project_niceseo",
      },
      {
        id: "loop_rank",
        name: "Rank slippage",
        skillName: "rank-slippage",
        isEnabled: true,
        cadence: "daily",
        nextRunAt: "2026-09-02T00:00:00.000Z",
        projectId: "project_niceseo",
      },
      {
        id: "loop_off",
        name: "Paused",
        skillName: "page-growth",
        isEnabled: false,
        cadence: "monthly",
        nextRunAt: null,
        projectId: "project_niceseo",
      },
    ];
    mocks.getLoopsForProject.mockResolvedValue(loopRows);
    mocks.getLoopById.mockImplementation(async (id: string) => {
      return loopRows.find((loop) => loop.id === id) ?? null;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns domain_not_allowed for a domain outside the house allowlist", async () => {
    await expect(
      triggerSamLoopsForDomain({ domain: "example.com" }),
    ).resolves.toEqual({ ok: false, reason: "domain_not_allowed" });
    expect(mocks.getAgencyScoreInputsGlobal).not.toHaveBeenCalled();
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("allows twa.studio and niceapp.ai through the house-domain gate", async () => {
    for (const domain of ["twa.studio", "niceapp.ai"] as const) {
      mocks.getAgencyScoreInputsGlobal.mockResolvedValue({
        projectId: "project_niceseo",
      });
      const result = await triggerSamLoopsForDomain({ domain });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.projectId).toBe("project_niceseo");
    }
  });

  it("returns daily_cap when today's run count is at the cap", async () => {
    mocks.countRunsCreatedSince.mockResolvedValue(SAM_LOOP_DAILY_RUN_CAP);
    await expect(
      triggerSamLoopsForDomain({ domain: "niceseo.ai" }),
    ).resolves.toEqual({ ok: false, reason: "daily_cap" });
    expect(mocks.ensureDefaultLoops).not.toHaveBeenCalled();
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("caps started loops to remaining daily budget", async () => {
    mocks.countRunsCreatedSince.mockResolvedValue(SAM_LOOP_DAILY_RUN_CAP - 1);
    const result = await triggerSamLoopsForDomain({ domain: "niceseo.ai" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capped).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(1);
  });

  it("returns project_not_found when the domain has no project", async () => {
    mocks.getAgencyScoreInputsGlobal.mockResolvedValue({ projectId: null });
    await expect(
      triggerSamLoopsForDomain({ domain: "niceseo.ai" }),
    ).resolves.toEqual({ ok: false, reason: "project_not_found" });
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("starts every enabled loop and skips disabled", async () => {
    const result = await triggerSamLoopsForDomain({ domain: "niceseo.ai" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projectId).toBe("project_niceseo");
    expect(result.capped).toBe(false);
    expect(result.results.map((row) => row.loopName)).toEqual([
      "Site health",
      "Rank slippage",
    ]);
    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(2);
  });

  it("filters by skill or loop name", async () => {
    const result = await triggerSamLoopsForDomain({
      domain: "niceseo.ai",
      names: ["rank-slippage"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.loopName).toBe("Rank slippage");
    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(1);
  });

  it("does not substring-match loop names", async () => {
    const result = await triggerSamLoopsForDomain({
      domain: "niceseo.ai",
      names: ["health"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.results).toEqual([]);
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("caps a soak POST at the default template count", async () => {
    const extra = Array.from(
      { length: DOGFOOD_SAM_LOOP_TRIGGER_CAP + 1 },
      (_, index) => ({
        id: `loop_${index}`,
        name: `Loop ${index}`,
        skillName: `skill-${index}`,
        isEnabled: true,
        cadence: "weekly" as const,
        nextRunAt: "2026-09-08T00:00:00.000Z",
        projectId: "project_niceseo",
      }),
    );
    mocks.getLoopsForProject.mockResolvedValue(extra);
    mocks.getLoopById.mockImplementation(async (id: string) => {
      return extra.find((loop) => loop.id === id) ?? null;
    });

    const result = await triggerSamLoopsForDomain({ domain: "niceseo.ai" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.capped).toBe(true);
    expect(result.results).toHaveLength(DOGFOOD_SAM_LOOP_TRIGGER_CAP);
    expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(
      DOGFOOD_SAM_LOOP_TRIGGER_CAP,
    );
  });
});
