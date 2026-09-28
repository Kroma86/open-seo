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

  it("default call output is byte-identical to the pre-NIC-885 output", async () => {
    mocks.getLatestResults.mockResolvedValue({
      measured: true,
      source: "dataforseo_llm_mentions",
      fetchedAt: "2026-09-20T00:00:00.000Z",
      config: { id: configId, brand: "Acme" },
      latestRun: {
        id: "run_1",
        totalMentions: 4,
        partialMentions: false,
        shareOfVoicePct: 25,
        promptsWithBrand: 1,
        promptsChecked: 2,
      },
    });
    mocks.getTrend.mockResolvedValue({
      measured: true,
      source: "dataforseo_llm_mentions",
      configId,
      promptSetVersion: 1,
      runs: [{ id: "run_1" }],
    });

    const parsed = z.object(getAiVisibilityTrendTool.config.inputSchema).parse({
      projectId,
    });
    const result = await getAiVisibilityTrendTool.handler(parsed, toolContext);

    // Captured from the tool before includePromptResults existed.
    expect(JSON.stringify(result)).toMatchInlineSnapshot(`"{"content":[{"type":"text","text":"Tracked AI visibility for Acme\\nFetched at: 2026-09-20T00:00:00.000Z\\nTotal mentions: 4\\nShare of voice: 25%\\nPrompts with brand: 1 / 2\\nTrend runs: 1\\n\\nHermes AI observations: missing; 0 saved ChatGPT answers; measured unknown; run unknown. External observations unavailable: agency feed is not configured."}],"structuredContent":{"measured":true,"source":"dataforseo_llm_mentions","latest":{"measured":true,"source":"dataforseo_llm_mentions","fetchedAt":"2026-09-20T00:00:00.000Z","config":{"id":"22222222-2222-4222-8222-222222222222","brand":"Acme"},"latestRun":{"id":"run_1","totalMentions":4,"partialMentions":false,"shareOfVoicePct":25,"promptsWithBrand":1,"promptsChecked":2}},"trend":{"measured":true,"source":"dataforseo_llm_mentions","configId":"22222222-2222-4222-8222-222222222222","promptSetVersion":1,"runs":[{"id":"run_1"}]},"externalObservations":{"source":"Hermes AI visibility","status":"missing","measuredAt":null,"stale":null,"runStatus":null,"answers":[],"googleScanPresent":false,"comparisonsSupported":false,"note":"No Hermes AI visibility data was provided. Captured answers and Google brand-scan results are unavailable from this feed."},"meta":{"projectId":"11111111-1111-4111-8111-111111111111","url":"https://open-seo.test/p/11111111-1111-4111-8111-111111111111/ai-visibility"}},"_meta":{"projectId":"11111111-1111-4111-8111-111111111111","url":"https://open-seo.test/p/11111111-1111-4111-8111-111111111111/ai-visibility"}}"`);
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
