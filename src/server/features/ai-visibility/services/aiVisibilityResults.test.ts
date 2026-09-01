import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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
});
