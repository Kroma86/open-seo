import { measurementReport } from "@/server/features/ai-visibility-v2/report";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { mcpResponse } from "@/server/mcp/formatters";
export const getAiVisibilityV2ReportTool = {
  name: "get_ai_visibility_v2_report",
  config: {
    title: "Get Measurement v2 report",
    description:
      "Read stored queued ChatGPT and Google AI Mode measurements only. No provider calls or credits. Shows question-level X/N, Wilson 95% bands, too few answers, exclusions, cited domains and same-question/week old-engine comparisons. API and UI measurements are different methods.",
    inputSchema: { projectId: projectIdSchema },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: { projectId: string }) => {
    const report = await measurementReport(args.projectId);
    return mcpResponse({
      text: report.engines.length
        ? report.engines
            .map(
              (e) =>
                `${e.engine}: ${e.x}/${e.n} questions named; ${e.citedX}/${e.n} cited; ${e.status}; band ${e.band ? `${e.band.low}–${e.band.high}` : "not measured"}; excluded ${JSON.stringify(e.excluded)}; top cited domains ${JSON.stringify(e.topDomains)}; old-engine comparison ${JSON.stringify(e.comparison)}`,
            )
            .join("\n")
        : "Measurement v2: not measured",
      structuredContent: report,
    });
  }),
};
