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

const updateInputSchema = z
  .object({
    projectId: projectIdSchema,
    loopId: z.string().uuid(),
    isEnabled: z.boolean().optional(),
    cadence: z.enum(["daily", "weekly", "monthly"]).optional(),
  })
  .strict()
  .refine(
    (input) => input.isEnabled !== undefined || input.cadence !== undefined,
    "Provide isEnabled, cadence, or both.",
  );

export const updateSamLoopTool = {
  name: "update_sam_loop",
  config: {
    title: "Update Sam loop schedule",
    description:
      "Enable or disable one existing project loop and/or set its daily, weekly, or monthly cadence. Changes saved settings only; does not start a run or use credits itself. Enabled loops may run on their normal schedules under existing project holds and usage limits. Does not enable the project, create loops, change prompts, or grant publication permission. Read list_sam_loops first to get the loopId.",
    inputSchema: updateInputSchema,
    outputSchema: {
      loop: looseObjectOutputSchema,
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (input: z.infer<typeof updateInputSchema>, context) => {
      // Validate here too: direct callers must not bypass the transport schema.
      const args = updateInputSchema.parse(input);
      // Project authorization excludes archived projects before this handler.
      const loop = await SamLoopService.updateSamLoop({
        projectId: args.projectId,
        loopId: args.loopId,
        ...(args.isEnabled !== undefined ? { isEnabled: args.isEnabled } : {}),
        ...(args.cadence !== undefined ? { cadence: args.cadence } : {}),
      });
      return mcpResponse({
        text: `Saved Sam loop ${loop.id}: ${loop.isEnabled ? "on" : "off"}, ${loop.cadence}; next:${loop.nextRunAt ?? "not scheduled"}. No run was started by this request. Project holds and usage limits still apply.`,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/loops`,
        ),
        structuredContent: { loop },
      });
    },
  ),
};

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
