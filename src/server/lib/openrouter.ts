import {
  createOpenRouter,
  type LanguageModelV3,
} from "@openrouter/ai-sdk-provider";
import { wrapLanguageModel } from "ai";
import {
  createOpenRouterPromptCacheMiddleware,
  parseOpenRouterPromptCacheFlag,
} from "@/server/lib/openrouterPromptCache";
import {
  getOptionalEnvValue,
  getRequiredEnvValue,
} from "@/server/lib/runtime-env";

// OpenRouter model slug used for the in-app chat agents (onboarding + SAM).
// Override with OPENROUTER_MODEL to swap models without a code change.
const DEFAULT_CHAT_AGENT_MODEL = "minimax/minimax-m3";

export type ChatAgentModelOptions = {
  // When true (default), restrict routing to Zero-Data-Retention endpoints.
  // Self-host may set OPENROUTER_ZDR=false to reach first-party Anthropic/etc.
  zdr?: boolean;
  // When true (default), attach Anthropic prompt-cache breakpoints for
  // anthropic/* models. Self-host may set OPENROUTER_PROMPT_CACHE=false.
  promptCache?: boolean;
};

export { parseOpenRouterPromptCacheFlag };

/**
 * Parse OPENROUTER_ZDR. Default true (hosted privacy posture). Explicit
 * 0/false/no/off disables request-level ZDR.
 */
export function parseOpenRouterZdrFlag(
  value: string | undefined,
): boolean {
  if (value == null || value.trim() === "") return true;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

/**
 * Returns the AI SDK LanguageModel for the chat agents. `usage: { include: true }`
 * turns on OpenRouter usage accounting so each response carries its real USD
 * cost (providerMetadata.openrouter.usage.cost) — which we meter against the
 * shared usage-credit pool.
 *
 * Default routing (`zdr: true`) prefers Together, then Atlas Cloud (fp8) and
 * restricts to Zero-Data-Retention endpoints (prompts are never retained). That
 * excludes MiniMax first-party without a hand-maintained allowlist. The account
 * may also enforce ZDR per model group; the request-level flag is
 * belt-and-braces. Fallbacks stay on within the ZDR set because pinning
 * providers caused a prod outage (Jul 2026: Together upstream-rate-limited m3
 * and every chat turn 429'd).
 *
 * Self-host can set `OPENROUTER_ZDR=false` (and e.g.
 * `OPENROUTER_MODEL=anthropic/claude-opus-5`) when no ZDR endpoints exist for
 * the chosen model — first-party Anthropic then works.
 *
 * `reasoning` turns on OpenRouter's reasoning-token channel so the model's
 * chain-of-thought comes back as a separate reasoning stream instead of
 * leaking into the visible answer text (MiniMax M3 otherwise dumps its
 * `<think>` trace inline). `effort: "medium"` is OpenRouter's default —
 * stated explicitly only because the SDK type requires one once the channel
 * is configured.
 */
export async function getChatAgentModel(
  options?: ChatAgentModelOptions,
): Promise<LanguageModelV3> {
  const apiKey = await getRequiredEnvValue("OPENROUTER_API_KEY");
  const modelId = await getOptionalEnvValue("OPENROUTER_MODEL");
  const zdr = parseOpenRouterZdrFlag(
    await getOptionalEnvValue("OPENROUTER_ZDR"),
  );
  const promptCache = parseOpenRouterPromptCacheFlag(
    await getOptionalEnvValue("OPENROUTER_PROMPT_CACHE"),
  );
  return buildChatAgentModel(apiKey, modelId, {
    zdr: options?.zdr ?? zdr,
    promptCache: options?.promptCache ?? promptCache,
  });
}

/**
 * Synchronous variant for callers that already hold the env values. Think's
 * `getModel()` hook is sync and runs on every turn, so the SAM agent reads the
 * key/model from its DO env and builds the model here.
 */
export function buildChatAgentModel(
  apiKey: string,
  modelId?: string,
  options?: ChatAgentModelOptions,
): LanguageModelV3 {
  const zdr = options?.zdr ?? true;
  const promptCache = options?.promptCache ?? true;
  const resolvedModelId = modelId ?? DEFAULT_CHAT_AGENT_MODEL;
  // ZDR path keeps the MiniMax-oriented provider preference. Non-ZDR path
  // drops that pin so frontier models (Anthropic Opus, etc.) can hit
  // first-party endpoints.
  const provider = zdr
    ? {
        order: ["together", "atlas-cloud/fp8"],
        zdr: true as const,
        allow_fallbacks: true,
      }
    : {
        allow_fallbacks: true,
      };

  const model = createOpenRouter({ apiKey })(resolvedModelId, {
    usage: { include: true },
    reasoning: { effort: "medium" },
    provider,
  });

  // R2/R6: only wrap anthropic/* when the env off-switch is on. Non-anthropic
  // and disabled paths stay byte-identical to the unwrapped model.
  if (!promptCache || !resolvedModelId.startsWith("anthropic/")) {
    return model;
  }

  return wrapLanguageModel({
    model,
    middleware: createOpenRouterPromptCacheMiddleware(),
  });
}
