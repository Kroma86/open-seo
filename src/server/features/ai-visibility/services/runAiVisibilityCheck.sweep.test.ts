import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFullSweepWeek } from "./aiVisibilitySweep";
import type { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { runAiVisibilityCheck } from "./runAiVisibilityCheck";

const mocks = vi.hoisted(() => ({
  getValidatedConfig: vi.fn(),
  requireAiVisibilityAccess: vi.fn(),
  getProjectForOrganization: vi.fn(),
  getActivePromptsForConfig: vi.fn(),
  getCompletedRunsForConfig: vi.fn(),
  updateRun: vi.fn(),
  updateRunIfInFlight:
    vi.fn<typeof AiVisibilityRepository.updateRunIfInFlight>(),
  updateConfig: vi.fn(),
  beginAiVisibilityRun: vi.fn(),
  failRunIfActive: vi.fn(),
  getBrandLookup: vi.fn(),
  explorePrompt: vi.fn(),
  reclaimStaleRunsForConfig: vi.fn(),
  askJevNamed: vi.fn(),
}));

vi.mock(
  "@/server/features/ai-visibility/services/AiVisibilityManagementService",
  () => ({
    AiVisibilityManagementService: {
      getValidatedConfig: mocks.getValidatedConfig,
      requireAiVisibilityAccess: mocks.requireAiVisibilityAccess,
    },
  }),
);
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/ai-visibility/repositories/AiVisibilityRepository",
  () => ({
    AiVisibilityRepository: {
      getActivePromptsForConfig: mocks.getActivePromptsForConfig,
      getCompletedRunsForConfig: mocks.getCompletedRunsForConfig,
      updateRun: mocks.updateRun,
      updateRunIfInFlight: mocks.updateRunIfInFlight,
      updateConfig: mocks.updateConfig,
    },
  }),
);
vi.mock("./aiVisibilityRunGuards", () => ({
  beginAiVisibilityRun: mocks.beginAiVisibilityRun,
  failRunIfActive: mocks.failRunIfActive,
}));
vi.mock("@/server/features/ai-search/services/brandLookup", () => ({
  getBrandLookup: mocks.getBrandLookup,
}));
vi.mock("@/server/features/ai-search/services/promptExplorer", () => ({
  explorePrompt: mocks.explorePrompt,
}));
vi.mock("./aiVisibilityReconciler", () => ({
  reclaimStaleRunsForConfig: mocks.reclaimStaleRunsForConfig,
}));
vi.mock("./jevBrandName", () => ({
  askJevNamed: mocks.askJevNamed,
}));

const billingCustomer = {
  userId: "user_1",
  userEmail: "user@test.com",
  organizationId: "org_1",
  projectId: "project_1",
};

const config = {
  id: "config_1",
  projectId: "project_1",
  brand: "Acme",
  competitors: "[]",
  platforms: '["google"]',
  scheduleInterval: "weekly" as const,
  promptSetVersion: 1,
  isActive: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function weekFor(configId: string, full: boolean): Date {
  const start = Date.parse("2026-06-01T00:00:00.000Z");
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(start + i * WEEK_MS);
    if (isFullSweepWeek(configId, candidate) === full) return candidate;
  }
  throw new Error(`no ${full ? "full" : "pulse"} week for ${configId}`);
}

function freshLookup(now: Date) {
  return {
    fetchedAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    totalMentions: 9,
    partialMentions: true,
    shareOfVoicePct: 12.5,
    perPlatform: [{ platform: "google", mentions: 9, impressions: null }],
    topCitedSources: [
      { url: "https://example.com/a", title: "A", domain: "example.com" },
    ],
  };
}

function completedCall() {
  return mocks.updateRunIfInFlight.mock.calls.find(
    (call) => call[1]?.status === "completed",
  );
}

function completedDetail(): {
  sweep?: string;
  models?: string[];
  brandLookup?: Record<string, unknown>;
} {
  const completed = completedCall();
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stored run detail read back with JSON.parse
  return JSON.parse(String(completed?.[1]?.detail)) as {
    sweep?: string;
    models?: string[];
    brandLookup?: Record<string, unknown>;
  };
}

describe("runAiVisibilityCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAiVisibilityAccess.mockResolvedValue(undefined);
    mocks.getValidatedConfig.mockResolvedValue(config);
    mocks.getProjectForOrganization.mockResolvedValue({
      locationCode: 2840,
      languageCode: "en",
    });
    mocks.beginAiVisibilityRun.mockResolvedValue({ ok: true, runId: "run_1" });
    mocks.updateRunIfInFlight.mockResolvedValue(true);
    mocks.getBrandLookup.mockResolvedValue({
      query: "Acme",
      resolvedTarget: "acme.com",
      fetchedAt: new Date().toISOString(),
      hasData: true,
      perPlatform: [{ platform: "google", mentions: 5, impressions: null }],
      topPages: [],
      shareOfVoice: null,
    });
    mocks.getActivePromptsForConfig.mockResolvedValue([
      { id: "prompt_1", prompt: "best tools" },
    ]);
    mocks.getCompletedRunsForConfig.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses the brand lookup on a scheduled pulse week", async () => {
    const now = weekFor("config_1", false);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const stored = freshLookup(now);
    mocks.getValidatedConfig.mockResolvedValue({
      ...config,
      platforms: '["chat_gpt","google"]',
    });
    mocks.getCompletedRunsForConfig.mockResolvedValue([
      { id: "prior_1", detail: JSON.stringify({ brandLookup: stored }) },
    ]);
    mocks.explorePrompt.mockResolvedValue({
      prompt: "best tools",
      highlightBrand: "Acme",
      fetchedAt: stored.fetchedAt,
      results: [
        { status: "success", model: "perplexity", brandMentioned: true },
      ],
    });

    await runAiVisibilityCheck({
      configId: "config_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "scheduled",
    });

    expect(mocks.getBrandLookup).not.toHaveBeenCalled();
    expect(mocks.getCompletedRunsForConfig).toHaveBeenCalledWith("config_1", 8);
    expect(mocks.explorePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        models: ["perplexity"],
        modelNameOverrides: { perplexity: "sonar" },
      }),
      billingCustomer,
      { skipCacheRead: true },
    );
    const completed = completedCall();
    expect(completed?.[1]).toMatchObject({
      totalMentions: 9,
      shareOfVoicePct: 12.5,
    });
    const costNote = String(completed?.[1]?.costNote);
    expect(costNote).toMatch(
      /^pulse \(perplexity sonar\); brand lookup reused from run prior_1; /,
    );
    expect(costNote).not.toContain("brand lookup cache/paid uncertain");
    const detail = completedDetail();
    expect(detail.sweep).toBe("pulse");
    expect(detail.models).toEqual(["perplexity"]);
    expect(detail.brandLookup).toMatchObject({
      reused: true,
      reusedFromRunId: "prior_1",
      fetchedAt: stored.fetchedAt,
      partialMentions: true,
      perPlatform: stored.perPlatform,
      topCitedSources: stored.topCitedSources,
    });
  });

  it("asks no prompt engine on a pulse when the config has none", async () => {
    const now = weekFor("config_1", false);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.getCompletedRunsForConfig.mockResolvedValue([
      {
        id: "prior_1",
        detail: JSON.stringify({ brandLookup: freshLookup(now) }),
      },
    ]);

    await runAiVisibilityCheck({
      configId: "config_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "scheduled",
    });

    expect(mocks.getBrandLookup).not.toHaveBeenCalled();
    expect(mocks.explorePrompt).not.toHaveBeenCalled();
    expect(completedDetail()).toMatchObject({ sweep: "pulse", models: [] });
    expect(completedCall()?.[1]?.costNote).toBe(
      "pulse (no prompt engines); brand lookup reused from run prior_1",
    );
  });

  it.each([
    ["a manual trigger even off the slot week", "manual", false],
    ["the config's slot week", "scheduled", true],
  ] as const)("runs a full sweep for %s", async (_label, trigger, slotWeek) => {
    const now = weekFor("config_1", slotWeek);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.getCompletedRunsForConfig.mockResolvedValue([
      {
        id: "prior_1",
        detail: JSON.stringify({ brandLookup: freshLookup(now) }),
      },
    ]);

    await runAiVisibilityCheck({
      configId: "config_1",
      projectId: "project_1",
      billingCustomer,
      trigger,
    });

    expect(mocks.getBrandLookup).toHaveBeenCalled();
    expect(completedDetail()).toMatchObject({ sweep: "full" });
    const completed = completedCall();
    expect(String(completed?.[1]?.costNote)).toMatch(
      /^full sweep \(\d+ engine\(s\): [a-z_, ]*\); brand lookup cache\/paid uncertain/,
    );
  });

  it.each([
    [
      "has no prior runs",
      () => mocks.getCompletedRunsForConfig.mockResolvedValue([]),
    ],
    [
      "cannot load prior runs",
      () =>
        mocks.getCompletedRunsForConfig.mockRejectedValue(new Error("db down")),
    ],
  ])(
    "runs a full sweep when a scheduled config %s",
    async (_label, arrange) => {
      vi.useFakeTimers();
      vi.setSystemTime(weekFor("config_1", false));
      arrange();

      await runAiVisibilityCheck({
        configId: "config_1",
        projectId: "project_1",
        billingCustomer,
        trigger: "scheduled",
      });

      expect(mocks.getBrandLookup).toHaveBeenCalled();
      expect(completedDetail()).toMatchObject({ sweep: "full" });
    },
  );
});
