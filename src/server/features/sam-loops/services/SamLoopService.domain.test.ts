import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SamLoopRunGuards from "@/server/features/sam-loops/services/samLoopRunGuards";
import { mockEnv, mocks } from "./SamLoopService.fixture";

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

import {
  DOGFOOD_SAM_LOOP_TRIGGER_CAP,
  SAM_LOOP_DAILY_RUN_CAP_DEFAULT,
} from "@/shared/sam-loops";
import { triggerSamLoopsForDomain } from "./SamLoopService";

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
    mocks.countRunsCreatedSince.mockResolvedValue(
      SAM_LOOP_DAILY_RUN_CAP_DEFAULT,
    );
    await expect(
      triggerSamLoopsForDomain({ domain: "niceseo.ai" }),
    ).resolves.toEqual({ ok: false, reason: "daily_cap" });
    expect(mocks.ensureDefaultLoops).not.toHaveBeenCalled();
    expect(mocks.beginSamLoopRun).not.toHaveBeenCalled();
  });

  it("caps started loops to remaining daily budget", async () => {
    mocks.countRunsCreatedSince.mockResolvedValue(
      SAM_LOOP_DAILY_RUN_CAP_DEFAULT - 1,
    );
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
