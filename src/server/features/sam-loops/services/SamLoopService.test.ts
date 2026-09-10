import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = vi.hoisted(
  () =>
    ({
      SAM_LOOP_WORKFLOW: {} as Env["SAM_LOOP_WORKFLOW"],
    }) as Env,
);

const mocks = vi.hoisted(() => ({
  getLoopById: vi.fn(),
  getLoopsForProject: vi.fn(),
  claimDueLoop: vi.fn(),
  updateLoop: vi.fn(),
  createLoop: vi.fn(),
  beginSamLoopRun: vi.fn(),
  ensureDefaultLoops: vi.fn(),
  countRunsCreatedSince: vi.fn(),
  getProjectById: vi.fn(),
  getProjectsByDomain: vi.fn(),
  getAgencyScoreInputsGlobal: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: mockEnv,
}));
vi.mock("@/server/features/sam-loops/repositories/SamLoopRepository", () => ({
  SamLoopRepository: {
    getLoopById: mocks.getLoopById,
    getLoopsForProject: mocks.getLoopsForProject,
    claimDueLoop: mocks.claimDueLoop,
    updateLoop: mocks.updateLoop,
    createLoop: mocks.createLoop,
    ensureDefaultLoops: mocks.ensureDefaultLoops,
    countRunsCreatedSince: mocks.countRunsCreatedSince,
  },
}));
vi.mock(
  "@/server/features/sam-loops/services/samLoopRunGuards",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/server/features/sam-loops/services/samLoopRunGuards")
      >();
    return {
      ...actual,
      beginSamLoopRun: mocks.beginSamLoopRun,
    };
  },
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectById: mocks.getProjectById,
    getProjectsByDomain: mocks.getProjectsByDomain,
  },
}));
vi.mock("@/server/features/agency/AgencyScoreInputsService", () => ({
  getAgencyScoreInputsGlobal: mocks.getAgencyScoreInputsGlobal,
}));

import { AppError } from "@/server/lib/errors";
import * as rankTracking from "@/shared/rank-tracking";
import {
  DEFAULT_SAM_LOOP_TEMPLATES,
  DOGFOOD_SAM_LOOP_TRIGGER_CAP,
  SAM_LOOP_DAILY_RUN_CAP,
  SAM_LOOP_DAILY_RUN_CAP_DEFAULT,
  computeNextSamLoopRunAt,
} from "@/shared/sam-loops";
import {
  createSamLoop,
  seedDefaultSamLoopsForProject,
  triggerSamLoop,
  triggerSamLoopsForDomain,
  updateSamLoop,
} from "./SamLoopService";

describe("createSamLoop", () => {
  it("rejects a custom loop carrying an approved template prompt verbatim", async () => {
    const templatePrompt = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (t) => t.sourceType === "custom",
    )?.customPrompt;
    expect(templatePrompt).toBeTruthy();
    await expect(
      createSamLoop({
        projectId: "project_1",
        name: "CTR opportunities",
        sourceType: "custom",
        customPrompt: templatePrompt,
        cadence: "monthly",
      } as never),
    ).rejects.toThrow(/approved template/);
    expect(mocks.createLoop).not.toHaveBeenCalled();
  });
});

describe("updateSamLoop", () => {
  const ownPromptLoop = {
    id: "loop_1",
    projectId: "project_1",
    name: "My loop",
    sourceType: "custom",
    customPrompt: "my own benign prompt",
    cadence: "weekly",
    isEnabled: true,
    nextRunAt: "2026-09-01T05:00:00.000Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T15:00:00.000Z"));
    // Deterministic base time-of-day for schedule seeds (random otherwise).
    vi.spyOn(rankTracking, "computeNextCheckAt").mockReturnValue(
      "2026-09-20T05:00:00.000Z",
    );
    mocks.updateLoop.mockResolvedValue({ id: "loop_1" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("rejects a prompt CHANGE onto an approved template prompt verbatim", async () => {
    const templatePrompt = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (t) => t.sourceType === "custom",
    )?.customPrompt;
    expect(templatePrompt).toBeTruthy();
    mocks.getLoopById.mockResolvedValue({ ...ownPromptLoop });

    await expect(
      updateSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        customPrompt: templatePrompt,
      } as never),
    ).rejects.toThrow(/approved template/);
    await expect(
      updateSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        customPrompt: templatePrompt,
      } as never),
    ).rejects.toThrow(/starter loops/);
    expect(mocks.updateLoop).not.toHaveBeenCalled();
  });

  it("lets a template-family loop swap to another approved template prompt", async () => {
    // The loop already lives in the template family: swapping among approved
    // template prompts grants nothing the starter-loops button doesn't, and
    // keeps a seeded loop repairable.
    const reviewWatch = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (t) => t.name === "Review watch",
    )?.customPrompt as string;
    const ctr = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (t) => t.name === "CTR opportunities",
    )?.customPrompt as string;
    mocks.getLoopById.mockResolvedValue({
      ...ownPromptLoop,
      name: "Review watch",
      customPrompt: reviewWatch,
    });

    await expect(
      updateSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        customPrompt: ctr,
      } as never),
    ).resolves.toBeDefined();
    expect(mocks.updateLoop).toHaveBeenCalledWith(
      "loop_1",
      "project_1",
      expect.objectContaining({ customPrompt: ctr }),
    );
  });

  it("lets a seeded loop round-trip its own template prompt unchanged", async () => {
    // Seeded loops legitimately HOLD a template prompt; updating an unrelated
    // field while the client re-submits the same prompt must not trip the rule.
    const templatePrompt = DEFAULT_SAM_LOOP_TEMPLATES.find(
      (t) => t.sourceType === "custom",
    )?.customPrompt as string;
    mocks.getLoopById.mockResolvedValue({
      ...ownPromptLoop,
      name: "CTR opportunities",
      customPrompt: templatePrompt,
      cadence: "monthly",
    });

    await expect(
      updateSamLoop({
        projectId: "project_1",
        loopId: "loop_1",
        isEnabled: false,
        customPrompt: templatePrompt,
      } as never),
    ).resolves.toBeDefined();
    expect(mocks.updateLoop).toHaveBeenCalled();
  });

  it("seeds the cadence re-anchor with the FINAL name on a simultaneous rename", async () => {
    mocks.getLoopById.mockResolvedValue({
      ...ownPromptLoop,
      name: "Old name",
    });

    await updateSamLoop({
      projectId: "project_1",
      loopId: "loop_1",
      cadence: "monthly",
      name: "New name",
    } as never);

    const scheduled = mocks.updateLoop.mock.calls[0]?.[2].nextRunAt as string;
    const finalNameSeed = computeNextSamLoopRunAt(
      "monthly",
      undefined,
      "project_1:New name",
    );
    const oldNameSeed = computeNextSamLoopRunAt(
      "monthly",
      undefined,
      "project_1:Old name",
    );
    // Precondition: the two seeds must land on different dates, else this
    // test cannot tell them apart — pick different names if it ever fails.
    expect(finalNameSeed).not.toBe(oldNameSeed);
    expect(scheduled).toBe(finalNameSeed);
  });

  it("seeds with projectId:name when enabling an unscheduled loop", async () => {
    mocks.getLoopById.mockResolvedValue({
      ...ownPromptLoop,
      name: "Review watch",
      isEnabled: false,
      nextRunAt: null,
    });

    await updateSamLoop({
      projectId: "project_1",
      loopId: "loop_1",
      isEnabled: true,
    } as never);

    const scheduled = mocks.updateLoop.mock.calls[0]?.[2].nextRunAt as string;
    expect(scheduled).toBe(
      computeNextSamLoopRunAt("weekly", undefined, "project_1:Review watch"),
    );
  });
});

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
    delete mockEnv.SAM_LOOP_DAILY_RUN_CAP;
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
      loopsEnabled: false,
    });
    mocks.getProjectsByDomain.mockResolvedValue([
      {
        id: "project_niceseo",
        name: "Default",
        domain: "niceseo.ai",
        organizationId: "org_1",
        loopsEnabled: false,
      },
    ]);
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
    mocks.getProjectsByDomain.mockResolvedValue([
      {
        id: "project_client",
        name: "Client",
        domain: "example.com",
        organizationId: "org_1",
        loopsEnabled: false,
      },
    ]);
    await expect(
      triggerSamLoopsForDomain({ domain: "example.com" }),
    ).resolves.toEqual({ ok: false, reason: "domain_not_allowed" });
    expect(mocks.getProjectsByDomain).toHaveBeenCalledWith("example.com");
    expect(mocks.getAgencyScoreInputsGlobal).not.toHaveBeenCalled();
    expect(mocks.getProjectById).not.toHaveBeenCalled();
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("returns domain_not_allowed for zero matching rows without further lookups", async () => {
    mocks.getProjectsByDomain.mockResolvedValue([]);
    await expect(
      triggerSamLoopsForDomain({ domain: "unknown.example" }),
    ).resolves.toEqual({ ok: false, reason: "domain_not_allowed" });
    expect(mocks.getProjectsByDomain).toHaveBeenCalledWith("unknown.example");
    expect(mocks.getAgencyScoreInputsGlobal).not.toHaveBeenCalled();
    expect(mocks.getProjectById).not.toHaveBeenCalled();
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
    expect(mocks.ensureDefaultLoops).not.toHaveBeenCalled();
    expect(mocks.countRunsCreatedSince).not.toHaveBeenCalled();
  });

  it("returns ambiguous_project_domain when matching rows disagree on the loops flag", async () => {
    mocks.getProjectsByDomain.mockResolvedValue([
      {
        id: "project_a",
        name: "A",
        domain: "example.com",
        organizationId: "org_1",
        loopsEnabled: true,
      },
      {
        id: "project_b",
        name: "B",
        domain: "example.com",
        organizationId: "org_1",
        loopsEnabled: false,
      },
    ]);
    await expect(
      triggerSamLoopsForDomain({ domain: "example.com" }),
    ).resolves.toEqual({
      ok: false,
      reason: "ambiguous_project_domain",
      count: 2,
    });
    expect(mocks.getAgencyScoreInputsGlobal).not.toHaveBeenCalled();
    expect(mocks.getProjectById).not.toHaveBeenCalled();
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("returns ambiguous_project_domain when two allowed projects share the domain (resolver CONFLICT)", async () => {
    mocks.getProjectsByDomain.mockResolvedValue([
      {
        id: "project_a",
        name: "A",
        domain: "example.com",
        organizationId: "org_1",
        loopsEnabled: true,
      },
      {
        id: "project_b",
        name: "B",
        domain: "example.com",
        organizationId: "org_2",
        loopsEnabled: true,
      },
    ]);
    mocks.getAgencyScoreInputsGlobal.mockRejectedValue(
      new AppError(
        "CONFLICT",
        "ambiguous_project_domain: 2 projects share example.com",
      ),
    );
    await expect(
      triggerSamLoopsForDomain({ domain: "example.com" }),
    ).resolves.toEqual({
      ok: false,
      reason: "ambiguous_project_domain",
      count: 2,
    });
    expect(mocks.getProjectById).not.toHaveBeenCalled();
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("allows a client domain when loopsEnabled is true", async () => {
    mocks.getAgencyScoreInputsGlobal.mockResolvedValue({
      projectId: "project_client",
    });
    mocks.getProjectsByDomain.mockResolvedValue([
      {
        id: "project_client",
        name: "Client",
        domain: "example.com",
        organizationId: "org_1",
        loopsEnabled: true,
      },
    ]);
    mocks.getProjectById.mockResolvedValue({
      id: "project_client",
      name: "Client",
      domain: "example.com",
      organizationId: "org_1",
      loopsEnabled: true,
    });
    mocks.getLoopsForProject.mockResolvedValue([]);
    const result = await triggerSamLoopsForDomain({ domain: "example.com" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projectId).toBe("project_client");
    expect(mocks.getAgencyScoreInputsGlobal).toHaveBeenCalledWith(
      "example.com",
    );
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("returns domain_not_allowed when the resolved run target is not in the pre-check set", async () => {
    mocks.getProjectsByDomain.mockResolvedValue([
      {
        id: "project_a",
        name: "A",
        domain: "example.com",
        organizationId: "org_1",
        loopsEnabled: true,
      },
    ]);
    mocks.getAgencyScoreInputsGlobal.mockResolvedValue({
      projectId: "project_b",
    });
    mocks.getProjectById.mockResolvedValue({
      id: "project_b",
      name: "B",
      domain: "example.com",
      organizationId: "org_1",
      loopsEnabled: true,
    });
    await expect(
      triggerSamLoopsForDomain({ domain: "example.com" }),
    ).resolves.toEqual({ ok: false, reason: "domain_not_allowed" });
    expect(mocks.getAgencyScoreInputsGlobal).toHaveBeenCalledWith(
      "example.com",
    );
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
    expect(mocks.ensureDefaultLoops).not.toHaveBeenCalled();
  });

  it("allows twa.studio and niceapp.ai through the house-domain gate", async () => {
    for (const domain of ["twa.studio", "niceapp.ai"] as const) {
      mocks.getProjectsByDomain.mockResolvedValue([
        {
          id: "project_niceseo",
          name: "Default",
          domain,
          organizationId: "org_1",
          loopsEnabled: false,
        },
      ]);
      mocks.getAgencyScoreInputsGlobal.mockResolvedValue({
        projectId: "project_niceseo",
      });
      const result = await triggerSamLoopsForDomain({ domain });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.projectId).toBe("project_niceseo");
      expect(mocks.getAgencyScoreInputsGlobal).toHaveBeenCalledWith(domain);
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

  describe("SAM_LOOP_DAILY_RUN_CAP", () => {
    it.each([
      { value: undefined, cap: SAM_LOOP_DAILY_RUN_CAP_DEFAULT, label: "unset" },
      { value: "100", cap: 100, label: "100" },
      { value: "0", cap: SAM_LOOP_DAILY_RUN_CAP_DEFAULT, label: "0" },
      { value: "abc", cap: SAM_LOOP_DAILY_RUN_CAP_DEFAULT, label: "abc" },
      { value: "-5", cap: SAM_LOOP_DAILY_RUN_CAP_DEFAULT, label: "-5" },
      { value: "1001", cap: SAM_LOOP_DAILY_RUN_CAP_DEFAULT, label: "1001" },
    ])(
      "$label returns daily_cap at configured limit",
      async ({ value, cap }) => {
        if (value !== undefined) {
          mockEnv.SAM_LOOP_DAILY_RUN_CAP = value;
        }
        mocks.countRunsCreatedSince.mockResolvedValue(cap);
        await expect(
          triggerSamLoopsForDomain({ domain: "niceseo.ai" }),
        ).resolves.toEqual({ ok: false, reason: "daily_cap" });
        expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
      },
    );

    it("caps started loops to remaining budget when cap is raised", async () => {
      mockEnv.SAM_LOOP_DAILY_RUN_CAP = "100";
      mocks.countRunsCreatedSince.mockResolvedValue(99);
      const result = await triggerSamLoopsForDomain({ domain: "niceseo.ai" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.capped).toBe(true);
      expect(result.results).toHaveLength(1);
      expect(mocks.beginSamLoopRun).toHaveBeenCalledTimes(1);
    });
  });

  it("returns domain_not_allowed when a house domain has zero matching rows", async () => {
    mocks.getProjectsByDomain.mockResolvedValue([]);
    await expect(
      triggerSamLoopsForDomain({ domain: "niceseo.ai" }),
    ).resolves.toEqual({ ok: false, reason: "domain_not_allowed" });
    expect(mocks.getAgencyScoreInputsGlobal).not.toHaveBeenCalled();
    expect(mocks.getProjectById).not.toHaveBeenCalled();
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
