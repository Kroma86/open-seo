import { z } from "zod";
import { SamLoopService } from "@/server/features/sam-loops/services/SamLoopService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const listInputSchema = {
  projectId: projectIdSchema,
} as const;

export const listSamLoopsTool = {
  name: "list_sam_loops",
  config: {
    title: "List Sam loops",
    description:
      "Lists scheduled Sam loops for a project (name, cadence, enabled, last/next run). Read-only — no credits. Use to answer what loops are configured for this client.",
    inputSchema: listInputSchema,
    outputSchema: {
      loops: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof listInputSchema>>, context) => {
      const { loops } = await SamLoopService.listSamLoopsForProject(
        args.projectId,
      );
      const text =
        loops.length === 0
          ? "No Sam loops configured yet."
          : `Sam loops (${loops.length}):\n` +
            loops
              .map((loop) => {
                const source =
                  loop.sourceType === "skill"
                    ? `skill:${loop.skillName ?? "?"}`
                    : "custom";
                return `- ${loop.name} [${loop.cadence}] ${loop.isEnabled ? "on" : "off"} ${source} last:${loop.lastRunAt ?? "never"} next:${loop.nextRunAt ?? "—"}`;
              })
              .join("\n");
      return mcpResponse({
        text,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/loops`,
        ),
        structuredContent: { loops },
      });
    },
  ),
};

const runsInputSchema = {
  projectId: projectIdSchema,
  loopId: z
    .string()
    .uuid()
    .optional()
    .describe("Optional loop id to filter runs."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max runs to return. Defaults to 20."),
} as const;

export const getSamLoopRunsTool = {
  name: "get_sam_loop_runs",
  config: {
    title: "Get Sam loop runs",
    description:
      "Returns recent Sam loop run reports for a project (plain-English findings, status, proposals queued). Read-only — no credits. Use to answer what the loops found this week.",
    inputSchema: runsInputSchema,
    outputSchema: {
      runs: z.array(looseObjectOutputSchema),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof runsInputSchema>>, context) => {
      const runs = await SamLoopService.getSamLoopRuns({
        projectId: args.projectId,
        loopId: args.loopId,
        limit: args.limit ?? 20,
      });
      const text =
        runs.length === 0
          ? "No Sam loop runs yet."
          : `Sam loop runs (${runs.length}):\n` +
            runs
              .map((run) => {
                const name =
                  "loopName" in run && typeof run.loopName === "string"
                    ? run.loopName
                    : run.loopId;
                const report =
                  run.report?.replace(/\s+/g, " ").slice(0, 240) ??
                  run.error ??
                  "(no report)";
                return `- ${name} [${run.status}] proposals:${run.proposalsQueued} — ${report}`;
              })
              .join("\n");
      return mcpResponse({
        text,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/loops`,
        ),
        structuredContent: { runs },
      });
    },
  ),
};
