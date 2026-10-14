import { describe, expect, it, vi } from "vitest";
import type { LlmResponseResult } from "@/server/lib/dataforseoLlmSchemas";
import type { PromptExplorerModel } from "@/types/schemas/ai-search";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn() }));

const { llmResponse, buildCacheKey, getCached } = vi.hoisted(() => ({
  llmResponse: vi.fn(),
  buildCacheKey: vi.fn(
    async (prefix: string, params: Record<string, unknown>) => {
      const raw = JSON.stringify(params, Object.keys(params).toSorted());
      return `${prefix}:${raw}`;
    },
  ),
  getCached: vi.fn(async () => null),
}));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    aiSearch: { llmResponse },
  }),
}));

vi.mock("@/server/lib/r2-cache", () => ({
  AI_SEARCH_PROMPT_CACHE_NAMESPACE: "ai-search:prompt-response",
  buildCacheKey,
  getCached,
  setCached: vi.fn(async () => undefined),
}));

const { extractCitations, explorePrompt } = await import("./promptExplorer");

// DataForSEO's LLM Responses payload nests references as untyped
// `{ title, url }` objects under items[].sections[].annotations — mirroring the
// SDK's AnnotationInfo, which has no citation-type discriminator.
function response(
  annotations: Array<{ title?: string; url?: string }>,
): LlmResponseResult {
  return {
    model_name: "gpt-5",
    web_search: true,
    items: [
      {
        type: "reasoning",
        sections: [{ type: "summary_text", text: "thinking" }],
      },
      {
        type: "message",
        sections: [{ type: "text", text: "answer", annotations }],
      },
    ],
  };
}

describe("extractCitations", () => {
  it("keeps untyped annotations (no citation-type discriminator exists)", () => {
    const citations = extractCitations(
      response([
        { title: "Town & Country", url: "https://www.townandcountrymag.com/x" },
        { title: "Stylevana", url: "https://www.stylevana.com/y" },
      ]),
    );
    expect(citations.map((c) => c.url)).toEqual([
      "https://www.townandcountrymag.com/x",
      "https://www.stylevana.com/y",
    ]);
    expect(citations[0]?.domain).toBe("townandcountrymag.com");
    expect(citations[0]?.title).toBe("Town & Country");
  });

  it("dedupes repeated URLs and drops unsafe schemes", () => {
    const citations = extractCitations(
      response([
        { title: "A", url: "https://example.com/a" },
        { title: "A dup", url: "https://example.com/a" },
        { title: "evil", url: "javascript:alert(1)" },
        { title: "no url" },
      ]),
    );
    expect(citations).toHaveLength(1);
    expect(citations[0]?.url).toBe("https://example.com/a");
  });

  it("ignores annotations outside message items and returns [] when absent", () => {
    expect(extractCitations({ items: [] })).toEqual([]);
    expect(
      extractCitations({
        items: [
          {
            type: "reasoning",
            sections: [
              {
                type: "summary_text",
                text: "t",
                annotations: [{ title: "x", url: "https://x.test/1" }],
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
});

function llmPayload(modelName: string): LlmResponseResult {
  return {
    model_name: modelName,
    web_search: true,
    items: [
      {
        type: "message",
        sections: [{ type: "text", text: "hi", annotations: [] }],
      },
    ],
  };
}

describe("explorePrompt model name override", () => {
  const billingCustomer = {
    organizationId: "org_123",
    userId: "user_123",
    userEmail: "a@example.com",
    projectId: "project_1",
  };
  const models: PromptExplorerModel[] = ["perplexity"];

  it("sends the override and keeps the cache key unchanged unless one is set", async () => {
    llmResponse.mockResolvedValue(llmPayload("sonar-reasoning-pro"));
    const input = {
      projectId: "project_1",
      prompt: "best tools",
      models,
      webSearch: true as const,
    };

    await explorePrompt(input, billingCustomer);
    await explorePrompt(input, billingCustomer);

    llmResponse.mockResolvedValue(llmPayload("sonar"));
    await explorePrompt(
      { ...input, modelNameOverrides: { perplexity: "sonar" } },
      billingCustomer,
    );

    expect(llmResponse).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        modelSlug: "perplexity",
        modelName: "sonar-reasoning-pro",
      }),
    );
    expect(llmResponse).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ modelSlug: "perplexity", modelName: "sonar" }),
    );

    const keys = buildCacheKey.mock.results.map(
      (result) => result.value as Promise<string>,
    );
    const [first, second, third] = await Promise.all(keys);
    expect(first).toBe(second);
    expect(first).not.toContain("modelName");
    expect(third).not.toBe(first);
    expect(third).toContain('"modelName":"sonar"');
    expect(buildCacheKey.mock.calls[0]?.[1]).toEqual({
      organizationId: "org_123",
      projectId: "project_1",
      model: "perplexity",
      prompt: "best tools",
      webSearch: true,
      webSearchCountryCode: null,
      systemPromptV: 5,
    });
  });
});
