import { z } from "zod";
import {
  AI_VISIBILITY_PLATFORMS,
  MAX_ACTIVE_PROMPTS_PER_CONFIG,
} from "@/shared/ai-visibility";
import { BRAND_LOOKUP_MAX_INPUT_LENGTH } from "@/types/schemas/ai-search";

const scheduleIntervalSchema = z.enum(["weekly", "monthly", "manual"]);
const platformSchema = z.enum(AI_VISIBILITY_PLATFORMS);

export const getAiVisibilityConfigSchema = z.object({
  projectId: z.string().min(1),
  configId: z.string().uuid().optional(),
});

export const createAiVisibilityConfigSchema = z.object({
  projectId: z.string().min(1),
  brand: z.string().trim().min(1).max(BRAND_LOOKUP_MAX_INPUT_LENGTH),
  competitors: z
    .array(z.string().trim().min(1).max(BRAND_LOOKUP_MAX_INPUT_LENGTH))
    .max(5)
    .default([]),
  platforms: z.array(platformSchema).min(1).default(["chat_gpt", "google"]),
  scheduleInterval: scheduleIntervalSchema.default("weekly"),
});

export const updateAiVisibilityConfigSchema = z.object({
  projectId: z.string().min(1),
  configId: z.string().uuid(),
  brand: z.string().trim().min(1).max(BRAND_LOOKUP_MAX_INPUT_LENGTH).optional(),
  competitors: z
    .array(z.string().trim().min(1).max(BRAND_LOOKUP_MAX_INPUT_LENGTH))
    .max(5)
    .optional(),
  platforms: z.array(platformSchema).min(1).optional(),
  scheduleInterval: scheduleIntervalSchema.optional(),
  isActive: z.boolean().optional(),
});

export const addAiVisibilityPromptSchema = z.object({
  projectId: z.string().min(1),
  configId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(500),
});

export const removeAiVisibilityPromptSchema = z.object({
  projectId: z.string().min(1),
  configId: z.string().uuid(),
  promptId: z.string().uuid(),
});

export const toggleAiVisibilityPromptSchema = z.object({
  projectId: z.string().min(1),
  configId: z.string().uuid(),
  promptId: z.string().uuid(),
  isActive: z.boolean(),
});

export const runAiVisibilityCheckSchema = z.object({
  projectId: z.string().min(1),
  configId: z.string().uuid(),
});

export const getAiVisibilityLatestSchema = z.object({
  projectId: z.string().min(1),
  configId: z.string().uuid().optional(),
});

export const getAiVisibilityTrendSchema = z.object({
  projectId: z.string().min(1),
  configId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export type AiVisibilityRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export type AiVisibilityLatestResults = {
  measured: boolean;
  source: "dataforseo_llm_mentions";
  fetchedAt: string | null;
  config: {
    id: string;
    brand: string;
    competitors: string[];
    platforms: string[];
    scheduleInterval: z.infer<typeof scheduleIntervalSchema>;
    promptSetVersion: number;
    prompts: Array<{
      id: string;
      prompt: string;
      isActive: boolean;
    }>;
  } | null;
  latestRun: {
    id: string;
    status: AiVisibilityRunStatus;
    finishedAt: string | null;
    totalMentions: number | null;
    shareOfVoicePct: number | null;
    promptsWithBrand: number | null;
    promptsChecked: number | null;
    promptSetVersion: number;
    costNote: string | null;
    error: string | null;
  } | null;
};

export type AiVisibilityTrendPoint = {
  id: string;
  finishedAt: string | null;
  promptSetVersion: number;
  totalMentions: number | null;
  shareOfVoicePct: number | null;
  promptsWithBrand: number | null;
  promptsChecked: number | null;
  delta: {
    totalMentions: number | null;
    shareOfVoicePct: number | null;
    promptsWithBrand: number | null;
    promptsChecked: number | null;
  } | null;
};

export type AiVisibilityTrend = {
  measured: boolean;
  source: "dataforseo_llm_mentions";
  configId: string | null;
  promptSetVersion: number | null;
  runs: AiVisibilityTrendPoint[];
};

export const MAX_ACTIVE_PROMPTS_PER_CONFIG_EXPORT = MAX_ACTIVE_PROMPTS_PER_CONFIG;
