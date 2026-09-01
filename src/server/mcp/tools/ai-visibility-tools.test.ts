import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getAiVisibilityTrendTool } from "./get-ai-visibility-trend";
import { runAiVisibilityCheckTool } from "./run-ai-visibility-check";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getLatestResults: vi.fn(),
  getTrend: vi.fn(),
  runAiVisibilityCheck: vi.fn(),
  captureServerEvent: vi.fn(),
  waitUntil: vi.fn((promise: Promise<unknown>) => void promise.catch(() => {})),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: mocks.waitUntil,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/ai-visibility/services/aiVisibilityResults", () => ({
  getLatestResults: mocks.getLatestResults,
  getTrend: mocks.getTrend,
}));
vi.mock("@/server/features/ai-visibility/services/runAiVisibilityCheck", () => ({
  runAiVisibilityCheck: mocks.runAiVisibilityCheck,
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: mocks.captureServerEvent,
}));

const projectId = "11111111-1111-4111-8111-111111111111";
const configId = "22222222-2222-4222-8222-222222222222";
const toolContext = makeToolContext();

describe("ai visibility MCP tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectForOrganization.mockResolvedValue({
      id: projectId,
      domain: "example.com",
      locationCode: 2840,
      languageCode: "en",
    });
    mocks.captureServerEvent.mockResolvedValue(undefined);
  });

  it("trend tool never calls the run path", async () => {
    mocks.getLatestResults.mockResolvedValue({
      measured: false,
      source: "dataforseo_llm_mentions",
      fetchedAt: null,
      config: null,
      latestRun: null,
    });
    mocks.getTrend.mockResolvedValue({
      measured: false,
      source: "dataforseo_llm_mentions",
      configId: null,
      promptSetVersion: null,
      runs: [],
    });

    const parsed = z.object(getAiVisibilityTrendTool.config.inputSchema).parse({
      projectId,
    });
    await getAiVisibilityTrendTool.handler(parsed, toolContext);

    expect(mocks.runAiVisibilityCheck).not.toHaveBeenCalled();
    expect(mocks.getLatestResults).toHaveBeenCalledTimes(1);
    expect(mocks.getTrend).toHaveBeenCalledTimes(1);
  });

  it("run tool starts a check", async () => {
    mocks.runAiVisibilityCheck.mockResolvedValue({ ok: true, runId: "run_1" });

    const parsed = z.object(runAiVisibilityCheckTool.config.inputSchema).parse({
      projectId,
      configId,
    });
    const result = await runAiVisibilityCheckTool.handler(parsed, toolContext);

    expect(mocks.runAiVisibilityCheck).toHaveBeenCalledTimes(1);
    expect(textContent(result)).toContain("run_1");
  });
});
