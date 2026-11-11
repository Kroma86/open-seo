/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- tests read stored run detail back with JSON.parse */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { extractPromptResults } from "./aiVisibilityPromptResults";
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

  it("uses a literal name without Jev, and does not count Hunter Exteriors", async () => {
    mocks.getValidatedConfig.mockResolvedValue({
      ...config,
      brand: "Jace-Xteriors",
      platforms: '["chat_gpt"]',
    });
    mocks.getProjectForOrganization.mockResolvedValue({
      locationCode: 2124,
      languageCode: "en",
      domain: "jacexteriors.net",
    });
    mocks.getActivePromptsForConfig.mockResolvedValue([
      { id: "prompt_literal", prompt: "where" },
      { id: "prompt_near", prompt: "who else" },
    ]);
    mocks.askJevNamed.mockResolvedValue({ p: 0.04, costUsd: 0.00004 });
    mocks.explorePrompt
      .mockResolvedValueOnce({
        prompt: "where",
        highlightBrand: "Jace-Xteriors",
        fetchedAt: new Date().toISOString(),
        results: [
          {
            status: "success",
            model: "chat_gpt",
            modelName: "gpt",
            text: "Jace\u2011Xteriors serves Lumby.",
            citations: [],
            fanOutQueries: [],
            brandMentioned: false,
            outputTokens: 10,
            webSearch: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        prompt: "who else",
        highlightBrand: "Jace-Xteriors",
        fetchedAt: new Date().toISOString(),
        results: [
          {
            status: "success",
            model: "chat_gpt",
            modelName: "gpt",
            text: "Hunter Exteriors lists Lumby. https://jacexteriors.net/",
            citations: [],
            fanOutQueries: [],
            brandMentioned: true,
            outputTokens: 10,
            webSearch: true,
          },
        ],
      });

    await runAiVisibilityCheck({
      configId: "config_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
    });

    expect(mocks.askJevNamed).toHaveBeenCalledTimes(1);
    const completedUpdate = mocks.updateRunIfInFlight.mock.calls.find(
      (call) => call[1]?.status === "completed",
    );
    expect(completedUpdate?.[1]).toMatchObject({
      promptsChecked: 2,
      promptsWithBrand: 1,
    });
    const detail = JSON.parse(String(completedUpdate?.[1]?.detail));
    expect(detail.prompts[0].results[0]).toMatchObject({
      brandMentioned: true,
      nameSource: "literal",
      nameProbability: null,
    });
    expect(detail.prompts[1].results[0]).toMatchObject({
      brandMentioned: false,
      nameSource: "jev",
      nameProbability: 0.04,
      nameUnsure: false,
    });
    expect(detail.jevSpendUsd).toBeCloseTo(0.00004);
  });

  it("does not count a citation-only match when Jev fails", async () => {
    mocks.getValidatedConfig.mockResolvedValue({
      ...config,
      brand: "TWA Studio",
      platforms: '["chat_gpt"]',
    });
    mocks.getActivePromptsForConfig.mockResolvedValue([
      { id: "p1", prompt: "who" },
    ]);
    mocks.askJevNamed.mockRejectedValue(new Error("jev_timeout"));
    mocks.explorePrompt.mockResolvedValueOnce({
      prompt: "who",
      highlightBrand: "TWA Studio",
      fetchedAt: new Date().toISOString(),
      results: [
        {
          status: "success",
          model: "chat_gpt",
          modelName: "gpt",
          text: "See this agency for marketing help.",
          citations: [{ url: "https://twa.studio/about", title: "About" }],
          fanOutQueries: [],
          brandMentioned: true,
          outputTokens: 10,
          webSearch: true,
        },
      ],
    });

    await runAiVisibilityCheck({
      configId: "config_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
    });

    const completedUpdate = mocks.updateRunIfInFlight.mock.calls.find(
      (call) => call[1]?.status === "completed",
    );
    expect(completedUpdate?.[1]).toMatchObject({
      promptsChecked: 1,
      promptsWithBrand: 0,
    });
    const summary = extractPromptResults(String(completedUpdate?.[1]?.detail), {
      runId: "run_1",
      completedAt: null,
      promptSetVersion: 1,
    }).summary;
    expect(summary).toEqual({
      questionsChecked: 1,
      questionsWithBrand: 0,
      namedByModel: { chat_gpt: 0 },
    });
    const detail = JSON.parse(String(completedUpdate?.[1]?.detail));
    expect(detail.prompts[0].results[0]).toMatchObject({
      brandMentioned: false,
      nameUnsure: true,
      nameSource: "matcher_fallback",
      nameProbability: null,
    });
  });
});
