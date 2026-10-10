import { createServerFn } from "@tanstack/react-start";
import { waitUntil } from "cloudflare:workers";
import { AiVisibilityManagementService } from "@/server/features/ai-visibility/services/AiVisibilityManagementService";
import {
  getLatestResults,
  getTrend,
} from "@/server/features/ai-visibility/services/aiVisibilityResults";
import { runAiVisibilityCheck } from "@/server/features/ai-visibility/services/runAiVisibilityCheck";
import { captureServerEvent } from "@/server/lib/posthog";
import { requireProjectContext } from "@/serverFunctions/middleware";
import {
  addAiVisibilityPromptSchema,
  createAiVisibilityConfigSchema,
  getAiVisibilityLatestSchema,
  getAiVisibilityTrendSchema,
  removeAiVisibilityPromptSchema,
  runAiVisibilityCheckSchema,
  toggleAiVisibilityPromptSchema,
  updateAiVisibilityConfigSchema,
} from "@/types/schemas/ai-visibility";

export const getAiVisibilityTracking = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAiVisibilityLatestSchema)
  .handler(async ({ data, context }) => {
    return getLatestResults(context.projectId, data.configId);
  });

export const getAiVisibilityTrackingTrend = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getAiVisibilityTrendSchema)
  .handler(async ({ data, context }) => {
    return getTrend(context.projectId, data.configId, data.limit);
  });

// Every tracked brand on the project, so the page can ask the user which one
// to show instead of the service picking one (it refuses when there are two).
export const listAiVisibilityTrackingConfigs = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(getAiVisibilityLatestSchema.pick({ projectId: true }))
  .handler(async ({ context }) => {
    const configs = await AiVisibilityManagementService.getConfigs(
      context.projectId,
    );
    return configs.map((config) => ({ id: config.id, brand: config.brand }));
  });

export const createAiVisibilityTrackingConfig = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(createAiVisibilityConfigSchema)
  .handler(async ({ data, context }) => {
    const config = await AiVisibilityManagementService.createConfig({
      projectId: context.projectId,
      brand: data.brand,
      competitors: data.competitors,
      platforms: data.platforms,
      scheduleInterval: data.scheduleInterval,
    });
    return AiVisibilityManagementService.getConfigWithPrompts(
      config.id,
      context.projectId,
    );
  });

export const updateAiVisibilityTrackingConfig = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(updateAiVisibilityConfigSchema)
  .handler(async ({ data, context }) => {
    await AiVisibilityManagementService.updateConfig(
      data.configId,
      context.projectId,
      {
        brand: data.brand,
        competitors: data.competitors,
        platforms: data.platforms,
        scheduleInterval: data.scheduleInterval,
        isActive: data.isActive,
      },
    );
    return AiVisibilityManagementService.getConfigWithPrompts(
      data.configId,
      context.projectId,
    );
  });

export const addAiVisibilityTrackingPrompt = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(addAiVisibilityPromptSchema)
  .handler(async ({ data, context }) => {
    await AiVisibilityManagementService.addPrompt(
      data.configId,
      context.projectId,
      data.prompt,
    );
    return AiVisibilityManagementService.getConfigWithPrompts(
      data.configId,
      context.projectId,
    );
  });

export const removeAiVisibilityTrackingPrompt = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(removeAiVisibilityPromptSchema)
  .handler(async ({ data, context }) => {
    await AiVisibilityManagementService.removePrompt(
      data.configId,
      context.projectId,
      data.promptId,
    );
    return AiVisibilityManagementService.getConfigWithPrompts(
      data.configId,
      context.projectId,
    );
  });

export const toggleAiVisibilityTrackingPrompt = createServerFn({
  method: "POST",
})
  .middleware(requireProjectContext)
  .validator(toggleAiVisibilityPromptSchema)
  .handler(async ({ data, context }) => {
    await AiVisibilityManagementService.togglePrompt(
      data.configId,
      context.projectId,
      data.promptId,
      data.isActive,
    );
    return AiVisibilityManagementService.getConfigWithPrompts(
      data.configId,
      context.projectId,
    );
  });

export const triggerAiVisibilityCheck = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(runAiVisibilityCheckSchema)
  .handler(async ({ data, context }) => {
    const result = await runAiVisibilityCheck({
      configId: data.configId,
      projectId: context.projectId,
      billingCustomer: context,
      trigger: "manual",
    });

    if (result.ok) {
      waitUntil(
        captureServerEvent({
          distinctId: context.userId,
          event: "ai_visibility:check_trigger",
          organizationId: context.organizationId,
          properties: {
            project_id: context.projectId,
            config_id: data.configId,
            run_id: result.runId,
          },
        }),
      );
    }

    return result;
  });
