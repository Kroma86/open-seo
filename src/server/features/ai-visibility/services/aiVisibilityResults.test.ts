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
  getActiveRunForConfig: vi.fn().mockResolvedValue(null),
  getLatestAttemptForConfig: vi.fn().mockResolvedValue(null),
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

const exportRun = (
  id: string,
  sweep: string | null,
  totalMentions: number,
) => ({
  id,
  finishedAt: `2026-03-0${totalMentions}T00:00:00.000Z`,
  promptSetVersion: 2,
  totalMentions,
  shareOfVoicePct: null,
  promptsWithBrand: 0,
  promptsChecked: 1,
  detail: sweep ? JSON.stringify({ sweep }) : JSON.stringify({}),
});

describe("aiVisibilityResults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfigsForProject.mockResolvedValue([config]);
    mocks.getConfigById.mockResolvedValue(config);
    mocks.getPromptsForConfig.mockResolvedValue([]);
    mocks.getActiveRunForConfig.mockResolvedValue(null);
    mocks.getLatestAttemptForConfig.mockResolvedValue(null);
  });

  it("refuses to pick a config silently when the project has more than one", async () => {
    mocks.getConfigsForProject.mockResolvedValue([
      config,
      { ...config, id: "config_2", brand: "Oopsie Daisy" },
    ]);
    await expect(getLatestResults("project_1")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- vitest asymmetric matcher
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
      activeRun: null,
      latestAttempt: null,
      measured: false,
      source: "dataforseo_llm_mentions",
      fetchedAt: null,
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- vitest asymmetric matcher
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

  it("reads sweep from detail and treats a missing or invalid value as legacy", async () => {
    const run = {
      id: "run_1",
      finishedAt: "2026-02-02T00:00:00.000Z",
      totalMentions: 4,
      shareOfVoicePct: 10,
      promptsWithBrand: 1,
      promptsChecked: 2,
      promptSetVersion: 2,
      costNote: null,
      error: null,
    };
    mocks.getLatestCompletedRunForConfig.mockResolvedValue({
      ...run,
      detail: JSON.stringify({ sweep: "pulse" }),
    });
    await expect(getLatestResults("project_1")).resolves.toMatchObject({
      latestRun: { sweep: "pulse" },
    });

    mocks.getLatestCompletedRunForConfig.mockResolvedValue({
      ...run,
      detail: JSON.stringify({ sweep: "full" }),
    });
    await expect(getLatestResults("project_1")).resolves.toMatchObject({
      latestRun: { sweep: "full" },
    });

    for (const detail of [
      null,
      "not-json",
      JSON.stringify({ sweep: "other" }),
      "{}",
    ]) {
      mocks.getLatestCompletedRunForConfig.mockResolvedValue({
        ...run,
        detail,
      });
      await expect(getLatestResults("project_1")).resolves.toMatchObject({
        latestRun: { sweep: "legacy" },
      });
    }
  });

  it("computes a delta against the next older run with the same sweep", async () => {
    mocks.getCompletedRunsForConfig.mockResolvedValue([
      {
        id: "full_new",
        finishedAt: "2026-03-03T00:00:00.000Z",
        promptSetVersion: 2,
        totalMentions: 12,
        shareOfVoicePct: 20,
        promptsWithBrand: 3,
        promptsChecked: 5,
        detail: JSON.stringify({ sweep: "full" }),
      },
      {
        id: "pulse_mid",
        finishedAt: "2026-03-02T00:00:00.000Z",
        promptSetVersion: 2,
        totalMentions: 99,
        shareOfVoicePct: 1,
        promptsWithBrand: 0,
        promptsChecked: 5,
        detail: JSON.stringify({ sweep: "pulse" }),
      },
      {
        id: "full_old",
        finishedAt: "2026-03-01T00:00:00.000Z",
        promptSetVersion: 2,
        totalMentions: 10,
        shareOfVoicePct: 15,
        promptsWithBrand: 2,
        promptsChecked: 5,
        detail: JSON.stringify({ sweep: "full" }),
      },
    ]);

    const trend = await getTrend("project_1");
    expect(trend.runs[0]?.sweep).toBe("full");
    expect(trend.runs[0]?.delta).toEqual({
      totalMentions: 2,
      shareOfVoicePct: 5,
      promptsWithBrand: 1,
      promptsChecked: 0,
    });
    expect(trend.runs[1]?.sweep).toBe("pulse");
    expect(trend.runs[1]?.delta).toBeNull();
  });

  it("bases the agency export on the newest completed run that is not a pulse", async () => {
    mocks.getCompletedRunsForConfig.mockResolvedValue([
      {
        id: "pulse_run",
        finishedAt: "2026-03-02T00:00:00.000Z",
        promptSetVersion: 2,
        totalMentions: 1,
        shareOfVoicePct: 1,
        promptsWithBrand: 0,
        promptsChecked: 1,
        detail: JSON.stringify({
          sweep: "pulse",
          brandLookup: { partialMentions: false },
        }),
      },
      {
        id: "full_run",
        finishedAt: "2026-03-01T00:00:00.000Z",
        promptSetVersion: 2,
        totalMentions: 8,
        shareOfVoicePct: 22,
        promptsWithBrand: 3,
        promptsChecked: 5,
        detail: JSON.stringify({
          sweep: "full",
          brandLookup: { partialMentions: true },
        }),
      },
    ]);

    await expect(getAgencyExportBlock("project_1")).resolves.toEqual({
      capturedAt: "2026-03-01T00:00:00.000Z",
      source: "dataforseo_llm_mentions",
      totalMentions: 8,
      partialMentions: true,
      shareOfVoicePct: 22,
      promptsWithBrand: 3,
      promptsChecked: 5,
      promptSetVersion: 2,
    });
    expect(mocks.getCompletedRunsForConfig).toHaveBeenCalledWith("config_1", 8);
  });

  it("agency export takes a legacy run over an older full run behind a pulse", async () => {
    mocks.getCompletedRunsForConfig.mockResolvedValue([
      exportRun("pulse_run", "pulse", 3),
      exportRun("legacy_run", null, 2),
      exportRun("full_run", "full", 1),
    ]);
    await expect(getAgencyExportBlock("project_1")).resolves.toMatchObject({
      totalMentions: 2,
      capturedAt: "2026-03-02T00:00:00.000Z",
    });
  });

  it("agency export falls back to the newest run when all are pulses", async () => {
    mocks.getCompletedRunsForConfig.mockResolvedValue([
      exportRun("pulse_new", "pulse", 2),
      exportRun("pulse_old", "pulse", 1),
    ]);
    await expect(getAgencyExportBlock("project_1")).resolves.toMatchObject({
      totalMentions: 2,
    });
  });

  it("agency export is null when there is no completed run", async () => {
    mocks.getCompletedRunsForConfig.mockResolvedValue([]);
    await expect(getAgencyExportBlock("project_1")).resolves.toBeNull();
  });

  it("deltas two pulses against each other but not across prompt set versions", async () => {
    mocks.getCompletedRunsForConfig.mockResolvedValue([
      { ...exportRun("pulse_new", "pulse", 5), promptsWithBrand: 3 },
      { ...exportRun("full_mid", "full", 4), promptsWithBrand: 9 },
      { ...exportRun("pulse_old", "pulse", 3), promptsWithBrand: 1 },
      { ...exportRun("pulse_v1", "pulse", 2), promptSetVersion: 1 },
    ]);
    const trend = await getTrend("project_1");
    expect(trend.runs[0]?.delta).toMatchObject({
      totalMentions: 2,
      promptsWithBrand: 2,
    });
    expect(trend.runs[2]?.delta).toBeNull();
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

describe("manual attempt status privacy", () => {
  it("returns active state without stored queue context and keeps completed results separate", async () => {
    mocks.getConfigById.mockResolvedValue(config);
    mocks.getPromptsForConfig.mockResolvedValue([]);
    mocks.getLatestCompletedRunForConfig.mockResolvedValue(null);
    mocks.getActiveRunForConfig.mockResolvedValue({
      id: "pending1",
      status: "pending",
      createdAt: "2026-10-15T00:00:00Z",
      startedAt: null,
      finishedAt: null,
      error: null,
      detail: "private billing snapshot",
      costNote: "private",
    });
    mocks.getLatestAttemptForConfig.mockResolvedValue({
      id: "pending1",
      status: "pending",
      createdAt: "2026-10-15T00:00:00Z",
      startedAt: null,
      finishedAt: null,
      error: null,
    });
    const result = await getLatestResults("project_1", "config_1");
    expect(result.activeRun?.status).toBe("pending");
    expect(result.latestRun).toBeNull();
    expect(result.measured).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("does not publish raw failure payloads", async () => {
    mocks.getConfigById.mockResolvedValue(config);
    mocks.getPromptsForConfig.mockResolvedValue([]);
    mocks.getLatestCompletedRunForConfig.mockResolvedValue(null);
    mocks.getActiveRunForConfig.mockResolvedValue(null);
    mocks.getLatestAttemptForConfig.mockResolvedValue({
      id: "failed1",
      status: "failed",
      createdAt: "2026-10-15T00:00:00Z",
      startedAt: null,
      finishedAt: "2026-10-15T00:01:00Z",
      error: "private upstream data",
    });
    const result = await getLatestResults("project_1", "config_1");
    expect(result.latestAttempt?.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private upstream data");
  });
});
