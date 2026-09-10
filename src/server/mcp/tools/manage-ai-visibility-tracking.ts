import { z } from "zod";
import { AiVisibilityManagementService } from "@/server/features/ai-visibility/services/AiVisibilityManagementService";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { AI_VISIBILITY_PLATFORMS } from "@/shared/ai-visibility";
import { BRAND_LOOKUP_MAX_INPUT_LENGTH } from "@/types/schemas/ai-search";

const manageActionSchema = z.enum([
  "list",
  "create",
  "update",
  "add_prompt",
  "remove_prompt",
  "toggle_prompt",
]);

const inputSchema = {
  projectId: projectIdSchema,
  action: manageActionSchema.describe(
    "Management action: list configs, create/update config, or add/remove/toggle tracked prompts.",
  ),
  configId: z.string().uuid().optional(),
  brand: z
    .string()
    .trim()
    .min(1)
    .max(BRAND_LOOKUP_MAX_INPUT_LENGTH)
    .optional(),
  competitors: z
    .array(z.string().trim().min(1).max(BRAND_LOOKUP_MAX_INPUT_LENGTH))
    .max(5)
    .optional(),
  platforms: z.array(z.enum(AI_VISIBILITY_PLATFORMS)).min(1).optional(),
  scheduleInterval: z.enum(["weekly", "monthly", "manual"]).optional(),
  isActive: z.boolean().optional(),
  promptId: z.string().uuid().optional(),
  prompt: z.string().trim().min(1).max(500).optional(),
  promptIsActive: z.boolean().optional(),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

/**
 * Brand is free text and legitimately differs from the domain (a flower shop
 * named "Oopsie Daisy" on vernonflowers.ca), so this never blocks. It does
 * flag the same-name-different-business pattern: no brand word of four or
 * more letters appears in the project's domain or name.
 */
export function brandMismatchWarning(
  brand: string,
  project: { domain: string | null; name: string },
): string | null {
  const haystack = `${project.domain ?? ""} ${project.name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  const tokens = brand
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4);
  if (tokens.length === 0) return null;
  if (tokens.some((token) => haystack.includes(token))) return null;
  return `WARNING: brand "${brand}" shares no word with the project website ${project.domain ?? "(none)"} or name "${project.name}". Check this is the same business before tracking.`;
}

export const manageAiVisibilityTrackingTool = {
  name: "manage_ai_visibility_tracking",
  config: {
    title: "Manage AI visibility tracking",
    description:
      "Configure tracked AI visibility for a project: create or update a brand config, and add, remove, or toggle tracked prompts (max 10 active). Prompt-set changes bump promptSetVersion and start a new trend baseline. Config CRUD uses no credits; run_ai_visibility_check performs paid lookups.",
    inputSchema,
    outputSchema: z
      .object({
        action: manageActionSchema,
        configs: z.array(looseObjectOutputSchema).optional(),
        config: looseObjectOutputSchema.optional(),
        result: looseObjectOutputSchema.optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const path = `/p/${args.projectId}/ai-visibility`;

    if (args.action === "list") {
      const configs = await AiVisibilityManagementService.getConfigs(
        args.projectId,
      );
      const text =
        configs.length === 0
          ? "No AI visibility tracking configs for this project."
          : configs
              .map(
                (c) =>
                  `- ${c.id} brand:${c.brand} prompts:${c.prompts.length} schedule:${c.scheduleInterval}`,
              )
              .join("\n");
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId, path),
        structuredContent: { action: args.action, configs },
      });
    }

    if (args.action === "create") {
      if (!args.brand) {
        throw new AppError("VALIDATION_ERROR", "brand is required to create");
      }
      const config = await AiVisibilityManagementService.createConfig({
        projectId: args.projectId,
        brand: args.brand,
        competitors: args.competitors,
        platforms: args.platforms,
        scheduleInterval: args.scheduleInterval,
      });
      const full = await AiVisibilityManagementService.getConfigWithPrompts(
        config.id,
        args.projectId,
      );
      const warning = brandMismatchWarning(config.brand, context.project);
      return mcpResponse({
        text: [
          `Created AI visibility config ${config.id} for ${config.brand}.`,
          ...(warning ? [warning] : []),
        ].join("\n"),
        meta: buildProjectMeta(context, args.projectId, path),
        structuredContent: {
          action: args.action,
          config: full,
        },
      });
    }

    if (!args.configId) {
      throw new AppError("VALIDATION_ERROR", "configId is required");
    }

    if (args.action === "update") {
      await AiVisibilityManagementService.updateConfig(
        args.configId,
        args.projectId,
        {
          brand: args.brand,
          competitors: args.competitors,
          platforms: args.platforms,
          scheduleInterval: args.scheduleInterval,
          isActive: args.isActive,
        },
      );
      const config = await AiVisibilityManagementService.getConfigWithPrompts(
        args.configId,
        args.projectId,
      );
      const warning = args.brand
        ? brandMismatchWarning(args.brand, context.project)
        : null;
      return mcpResponse({
        text: [
          `Updated AI visibility config ${args.configId}.`,
          ...(warning ? [warning] : []),
        ].join("\n"),
        meta: buildProjectMeta(context, args.projectId, path),
        structuredContent: { action: args.action, config },
      });
    }

    if (args.action === "add_prompt") {
      if (!args.prompt) {
        throw new AppError("VALIDATION_ERROR", "prompt is required");
      }
      const result = await AiVisibilityManagementService.addPrompt(
        args.configId,
        args.projectId,
        args.prompt,
      );
      const config = await AiVisibilityManagementService.getConfigWithPrompts(
        args.configId,
        args.projectId,
      );
      return mcpResponse({
        text: `Added prompt ${result.promptId} to config ${args.configId} (promptSetVersion ${config.promptSetVersion}).`,
        meta: buildProjectMeta(context, args.projectId, path),
        structuredContent: { action: args.action, config, result },
      });
    }

    if (args.action === "remove_prompt") {
      if (!args.promptId) {
        throw new AppError("VALIDATION_ERROR", "promptId is required");
      }
      const result = await AiVisibilityManagementService.removePrompt(
        args.configId,
        args.projectId,
        args.promptId,
      );
      const config = await AiVisibilityManagementService.getConfigWithPrompts(
        args.configId,
        args.projectId,
      );
      return mcpResponse({
        text: `Removed prompt from config ${args.configId} (promptSetVersion ${config.promptSetVersion}).`,
        meta: buildProjectMeta(context, args.projectId, path),
        structuredContent: { action: args.action, config, result },
      });
    }

    if (args.action === "toggle_prompt") {
      if (!args.promptId || args.promptIsActive == null) {
        throw new AppError(
          "VALIDATION_ERROR",
          "promptId and promptIsActive are required",
        );
      }
      const result = await AiVisibilityManagementService.togglePrompt(
        args.configId,
        args.projectId,
        args.promptId,
        args.promptIsActive,
      );
      const config = await AiVisibilityManagementService.getConfigWithPrompts(
        args.configId,
        args.projectId,
      );
      return mcpResponse({
        text: `Toggled prompt on config ${args.configId} (promptSetVersion ${config.promptSetVersion}).`,
        meta: buildProjectMeta(context, args.projectId, path),
        structuredContent: { action: args.action, config, result },
      });
    }

    throw new AppError("VALIDATION_ERROR", "Unsupported action");
  }),
};
