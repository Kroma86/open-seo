import type { LanguageModelV3 } from "@openrouter/ai-sdk-provider";
import { type LanguageModelMiddleware } from "ai";

type CallOptions = Parameters<LanguageModelV3["doGenerate"]>[0];
type PromptMessage = CallOptions["prompt"][number];
type ToolDefinition = NonNullable<CallOptions["tools"]>[number];
type FunctionTool = Extract<ToolDefinition, { type: "function" }>;
type ProviderOptions = NonNullable<PromptMessage["providerOptions"]>;

/** Confirmed against `@openrouter/ai-sdk-provider` `getCacheControl()` — prefers `openrouter.cacheControl`. */
export const OPENROUTER_CACHE_CONTROL = { type: "ephemeral" } as const;

/**
 * Parse OPENROUTER_PROMPT_CACHE. Default true (caching on). Explicit
 * 0/false/no/off disables the prompt-cache middleware.
 */
export function parseOpenRouterPromptCacheFlag(
  value: string | undefined,
): boolean {
  if (value == null || value.trim() === "") return true;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function hasCacheControl(providerOptions: ProviderOptions | undefined): boolean {
  const openrouter = providerOptions?.openrouter;
  if (!openrouter || typeof openrouter !== "object") return false;
  return "cacheControl" in openrouter || "cache_control" in openrouter;
}

function withCacheControl<T extends { providerOptions?: ProviderOptions }>(
  item: T,
): T {
  if (hasCacheControl(item.providerOptions)) return item;
  const existingOpenrouter =
    item.providerOptions?.openrouter &&
    typeof item.providerOptions.openrouter === "object"
      ? item.providerOptions.openrouter
      : {};
  return {
    ...item,
    providerOptions: {
      ...item.providerOptions,
      openrouter: {
        ...existingOpenrouter,
        cacheControl: OPENROUTER_CACHE_CONTROL,
      },
    },
  };
}

function withFunctionToolCacheControl(tool: FunctionTool): FunctionTool {
  return withCacheControl(tool);
}

function toolHasCacheControl(tool: ToolDefinition): boolean {
  return tool.type === "function" && hasCacheControl(tool.providerOptions);
}

/** Count AI-SDK-level cache breakpoints set via openrouter/anthropic providerOptions. */
export function countPromptCacheBreakpoints(params: CallOptions): number {
  let count = 0;
  for (const tool of params.tools ?? []) {
    if (toolHasCacheControl(tool)) count += 1;
  }
  for (const message of params.prompt) {
    if (hasCacheControl(message.providerOptions)) count += 1;
  }
  return count;
}

/**
 * Place up to 3 Anthropic cache breakpoints (max 4 allowed by the API):
 * 1. last tool definition  2. last system message  3. last conversation message
 */
export function applyPromptCacheBreakpoints(params: CallOptions): CallOptions {
  let tools = params.tools;
  if (tools && tools.length > 0) {
    let lastFunctionIndex = -1;
    for (let i = tools.length - 1; i >= 0; i -= 1) {
      if (tools[i]?.type === "function") {
        lastFunctionIndex = i;
        break;
      }
    }
    if (lastFunctionIndex >= 0) {
      tools = tools.map((tool, index) => {
        if (index !== lastFunctionIndex || tool.type !== "function") return tool;
        return withFunctionToolCacheControl(tool);
      });
    }
  }

  const prompt = [...params.prompt];
  let lastSystemIndex = -1;
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    if (prompt[i]?.role === "system") {
      lastSystemIndex = i;
      break;
    }
  }
  if (lastSystemIndex >= 0) {
    const system = prompt[lastSystemIndex];
    if (system) prompt[lastSystemIndex] = withCacheControl(system);
  }

  if (prompt.length > 0) {
    const lastIndex = prompt.length - 1;
    const last = prompt[lastIndex];
    if (last) prompt[lastIndex] = withCacheControl(last);
  }

  return { ...params, tools, prompt };
}

/** Identity for non-`anthropic/` models; otherwise apply cache breakpoints. */
export function transformPromptCacheParams(
  modelId: string,
  params: CallOptions,
): CallOptions {
  if (!modelId.startsWith("anthropic/")) return params;
  return applyPromptCacheBreakpoints(params);
}

function logCacheUsage(
  usage: {
    inputTokens?: {
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
      total?: number | undefined;
    };
  },
  providerMetadata: unknown,
): void {
  const openrouter =
    providerMetadata &&
    typeof providerMetadata === "object" &&
    "openrouter" in providerMetadata
      ? (providerMetadata as { openrouter?: { usage?: Record<string, unknown> } })
          .openrouter
      : undefined;
  const usageMeta = openrouter?.usage;
  const cachedTokens =
    usageMeta &&
    typeof usageMeta === "object" &&
    "promptTokensDetails" in usageMeta &&
    usageMeta.promptTokensDetails &&
    typeof usageMeta.promptTokensDetails === "object" &&
    "cachedTokens" in usageMeta.promptTokensDetails
      ? (usageMeta.promptTokensDetails as { cachedTokens?: number }).cachedTokens
      : undefined;

  console.log("[sam] cache", {
    cacheRead: usage.inputTokens?.cacheRead ?? 0,
    cacheWrite: usage.inputTokens?.cacheWrite ?? 0,
    cachedTokens: cachedTokens ?? 0,
    inputTokens: usage.inputTokens?.total ?? 0,
    // OpenRouter field name confirmed in provider: prompt_tokens_details.cached_tokens
    cached_tokens: cachedTokens ?? usage.inputTokens?.cacheRead ?? 0,
  });
}

/** Middleware: transformParams adds breakpoints; wrap* logs cache counters per step. */
export function createOpenRouterPromptCacheMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    transformParams: async ({ params, model }) =>
      transformPromptCacheParams(model.modelId, params),
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      logCacheUsage(result.usage, result.providerMetadata);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      const transform = new TransformStream({
        transform(chunk, controller) {
          if (chunk.type === "finish") {
            logCacheUsage(chunk.usage, chunk.providerMetadata);
          }
          controller.enqueue(chunk);
        },
      });
      return { ...rest, stream: stream.pipeThrough(transform) };
    },
  };
}
