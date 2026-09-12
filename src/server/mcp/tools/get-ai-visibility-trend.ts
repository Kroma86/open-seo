import { z } from "zod";
import {
  getLatestResults,
  getTrend,
} from "@/server/features/ai-visibility/services/aiVisibilityResults";
import { formatMentionsDisplay } from "@/shared/ai-visibility-mentions";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  configId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Tracked AI visibility config ID. If omitted, uses the first active config in the project.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum completed runs to return (default 20)."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

function formatNullable(value: number | null | undefined): string {
  return value == null ? "not measured" : String(value);
}

export const getAiVisibilityTrendTool = {
  name: "get_ai_visibility_trend",
  config: {
    title: "Get AI visibility trend",
    description:
      "Read-only view of tracked AI visibility runs and deltas for a project. Uses stored check results only — never triggers a new run and uses no credits. Deltas appear only between consecutive completed runs with the same prompt-set version; a prompt change starts a new baseline. When nothing has been measured yet, reports not measured — never zero-filled numbers.",
    inputSchema,
    outputSchema: z
      .object({
        measured: z.boolean(),
        source: z.literal("dataforseo_llm_mentions"),
        latest: looseObjectOutputSchema.nullable(),
        trend: looseObjectOutputSchema,
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const [latest, trend] = await Promise.all([
      getLatestResults(args.projectId, args.configId),
      getTrend(args.projectId, args.configId, args.limit ?? 20),
    ]);

    const text = latest.measured
      ? [
          `Tracked AI visibility for ${latest.config?.brand ?? "project"}`,
          `Fetched at: ${latest.fetchedAt}`,
          `Total mentions: ${formatMentionsDisplay(
            latest.latestRun?.totalMentions ?? null,
            latest.latestRun?.partialMentions ?? false,
          )}`,
          `Share of voice: ${formatNullable(latest.latestRun?.shareOfVoicePct)}${latest.latestRun?.shareOfVoicePct == null ? "" : "%"}`,
          `Prompts with brand: ${formatNullable(latest.latestRun?.promptsWithBrand)} / ${formatNullable(latest.latestRun?.promptsChecked)}`,
          `Trend runs: ${trend.runs.length}`,
        ].join("\n")
      : "AI visibility: not measured yet for this project.";

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/ai-visibility`,
      ),
      structuredContent: {
        measured: latest.measured,
        source: "dataforseo_llm_mentions" as const,
        latest,
        trend,
      },
    });
  }),
};
