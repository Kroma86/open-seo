import type { BillingCustomerContext } from "@/server/billing/subscription";
import { customerHasPaidPlan } from "@/server/billing/subscription";
import { AiVisibilityRepository } from "@/server/features/ai-visibility/repositories/AiVisibilityRepository";
import { AppError } from "@/server/lib/errors";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import {
  computeNextRunAt,
  isScheduledAiVisibilityInterval,
  MAX_ACTIVE_PROMPTS_ERROR,
  MAX_ACTIVE_PROMPTS_PER_CONFIG,
  parseCompetitorsJson,
  parsePlatformsJson,
} from "@/shared/ai-visibility";

type ScheduleInterval = "weekly" | "monthly" | "manual";

async function getValidatedConfig(configId: string, projectId: string) {
  const config = await AiVisibilityRepository.getConfigById({
    configId,
    projectId,
  });
  if (!config) {
    throw new AppError("NOT_FOUND", "AI visibility config not found");
  }
  return config;
}

function normalizeBrand(brand: string): string {
  const trimmed = brand.trim();
  if (!trimmed) {
    throw new AppError("VALIDATION_ERROR", "Brand is required");
  }
  return trimmed;
}

function scheduleNextRunAt(interval: ScheduleInterval): string | null {
  if (!isScheduledAiVisibilityInterval(interval)) return null;
  return computeNextRunAt(interval);
}

async function createConfig(input: {
  projectId: string;
  brand: string;
  competitors?: string[];
  platforms?: string[];
  scheduleInterval?: ScheduleInterval;
}) {
  const brand = normalizeBrand(input.brand);
  const existing = await AiVisibilityRepository.getConfigByProjectBrand(
    input.projectId,
    brand,
  );
  if (existing?.isActive) {
    throw new AppError(
      "VALIDATION_ERROR",
      "This brand is already tracked for AI visibility",
    );
  }

  const scheduleInterval = input.scheduleInterval ?? "weekly";
  const nextRunAt = scheduleNextRunAt(scheduleInterval);
  const platforms = JSON.stringify(
    input.platforms?.length ? input.platforms : ["chat_gpt", "google"],
  );
  const competitors = JSON.stringify(input.competitors ?? []);

  if (existing) {
    await AiVisibilityRepository.updateConfig(existing.id, input.projectId, {
      isActive: true,
      competitors,
      platforms,
      scheduleInterval,
      nextRunAt,
    });
    return getValidatedConfig(existing.id, input.projectId);
  }

  const configId = crypto.randomUUID();
  await AiVisibilityRepository.createConfig({
    id: configId,
    projectId: input.projectId,
    brand,
    competitors,
    platforms,
    scheduleInterval,
    promptSetVersion: 1,
    isActive: true,
    lastRunAt: null,
    nextRunAt,
  });
  return getValidatedConfig(configId, input.projectId);
}

async function updateConfig(
  configId: string,
  projectId: string,
  input: {
    brand?: string;
    competitors?: string[];
    platforms?: string[];
    scheduleInterval?: ScheduleInterval;
    isActive?: boolean;
  },
) {
  await getValidatedConfig(configId, projectId);
  const updates: Parameters<typeof AiVisibilityRepository.updateConfig>[2] = {};

  if (input.brand !== undefined) {
    const brand = normalizeBrand(input.brand);
    const conflict = await AiVisibilityRepository.getConfigByProjectBrand(
      projectId,
      brand,
    );
    if (conflict && conflict.id !== configId && conflict.isActive) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Another active config already tracks this brand",
      );
    }
    updates.brand = brand;
  }
  if (input.competitors !== undefined) {
    updates.competitors = JSON.stringify(input.competitors);
  }
  if (input.platforms !== undefined) {
    updates.platforms = JSON.stringify(input.platforms);
  }
  if (input.isActive !== undefined) {
    updates.isActive = input.isActive;
  }
  if (input.scheduleInterval !== undefined) {
    updates.scheduleInterval = input.scheduleInterval;
    updates.nextRunAt = scheduleNextRunAt(input.scheduleInterval);
  }

  await AiVisibilityRepository.updateConfig(configId, projectId, updates);
}

async function addPrompt(configId: string, projectId: string, prompt: string) {
  await getValidatedConfig(configId, projectId);
  const normalized = prompt.trim();
  if (!normalized) {
    throw new AppError("VALIDATION_ERROR", "Prompt is required");
  }

  const promptId = crypto.randomUUID();
  const inserted = await AiVisibilityRepository.addPromptRespectingCap({
    id: promptId,
    configId,
    prompt: normalized,
  });
  if (!inserted.ok) {
    if (inserted.reason === "cap") {
      throw new AppError("VALIDATION_ERROR", MAX_ACTIVE_PROMPTS_ERROR);
    }
    throw new AppError(
      "VALIDATION_ERROR",
      "This prompt is already tracked for this config",
    );
  }

  await AiVisibilityRepository.bumpPromptSetVersion(configId, projectId);
  return { promptId: inserted.promptId };
}

async function removePrompt(
  configId: string,
  projectId: string,
  promptId: string,
) {
  await getValidatedConfig(configId, projectId);
  const removed = await AiVisibilityRepository.removePrompt(
    promptId,
    configId,
  );
  if (!removed) {
    throw new AppError("NOT_FOUND", "Prompt not found");
  }
  await AiVisibilityRepository.bumpPromptSetVersion(configId, projectId);
  return { removed: true };
}

async function togglePrompt(
  configId: string,
  projectId: string,
  promptId: string,
  isActive: boolean,
) {
  await getValidatedConfig(configId, projectId);
  const existing = await AiVisibilityRepository.getPromptById(
    promptId,
    configId,
  );
  if (!existing) {
    throw new AppError("NOT_FOUND", "Prompt not found");
  }
  if (existing.isActive === isActive) {
    return { toggled: false };
  }

  if (isActive) {
    const activated = await AiVisibilityRepository.activatePromptRespectingCap(
      promptId,
      configId,
    );
    if (!activated.ok) {
      if (activated.reason === "cap") {
        throw new AppError("VALIDATION_ERROR", MAX_ACTIVE_PROMPTS_ERROR);
      }
      throw new AppError("NOT_FOUND", "Prompt not found");
    }
  } else {
    const toggled = await AiVisibilityRepository.togglePrompt(
      promptId,
      configId,
      false,
    );
    if (!toggled) {
      throw new AppError("NOT_FOUND", "Prompt not found");
    }
  }

  await AiVisibilityRepository.bumpPromptSetVersion(configId, projectId);
  return { toggled: true };
}

async function getConfigWithPrompts(configId: string, projectId: string) {
  const config = await getValidatedConfig(configId, projectId);
  const prompts = await AiVisibilityRepository.getPromptsForConfig(configId);
  return {
    ...config,
    competitors: parseCompetitorsJson(config.competitors),
    platforms: parsePlatformsJson(config.platforms),
    prompts,
  };
}

async function getConfigs(projectId: string) {
  const configs = await AiVisibilityRepository.getConfigsForProject(projectId);
  return Promise.all(
    configs.map(async (config) => {
      const prompts = await AiVisibilityRepository.getPromptsForConfig(
        config.id,
      );
      return {
        ...config,
        competitors: parseCompetitorsJson(config.competitors),
        platforms: parsePlatformsJson(config.platforms),
        prompts,
      };
    }),
  );
}

async function requireAiVisibilityAccess(organizationId: string) {
  if (!(await isHostedServerAuthMode())) return;
  if (await customerHasPaidPlan(organizationId)) return;
  throw new AppError(
    "PAYMENT_REQUIRED",
    "Upgrade to the paid plan to run AI visibility checks",
  );
}

export const AiVisibilityManagementService = {
  createConfig,
  updateConfig,
  addPrompt,
  removePrompt,
  togglePrompt,
  getConfigWithPrompts,
  getConfigs,
  getValidatedConfig,
  requireAiVisibilityAccess,
};

export type AiVisibilityCheckTrigger = "manual" | "scheduled";

export type AiVisibilityCheckTriggerResult =
  | { ok: true; runId: string }
  | { ok: false; reason: "already_running"; blockingRunId: string | null };
