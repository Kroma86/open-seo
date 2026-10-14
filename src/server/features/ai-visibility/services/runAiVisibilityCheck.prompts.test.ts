/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access -- tests read stored run detail back with JSON.parse */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("stores zero prompt checks and null promptsWithBrand for google-only configs", async () => {
    mocks.explorePrompt.mockResolvedValue({
      prompt: "best tools",
      highlightBrand: "Acme",
      fetchedAt: new Date().toISOString(),
      results: [],
    });

    await runAiVisibilityCheck({
      configId: "config_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
    });

    expect(mocks.explorePrompt).not.toHaveBeenCalled();
    const completedUpdate = mocks.updateRunIfInFlight.mock.calls.find(
      (call) => call[1]?.status === "completed",
    );
    expect(completedUpdate?.[1]).toMatchObject({
      promptsChecked: 0,
      promptsWithBrand: null,
    });
  });

  it("counts promptsChecked only for definitive brandMentioned answers", async () => {
    mocks.getValidatedConfig.mockResolvedValue({
      ...config,
      platforms: '["chat_gpt","google"]',
    });
    mocks.getActivePromptsForConfig.mockResolvedValue([
      { id: "prompt_1", prompt: "answered" },
      { id: "prompt_2", prompt: "errored" },
    ]);
    mocks.explorePrompt
      .mockResolvedValueOnce({
        prompt: "answered",
        highlightBrand: "Acme",
        fetchedAt: new Date().toISOString(),
        results: [
          {
            model: "chat_gpt",
            status: "success",
            error: null,
            response: "Acme is great",
            citations: [],
            brandMentioned: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        prompt: "errored",
        highlightBrand: "Acme",
        fetchedAt: new Date().toISOString(),
        results: [
          {
            model: "chat_gpt",
            status: "error",
            error: "upstream failed",
            response: null,
            citations: [],
            brandMentioned: null,
          },
        ],
      })
      // the errored question is asked once more; that retry throws
      .mockRejectedValueOnce(new Error("retry unavailable"));

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
      promptsWithBrand: 1,
    });
    const detail = JSON.parse(String(completedUpdate?.[1]?.detail));
    expect(detail.promptsAttempted).toBe(2);
  });

  it("asks a failed question once more and keeps the first result when the retry fails or throws", async () => {
    mocks.getValidatedConfig.mockResolvedValue({
      ...config,
      platforms: '["chat_gpt","google"]',
    });
    mocks.getActivePromptsForConfig.mockResolvedValue([
      { id: "prompt_1", prompt: "flaky" },
      { id: "prompt_2", prompt: "dead" },
      { id: "prompt_3", prompt: "throws" },
    ]);
    const failed = {
      prompt: "x",
      highlightBrand: "Acme",
      fetchedAt: new Date().toISOString(),
      results: [
        {
          model: "chat_gpt",
          status: "error",
          error: "model temporarily unavailable",
          response: null,
          citations: [],
          brandMentioned: null,
        },
      ],
    };
    const answered = {
      ...failed,
      results: [
        {
          model: "chat_gpt",
          status: "success",
          error: null,
          response: "Acme is great",
          citations: [],
          brandMentioned: true,
        },
      ],
    };
    const failedAgain = { ...failed, fetchedAt: "2000-01-01T00:00:00.000Z" };
    // flaky: fail then succeed; dead: fail then fail again; throws: fail then the retry throws
    mocks.explorePrompt
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(answered)
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(failedAgain)
      .mockResolvedValueOnce(failed)
      .mockRejectedValueOnce(new Error("retry unavailable"));

    await runAiVisibilityCheck({
      configId: "config_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
    });

    expect(mocks.explorePrompt).toHaveBeenCalledTimes(6);
    const completedUpdate = mocks.updateRunIfInFlight.mock.calls.find(
      (call) => call[1]?.status === "completed",
    );
    expect(completedUpdate?.[1]).toMatchObject({
      promptsChecked: 1,
      promptsWithBrand: 1,
    });
    const detail = JSON.parse(String(completedUpdate?.[1]?.detail));
    expect(detail.promptsAttempted).toBe(3);
    expect(detail.prompts[1].fetchedAt).toBe(failed.fetchedAt);
    expect(String(completedUpdate?.[1]?.costNote)).toContain(
      "6 prompt check(s)",
    );
  });

  it("does not write results when the run was reclaimed before completion", async () => {
    mocks.updateRunIfInFlight.mockResolvedValue(false);

    await runAiVisibilityCheck({
      configId: "config_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
    });

    expect(mocks.updateConfig).not.toHaveBeenCalled();
  });

  it("stores null promptsWithBrand when every explorer call fails", async () => {
    mocks.getValidatedConfig.mockResolvedValue({
      ...config,
      platforms: '["chat_gpt","google"]',
    });
    mocks.explorePrompt.mockResolvedValue({
      prompt: "best tools",
      highlightBrand: "Acme",
      fetchedAt: new Date().toISOString(),
      results: [
        {
          model: "chat_gpt",
          status: "error",
          error: "upstream failed",
          response: null,
          citations: [],
          brandMentioned: null,
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
      promptsChecked: 0,
      promptsWithBrand: null,
    });
  });

  it("labels fresh brand lookup costs as uncertain while using cache signal for hits", async () => {
    mocks.getValidatedConfig.mockResolvedValue({
      ...config,
      platforms: '["chat_gpt","google"]',
    });
    mocks.getBrandLookup.mockResolvedValue({
      query: "Acme",
      resolvedTarget: "acme.com",
      fetchedAt: "2026-01-01T00:00:00.000Z",
      hasData: true,
      perPlatform: [
        { platform: "google", mentions: 5, impressions: null },
        { platform: "chat_gpt", mentions: 3, impressions: null },
      ],
      topPages: [],
      shareOfVoice: null,
    });
    mocks.explorePrompt.mockResolvedValue({
      prompt: "best tools",
      highlightBrand: "Acme",
      fetchedAt: new Date().toISOString(),
      results: [
        {
          model: "chat_gpt",
          status: "success",
          error: null,
          response: "Acme is great",
          citations: [],
          brandMentioned: true,
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
    // No cache/paid signal exists on getBrandLookup, so the label never
    // asserts either direction from latency.
    expect(completedUpdate?.[1]?.costNote).toBe(
      "full sweep (1 engine(s): chat_gpt); brand lookup cache/paid uncertain; 1 prompt check(s): cache/paid uncertain",
    );
  });

  it("never labels a fresh brand lookup as paid from latency alone", async () => {
    mocks.getValidatedConfig.mockResolvedValue({
      ...config,
      platforms: '["chat_gpt","google"]',
    });
    mocks.getBrandLookup.mockResolvedValue({
      query: "Acme",
      resolvedTarget: "acme.com",
      fetchedAt: new Date().toISOString(),
      hasData: true,
      perPlatform: [
        { platform: "google", mentions: 5, impressions: null },
        { platform: "chat_gpt", mentions: 3, impressions: null },
      ],
      topPages: [],
      shareOfVoice: null,
    });
    mocks.explorePrompt.mockResolvedValue({
      prompt: "best tools",
      highlightBrand: "Acme",
      fetchedAt: new Date().toISOString(),
      results: [
        {
          model: "chat_gpt",
          status: "success",
          error: null,
          response: "Acme is great",
          citations: [],
          brandMentioned: true,
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
    expect(completedUpdate?.[1]?.costNote).toBe(
      "full sweep (1 engine(s): chat_gpt); brand lookup cache/paid uncertain; 1 prompt check(s): cache/paid uncertain",
    );
  });
});
