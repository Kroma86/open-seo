import { describe, expect, it } from "vitest";
import type { LanguageModelV3 } from "@openrouter/ai-sdk-provider";
import {
  applyPromptCacheBreakpoints,
  countPromptCacheBreakpoints,
  OPENROUTER_CACHE_CONTROL,
  parseOpenRouterPromptCacheFlag,
  transformPromptCacheParams,
} from "@/server/lib/openrouterPromptCache";

type CallOptions = Parameters<LanguageModelV3["doGenerate"]>[0];

function baseParams(overrides: Partial<CallOptions> = {}): CallOptions {
  return {
    prompt: [
      { role: "system", content: "soul + project context" },
      {
        role: "user",
        content: [{ type: "text", text: "audit niceseo.ai" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "I'll start the audit." }],
      },
    ],
    tools: [
      {
        type: "function",
        name: "read_site",
        description: "Read a site",
        inputSchema: { type: "object", properties: {} },
      },
      {
        type: "function",
        name: "run_site_audit",
        description: "Run an audit",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    ...overrides,
  };
}

describe("parseOpenRouterPromptCacheFlag", () => {
  it("defaults on for unset/empty", () => {
    expect(parseOpenRouterPromptCacheFlag(undefined)).toBe(true);
    expect(parseOpenRouterPromptCacheFlag("")).toBe(true);
    expect(parseOpenRouterPromptCacheFlag("   ")).toBe(true);
  });

  it("disables for 0/false/no/off (case-insensitive)", () => {
    for (const value of ["0", "false", "FALSE", "no", "off", " Off "]) {
      expect(parseOpenRouterPromptCacheFlag(value)).toBe(false);
    }
  });

  it("stays on for other explicit values", () => {
    expect(parseOpenRouterPromptCacheFlag("1")).toBe(true);
    expect(parseOpenRouterPromptCacheFlag("true")).toBe(true);
    expect(parseOpenRouterPromptCacheFlag("yes")).toBe(true);
  });
});

describe("transformPromptCacheParams gating", () => {
  it("passes non-anthropic models through identity (same reference)", () => {
    const params = baseParams();
    expect(transformPromptCacheParams("minimax/minimax-m3", params)).toBe(
      params,
    );
    expect(
      transformPromptCacheParams("openai/gpt-5", params),
    ).toBe(params);
  });

  it("applies breakpoints for anthropic/ model ids", () => {
    const params = baseParams();
    const next = transformPromptCacheParams(
      "anthropic/claude-sonnet-5",
      params,
    );
    expect(next).not.toBe(params);
    expect(countPromptCacheBreakpoints(next)).toBeGreaterThan(0);
  });
});

describe("applyPromptCacheBreakpoints placement", () => {
  it("marks last tool, last system, and last message (≤4 total)", () => {
    const params = baseParams();
    const next = applyPromptCacheBreakpoints(params);

    expect(countPromptCacheBreakpoints(next)).toBeLessThanOrEqual(4);
    expect(countPromptCacheBreakpoints(next)).toBe(3);

    const tools = next.tools ?? [];
    const lastTool = tools[tools.length - 1];
    expect(lastTool?.type).toBe("function");
    if (lastTool?.type === "function") {
      expect(lastTool.providerOptions).toEqual({
        openrouter: { cacheControl: OPENROUTER_CACHE_CONTROL },
      });
    }
    const firstTool = tools[0];
    if (firstTool?.type === "function") {
      expect(firstTool.providerOptions).toBeUndefined();
    }

    const system = next.prompt.filter((m) => m.role === "system");
    const lastSystem = system[system.length - 1];
    expect(lastSystem?.providerOptions).toEqual({
      openrouter: { cacheControl: OPENROUTER_CACHE_CONTROL },
    });

    const lastMessage = next.prompt[next.prompt.length - 1];
    expect(lastMessage?.providerOptions).toEqual({
      openrouter: { cacheControl: OPENROUTER_CACHE_CONTROL },
    });
  });

  it("does not exceed 4 breakpoints with multiple system messages", () => {
    const params = baseParams({
      prompt: [
        { role: "system", content: "soul" },
        { role: "system", content: "project context" },
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "continue" }],
        },
      ],
    });
    const next = applyPromptCacheBreakpoints(params);
    expect(countPromptCacheBreakpoints(next)).toBeLessThanOrEqual(4);
    expect(next.prompt[0]?.providerOptions).toBeUndefined();
    expect(next.prompt[1]?.providerOptions).toEqual({
      openrouter: { cacheControl: OPENROUTER_CACHE_CONTROL },
    });
    expect(next.prompt[next.prompt.length - 1]?.providerOptions).toEqual({
      openrouter: { cacheControl: OPENROUTER_CACHE_CONTROL },
    });
  });

  it("preserves existing openrouter providerOptions when marking", () => {
    const params = baseParams({
      prompt: [
        {
          role: "system",
          content: "soul",
          providerOptions: {
            openrouter: { reasoning: { effort: "medium" } },
          },
        },
        {
          role: "user",
          content: [{ type: "text", text: "hi" }],
        },
      ],
    });
    const next = applyPromptCacheBreakpoints(params);
    expect(next.prompt[0]?.providerOptions).toEqual({
      openrouter: {
        reasoning: { effort: "medium" },
        cacheControl: OPENROUTER_CACHE_CONTROL,
      },
    });
  });

  it("leaves tools/prompt order unchanged", () => {
    const params = baseParams();
    const next = applyPromptCacheBreakpoints(params);
    expect(
      next.tools?.map((t) => (t.type === "function" ? t.name : t.name)),
    ).toEqual(["read_site", "run_site_audit"]);
    expect(next.prompt.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });
});
