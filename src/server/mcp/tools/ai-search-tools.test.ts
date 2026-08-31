import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import type {
  BrandLookupResult,
  PromptExplorerResult,
} from "@/types/schemas/ai-search";
import {
  exploreAiPromptTool,
  getAiBrandVisibilityTool,
} from "./ai-search-tools";
import { makeToolContext, textContent } from "./tool-test-support";

const mocks = vi.hoisted(() => ({
  getBrandLookup: vi.fn(),
  explorePrompt: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/features/ai-search/services/brandLookup", () => ({
  getBrandLookup: mocks.getBrandLookup,
}));

vi.mock("@/server/features/ai-search/services/promptExplorer", () => ({
  explorePrompt: mocks.explorePrompt,
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

const toolContext = makeToolContext();

const usProjectRow = {
  id: "project_1",
  locationCode: 2840,
  languageCode: "en",
};

const brandLookupFixture: BrandLookupResult = {
  query: "acme.com",
  detectedTargetType: "domain",
  resolvedTarget: "acme.com",
  scope: "subdomains",
  aggregatesAreDomainLevel: false,
  fetchedAt: "2026-08-31T12:00:00.000Z",
  hasData: true,
  totalMentions: 42,
  totalAiSearchVolume: 1200,
  perPlatform: [
    {
      platform: "chat_gpt",
      status: "success",
      mentions: 20,
      aiSearchVolume: 600,
    },
    {
      platform: "google",
      status: "success",
      mentions: 22,
      aiSearchVolume: 600,
    },
  ],
  shareOfVoice: {
    platforms: ["chat_gpt", "google"],
    entries: [
      {
        label: "acme.com",
        isTarget: true,
        mentions: 42,
        sharePct: 60,
      },
      {
        label: "rival.com",
        isTarget: false,
        mentions: 28,
        sharePct: 40,
      },
    ],
  },
  topPages: [
    {
      url: "https://acme.com/guide",
      domain: "acme.com",
      platform: "chat_gpt",
      mentions: 5,
      capturedVolume: 100,
      keywords: [{ question: "what is acme?", aiSearchVolume: 50 }],
    },
  ],
  topQueries: [],
  monthlyVolume: [],
};

const promptExplorerFixture: PromptExplorerResult = {
  prompt: "What is the best project management tool?",
  highlightBrand: "Acme",
  fetchedAt: "2026-08-31T13:00:00.000Z",
  results: [
    {
      status: "success",
      model: "chat_gpt",
      modelName: "gpt-5",
      text: "Acme is often mentioned among leading tools.",
      citations: [
        {
          url: "https://acme.com",
          domain: "acme.com",
          title: "Acme",
          matchedBrand: true,
        },
      ],
      fanOutQueries: [],
      brandMentioned: true,
      outputTokens: 120,
      webSearch: true,
    },
  ],
};

describe("AI search MCP tools", () => {
  beforeEach(() => {
    // Review 2026-08-31: reset call history so toHaveBeenCalledWith proves
    // THIS test's invocation, not a stale one.
    vi.clearAllMocks();
    mocks.getProjectForOrganization.mockResolvedValue(usProjectRow);
  });

  it("rejects more than 2 models in explore_ai_prompt input schema", () => {
    const modelsSchema = exploreAiPromptTool.config.inputSchema.models;
    expect(
      modelsSchema.safeParse(["chat_gpt", "claude", "gemini"]).success,
    ).toBe(false);
    expect(modelsSchema.safeParse(["chat_gpt", "claude"]).success).toBe(true);
  });

  it("returns brand visibility with source and fetchedAt from the service", async () => {
    mocks.getBrandLookup.mockResolvedValue(brandLookupFixture);

    const result = await getAiBrandVisibilityTool.handler(
      {
        projectId: "project_1",
        query: "acme.com",
        competitors: ["rival.com"],
      },
      toolContext,
    );

    expect(mocks.getBrandLookup).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        query: "acme.com",
        competitors: ["rival.com"],
        locationCode: 2840,
        languageCode: "en",
      }),
      expect.objectContaining({ organizationId: "org_123" }),
    );

    expect(result.structuredContent).toMatchObject({
      source: "dataforseo_llm_mentions",
      fetchedAt: "2026-08-31T12:00:00.000Z",
      totalMentions: 42,
      totalAiSearchVolume: 1200,
      shareOfVoice: brandLookupFixture.shareOfVoice,
      perPlatform: brandLookupFixture.perPlatform,
      topCitedSources: brandLookupFixture.topPages,
    });
    expect(textContent(result)).toContain("acme.com");
    expect(textContent(result)).toContain("42");
  });

  it("omits absent brand metrics as null rather than inventing zeros", async () => {
    mocks.getBrandLookup.mockResolvedValue({
      ...brandLookupFixture,
      totalMentions: null,
      totalAiSearchVolume: null,
      shareOfVoice: null,
      perPlatform: [
        {
          platform: "chat_gpt",
          status: "error",
          mentions: null,
          aiSearchVolume: null,
        },
        {
          platform: "google",
          status: "error",
          mentions: null,
          aiSearchVolume: null,
        },
      ],
      topPages: [],
      hasData: false,
    });

    const result = await getAiBrandVisibilityTool.handler(
      { projectId: "project_1", query: "unknown-brand" },
      toolContext,
    );

    expect(result.structuredContent.totalMentions).toBeNull();
    expect(result.structuredContent.totalAiSearchVolume).toBeNull();
    expect(result.structuredContent.shareOfVoice).toBeNull();
    expect(textContent(result)).not.toMatch(/total mentions:\s*0/i);
  });

  it("surfaces brand lookup service errors as tool errors", async () => {
    mocks.getBrandLookup.mockRejectedValue(
      new AppError("INSUFFICIENT_CREDITS", "No credits"),
    );

    await expect(
      getAiBrandVisibilityTool.handler(
        { projectId: "project_1", query: "acme.com" },
        toolContext,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_CREDITS" });
  });

  it("returns prompt explorer results with fetchedAt", async () => {
    mocks.explorePrompt.mockResolvedValue(promptExplorerFixture);

    const result = await exploreAiPromptTool.handler(
      {
        projectId: "project_1",
        prompt: "What is the best project management tool?",
        models: ["chat_gpt"],
        highlightBrand: "Acme",
      },
      toolContext,
    );

    expect(mocks.explorePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        prompt: "What is the best project management tool?",
        models: ["chat_gpt"],
        highlightBrand: "Acme",
        webSearch: true,
      }),
      expect.objectContaining({ organizationId: "org_123" }),
    );

    expect(result.structuredContent).toMatchObject({
      fetchedAt: "2026-08-31T13:00:00.000Z",
      highlightBrand: "Acme",
      results: [
        expect.objectContaining({
          model: "chat_gpt",
          brandMentioned: true,
          citations: [
            expect.objectContaining({
              url: "https://acme.com",
              matchedBrand: true,
            }),
          ],
        }),
      ],
    });
    expect(textContent(result)).toContain("chat_gpt");
    expect(textContent(result)).toContain("mentioned");
  });

  it("surfaces prompt explorer service errors as tool errors", async () => {
    mocks.explorePrompt.mockRejectedValue(
      new AppError("AI_SEARCH_BILLING_ISSUE", "Billing issue"),
    );

    await expect(
      exploreAiPromptTool.handler(
        {
          projectId: "project_1",
          prompt: "hello",
          models: ["claude"],
        },
        toolContext,
      ),
    ).rejects.toMatchObject({ code: "AI_SEARCH_BILLING_ISSUE" });
  });

  it("validates explore_ai_prompt models enum via zod shape", () => {
    const schema = z.object(exploreAiPromptTool.config.inputSchema);
    expect(
      schema.safeParse({
        projectId: "project_1",
        prompt: "hello",
        models: ["not_a_model"],
      }).success,
    ).toBe(false);
  });
});
