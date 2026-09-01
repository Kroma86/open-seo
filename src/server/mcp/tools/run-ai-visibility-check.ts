import { z } from "zod";
import { waitUntil } from "cloudflare:workers";
import { runAiVisibilityCheck } from "@/server/features/ai-visibility/services/runAiVisibilityCheck";
import { captureServerEvent } from "@/server/lib/posthog";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  configId: z
    .string()
    .uuid()
    .describe("Tracked AI visibility config ID to check."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const runAiVisibilityCheckTool = {
  name: "run_ai_visibility_check",
  config: {
    title: "Run AI visibility check",
    description:
      "Explicitly run a tracked AI visibility check now: one DataForSEO brand lookup plus one prompt-explorer call per active tracked prompt. Spends DataForSEO credits on cache miss; cached brand lookups (24h) and prompt responses (7d) reduce cost. Hosted accounts require a paid plan. If a check is already in progress, reports the blocking run without starting another paid run.",
    inputSchema,
    outputSchema: z
      .object({
        configId: z.string(),
        started: z.boolean(),
        runId: z.string().optional(),
        blockingRunId: z.string().nullable().optional(),
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
    const result = await runAiVisibilityCheck({
      configId: args.configId,
      projectId: args.projectId,
      billingCustomer: context.billing,
      trigger: "manual",
    });
    const path = `/p/${args.projectId}/ai-visibility`;

    if (!result.ok) {
      return mcpResponse({
        text: `An AI visibility check is already running for config ${args.configId}${result.blockingRunId ? ` (run ${result.blockingRunId})` : ""}. No new run was started.`,
        meta: buildProjectMeta(context, args.projectId, path),
        structuredContent: {
          configId: args.configId,
          started: false,
          blockingRunId: result.blockingRunId,
        },
      });
    }

    waitUntil(
      captureServerEvent({
        distinctId: context.auth.userId,
        event: "ai_visibility:check_trigger",
        organizationId: context.auth.organizationId,
        properties: {
          project_id: args.projectId,
          config_id: args.configId,
          run_id: result.runId,
          source: "mcp",
        },
      }),
    );

    return mcpResponse({
      text: `AI visibility check ${result.runId} completed for config ${args.configId}. Read results with get_ai_visibility_trend.`,
      meta: buildProjectMeta(context, args.projectId, path),
      structuredContent: {
        configId: args.configId,
        started: true,
        runId: result.runId,
      },
    });
  }),
};
