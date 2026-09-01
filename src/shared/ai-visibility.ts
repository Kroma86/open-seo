import { computeNextCheckAt } from "@/shared/rank-tracking";
import type { PromptExplorerModel } from "@/types/schemas/ai-search";

export type AiVisibilityScheduleInterval = "weekly" | "monthly" | "manual";

export const MAX_ACTIVE_PROMPTS_PER_CONFIG = 10;

/** Platforms stored on ai_visibility_configs (JSON string[]). */
export const AI_VISIBILITY_PLATFORMS = [
  "chat_gpt",
  "google",
  "claude",
  "gemini",
  "perplexity",
] as const;

export type AiVisibilityPlatform = (typeof AI_VISIBILITY_PLATFORMS)[number];

// Set<string> so .has() accepts any platform value; the filter's type guard
// still narrows matches to PromptExplorerModel.
const PROMPT_EXPLORER_MODEL_SET: ReadonlySet<string> = new Set<PromptExplorerModel>([
  "chat_gpt",
  "claude",
  "gemini",
  "perplexity",
]);

export function isScheduledAiVisibilityInterval(
  interval: string,
): interval is Exclude<AiVisibilityScheduleInterval, "manual"> {
  return interval === "weekly" || interval === "monthly";
}

export function parsePlatformsJson(raw: string): AiVisibilityPlatform[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return ["chat_gpt", "google"];
    const platforms = parsed.filter(
      (item): item is AiVisibilityPlatform =>
        typeof item === "string" &&
        (AI_VISIBILITY_PLATFORMS as readonly string[]).includes(item),
    );
    return platforms.length > 0 ? platforms : ["chat_gpt", "google"];
  } catch {
    return ["chat_gpt", "google"];
  }
}

export function parseCompetitorsJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

/** Prompt-explorer models from config platforms (max 2 per spec / MCP cap). */
export function promptExplorerModelsForPlatforms(
  platforms: AiVisibilityPlatform[],
): PromptExplorerModel[] {
  return platforms
    .filter((p): p is PromptExplorerModel => PROMPT_EXPLORER_MODEL_SET.has(p))
    .slice(0, 2);
}

export function brandLookupPlatforms(
  platforms: AiVisibilityPlatform[],
): Array<"chat_gpt" | "google"> {
  return platforms.filter(
    (p): p is "chat_gpt" | "google" => p === "chat_gpt" || p === "google",
  );
}

/**
 * Reuse rank-tracking schedule math (weekly / end-of-month).
 * Re-anchor when stale so downtime cannot stampede catch-up.
 */
export function computeNextRunAt(
  interval: Exclude<AiVisibilityScheduleInterval, "manual">,
  previousNextRunAt?: string | null,
): string {
  const next = computeNextCheckAt(interval, previousNextRunAt);
  if (new Date(next).getTime() > Date.now()) return next;
  return computeNextCheckAt(interval);
}

export const MAX_ACTIVE_PROMPTS_ERROR = `Maximum ${MAX_ACTIVE_PROMPTS_PER_CONFIG} active prompts per tracking config`;
