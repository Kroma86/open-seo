import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAgencyExportBlock,
  getLatestResults,
  getPromptResults,
  getTrend,
} from "./aiVisibilityResults";

const mocks = vi.hoisted(() => ({
  getConfigsForProject: vi.fn(),
  getConfigById: vi.fn(),
  getPromptsForConfig: vi.fn(),
  getLatestCompletedRunForConfig: vi.fn(),
  getCompletedRunsForConfig: vi.fn(),
  getRunById: vi.fn(),
}));

vi.mock(
  "@/server/features/ai-visibility/repositories/AiVisibilityRepository",
  () => ({ AiVisibilityRepository: mocks }),
);

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
    });
  });

  describe("getPromptResults", () => {
    const storedRun = {
      id: "run_9",
      projectId: "project_1",
      configId: "config_1",
      status: "completed",
      finishedAt: "2026-02-03T00:00:00.000Z",
      promptSetVersion: 2,
      detail: JSON.stringify({ prompts: [] }),
    };

    it("defaults to the latest completed run of the chosen config", async () => {
      mocks.getLatestCompletedRunForConfig.mockResolvedValue(storedRun);

      await expect(getPromptResults("project_1")).resolves.toMatchObject({
        measured: true,
        runId: "run_9",
        completedAt: "2026-02-03T00:00:00.000Z",
        promptSetVersion: 2,
      });
      expect(mocks.getLatestCompletedRunForConfig).toHaveBeenCalledWith(
        "config_1",
      );
    });

    it("loads a runId that belongs to the project", async () => {
      mocks.getRunById.mockResolvedValue(storedRun);

      await expect(
        getPromptResults("project_1", "config_1", "run_9"),
      ).resolves.toMatchObject({ runId: "run_9" });
    });

    it.each([
      ["another project", { projectId: "project_2" }, undefined],
      ["another config", { configId: "config_2" }, "config_1"],
      ["an unfinished run", { status: "running" }, undefined],
    ])(
      "refuses a runId from %s as not found",
      async (_label, override, configId) => {
        mocks.getRunById.mockResolvedValue({ ...storedRun, ...override });

        await expect(
          getPromptResults("project_1", configId, "run_9"),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      },
    );
  });
});
