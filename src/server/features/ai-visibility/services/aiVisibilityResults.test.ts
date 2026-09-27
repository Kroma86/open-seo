import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAgencyExportBlock,
  getLatestResults,
  getTrend,
} from "./aiVisibilityResults";

const mocks = vi.hoisted(() => ({
  getConfigsForProject: vi.fn(),
  getConfigById: vi.fn(),
  getPromptsForConfig: vi.fn(),
  getLatestCompletedRunForConfig: vi.fn(),
  getCompletedRunsForConfig: vi.fn(),
}));

const projectMocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
}));

vi.mock(
  "@/server/features/ai-visibility/repositories/AiVisibilityRepository",
  () => ({ AiVisibilityRepository: mocks }),
);

vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: projectMocks,
}));

const config = {
  id: "config_1",
  projectId: "project_1",
  brand: "Acme",
  competitors: "[]",
  platforms: '["chat_gpt","google"]',
  scheduleInterval: "weekly" as const,
  promptSetVersion: 2,
  isActive: true,
  lastRunAt: null,
  nextRunAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("aiVisibilityResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfigsForProject.mockResolvedValue([config]);
    mocks.getConfigById.mockResolvedValue(config);
    mocks.getPromptsForConfig.mockResolvedValue([]);
    projectMocks.getProjectById.mockResolvedValue({ domain: "acme.com" });
  });

  it("refuses to pick a config silently when the project has more than one", async () => {
    mocks.getConfigsForProject.mockResolvedValue([
      config,
      { ...config, id: "config_2", brand: "Oopsie Daisy" },
    ]);
    await expect(getLatestResults("project_1")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("pass configId"),
    });
    await expect(getTrend("project_1")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(mocks.getLatestCompletedRunForConfig).not.toHaveBeenCalled();
  });

  it("agency export block reports not-measured (null) for a multi-config project", async () => {
    mocks.getConfigsForProject.mockResolvedValue([
      config,
      { ...config, id: "config_2", brand: "Oopsie Daisy" },
    ]);
    await expect(getAgencyExportBlock("project_1")).resolves.toBeNull();
    expect(mocks.getLatestCompletedRunForConfig).not.toHaveBeenCalled();
  });

  it("still resolves by explicit configId when the project has more than one", async () => {
    mocks.getConfigsForProject.mockResolvedValue([
      config,
      { ...config, id: "config_2", brand: "Oopsie Daisy" },
    ]);
    mocks.getLatestCompletedRunForConfig.mockResolvedValue(null);
    await expect(
      getLatestResults("project_1", "config_1"),
    ).resolves.toMatchObject({ measured: false });
    expect(mocks.getConfigById).toHaveBeenCalledWith({
      configId: "config_1",
      projectId: "project_1",
    });
  });

  it("returns a not-measured shape without zero-filled numbers", async () => {
    mocks.getLatestCompletedRunForConfig.mockResolvedValue(null);

    await expect(getLatestResults("project_1")).resolves.toEqual({
      measured: false,
      source: "dataforseo_llm_mentions",
      fetchedAt: null,
      config: expect.objectContaining({ id: "config_1" }),
      latestRun: null,
    });
  });

  it("computes deltas only for the same promptSetVersion", async () => {
    mocks.getCompletedRunsForConfig.mockResolvedValue([
      {
        id: "run_2",
        finishedAt: "2026-02-02T00:00:00.000Z",
        promptSetVersion: 2,
        totalMentions: 12,
        shareOfVoicePct: 20,
        promptsWithBrand: 3,
        promptsChecked: 5,
      },
      {
        id: "run_1",
        finishedAt: "2026-02-01T00:00:00.000Z",
        promptSetVersion: 1,
        totalMentions: 10,
        shareOfVoicePct: 15,
        promptsWithBrand: 2,
        promptsChecked: 5,
      },
    ]);

    const trend = await getTrend("project_1");
    expect(trend.runs[0]?.delta).toBeNull();
    expect(trend.runs[1]?.delta).toBeNull();
  });

  it("computes deltas between consecutive same-version runs", async () => {
    mocks.getCompletedRunsForConfig.mockResolvedValue([
      {
        id: "run_2",
        finishedAt: "2026-02-02T00:00:00.000Z",
        promptSetVersion: 2,
        totalMentions: 12,
        shareOfVoicePct: 20,
        promptsWithBrand: 3,
        promptsChecked: 5,
      },
      {
        id: "run_1",
        finishedAt: "2026-02-01T00:00:00.000Z",
        promptSetVersion: 2,
        totalMentions: 10,
        shareOfVoicePct: 15,
        promptsWithBrand: 2,
        promptsChecked: 5,
      },
    ]);

    const trend = await getTrend("project_1");
    expect(trend.runs[0]?.delta).toEqual({
      totalMentions: 2,
      shareOfVoicePct: 5,
      promptsWithBrand: 1,
      promptsChecked: 0,
      realMentions: null,
      ownSiteCitationCount: null,
      ownSiteCitationSharePct: null,
    });
  });

  it("reports own-site citation count from stored links, not the loose mentions total", async () => {
    mocks.getLatestCompletedRunForConfig.mockResolvedValue({
      id: "run_1",
      status: "completed",
      finishedAt: "2026-02-02T00:00:00.000Z",
      totalMentions: 11880,
      shareOfVoicePct: null,
      promptsWithBrand: 6,
      promptsChecked: 2,
      promptSetVersion: 2,
      costNote: null,
      error: null,
      detail: JSON.stringify({
        prompts: [
          {
            results: [
              {
                status: "success",
                citations: [{ domain: "www.acme.com" }],
              },
            ],
          },
          {
            results: [
              {
                status: "success",
                citations: [{ domain: "unrelated.example" }],
              },
            ],
          },
        ],
      }),
    });

    const latest = await getLatestResults("project_1");
    expect(latest.latestRun).toMatchObject({
      totalMentions: 11880,
      realMentions: null,
      ownSiteCitationCount: 1,
      ownSiteCitationSharePct: 50,
      ownSiteCitationsChecked: 2,
    });
    expect(projectMocks.getProjectById).toHaveBeenCalledWith("project_1");
  });

  it("reads the stored real mention count without calling out", async () => {
    mocks.getLatestCompletedRunForConfig.mockResolvedValue({
      id: "run_1",
      status: "completed",
      finishedAt: "2026-09-23T00:00:00.000Z",
      totalMentions: 184,
      shareOfVoicePct: null,
      promptsWithBrand: 1,
      promptsChecked: 1,
      promptSetVersion: 2,
      costNote: "jev 2 call(s) $0.0000",
      error: null,
      detail: JSON.stringify({
        brandLookup: {
          totalMentions: 184,
          real_mentions: 3,
          topCitedSources: [
            { url: "https://ssocc.ca/a", p: 0.9 },
            { url: "https://ssocc.ca/b", p: 0.8 },
            { url: "https://cinnamoncounselling.ca/sex-therapy", p: 0.7 },
          ],
        },
      }),
    });

    const latest = await getLatestResults("project_1");
    expect(latest.latestRun?.realMentions).toBe(3);
    expect(latest.latestRun?.totalMentions).toBe(184);
  });
});
